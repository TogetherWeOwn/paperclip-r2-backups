import assert from "node:assert/strict";
import { test } from "node:test";
import { consoleApi, ADAPTER_VERSION } from "../src/console-api.ts";
import { encode, keyPath, mockBucket, request } from "./fixtures.mjs";

const base = "/api/buckets/BACKUPS";
const prefixes = ["db/", "instance/", "status/"];
function fixture() {
  const state = mockBucket();
  return { ...state, send: (req, allowed = prefixes, limits) => consoleApi(req, { BACKUPS: state.bucket }, allowed, limits) };
}
const post = (path, body, headers) => request(path, { method: "POST", body, headers });
const seed = (state, key = "db/source") => state.objects.set(key, { bytes: new TextEncoder().encode("streamed data"), customMetadata: { owner: "fixture" }, httpMetadata: { contentType: "text/plain", cacheControl: "max-age=30" } });

async function rejected(state, req, status = 400, allowed = prefixes, limits) {
  const response = await state.send(req, allowed, limits);
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.ok(Buffer.byteLength(await response.text()) <= 1024);
  assert.deepEqual(state.calls, []);
}

test("config exposes only the intended bucket and distinct adapter/dashboard identity", async () => {
  const state = fixture();
  const response = await state.send(request("/api/server/config"));
  assert.deepEqual(await response.json(), { version: ADAPTER_VERSION, dashboardVersion: "1.2.0", config: { readonly: false, showHiddenFiles: false }, buckets: [{ name: "BACKUPS", publicUrl: null }] });
  assert.deepEqual(state.calls, []);
});

test("list preserves repeated include, pagination, prefix decode and raw startAfter", async () => {
  const state = fixture();
  seed(state);
  const response = await state.send(request(`${base}?include=customMetadata&include=httpMetadata&prefix=${encode("db/")}&cursor=next&delimiter=/&startAfter=db/previous&limit=42`));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).objects[0].key, "db/source");
  assert.deepEqual(state.calls[0], ["list", { include: ["customMetadata", "httpMetadata"], prefix: "db/", cursor: "next", delimiter: "/", startAfter: "db/previous", limit: 42 }]);
  state.calls.length = 0;
  await state.send(request(base));
  assert.equal(state.calls[0][1].limit, 1000);
  assert.equal(state.calls[0][1].delimiter, "");
});

test("list bounds repeats and individual query values before R2 calls", async () => {
  for (const query of ["limit=0", "limit=1001", "limit=1.1", "limit=2&limit=3", "include=customMetadata,httpMetadata", "include=unknown", "include=" + "x".repeat(65), Array(17).fill("include=httpMetadata").join("&"), "unknown=x", "prefix=%FF", "x=" + "a".repeat(8192)]) {
    await rejected(fixture(), request(`${base}?${query}`));
  }
  for (const count of [15, 16]) {
    const state = fixture();
    assert.equal((await state.send(request(`${base}?${Array(count).fill("include=httpMetadata").join("&")}`))).status, 200);
  }
});

test("move checks both write targets; copy checks only its destination and preserves metadata streams", async () => {
  for (const operation of ["move", "copy"]) {
    const state = fixture();
    const source = operation === "copy" ? "outside/source" : "db/source";
    seed(state, source);
    let stream;
    const get = state.bucket.get;
    state.bucket.get = async (key) => { const object = await get(key); stream = object.body; return object; };
    const body = operation === "move" ? { oldKey: encode(source), newKey: encode("db/dest"), ignored: "stripped" } : { sourceKey: encode(source), destinationKey: encode("db/dest") };
    const response = await state.send(post(`${base}/${operation}`, body));
    assert.equal(response.status, 200);
    const put = state.calls.find(([name]) => name === "put");
    assert.equal(put[2], stream);
    assert.deepEqual(put[3], { customMetadata: { owner: "fixture" }, httpMetadata: { contentType: "text/plain", cacheControl: "max-age=30" } });
    assert.equal(state.calls.some(([name]) => name === "delete"), operation === "move");
    assert.equal(new TextDecoder().decode(state.objects.get("db/dest").bytes), "streamed data");
  }
  await rejected(fixture(), post(`${base}/move`, { oldKey: encode("outside/source"), newKey: encode("db/dest") }), 403);
  await rejected(fixture(), post(`${base}/copy`, { sourceKey: encode("db/source"), destinationKey: encode("outside/dest") }), 403);
});

test("unchanged rename rejects without reading, rewriting or deleting the original", async () => {
  const state = fixture();
  seed(state);
  const original = state.objects.get("db/source");
  await rejected(state, post(`${base}/move`, { oldKey: encode("db/source"), newKey: encode("db/source") }));
  assert.equal(state.objects.get("db/source"), original);
});

