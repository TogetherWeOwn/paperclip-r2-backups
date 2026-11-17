import { ControlError } from "./control-headers.ts";
import type { ControlRoute } from "./control-validation.ts";

export const QUERY_LIMITS = Object.freeze({ queryBytes: 8192, includes: 16, includeBytes: 64 });
export type ControlUrl = Pick<URL, "origin" | "pathname" | "search" | "searchParams">;

const utf8 = new TextEncoder();
const boundedString = (value: string, bytes: number): boolean =>
  value.length <= bytes && utf8.encode(value).byteLength <= bytes;
function invalid(): never {
  throw new ControlError(400);
}

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
  const rest = url.pathname.match(/^\/api\/buckets\/[^/]+\/([\s\S]+)$/)?.[1];
  if (!rest || ["upload", "multipart/create", "multipart/upload"].includes(rest)) return null;
  if (["move", "copy", "folder", "delete", "multipart/complete"].includes(rest)) return rest as ControlRoute;
  return rest.includes("/") ? null : "metadata";
}

/** Chanfana 2.8.3 represents arrays as repeated names, not CSV or packed JSON. */
export function checkQuery(url: ControlUrl): void {
  if (!url.pathname.startsWith("/api/")) return;
  const query = url.search.slice(1);
  if (!boundedString(query, QUERY_LIMITS.queryBytes)) invalid();
  let includes = 0;
  for (const [name, value] of url.searchParams) {
    if (name !== "include") continue;
    if (++includes > QUERY_LIMITS.includes || !boundedString(value, QUERY_LIMITS.includeBytes)) invalid();
    if (value !== "httpMetadata" && value !== "customMetadata") invalid();
  }
}
