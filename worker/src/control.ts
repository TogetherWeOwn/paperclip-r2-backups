export const CONTROL_LIMITS = Object.freeze({
  bytes: 4 * 1024 * 1024,
  milliseconds: 10_000,
  parts: 10_000,
  etagBytes: 256,
  keyBytes: 1024,
  encodedKeyBytes: 4096,
  uploadIdBytes: 2048,
  queryBytes: 8192,
  includes: 16,
  includeBytes: 64,
});

type ControlObject = Record<string, unknown>;
export type ControlRoute = "move" | "copy" | "folder" | "delete" | "multipart/complete" | "metadata";

export class ControlError extends Error {
  readonly status: number;
  constructor(status: number) {
    super("Control request rejected");
    this.status = status;
  }
}

export const controlFailure = (status: number): Response =>
  new Response("Control request rejected", {
    status,
    headers: { "cache-control": "no-store", "content-type": "text/plain" },
  });

const utf8 = new TextEncoder();
const record = (value: unknown): value is ControlObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const boundedString = (value: unknown, bytes: number): value is string =>
  typeof value === "string" && value.length <= bytes && utf8.encode(value).byteLength <= bytes;
function invalid(): never {
  throw new ControlError(400);
}

export function decodedKey(value: unknown): string | null {
  if (!boundedString(value, CONTROL_LIMITS.encodedKeyBytes) || !value) return null;
  try {
    const key = decodeURIComponent(escape(atob(value)));
    return boundedString(key, CONTROL_LIMITS.keyBytes) ? key : null;
  } catch {
    return null;
  }
}

export type ControlUrl = Pick<URL, "origin" | "pathname" | "search" | "searchParams">;

/** Match the pinned router's decodeURI and literal-percent treatment, without URL reserialization. */
export function controlUrl(value: string): ControlUrl {
  const url = new URL(value);
  let pathname: string;
  try {
    pathname = decodeURI(url.pathname.replace(/%25/g, "%2525"));
  } catch {
    return invalid();
  }
  return { origin: url.origin, pathname, search: url.search, searchParams: url.searchParams };
}

/** Exact POST routes in the pinned Explorer. Binary routes never enter the JSON reader. */
export function controlRoute(method: string, url: ControlUrl): ControlRoute | null {
  if (method !== "POST") return null;
  const rest = url.pathname.match(/^\/api\/buckets\/[^/]+\/(.+)$/)?.[1];
  if (!rest || ["upload", "multipart/create", "multipart/upload"].includes(rest)) return null;
  if (["move", "copy", "folder", "delete", "multipart/complete"].includes(rest)) return rest as ControlRoute;
  return rest.includes("/") ? null : "metadata";
}

/** Chanfana 2.8.3 represents arrays as repeated names, not CSV or packed JSON. */
export function checkQuery(url: ControlUrl): void {
  if (!url.pathname.startsWith("/api/")) return;
  const query = url.search.slice(1);
  if (!boundedString(query, CONTROL_LIMITS.queryBytes)) invalid();
  let includes = 0;
  for (const [name, value] of url.searchParams) {
    if (name !== "include") continue;
    if (++includes > CONTROL_LIMITS.includes || !boundedString(value, CONTROL_LIMITS.includeBytes)) invalid();
    if (value !== "httpMetadata" && value !== "customMetadata") invalid();
  }
}

/** Fixed storage: network chunk count does not become retained bookkeeping. */
export async function readControl(
  request: Request,
  limits: { bytes: number; milliseconds: number } = CONTROL_LIMITS,
): Promise<Uint8Array> {
  const cancelBody = () => { void request.body?.cancel().catch(() => {}); };
  const encoding = request.headers.get("content-encoding");
  if (encoding !== null && encoding.trim().toLowerCase() !== "identity") {
    cancelBody();
    throw new ControlError(415);
  }
  const length = request.headers.get("content-length");
  if (length !== null && !/^\d+$/.test(length)) {
    cancelBody();
    invalid();
  }
  if (length !== null && Number(length) > limits.bytes) {
    cancelBody();
    throw new ControlError(413);
  }
  if (!request.body) invalid();
  const reader = request.body.getReader();
  const storage = new Uint8Array(limits.bytes);
  let used = 0;
  let complete = false;
  let interrupted: ControlError | undefined;
  const interrupt = (status: number) => {
    interrupted ??= new ControlError(status);
    // Native cancellation resolves pending read() calls before producer acknowledgement.
    void reader.cancel().catch(() => {});
  };
  const deadline = Date.now() + limits.milliseconds;
  const timer = setTimeout(() => interrupt(408), limits.milliseconds);
  const onAbort = () => interrupt(400);
  request.signal.addEventListener("abort", onAbort, { once: true });
  if (request.signal.aborted) onAbort();
  try {
    for (;;) {
      if (interrupted) throw interrupted;
      if (Date.now() >= deadline) throw new ControlError(408);
      const { done, value } = await reader.read();
      if (interrupted) throw interrupted;
      if (done) {
        complete = true;
        return storage.subarray(0, used);
      }
      if (value.byteLength > limits.bytes - used) throw new ControlError(413);
      storage.set(value, used);
      used += value.byteLength;
    }
  } catch (error) {
    if (error instanceof ControlError) throw error;
    throw new ControlError(400);
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", onAbort);
    // Cancellation may never settle for a broken producer; do not await its acknowledgement.
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function parseControl(bytes: Uint8Array): ControlObject {
  let body: unknown;
  try {
    // Match Request.json(): replacement decoding (and BOM handling), not a new UTF-8 dialect.
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return invalid();
  }
  if (!record(body)) invalid();
  return body;
}

export function checkControl(route: ControlRoute, body: ControlObject): void {
  const fields = route === "move" ? ["oldKey", "newKey"]
    : route === "copy" ? ["sourceKey", "destinationKey"]
    : route === "metadata" ? [] : ["key"];
  for (const field of fields) if (decodedKey(body[field]) === null) invalid();
  if (route === "folder") {
    const key = decodedKey(body.key)!;
    if (!key.endsWith("/") && !boundedString(key, CONTROL_LIMITS.keyBytes - 1)) invalid();
  }
  if (route === "multipart/complete") {
    const parts = body.parts;
    if (!Array.isArray(parts) || parts.length < 1 || parts.length > CONTROL_LIMITS.parts) invalid();
    if (!boundedString(body.uploadId, CONTROL_LIMITS.uploadIdBytes)) invalid();
    for (const part of parts) {
      if (!record(part) || !boundedString(part.etag, CONTROL_LIMITS.etagBytes)
        || !Number.isInteger(part.partNumber) || (part.partNumber as number) < 1
        || (part.partNumber as number) > CONTROL_LIMITS.parts) invalid();
    }
  }
  if (route === "metadata") {
    // The pinned schemas are record(string, any): nested values are not recursively validated.
    if (!record(body.customMetadata) || !record(body.httpMetadata)) invalid();
  }
}

export function replayControl(request: Request, bytes: Uint8Array): Request {
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Request(request.url, {
    method: request.method,
    headers,
    body: bytes,
    redirect: request.redirect,
    signal: request.signal,
  });
}
