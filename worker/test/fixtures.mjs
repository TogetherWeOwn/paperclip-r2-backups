import { Readable } from "node:stream";

export const encode = (text) => Buffer.from(text).toString("base64");
export const keyPath = (key) => encodeURIComponent(encode(key));

export function mockBucket() {
  const calls = [];
  const objects = new Map();
  const pending = new Map();
  function details(key, value) {
    const metadata = {
      key, version: "fixture-version", size: value.bytes.length,
      etag: "fixture-etag", httpEtag: '"fixture-etag"',
      uploaded: new Date("2026-11-01T00:00:00.000Z"),
      httpMetadata: value.httpMetadata ?? {}, customMetadata: value.customMetadata ?? {},
      checksums: {}, storageClass: "Standard",
    };
    return {
      ...metadata,
      writeHttpMetadata(headers) {
        const names = { contentType: "content-type", contentLanguage: "content-language", contentDisposition: "content-disposition", contentEncoding: "content-encoding", cacheControl: "cache-control", cacheExpiry: "expires" };
        for (const [name, text] of Object.entries(metadata.httpMetadata)) {
          headers.set(names[name], text instanceof Date ? text.toUTCString() : text);
        }
      },
      toJSON() { return metadata; },
    };
  }
  const bucket = {
    async list(options) {
      calls.push(["list", options]);
      return { objects: [...objects].map(([key, value]) => details(key, value)), truncated: false, delimitedPrefixes: [] };
    },
    async get(key) {
      calls.push(["get", key]);
      const value = objects.get(key);
      if (!value) return null;
      const body = new ReadableStream({ start(controller) { controller.enqueue(Uint8Array.from(value.bytes)); controller.close(); } });
      return { ...details(key, value), body };
    },
    async head(key) {
      calls.push(["head", key]);
      return objects.has(key) ? details(key, objects.get(key)) : null;
    },
    async put(key, body, options = {}) {
      calls.push(["put", key, body, options]);
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      const value = { bytes, ...options };
      objects.set(key, value);
      return details(key, value);
    },
    async delete(key) { calls.push(["delete", key]); objects.delete(key); },
    async createMultipartUpload(key, options = {}) {
      calls.push(["create", key, options]);
      const uploadId = "fixture-upload";
      pending.set(uploadId, { key, options, parts: new Map() });
      return { key, uploadId };
    },
    resumeMultipartUpload(key, uploadId) {
      calls.push(["resume", key, uploadId]);
      return {
        async uploadPart(partNumber, body) {
          calls.push(["part", partNumber, body]);
          const bytes = new Uint8Array(await new Response(body).arrayBuffer());
          pending.get(uploadId)?.parts.set(partNumber, bytes);
          return { partNumber, etag: `part-${partNumber}` };
        },
        async complete(parts) {
          calls.push(["complete", parts]);
          const upload = pending.get(uploadId);
          const value = { bytes: Uint8Array.from(parts.flatMap((part) => [...(upload?.parts.get(part.partNumber) ?? [])])), ...upload?.options };
          objects.set(key, value);
          return details(key, value);
        },
      };
    },
  };
  return { bucket, calls, objects, pending };
}

export function request(path, { method = "GET", body, headers = {}, raw } = {}) {
  return new Request(`https://console.test${path}`, {
    method,
    headers: { origin: "https://console.test", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : raw !== undefined ? { body: raw, duplex: "half" } : {}),
  });
}

export async function signedAccess(team = "fixture-team") {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = { ...await crypto.subtle.exportKey("jwk", pair.publicKey), kid: "fixture-key", alg: "RS256" };
  async function token(claims = {}, header = {}) {
    const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${part({ alg: "RS256", kid: jwk.kid, ...header })}.${part({ iss: `https://${team}.cloudflareaccess.com`, aud: "fixture-aud", exp: Math.floor(Date.now() / 1000) + 600, ...claims })}`;
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(unsigned));
    return `${unsigned}.${Buffer.from(signature).toString("base64url")}`;
  }
  return { team, jwk, token };
}

export function nodeRequest(incoming, origin, headers = {}) {
  const method = incoming.method;
  return new Request(new URL(incoming.url, origin), {
    method, headers: { ...incoming.headers, ...headers },
    ...(!["GET", "HEAD"].includes(method) ? { body: Readable.toWeb(incoming), duplex: "half" } : {}),
  });
}
