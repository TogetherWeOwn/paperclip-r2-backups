export const LIMITS = Object.freeze({
  controlBytes: 4_194_304,
  controlTimeoutMs: 10_000,
  parts: 10_000,
  etagBytes: 256,
  keyBytes: 1_024,
  encodedKeyBytes: 4_096,
  uploadIdBytes: 2_048,
  queryBytes: 8_192,
  includes: 16,
  includeBytes: 64,
  encodedMetadataBytes: 4_096,
  metadataJsonBytes: 3_072,
  customEntries: 128,
  customKeyBytes: 128,
  customValueBytes: 2_048,
  customBytes: 8_192,
  httpBytes: 8_192,
  listObjects: 1_000,
});

export class InputError extends Error {
  status: number;

  constructor(status = 400) {
    super("Invalid request");
    this.status = status;
  }
}

export function boundedString(value: unknown, maxBytes: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.length > maxBytes) {
    throw new InputError();
  }
  if (new TextEncoder().encode(value).byteLength > maxBytes) throw new InputError();
  return value;
}

export function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new InputError();
  return value as Record<string, unknown>;
}

/** One absolute deadline, one bounded byte buffer, and one parse; never clone the request. */
export async function readControlJson(
  request: Request,
  limits: { controlBytes: number; controlTimeoutMs: number } = LIMITS,
): Promise<Record<string, unknown>> {
  function rejectUnread(status: number): never {
    if (request.body) void request.body.cancel().catch(() => {});
    throw new InputError(status);
  }
  const encoding = request.headers.get("content-encoding");
  if (encoding !== null && encoding.toLowerCase() !== "identity") rejectUnread(415);
  const length = request.headers.get("content-length");
  if (length !== null) {
    if (!/^\d{1,16}$/.test(length)) rejectUnread(400);
    if (Number(length) > limits.controlBytes) rejectUnread(413);
  }
  if (!request.body) throw new InputError();

  const expiresAt = performance.now() + limits.controlTimeoutMs;
  const reader = request.body.getReader();
  let interrupted = false;
  const timer = setTimeout(() => {
    interrupted = true;
    // Cancelling settles a pending read without awaiting the producer's acknowledgement.
    void reader.cancel().catch(() => {});
  }, limits.controlTimeoutMs);
  let complete = false;
  try {
    // Copy into bounded storage, rather than retaining arbitrarily many tiny/empty chunks.
    let buffer = new Uint8Array(Math.min(16_384, limits.controlBytes));
    let size = 0;
    while (true) {
      // Already-resolved empty reads can starve timer callbacks; check the clock as well.
      if (performance.now() >= expiresAt) throw new InputError(408);
      const { done, value } = await reader.read();
      if (interrupted || performance.now() >= expiresAt) throw new InputError(408);
      if (done) break;
      if (value.byteLength > limits.controlBytes - size) throw new InputError(413);
      const required = size + value.byteLength;
      if (required > buffer.byteLength) {
        const next = new Uint8Array(Math.min(limits.controlBytes, Math.max(required, buffer.byteLength * 2)));
        next.set(buffer.subarray(0, size));
        buffer = next;
      }
      buffer.set(value, size);
      size = required;
    }
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(buffer.subarray(0, size));
    const result = record(JSON.parse(text));
    complete = true;
    return result;
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // Cancellation is initiated but not awaited: a failing source must not extend the deadline.
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function queryFor(requestUrl: string): URLSearchParams {
  const start = requestUrl.indexOf("?");
  const query = start < 0 ? "" : requestUrl.slice(start + 1).split("#", 1)[0];
  boundedString(query, LIMITS.queryBytes, true);
  try {
    decodeURIComponent(query.replace(/\+/g, " "));
  } catch {
    throw new InputError();
  }
  return new URLSearchParams(query);
}

/** Reject repeats on scalar fields; include is the sole repeated-name client contract. */
export function queryValue(query: URLSearchParams, name: string): string | null {
  const values = query.getAll(name);
  if (values.length > 1) throw new InputError();
  return values[0] ?? null;
}

export function decodeBase64(value: unknown, encodedBytes: number, decodedBytes: number): string {
  const encoded = boundedString(value, encodedBytes, true);
  let binary: string;
  try {
    binary = atob(encoded);
  } catch {
    throw new InputError();
  }
  if (binary.length > decodedBytes) throw new InputError();
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0)));
  } catch {
    throw new InputError();
  }
}

