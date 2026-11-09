import { consoleApi, failure } from "./console-api.ts";

interface Env {
  ASSETS: Fetcher;
  BACKUPS: R2Bucket;
  /** Access team name, i.e. the subdomain of <team>.cloudflareaccess.com. */
  ACCESS_TEAM_NAME?: string;
  /** Application Audience (AUD) tag of the Access self-hosted app. */
  ACCESS_AUD?: string;
  /** Comma separated key prefixes that may be modified. "*" = no restriction. */
  WRITE_PREFIXES?: string;
}

const DEFAULT_WRITE_PREFIXES = "db/,instance/,status/";
const CERTS_TTL_MS = 60 * 60 * 1000;
const CERTS_MIN_REFETCH_MS = 60 * 1000;
const CLOCK_SKEW_S = 30;

type Jwk = JsonWebKey & { kid?: string };
let certCache: { team: string; keys: Map<string, CryptoKey>; at: number } | null = null;

const b64urlToBytes = (s: string): Uint8Array => {
  const b = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b + "=".repeat((4 - (b.length % 4)) % 4));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
};
const b64urlToJson = (s: string): Record<string, unknown> =>
  JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));

async function loadKeys(team: string, force: boolean): Promise<Map<string, CryptoKey>> {
  const now = Date.now();
  if (certCache && certCache.team === team) {
    const age = now - certCache.at;
    if (age < CERTS_TTL_MS && !(force && age > CERTS_MIN_REFETCH_MS)) return certCache.keys;
    if (force && age <= CERTS_MIN_REFETCH_MS) return certCache.keys;
  }
  const res = await fetch(`https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs fetch failed: ${res.status}`);
  const body = (await res.json()) as { keys: Jwk[] };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys) {
    if (!jwk.kid) continue;
    keys.set(
      jwk.kid,
      await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]),
    );
  }
  certCache = { team, keys, at: now };
  return keys;
}

/** Returns an error string, or null when the token is valid for this team + AUD. */
async function verifyAccessJwt(token: string, team: string, aud: string): Promise<string | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return "malformed token";
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = b64urlToJson(parts[0]);
    payload = b64urlToJson(parts[1]);
    if (!header || !payload || Array.isArray(header) || Array.isArray(payload)) return "malformed token";
  } catch {
    return "undecodable token";
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string") return "unsupported alg or missing kid";

  let keys = await loadKeys(team, false);
  let key = keys.get(header.kid);
  if (!key) {
    keys = await loadKeys(team, true); // key rotation
    key = keys.get(header.kid);
  }
  if (!key) return "unknown signing key";

  let signature: Uint8Array;
  try {
    signature = b64urlToBytes(parts[2]);
  } catch {
    return "bad signature";
  }
  const ok = await crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    signature,
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!ok) return "bad signature";

  const nowS = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp) || payload.exp + CLOCK_SKEW_S <= nowS) return "expired";
  if (payload.nbf !== undefined && (typeof payload.nbf !== "number" || !Number.isFinite(payload.nbf) || payload.nbf - CLOCK_SKEW_S > nowS)) return "not yet valid";
  if (payload.iss !== `https://${team}.cloudflareaccess.com`) return "wrong issuer";
  const audClaim = payload.aud;
  const audOk = Array.isArray(audClaim) ? audClaim.includes(aud) : audClaim === aud;
  if (!audOk) return "wrong audience";
  return null;
}

const deny = (status: number, msg: string) =>
  new Response(msg, { status, headers: { "cache-control": "no-store", "content-type": "text/plain" } });

const RAW_WRITE_ROUTES = ["upload", "multipart/create", "multipart/upload"];

/**
 * CSRF defence for state-changing requests. A valid Access JWT is attached by Access
 * whenever the browser sends the CF_Authorization cookie, including on cross-site
 * requests, so the JWT alone does not prove the request came from the console.
 * Allow only same-origin requests: Sec-Fetch-Site must be "same-origin", or, when the
 * browser does not send it, Origin must equal this Worker's origin.
 */
function csrfError(req: Request, url: URL): string | null {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return null;
  const site = req.headers.get("sec-fetch-site");
  if (site !== null) {
    if (site !== "same-origin") return "cross-site write request blocked";
  } else if (req.headers.get("origin") !== url.origin) {
    return "write request without a same-origin Origin blocked";
  }
  const rest = url.pathname.match(/^\/api\/buckets\/[^/]+\/(.+)$/)?.[1];
  const jsonRoute = rest !== undefined && !RAW_WRITE_ROUTES.includes(rest);
  if (jsonRoute && (req.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    return "JSON content type required";
  }
  return null;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const team = env.ACCESS_TEAM_NAME?.trim();
    const aud = env.ACCESS_AUD?.trim();
    if (!team || !aud) return deny(500, "Access is not configured (fail closed)");

    const token = request.headers.get("cf-access-jwt-assertion");
    if (!token) return deny(403, "Missing Cloudflare Access token");
    let err: string | null;
    try {
      err = await verifyAccessJwt(token.trim(), team, aud);
    } catch {
      console.error("Access verification unavailable");
      return deny(503, "Access verification unavailable");
    }
    if (err) return deny(403, `Invalid Cloudflare Access token: ${err}`);

    const url = new URL(request.url);

    // Public, unauthenticated share links would bypass Access: disabled entirely.
    // They also write .r2-explorer/ objects into the bucket. No email handler either.
    if (
      url.pathname.startsWith("/share/") ||
      url.pathname.startsWith("/api/emails") ||
      /\/api\/buckets\/[^/]+\/(shares?($|\/)|[^/]+\/share$)/.test(url.pathname)
    ) {
      return deny(404, "Not found");
    }

    const csrf = csrfError(request, url);
    if (csrf) return deny(403, csrf);

    // Keep the console inside the managed prefixes unless explicitly widened.
    const allowed = (env.WRITE_PREFIXES ?? DEFAULT_WRITE_PREFIXES)
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return consoleApi(request, env, allowed);
    }

    // Worker-first assets stay behind the same Access and method checks as the API.
    if (request.method !== "GET" && request.method !== "HEAD") return deny(405, "Method not allowed");
    try {
      return await env.ASSETS.fetch(request);
    } catch {
      console.error("Backup console assets unavailable");
      return failure(500);
    }
  },
};
