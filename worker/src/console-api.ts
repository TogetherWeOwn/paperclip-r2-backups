import {
  LIMITS, InputError, boundedString, completionParts, customMetadata, decodeBase64, decodeKey,
  httpMetadata, queryFor, queryValue, readControlJson,
} from "./control-limits.ts";

export interface ConsoleEnv {
  BACKUPS: R2Bucket;
}

export const ADAPTER_VERSION = "backup-console-api-v1";
export const DASHBOARD_VERSION = "1.2.0";

export function failure(status: number): Response {
  // Fixed messages only; neither input nor platform errors enter a failure envelope.
  const msg = status === 404 ? "Object Not Found" : status === 405 ? "Method not allowed" :
    status === 403 ? "Forbidden" : status === 413 ? "Request too large" :
    status === 408 ? "Request timed out" : status === 415 ? "Unsupported encoding" :
    status === 500 ? "Internal server error" : "Invalid request";
  return Response.json({ msg }, { status, headers: { "cache-control": "no-store" } });
}

const json = (value: unknown) => Response.json(value, { headers: { "cache-control": "no-store" } });

function checkQuery(query: URLSearchParams, allowed: readonly string[]): void {
  for (const name of query.keys()) {
    if (!allowed.includes(name)) throw new InputError();
  }
}

function integerQuery(value: string, maximum: number): number {
  if (!/^\d{1,5}$/.test(value)) throw new InputError();
  const number = Number(value);
  if (number < 1 || number > maximum) throw new InputError();
  return number;
}

function writable(keys: string[], prefixes: readonly string[]): void {
  if (!keys.every((key) => prefixes.includes("*") || prefixes.some((prefix) => key.startsWith(prefix)))) {
    throw new InputError(403);
  }
}

function metadata(custom: unknown, http: unknown): R2PutOptions {
  const customValues = custom === undefined ? undefined : customMetadata(custom);
  const httpValues = http === undefined ? undefined : httpMetadata(http);
  // R2's documented total object metadata limit is shared by the two records.
  let total = 0;
  for (const [key, value] of Object.entries(customValues ?? {})) {
    total += new TextEncoder().encode(key + value).byteLength;
  }
  for (const [key, value] of Object.entries(httpValues ?? {})) {
    total += new TextEncoder().encode(key + (value instanceof Date ? value.toISOString() : value)).byteLength;
  }
  if (total > LIMITS.customBytes) throw new InputError();
  return { customMetadata: customValues, httpMetadata: httpValues };
}

function metadataQuery(query: URLSearchParams): R2PutOptions {
  function parse(name: string): unknown {
    const encoded = queryValue(query, name);
    if (!encoded) return undefined;
    const text = decodeBase64(encoded, LIMITS.encodedMetadataBytes, LIMITS.metadataJsonBytes);
    try {
      return JSON.parse(text);
    } catch {
      throw new InputError();
    }
  }
  return metadata(parse("customMetadata"), parse("httpMetadata"));
}

function listOptions(query: URLSearchParams): R2ListOptions {
  checkQuery(query, ["limit", "prefix", "cursor", "delimiter", "startAfter", "include"]);
  const includes = query.getAll("include");
  if (includes.length > LIMITS.includes) throw new InputError();
  const include: ("customMetadata" | "httpMetadata")[] = [];
  for (const item of includes) {
    boundedString(item, LIMITS.includeBytes);
    if (item !== "customMetadata" && item !== "httpMetadata") throw new InputError();
    include.push(item);
  }
  const limit = queryValue(query, "limit");
  const prefix = queryValue(query, "prefix");
  const cursor = queryValue(query, "cursor");
  const delimiter = queryValue(query, "delimiter");
  const startAfter = queryValue(query, "startAfter");
  return {
    limit: limit === null ? LIMITS.listObjects : integerQuery(limit, LIMITS.listObjects),
    prefix: prefix ? decodeKey(prefix, true) : undefined,
    cursor: cursor ? boundedString(cursor, LIMITS.queryBytes) : undefined,
    delimiter: delimiter ? boundedString(delimiter, LIMITS.keyBytes) : "",
    // Explorer passes startAfter through unchanged; unlike prefix, it is not base64.
    startAfter: startAfter ? boundedString(startAfter, LIMITS.keyBytes) : undefined,
    include: include.length ? include : undefined,
  };
}

const POST_ROUTES = ["move", "copy", "folder", "delete", "upload", "multipart/create", "multipart/upload", "multipart/complete"];