export function decodeKey(value: unknown, allowEmpty = false): string {
  const key = decodeBase64(value, LIMITS.encodedKeyBytes, LIMITS.keyBytes);
  if (!allowEmpty && key.length === 0) throw new InputError();
  return key;
}

export function partNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > LIMITS.parts) {
    throw new InputError();
  }
  return value;
}

export function completionParts(value: unknown, maximum = LIMITS.parts): R2UploadedPart[] {
  // The count guard precedes every index, iterator or item property read.
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) throw new InputError();
  const parts: R2UploadedPart[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = record(value[i]);
    parts.push({ etag: boundedString(item.etag, LIMITS.etagBytes), partNumber: partNumber(item.partNumber) });
  }
  return parts;
}

function ownKeys(value: Record<string, unknown>, maximum: number): string[] {
  const keys: string[] = [];
  // Avoid Object.entries/keys, which materialize an unbounded collection before checking it.
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (keys.length === maximum) throw new InputError();
    keys.push(key);
  }
  return keys;
}

export function customMetadata(value: unknown, maximum = LIMITS.customEntries): Record<string, string> {
  const input = record(value);
  const keys = ownKeys(input, maximum);
  const result: Record<string, string> = Object.create(null);
  let bytes = 0;
  for (const key of keys) {
    boundedString(key, LIMITS.customKeyBytes);
    const item = input[key];
    // R2 dictionary scalar conversions are explicit. Nested objects/arrays never stringify.
    if (item !== null && typeof item !== "string" && typeof item !== "boolean" && !(typeof item === "number" && Number.isFinite(item))) {
      throw new InputError();
    }
    const text = boundedString(String(item), LIMITS.customValueBytes, true);
    bytes += new TextEncoder().encode(key).byteLength + new TextEncoder().encode(text).byteLength;
    if (bytes > LIMITS.customBytes) throw new InputError();
    result[key] = text;
  }
  return result;
}

const HTTP_FIELDS = Object.freeze({
  contentType: 1_024,
  contentLanguage: 256,
  contentDisposition: 2_048,
  contentEncoding: 256,
  cacheControl: 2_048,
  cacheExpiry: 64,
});

export function httpMetadata(value: unknown): R2HTTPMetadata {
  const input = record(value);
  const keys = ownKeys(input, 6);
  const result: R2HTTPMetadata = {};
  let bytes = 0;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(HTTP_FIELDS, key)) throw new InputError();
    const name = key as keyof typeof HTTP_FIELDS;
    const item = input[name];
    if (name === "cacheExpiry") {
      // JSON Date.toJSON() emits ISO text; native Date values are supported by direct fixtures.
      if (item instanceof Date && !Number.isFinite(item.getTime())) throw new InputError();
      const text = item instanceof Date ? item.toISOString() : boundedString(item, HTTP_FIELDS.cacheExpiry);
      const date = new Date(text);
      if (!Number.isFinite(date.getTime())) throw new InputError();
      result.cacheExpiry = date;
      bytes += text.length;
    } else {
      const text = boundedString(item, HTTP_FIELDS[name], true);
      if (/[\r\n\0]/.test(text)) throw new InputError();
      result[name] = text;
      bytes += new TextEncoder().encode(text).byteLength;
    }
    bytes += key.length;
    if (bytes > LIMITS.httpBytes) throw new InputError();
  }
  return result;
}

