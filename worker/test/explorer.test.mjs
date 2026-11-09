import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { env, encode, certsFetch, request, path } from "./fixtures.mjs";

globalThis.fetch = certsFetch();
const run = (req, BACKUPS) => worker.fetch(req, { ...env, BACKUPS }, {});
const noR2 = new Proxy({}, { get() { assert.fail("unexpected R2 access"); } });

test("pinned Explorer accepts valid completion and strips only unknown fields", async () => {
  const parts = [{ etag: '"second opaque"', partNumber: 2, extra: 1 }, { etag: "first opaque", partNumber: 1 }];
  const calls = [];
  const bucket = {
    resumeMultipartUpload(key, id) {
      calls.push([key, id]);
      return { async complete(actual) { calls.push(actual); return { key }; } };
    },
  };
  const response = await run(request(path("multipart/complete"), {
    body: { key: encode("db/☃"), uploadId: "fixture-upload", parts, unknown: "stripped" },
  }), bucket);
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [["db/☃", "fixture-upload"], [{ etag: '"second opaque"', partNumber: 2 }, { etag: "first opaque", partNumber: 1 }]]);
  assert.equal((await response.json()).success, true);
});

test("pinned Explorer metadata records and list-query representation stay compatible", async () => {
  const calls = [];
  const bucket = {
    async get(key) { calls.push(["get", key]); return { body: "fixture" }; },
    async put(key, body, options) { calls.push(["put", key, body, options]); return { key }; },
    async list(options) { calls.push(["list", options]); return { objects: [], truncated: false }; },
  };
  const metadata = { customMetadata: { label: "☃", nested: { fixture: [1, 2] } }, httpMetadata: { contentType: "text/plain" } };
  const response = await run(request(path(encodeURIComponent(encode("db/file"))), { body: metadata }), bucket);
  assert.equal(response.status, 200);
  assert.deepEqual(calls[1], ["put", "db/file", "fixture", metadata]);
  const list = await run(request("/api/buckets/BACKUPS?include=httpMetadata&include=customMetadata&limit=1&prefix=" + encodeURIComponent(encode("db/")), { method: "GET" }), bucket);
  assert.equal(list.status, 200);
  assert.deepEqual(calls[2][1].include, ["httpMetadata", "customMetadata"]);
  assert.equal(calls[2][1].prefix, "db/");
  assert.equal(calls[2][1].limit, 1);
});

test("pinned Explorer multipart create/upload and object upload retain streams", async () => {
  const calls = [];
  const bucket = {
    async createMultipartUpload(key, options) { calls.push(["create", key, options]); return { key, uploadId: "upload" }; },
    resumeMultipartUpload(key, id) { return { async uploadPart(number, stream) {
      calls.push(["part", key, id, number, await new Response(stream).text()]); return { etag: "opaque", partNumber: number };
    } }; },
    async put(key, stream, options) { calls.push(["put", key, await new Response(stream).text(), options]); return { key }; },
  };
  const metadata = encode(JSON.stringify({ contentType: "text/plain" }));
  const query = `?key=${encodeURIComponent(encode("db/file"))}&httpMetadata=${encodeURIComponent(metadata)}`;
  assert.equal((await run(request(path("multipart/create") + query), bucket)).status, 200);
  assert.equal((await run(request(path("multipart/upload") + query + "&uploadId=upload&partNumber=2", { body: "part data", headers: { "content-type": "multipart/form-data" } }), bucket)).status, 200);
  assert.equal((await run(request(path("upload") + query, { body: "object data", headers: { "content-type": "multipart/form-data" } }), bucket)).status, 200);
  assert.deepEqual(calls[0], ["create", "db/file", { httpMetadata: { contentType: "text/plain" }, customMetadata: undefined }]);
  assert.deepEqual(calls[1], ["part", "db/file", "upload", 2, "part data"]);
  assert.equal(calls[2][2], "object data");
});

test("pinned Explorer preserves copy authorization and service error semantics", async () => {
  const calls = [];
  const bucket = {
    async get(key) { calls.push(["get", key]); return { body: "fixture", customMetadata: {}, httpMetadata: {} }; },
    async put(key) { calls.push(["put", key]); return { key }; },
    resumeMultipartUpload() { return { async complete() { throw new Error("fixture upload unavailable"); } }; },
  };
  const copy = await run(request(path("copy"), { body: { sourceKey: encode("outside/source"), destinationKey: encode("db/destination") } }), bucket);
  assert.equal(copy.status, 200);
  assert.deepEqual(calls, [["get", "outside/source"], ["put", "db/destination"]]);
  const completion = await run(request(path("multipart/complete"), {
    body: { key: encode("db/file"), uploadId: "upload", parts: [{ etag: "opaque", partNumber: 1 }] },
  }), bucket);
  assert.equal(completion.status, 400);
  assert.deepEqual(await completion.json(), { msg: "fixture upload unavailable" });
});

test("route aliases, methods and malformed controls cannot bypass the wrapper", async () => {
  for (const route of ["multipart/complete", "multipart/complete/", "multipart%2Fcomplete", "%6dove", "folder/"]) {
    const response = await run(request(path(route), { body: "null" }), noR2);
    assert.ok(response.status >= 400);
  }
  for (const method of ["PUT", "PATCH", "DELETE"]) {
    const response = await run(request(path("multipart/complete"), { method, body: {} }), noR2);
    assert.ok(response.status >= 400);
  }
  const response = await run(request(path("multipart/complete"), { body: {
    key: encode("db/file"), uploadId: "upload", parts: [null],
  } }), noR2);
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("cache-control"), "no-store");
});
