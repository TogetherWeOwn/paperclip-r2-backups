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

const TRUSTED_SCRIPTS: Record<string, { bytes: number; hash: string }> = {
  "/assets/AuthLayout.preview-layout-v1.js": { bytes: 355, hash: "965abc58b409dbcce7bbf379d351683bc135212869b03d6ee4a30316622157bc" },
  "/assets/EmailFilePage.preview-layout-v1.js": { bytes: 6145, hash: "e1bcb6b9f1e4f047f8cddce23de73bf088c237763e04954882fec56f2de9d987" },
  "/assets/ErrorNotFound.preview-layout-v1.js": { bytes: 575, hash: "88ea1c11be8ed30754b6859d52b42abc9b2739dffb86f3ebec8bd4c10fd531d9" },
  "/assets/LoginPage.preview-layout-v1.js": { bytes: 2587, hash: "ee4271e4ba77964294ac9def9c226c464ad9deaad4d273a83ea08b3be437023e" },
  "/assets/auth-store.preview-layout-v1.js": { bytes: 994, hash: "75887c31945e1e207d38291cc689f9e5a5ecb33e0c61b9dccf702be6254708f4" },
  "/assets/auth.preview-layout-v1.js": { bytes: 309, hash: "26106da4b611192ad70b9cadc6e428a79aad92e1ce65984891f6a575ec6d020b" },
  "/assets/bus.preview-layout-v1.js": { bytes: 727, hash: "060e6e6e86af12498ad8ef2dc8be8b46dc38a5ec3f74f3e41742602c64e2cc75" },
  "/assets/index.preview-layout-v1.js": { bytes: 1652251, hash: "650443fd1fde07831d40ab52e269854b18c2d0d31a64e47a7c9a28e14c07b31c" },
};
// Original scripts remain verifiable provenance URLs, never executable policy sources.
const ORIGINAL_SCRIPTS: Record<string, { bytes: number; hash: string }> = {
  "AuthLayout.db6e752c.js": { bytes: 346, hash: "b5f5eaf25dfc166fd82988fb3fec42e696f94bde28bfe201e4943a5de92e97c1" },
  "EmailFilePage.8578c819.js": { bytes: 6136, hash: "59cf080d0ffae848aba35c72610c591db7feed35db911c71990ebb80a048a26d" },
  "ErrorNotFound.1cad377e.js": { bytes: 566, hash: "2cad3eb1bb505fd24405b5625f90745637fcebbf4f9bd76614b85fab9dbcee35" },
  "LoginPage.c1ee667f.js": { bytes: 2569, hash: "74d14c5c727b0ccffabc4baf31b1cdde735ce5f8be2cf5c539ed0ff67aa46650" },
  "auth-store.ba1aa298.js": { bytes: 985, hash: "3f62e5696ed8b8ea7a69a42ddbe5111132bab679d055d3f2fbbc3be94c802586" },
  "auth.315647f3.js": { bytes: 291, hash: "7d536eb488ce6623303a61a2f897ec4f7164f795b20abbdfcfd3aee62d0d707b" },
  "bus.2c308485.js": { bytes: 718, hash: "6048f86039d9eb6c10e93193dfbc2ea7c551c033ecd64989c127af5be70eeb3f" },
  "index.97b9144c.js": { bytes: 1651880, hash: "4ae881a8bbe7b75a9880279f2bd224d135cb854aca8d61586323711c57fbdaaa" },
};
const LEGACY_SCRIPTS = Object.fromEntries(["/assets/", "/spa/assets/"].flatMap((prefix) => Object.entries(ORIGINAL_SCRIPTS).map(([name, pin]) => [prefix + name, pin])));
const SCRIPT_PATHS = Object.keys(TRUSTED_SCRIPTS);
const DOCUMENT_PATH = "/preview-layout-v1/";
const DOCUMENT_PIN = { bytes: 2318, hash: "2a356c67a20ba6174a2c7a04f00e7e2ca2cbaa6faa749181c0a8cac6232055a6" };
const ORIGINAL_DOCUMENT_PIN = { bytes: 2309, hash: "8134e3d37c08aaf1817a67b2d08d827823d2e3b4027ff6f011f5934ca4ae709a" };
const NAVIGATION_POLICY = "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; sandbox allow-downloads";

