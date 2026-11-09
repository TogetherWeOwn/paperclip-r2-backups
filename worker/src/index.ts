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

const SCRIPT_HASHES: Record<string, string> = {
  "AuthLayout.db6e752c.js": "b5f5eaf25dfc166fd82988fb3fec42e696f94bde28bfe201e4943a5de92e97c1",
  "EmailFilePage.8578c819.js": "59cf080d0ffae848aba35c72610c591db7feed35db911c71990ebb80a048a26d",
  "ErrorNotFound.1cad377e.js": "2cad3eb1bb505fd24405b5625f90745637fcebbf4f9bd76614b85fab9dbcee35",
  "LoginPage.c1ee667f.js": "74d14c5c727b0ccffabc4baf31b1cdde735ce5f8be2cf5c539ed0ff67aa46650",
  "auth-store.ba1aa298.js": "3f62e5696ed8b8ea7a69a42ddbe5111132bab679d055d3f2fbbc3be94c802586",
  "auth.315647f3.js": "7d536eb488ce6623303a61a2f897ec4f7164f795b20abbdfcfd3aee62d0d707b",
  "bus.2c308485.js": "6048f86039d9eb6c10e93193dfbc2ea7c551c033ecd64989c127af5be70eeb3f",
  "index.97b9144c.js": "4ae881a8bbe7b75a9880279f2bd224d135cb854aca8d61586323711c57fbdaaa",
};
const SCRIPT_PATHS = ["/assets/", "/spa/assets/"].flatMap((prefix) => Object.keys(SCRIPT_HASHES).map((name) => prefix + name));
const NAVIGATION_POLICY = "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; sandbox allow-downloads";

function documentPolicy(origin: string): string {
  return "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; script-src " +
    SCRIPT_PATHS.map((path) => origin + path).join(" ") + " 'sha256-ivd6tHqEA4mIbBgQ80xHC/HM2TD8VhP3tLA5jLgSI+0='; " +
    "script-src-attr 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' data:; media-src blob:; connect-src 'self' blob:; worker-src 'none'; frame-src 'self'";
}

async function protectedAsset(request: Request, env: Env, url: URL): Promise<Response> {
  if (!SCRIPT_PATHS.includes(url.pathname)) return env.ASSETS.fetch(request);
  // Never allow a trusted script URL to redirect, become an HTML fallback, or reuse
  // unverified partial/cached bytes. Only these static scripts are buffered, not R2.
  const headers = new Headers(request.headers);
  for (const name of ["if-none-match", "if-modified-since", "if-match", "if-unmodified-since", "if-range", "range"]) headers.delete(name);
  const asset = await env.ASSETS.fetch(new Request(url.origin + url.pathname, { method: "GET", headers, redirect: "manual" }));
  if (asset.status !== 200 || asset.headers.has("location") ||
    !["text/javascript", "application/javascript"].includes((asset.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase())) {
    void asset.body?.cancel().catch(() => {});
    return failure(500);
  }
  const bytes = await asset.arrayBuffer();
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (hash !== SCRIPT_HASHES[url.pathname.slice(url.pathname.lastIndexOf("/") + 1)]) return failure(500);
  return new Response(request.method === "HEAD" ? null : bytes, { headers: asset.headers });
}

const handler = {
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
      return await protectedAsset(request, env, url);
    } catch {
      console.error("Backup console assets unavailable");
      return failure(500);
    }
  },
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // The URL's effective origin is platform-controlled, never an arbitrary Host,
    // forwarded header, object key or metadata value. HTTP is fixture-loopback only.
    const validOrigin = url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname));
    const api = url.pathname === "/api" || url.pathname.startsWith("/api/");
    const response = validOrigin ? await handler.fetch(request, env, ctx) : deny(500, "Invalid console origin");
    const headers = new Headers(response.headers);
    headers.set("content-security-policy", api || !validOrigin ? NAVIGATION_POLICY : documentPolicy(url.origin));
    headers.set("x-content-type-options", "nosniff");
    // Revalidation cannot resurrect HTML without this response policy.
    if (!api) headers.set("cache-control", "no-store");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
};