/** Closed dispatch: no env enumeration, generic resolver, recursive operation or parser fallback. */
export async function consoleApi(
  request: Request,
  env: ConsoleEnv,
  prefixes: readonly string[],
  controlLimits: { controlBytes: number; controlTimeoutMs: number } = LIMITS,
): Promise<Response> {
  try {
    const query = queryFor(request.url);
    const path = new URL(request.url).pathname;
    if (path === "/api/server/config") {
      if (request.method !== "GET") return failure(405);
      checkQuery(query, []);
      return json({
        version: ADAPTER_VERSION,
        dashboardVersion: DASHBOARD_VERSION,
        config: { readonly: false, showHiddenFiles: false },
        buckets: [{ name: "BACKUPS", publicUrl: null }],
      });
    }

    const match = /^\/api\/buckets\/BACKUPS(?:\/(.+))?$/.exec(path);
    if (!match) return failure(404);
    const rest = match[1];
    if (rest === undefined) {
      if (request.method !== "GET") return failure(405);
      return json(await env.BACKUPS.list(listOptions(query)));
    }
    if (POST_ROUTES.includes(rest)) {
      if (request.method !== "POST") return failure(405);
      if (rest === "upload" || rest === "multipart/create" || rest === "multipart/upload") {
        checkQuery(query, rest === "multipart/upload" ? ["key", "uploadId", "partNumber"] : ["key", "customMetadata", "httpMetadata"]);
        const key = decodeKey(queryValue(query, "key"));
        const options = rest === "multipart/upload" ? undefined : metadataQuery(query);
        const uploadId = rest === "multipart/upload" ? boundedString(queryValue(query, "uploadId"), LIMITS.uploadIdBytes) : undefined;
        const number = rest === "multipart/upload" ? integerQuery(queryValue(query, "partNumber") ?? "", LIMITS.parts) : undefined;
        writable([key], prefixes);
        if (rest === "multipart/create") return json(await env.BACKUPS.createMultipartUpload(key, options));
        if (rest === "multipart/upload") {
          const upload = env.BACKUPS.resumeMultipartUpload(key, uploadId!);
          return json(await upload.uploadPart(number!, request.body!));
        }
        return json(await env.BACKUPS.put(key, request.body, options));
      }

      checkQuery(query, []);
      const body = await readControlJson(request, controlLimits);
      if (rest === "move" || rest === "copy") {
        const source = decodeKey(rest === "move" ? body.oldKey : body.sourceKey);
        const destination = decodeKey(rest === "move" ? body.newKey : body.destinationKey);
        writable(rest === "move" ? [source, destination] : [destination], prefixes);
        const object = await env.BACKUPS.get(source);
        if (object === null) return failure(404);
        const result = await env.BACKUPS.put(destination, object.body, {
          customMetadata: object.customMetadata, httpMetadata: object.httpMetadata,
        });
        if (rest === "move") await env.BACKUPS.delete(source);
        return json(result);
      }
      const key = decodeKey(body.key);
      if (rest === "multipart/complete") {
        const uploadId = boundedString(body.uploadId, LIMITS.uploadIdBytes);
        const parts = completionParts(body.parts);
        writable([key], prefixes);
        const result = await env.BACKUPS.resumeMultipartUpload(key, uploadId).complete(parts);
        return json({ success: true, str: result });
      }
      if (rest === "folder") {
        const folder = key.endsWith("/") ? key : `${key}/`;
        boundedString(folder, LIMITS.keyBytes);
        writable([folder], prefixes);
        return json(await env.BACKUPS.put(folder, ""));
      }
      writable([key], prefixes);
      await env.BACKUPS.delete(key);
      return json({ success: true });
    }

    // Named route aliases are never reinterpreted as object keys.
    if (rest === "share" || rest === "shares" || rest.endsWith("/")) return failure(404);
    const headAlias = rest.endsWith("/head");
    const encodedPath = headAlias ? rest.slice(0, -5) : rest;
    if (encodedPath.includes("/")) return failure(404);
    if (headAlias ? request.method !== "GET" : !["GET", "HEAD", "POST"].includes(request.method)) return failure(405);
    checkQuery(query, []);
    boundedString(encodedPath, LIMITS.encodedKeyBytes);
    let encoded: string;
    try {
      encoded = decodeURIComponent(encodedPath);
    } catch {
      throw new InputError();
    }
    const key = decodeKey(encoded);
    if (headAlias || request.method === "HEAD") {
      const object = await env.BACKUPS.head(key);
      if (object === null) return failure(404);
      const response = json(object);
      return request.method === "HEAD" ? new Response(null, { headers: response.headers }) : response;
    }
    if (request.method === "POST") {
      const body = await readControlJson(request, controlLimits);
      // Both fields are required by the pinned metadata editor contract.
      if (body.customMetadata === undefined || body.httpMetadata === undefined) throw new InputError();
      const options = metadata(body.customMetadata, body.httpMetadata);
      writable([key], prefixes);
      const object = await env.BACKUPS.get(key);
      if (object === null) return failure(404);
      return json(await env.BACKUPS.put(key, object.body, options));
    }
    const object = await env.BACKUPS.get(key);
    if (object === null) return failure(404);
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("content-length", String(object.size));
    const filename = key.split("/").pop() || "download";
    const ascii = filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "'");
    const utf8 = encodeURIComponent(filename).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    headers.set("content-disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`);
    return new Response(object.body, { headers });
  } catch (error) {
    if (error instanceof InputError) return failure(error.status);
    // One constant safe log at most; no platform exception detail or request values.
    console.error("Backup console operation failed");
    return failure(500);
  }
}