function documentPolicy(origin: string): string {
  return "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; script-src " +
    SCRIPT_PATHS.map((path) => origin + path).join(" ") + " 'sha256-ivd6tHqEA4mIbBgQ80xHC/HM2TD8VhP3tLA5jLgSI+0='; " +
    "script-src-attr 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' data:; media-src blob:; connect-src 'self' blob:; worker-src 'none'; frame-src 'self'";
}

function fullAssetRequest(request: Request, target: string): Request {
  const headers = new Headers(request.headers);
  for (const name of ["if-none-match", "if-modified-since", "if-match", "if-unmodified-since", "if-range", "range"]) headers.delete(name);
  return new Request(target, { method: "GET", headers, redirect: "manual" });
}

async function matchesAsset(bytes: ArrayBuffer, pin: { bytes: number; hash: string }): Promise<boolean> {
  if (bytes.byteLength !== pin.bytes) return false;
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return hash === pin.hash;
}

const PDF_NOTE_PIN = { bytes: 1083, hash: "f8e7b10e93f771ba1ef3a3c771bcbf59e5a3efe9832bef90baf1dbe9f66e1d07" };
const PDF_NOTE_PATH = "/pdf-note-v1/annotation-note.svg";

function noteFolder(parameter: string): boolean {
  if (!parameter || parameter.length > 4096 || !/^(?:[A-Za-z0-9+=]|%2F)+$/.test(parameter)) return false;
  if (parameter === "IA==") return true; // Shipped client's root sentinel.
  const base64 = parameter.replaceAll("%2F", "/");
  if (base64.length > 1368 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) return false;
  const decodedLength = base64.length / 4 * 3 - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
  if (decodedLength < 1 || decodedLength > 1024) return false;
  try {
    const binary = atob(base64);
    if (!binary.length || binary.length > 1024 || btoa(binary) !== base64 || base64.replaceAll("/", "%2F") !== parameter) return false;
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    const folder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const encoded = new TextEncoder().encode(folder);
    if (encoded.length !== bytes.length || encoded.some((byte, i) => byte !== bytes[i])) return false;
    if (!folder.endsWith("/") || /[\\\\%\u0000-\u001f\u007f]/.test(folder)) return false;
    return folder.slice(0, -1).split("/").every((part) => part !== "" && part !== "." && part !== "..");
  } catch {
    return false;
  }
}

// Classification only: decoding can reject a confused resource identity, never
// select bytes. In particular, %2F inside the folder remains a base64 symbol.
function noteCandidate(path: string): boolean {
  const inFiles = /^\/[^/]+\/files(?:\/|$)/i.test(path);
  let leaf = path.replace(/\/+$/, "").split("/").at(-1) ?? "";
  if (leaf.length > 4096) return true;
  for (let pass = 0; pass < 16 && leaf.includes("%"); pass++) {
    try {
      const decoded = decodeURIComponent(leaf);
      if (decoded === leaf) break;
      leaf = decoded;
    } catch { return true; }
  }
  if (leaf.includes("%")) return true;
  leaf = leaf.split(/[\\\\/]/).filter(Boolean).at(-1)?.toLowerCase() ?? "";
  return leaf.startsWith("annotation-") || (inFiles && leaf.endsWith(".svg"));
}

