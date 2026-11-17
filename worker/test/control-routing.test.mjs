import { test } from "node:test";
import assert from "node:assert/strict";
import { ControlError } from "../src/control-headers.ts";
import { QUERY_LIMITS, checkQuery, controlRoute, controlUrl } from "../src/control-routing.ts";

const rejected = (error) => error instanceof ControlError && error.status === 400;
const base = "https://console.example/api/buckets/BACKUPS/";

test("normalization preserves router encodings and rejects malformed paths", () => {
  const url = controlUrl("https://console.example/%61pi/%62uckets/BACKUPS/%66older?include=httpMetadata");
  assert.equal(url.pathname, "/api/buckets/BACKUPS/folder");
  assert.equal(url.searchParams.get("include"), "httpMetadata");
  assert.equal(controlRoute("POST", url), "folder");
  for (const segment of ["a%2Fb%2Bc%3D", "a%252Fb", "%25ZZ"]) {
    assert.equal(controlUrl(base + segment).pathname, `/api/buckets/BACKUPS/${segment}`);
  }
  for (const segment of ["%ZZ", "%E0%A4%A", "%FF"]) {
    assert.throws(() => controlUrl(base + segment), rejected);
  }
});

test("only exact POST controls are classified; streams and aliases remain excluded", () => {
  for (const route of ["move", "copy", "folder", "delete", "multipart/complete"]) {
    assert.equal(controlRoute("POST", controlUrl(base + route)), route);
  }
  for (const route of ["upload", "multipart/create", "multipart/upload", "multipart/complete/", "folder/", "a/b"]) {
    assert.equal(controlRoute("POST", controlUrl(base + route)), null);
  }
  assert.equal(controlRoute("POST", controlUrl(base + "multipart%2Fcomplete")), "metadata");
  assert.equal(controlRoute("POST", controlUrl(base + "ZGIvZmlsZQ%3D%3D")), "metadata");
  for (const key of ["ZG%0AIvYQ==", "ZG%0DIvYQ==", "%0A", "%0D"]) {
    assert.equal(controlRoute("POST", controlUrl(base + key)), "metadata");
    assert.equal(controlRoute("GET", controlUrl(base + key)), null);
    assert.equal(controlRoute("POST", controlUrl(base + key + "/extra")), null);
  }
  for (const method of ["GET", "PUT", "PATCH", "DELETE"]) {
    assert.equal(controlRoute(method, controlUrl(base + "folder")), null);
  }
});

test("query limits apply to serialized UTF-8 bytes and repeated names", () => {
  assert.deepEqual(QUERY_LIMITS, { queryBytes: 8192, includes: 16, includeBytes: 64 });
  const url = (q) => controlUrl(`https://console.example/api/buckets/BACKUPS?${q}`);
  checkQuery(url(Array(16).fill("include=httpMetadata").join("&")));
  assert.throws(() => checkQuery(url(Array(17).fill("include=httpMetadata").join("&"))), rejected);
  checkQuery(url("%69nclude=customMetadata&include=httpMetadata"));
  for (const query of ["include=httpMetadata,customMetadata", "include=%5B%22httpMetadata%22%5D", "include=", `include=${"é".repeat(33)}`]) {
    assert.throws(() => checkQuery(url(query)), rejected);
  }
  checkQuery(url(`x=${"a".repeat(8190)}`));
  assert.throws(() => checkQuery(url(`x=${"a".repeat(8191)}`)), rejected);
  checkQuery(url(`x=${"é".repeat(1365)}`));
  assert.throws(() => checkQuery(url(`x=${"é".repeat(1366)}`)), rejected);
  checkQuery(controlUrl(`https://console.example/assets?x=${"a".repeat(8192)}`));
});