test("raw and escaped base64 slash paths preserve key identity for object operations", async () => {
  for (const key of ["db/???.txt", "db/???", "db/??????"]) {
    assert.ok(encode(key).includes("/"));
    for (const path of [encode(key), keyPath(key)]) {
      const state = fixture();
      seed(state, key);
      assert.equal(await (await state.send(request(`${base}/${path}`))).text(), "streamed data");
      assert.equal((await (await state.send(request(`${base}/${path}/head`))).json()).key, key);
      assert.equal((await state.send(request(`${base}/${path}`, { method: "HEAD" }))).status, 200);
      assert.equal((await state.send(post(`${base}/${path}`, { customMetadata: { edited: true }, httpMetadata: {} }))).status, 200);
      assert.ok(state.calls.every(([, target]) => target === key));
    }
  }
});

test("leading BOM remains part of key identity for reads, writes and prefix checks", async () => {
  const state = fixture();
  seed(state);
  const key = String.fromCodePoint(0xfeff) + "db/source";
  state.objects.set(key, { bytes: new TextEncoder().encode("BOM object") });
  assert.equal(await (await state.send(request(`${base}/${keyPath(key)}`))).text(), "BOM object");
  state.calls.length = 0;
  await rejected(state, post(`${base}/delete`, { key: encode(key) }), 403);
  await rejected(state, post(`${base}/${keyPath(key)}`, { customMetadata: {}, httpMetadata: {} }), 403);
  assert.equal((await state.send(post(`${base}/delete`, { key: encode(key) }), ["*"])).status, 200);
  assert.deepEqual(state.calls, [["delete", key]]);
  assert.ok(state.objects.has("db/source"));
  assert.ok(!state.objects.has(key));
});

test("folder appends exactly one slash; delete is one object only", async () => {
  for (const key of ["db/folder", "db/folder/"]) {
    const state = fixture();
    assert.equal((await state.send(post(`${base}/folder`, { key: encode(key) }))).status, 200);
    assert.equal(state.calls[0][1], "db/folder/");
  }
  const state = fixture();
  seed(state, "db/folder/child");
  assert.deepEqual(await (await state.send(post(`${base}/delete`, { key: encode("db/folder/") }))).json(), { success: true });
  assert.deepEqual(state.calls, [["delete", "db/folder/"]]);
  assert.ok(state.objects.has("db/folder/child"));
});

test("raw upload streams multipart/form-data bytes verbatim and decodes base64 query metadata", async () => {
  const state = fixture();
  const req = request(`${base}/upload?key=${encode("db/raw")}&httpMetadata=${encode(JSON.stringify({ contentType: "application/octet-stream" }))}&customMetadata=${encode(JSON.stringify({ read: false }))}`, { method: "POST", raw: "not MIME multipart", headers: { "content-type": "multipart/form-data" } });
  const body = req.body;
  const response = await state.send(req);
  assert.equal(response.status, 200);
  assert.equal(state.calls[0][2], body);
  assert.deepEqual({ ...state.calls[0][3], customMetadata: { ...state.calls[0][3].customMetadata } }, { httpMetadata: { contentType: "application/octet-stream" }, customMetadata: { read: "false" } });
  assert.equal(new TextDecoder().decode(state.objects.get("db/raw").bytes), "not MIME multipart");
});

test("multipart create, raw part and opaque ordered completion use pinned shapes", async () => {
  const state = fixture();
  const key = encode("db/multipart");
  const created = await (await state.send(request(`${base}/multipart/create?key=${key}&httpMetadata=${encode(JSON.stringify({ contentType: "text/plain" }))}`, { method: "POST" }))).json();
  assert.deepEqual(created, { key: "db/multipart", uploadId: "fixture-upload" });
  const req = request(`${base}/multipart/upload?key=${key}&uploadId=${created.uploadId}&partNumber=7`, { method: "POST", raw: "raw part", headers: { "content-type": "multipart/form-data" } });
  const stream = req.body;
  const uploaded = await (await state.send(req)).json();
  assert.deepEqual(uploaded, { partNumber: 7, etag: "part-7" });
  assert.equal(state.calls.find(([name]) => name === "part")[2], stream);
  const parts = [{ partNumber: 7, etag: '"opaque"' }, { partNumber: 1, etag: "same" }, { partNumber: 1, etag: "same" }];
  const response = await state.send(post(`${base}/multipart/complete`, { key, uploadId: created.uploadId, parts }));
  const result = await response.json();
  assert.equal(result.success, true);
  assert.equal(result.str.key, "db/multipart");
  assert.deepEqual(state.calls.find(([name]) => name === "complete")[1], parts);
});

