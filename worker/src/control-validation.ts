import { ControlError } from "./control-headers.ts";

export const VALIDATION_LIMITS = Object.freeze({
  parts: 10_000,
  etagBytes: 256,
  keyBytes: 1024,
  encodedKeyBytes: 4096,
  uploadIdBytes: 2048,
});

type ControlObject = Record<string, unknown>;
export type ControlRoute = "move" | "copy" | "folder" | "delete" | "multipart/complete" | "metadata";

const utf8 = new TextEncoder();
const record = (value: unknown): value is ControlObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const boundedString = (value: unknown, bytes: number): value is string =>
  typeof value === "string" && value.length <= bytes && utf8.encode(value).byteLength <= bytes;
function invalid(): never {
  throw new ControlError(400);
}

export function decodedKey(value: unknown): string | null {
  if (!boundedString(value, VALIDATION_LIMITS.encodedKeyBytes) || !value) return null;
  try {
    const key = decodeURIComponent(escape(atob(value)));
    return boundedString(key, VALIDATION_LIMITS.keyBytes) ? key : null;
  } catch {
    return null;
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
    if (!key.endsWith("/") && !boundedString(key, VALIDATION_LIMITS.keyBytes - 1)) invalid();
  }
  if (route === "multipart/complete") {
    const parts = body.parts;
    if (!Array.isArray(parts) || parts.length < 1 || parts.length > VALIDATION_LIMITS.parts) invalid();
    if (!boundedString(body.uploadId, VALIDATION_LIMITS.uploadIdBytes)) invalid();
    for (const part of parts) {
      if (!record(part) || !boundedString(part.etag, VALIDATION_LIMITS.etagBytes)
        || !Number.isInteger(part.partNumber) || (part.partNumber as number) < 1
        || (part.partNumber as number) > VALIDATION_LIMITS.parts) invalid();
    }
  }
  if (route === "metadata") {
    // The pinned schemas are record(string, any): nested values are not recursively validated.
    if (!record(body.customMetadata) || !record(body.httpMetadata)) invalid();
  }
}
