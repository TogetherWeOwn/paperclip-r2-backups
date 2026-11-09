import { R2Explorer } from "r2-explorer";
import {
  CONTROL_LIMITS, ControlError, checkControl, checkQuery, controlFailure, controlRoute,
  decodedKey, parseControl, readControl, replayControl,
} from "./control.ts";

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

  const ok = await crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    b64urlToBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!ok) return "bad signature";

  const nowS = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp + CLOCK_SKEW_S <= nowS) return "expired";
  if (typeof payload.nbf === "number" && payload.nbf - CLOCK_SKEW_S > nowS) return "not yet valid";
  if (payload.iss !== `https://${team}.cloudflareaccess.com`) return "wrong issuer";
  const audClaim = payload.aud;
  const audOk = Array.isArray(audClaim) ? audClaim.includes(aud) : audClaim === aud;
  if (!audOk) return "wrong audience";
  return null;
}

const deny = (status: number, msg: string) =>
  new Response(msg, { status, headers: { "cache-control": "no-store", "content-type": "text/plain" } });

const fromB64 = decodedKey;

/**
 * Keys a request would modify, derived from R2-Explorer's write endpoints.
 * Returns null for non-write requests, [] for a write we cannot attribute (denied).
 */
function writeTargets(req: Request, url: URL, body?: Record<string, unknown>): string[] | null {
  if (req.method !== "POST" && req.method !== "PUT" && req.method !== "DELETE") return null;
  const m = url.pathname.match(/^\/api\/buckets\/[^/]+\/(.+)$/);
  if (!m) return null;
  const rest = m[1];
  if (rest === "upload" || rest === "multipart/create" || rest === "multipart/upload") {
    const k = fromB64(url.searchParams.get("key"));
    return k === null ? [] : [k];
  }
  if (["move", "copy", "folder", "delete", "multipart/complete"].includes(rest)) {
    if (!body) return [];
    // Match the pinned schemas' unknown-field stripping. A copy only reads its source.
    const fields = rest === "move" ? ["oldKey", "newKey"]
      : rest === "copy" ? ["destinationKey"] : ["key"];
    const keys = fields.map((f) => fromB64(body[f]));
    return keys.some((k) => k === null) || keys.length === 0 ? [] : (keys as string[]);
  }
  // POST /api/buckets/:bucket/:key  (metadata edit)
  if (req.method === "POST" && !rest.includes("/")) {
    let k: string | null;
    try {
      k = fromB64(decodeURIComponent(rest));
    } catch {
      k = null;
    }
    return k === null ? [] : [k];
  }
  return [];
}

const JSON_WRITE_ROUTES = ["move", "copy", "folder", "delete", "multipart/complete"];

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
  const jsonRoute = rest !== undefined && (JSON_WRITE_ROUTES.includes(rest) || (!rest.includes("/") && rest !== "upload"));
  if (jsonRoute && !(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return "JSON content type required";
  }
  return null;
}

const explorer = R2Explorer({
  readonly: false,
  // Not using cfAccessTeamName: R2-Explorer's built-in check only covers /api/*,
  // does not verify the AUD, and needs the team name at build time. The wrapper
  // below validates every request instead.
  showHiddenFiles: false,
});

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
    } catch (e) {
      console.error("access verification error", (e as Error).message);
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

    // Bound controls after auth/CSRF, before any helper or Explorer reads a body.
    let body: Record<string, unknown> | undefined;
    let delegated = request;
    try {
      checkQuery(url);
      const route = controlRoute(request.method, url);
      if (route) {
        const bytes = await readControl(request);
        body = parseControl(bytes);
        checkControl(route, body);
        delegated = replayControl(request, bytes);
      }
      const binaryRoute = request.method === "POST"
        && /^\/api\/buckets\/[^/]+\/(upload|multipart\/(create|upload))$/.test(url.pathname);
      if (binaryRoute) {
        if (fromB64(url.searchParams.get("key")) === null) throw new ControlError(400);
        if (url.pathname.endsWith("/multipart/upload")) {
          const id = url.searchParams.get("uploadId");
          const part = url.searchParams.get("partNumber");
          if (id === null || new TextEncoder().encode(id).byteLength > CONTROL_LIMITS.uploadIdBytes
            || part === null || !/^\d+$/.test(part) || Number(part) < 1
            || Number(part) > CONTROL_LIMITS.parts) throw new ControlError(400);
        }
      }
      if (route === "metadata") {
        const key = decodeURIComponent(url.pathname.split("/").pop()!);
        if (fromB64(key) === null) throw new ControlError(400);
      }
    } catch (error) {
      return controlFailure(error instanceof ControlError ? error.status : 500);
    }

    // Keep the console inside the managed prefixes unless explicitly widened.
    const allowed = (env.WRITE_PREFIXES ?? DEFAULT_WRITE_PREFIXES)
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    if (!allowed.includes("*")) {
      const targets = writeTargets(request, url, body);
      if (targets !== null) {
        if (targets.length === 0) return deny(403, "Write target could not be determined");
        const bad = targets.find((k) => !allowed.some((p) => k.startsWith(p)));
        if (bad !== undefined) return deny(403, `Writes outside managed prefixes (${allowed.join(", ")}) are blocked`);
      }
    }

    // R2-Explorer 1.2.0 never serves its dashboard itself (its "/" handler returns 500 and
    // "*" 404s for any path containing a dot). With run_worker_first the asset layer is
    // skipped, so serve static files here, after the checks above.
    if (!url.pathname.startsWith("/api/")) {
      if (request.method !== "GET" && request.method !== "HEAD") return deny(405, "Method not allowed");
      return env.ASSETS.fetch(request);
    }

    return explorer.fetch(delegated, env, ctx);
  },
};