test("GET download, HEAD and GET head alias retain metadata and missing semantics", async () => {
  const state = fixture();
  const key = 'db/é "file".txt';
  seed(state, key);
  const download = await state.send(request(`${base}/${keyPath(key)}`));
  assert.equal(download.headers.get("etag"), '"fixture-etag"');
  assert.equal(download.headers.get("content-type"), "text/plain");
  assert.equal(download.headers.get("content-length"), "13");
  assert.match(download.headers.get("content-disposition"), /filename\*=UTF-8''db%2F|filename\*=UTF-8''%C3%A9/);
  assert.equal(await download.text(), "streamed data");
  const head = await state.send(request(`${base}/${keyPath(key)}`, { method: "HEAD" }));
  assert.equal(head.status, 200);
  assert.deepEqual([...head.headers], [...download.headers]);
  assert.equal(await head.text(), "");
  assert.equal(state.calls.filter(([name]) => name === "get").length, 1);
  assert.equal(state.calls.filter(([name]) => name === "head").length, 1);
  const alias = await (await state.send(request(`${base}/${keyPath(key)}/head`))).json();
  assert.equal(alias.key, key);
  assert.deepEqual(alias.customMetadata, { owner: "fixture" });
  for (const suffix of ["", "/head"]) assert.equal((await state.send(request(`${base}/${keyPath("db/missing")}${suffix}`))).status, 404);
});

test("metadata edit keeps stream and supports scalar/date representations", async () => {
  const state = fixture();
  seed(state);
  let stream;
  const get = state.bucket.get;
  state.bucket.get = async (key) => { const object = await get(key); stream = object.body; return object; };
  const iso = "2026-11-01T00:00:00.000Z";
  const response = await state.send(post(`${base}/${keyPath("db/source")}`, { customMetadata: { read: true, count: 4 }, httpMetadata: { contentType: "text/plain", cacheExpiry: iso }, ignored: { unknown: true } }));
  assert.equal(response.status, 200);
  const put = state.calls.find(([name]) => name === "put");
  assert.equal(put[2], stream);
  assert.deepEqual({ ...put[3], customMetadata: { ...put[3].customMetadata } }, { customMetadata: { read: "true", count: "4" }, httpMetadata: { contentType: "text/plain", cacheExpiry: new Date(iso) } });
});

test("invalid metadata and query encodings produce zero R2 operations", async () => {
  for (const body of [
    {}, { customMetadata: {}, httpMetadata: null }, { customMetadata: { a: {} }, httpMetadata: {} },
    { customMetadata: Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`k${i}`, ""])), httpMetadata: {} },
    { customMetadata: {}, httpMetadata: { unknown: "field" } },
    { customMetadata: {}, httpMetadata: { contentType: "x\r\ny" } },
  ]) await rejected(fixture(), post(`${base}/${keyPath("db/key")}`, body));
  for (const query of ["customMetadata=%%", `httpMetadata=${encode("null")}`, `customMetadata=${encode(JSON.stringify({ a: {} }))}`, `httpMetadata=${"x".repeat(4097)}`, `customMetadata=${encode(" ".repeat(3073))}`, "key=another"]) {
    await rejected(fixture(), request(`${base}/upload?key=${encode("db/upload")}&${query}`, { method: "POST", raw: "raw" }));
  }
});

test("wildcard does not bypass bytes, multipart counts, numbers or metadata bounds", async () => {
  await rejected(fixture(), post(`${base}/delete`, { key: encode("anywhere"), extra: "x".repeat(64) }), 413, ["*"], { controlBytes: 16, controlTimeoutMs: 100 });
  for (const parts of [null, {}, [], new Array(10_001).fill(null), [{ partNumber: 0, etag: "x" }], [{ partNumber: 1, etag: "x".repeat(257) }]]) {
    await rejected(fixture(), post(`${base}/multipart/complete`, { key: encode("db/part"), uploadId: "id", parts }), 400, ["*"]);
  }
  await rejected(fixture(), post(`${base}/multipart/complete`, { key: encode("db/part"), uploadId: "x".repeat(2049), parts: [{ partNumber: 1, etag: "x" }] }));
});

test("unknown bindings, methods, trailing slash and nested aliases never reach R2", async () => {
  for (const path of ["/api", "/api/docs", "/api/openapi.json", "/api/buckets/ASSETS", `${base}/`, `${base}/folder/`, `${base}/share`, `${base}/shares`, `${base}/abc/nested`, `${base}/abc/head/`, `${base}/multipart/unknown`]) {
    await rejected(fixture(), request(path), 404);
  }
  for (const method of ["PUT", "DELETE", "OPTIONS", "PATCH"]) await rejected(fixture(), request(base, { method }), 405);
  await rejected(fixture(), request(`${base}/move`), 405);
  await rejected(fixture(), request(`${base}/${keyPath("db/key")}/head`, { method: "POST" }), 405);
});

test("platform failures are generic, no-store and logged once without reflection", async (t) => {
  const state = fixture();
  state.bucket.list = async () => { throw new Error("secret internal token key etag uploadId"); };
  const log = t.mock.method(console, "error", () => {});
  const response = await state.send(request(base));
  assert.equal(response.status, 500);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { msg: "Internal server error" });
  assert.equal(log.mock.callCount(), 1);
  assert.ok(Buffer.byteLength(log.mock.calls[0].arguments.join(" ")) <= 512);
  assert.doesNotMatch(log.mock.calls[0].arguments.join(" "), /secret|token|etag|uploadId/);
});