async function pdfNote(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (/^\/pdf-note-v1(?:\/|$)/i.test(url.pathname)) return deny(404, "Not found");
  if (!noteCandidate(url.pathname)) return null;
  const match = /^\/BACKUPS\/files\/([^/]+)\/annotation-note\.svg$/.exec(url.pathname);
  // URL.search/hash omit bare delimiters. Validate the full serialized identity.
  if (!match || request.url !== url.origin + url.pathname || !noteFolder(match[1])) return deny(404, "Not found");
  const internal = fullAssetRequest(request, url.origin + PDF_NOTE_PATH);
  internal.headers.set("accept", "image/svg+xml");
  internal.headers.set("accept-encoding", "identity");
  let asset: Response;
  try { asset = await env.ASSETS.fetch(internal); } catch { return failure(500); }
  const length = asset.headers.get("content-length");
  if (asset.status !== 200 || asset.headers.has("location") ||
    (asset.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase() !== "image/svg+xml" ||
    ![null, "identity"].includes(asset.headers.get("content-encoding")?.trim().toLowerCase() ?? null) ||
    (length !== null && length !== "1083") || !asset.body) {
    void asset.body?.cancel().catch(() => {});
    return failure(500);
  }
  const reader = asset.body.getReader();
  const bytes = new Uint8Array(1084);
  let size = 0;
  let eof = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Asset deadline")), 10_000); });
  try {
    // Fixed storage, a one-byte overflow sentinel, bounded empty-chunk work and an
    // absolute deadline. A backend Content-Length never substitutes for EOF/hash.
    for (let chunks = 0; chunks < 1085; chunks++) {
      const result = await Promise.race([reader.read(), deadline]);
      if (result.done) { eof = true; break; }
      if (result.value.byteLength > bytes.length - size) return failure(500);
      bytes.set(result.value, size);
      size += result.value.byteLength;
      if (size > PDF_NOTE_PIN.bytes) return failure(500);
    }
    if (!eof || !await matchesAsset(bytes.slice(0, size).buffer, PDF_NOTE_PIN)) return failure(500);
    return new Response(request.method === "HEAD" ? null : bytes.slice(0, size), { headers: {
      "content-type": "image/svg+xml", "content-length": "1083", "cache-control": "no-store", "x-content-type-options": "nosniff",
    } });
  } catch {
    return failure(500);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (!eof) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function selectedDocument(request: Request, env: Env, url: URL): Promise<Response> {
  const asset = await env.ASSETS.fetch(fullAssetRequest(request, url.origin + DOCUMENT_PATH));
  if (asset.status !== 200 || asset.headers.has("location") ||
    (asset.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase() !== "text/html") {
    void asset.body?.cancel().catch(() => {});
    return failure(500);
  }
  const bytes = await asset.arrayBuffer();
  if (!await matchesAsset(bytes, DOCUMENT_PIN)) return failure(500);
  const headers = new Headers(asset.headers);
  headers.set("content-location", DOCUMENT_PATH);
  return new Response(request.method === "HEAD" ? null : bytes, { headers });
}

async function protectedAsset(request: Request, env: Env, url: URL): Promise<Response> {
  // The superseded constructor-only graph is retained on disk as evidence, not
  // served as a stale document alias or a second executable application.
  if (/^\/email-constructor-v1(?:\/|$)/.test(url.pathname) || url.pathname.endsWith(".email-constructor-v1.js")) return deny(404, "Not found");
  const pin = Object.hasOwn(TRUSTED_SCRIPTS, url.pathname) ? TRUSTED_SCRIPTS[url.pathname] :
    Object.hasOwn(LEGACY_SCRIPTS, url.pathname) ? LEGACY_SCRIPTS[url.pathname] : undefined;
  if (pin) {
    // A trusted or legacy identity cannot redirect, become HTML, or reuse partial
    // bytes. The two inventories stay distinct: legacy scripts are not CSP sources.
    const asset = await env.ASSETS.fetch(fullAssetRequest(request, url.origin + url.pathname));
    if (asset.status !== 200 || asset.headers.has("location") ||
      !["text/javascript", "application/javascript"].includes((asset.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase())) {
      void asset.body?.cancel().catch(() => {});
      return failure(500);
    }
    const bytes = await asset.arrayBuffer();
    if (!await matchesAsset(bytes, pin)) return failure(500);
    return new Response(request.method === "HEAD" ? null : bytes, { headers: asset.headers });
  }
  if (["/", "/index.html", "/spa", "/spa/", "/spa/index.html", DOCUMENT_PATH, DOCUMENT_PATH + "index.html"].includes(url.pathname)) {
    return selectedDocument(request, env, url);
  }
  // Discover only genuine, byte-recognized SPA entrypoints. Failed assets and
  // arbitrary HTML are not silently promoted into the selected document.
  const asset = await env.ASSETS.fetch(fullAssetRequest(request, url.origin + url.pathname + url.search));
  if (asset.status !== 200 || asset.headers.has("location") ||
    (asset.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase() !== "text/html") {
    return new Response(request.method === "HEAD" ? null : asset.body, asset);
  }
  const bytes = await asset.arrayBuffer();
  if (await matchesAsset(bytes, ORIGINAL_DOCUMENT_PIN) || await matchesAsset(bytes, DOCUMENT_PIN)) {
    return selectedDocument(request, env, url);
  }
  return new Response(request.method === "HEAD" ? null : bytes, asset);
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
      const note = await pdfNote(request, env, url);
      if (note) {
        if (request.method !== "HEAD") return note;
        void note.body?.cancel().catch(() => {});
        return new Response(null, note);
      }
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
