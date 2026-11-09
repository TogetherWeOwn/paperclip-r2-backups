import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { env, encode, jwt, token, certsFetch, request, path } from "./fixtures.mjs";
import { CONTROL_LIMITS } from "../src/control.ts";

const delegated = [];
mock.module("r2-explorer", { namedExports: { R2Explorer: () => ({
  async fetch(request) {
    delegated.push(request);
    return new Response("delegated");
  },
}) } });
const { default: worker } = await import("../src/index.ts");
globalThis.fetch = certsFetch();
const run = (req, overrides = {}) => worker.fetch(req, { ...env, ...overrides }, {});
const complete = () => ({ key: encode("db/file"), uploadId: "upload", parts: [{ etag: "opaque", partNumber: 1 }] });

async function denied(req, status, overrides = {}) {
  delegated.length = 0;
  const response = await run(req, overrides);
  assert.equal(response.status, status);
  assert.equal(delegated.length, 0);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.ok(new TextEncoder().encode(await response.text()).length <= 1024);
}

test("authentication and availability fail before application body reads", async () => {
  const unread = (headers = {}) => {
    const req = request(path("folder"), { headers, body: { key: encode("db/file") } });
    req.body.getReader = () => assert.fail("read before authentication gate");
    return req;
  };
  await denied(unread(), 500, { ACCESS_AUD: "" });
  await denied(unread({ "cf-access-jwt-assertion": "" }), 403);
  await denied(unread({ "cf-access-jwt-assertion": "malformed" }), 403);
  for (const claims of [{ iss: "wrong" }, { aud: "wrong" }, { exp: 0 }, { nbf: Math.floor(Date.now() / 1000) + 600 }]) {
    await denied(unread({ "cf-access-jwt-assertion": await jwt(claims) }), 403);
  }
  const signature = token.split(".");
  signature[2] = `${signature[2][0] === "A" ? "B" : "A"}${signature[2].slice(1)}`;
  await denied(unread({ "cf-access-jwt-assertion": signature.join(".") }), 403);
  const previous = globalThis.fetch;
  const consoleError = mock.method(console, "error", () => {});
  globalThis.fetch = async () => { throw new Error("fixture unavailable"); };
  try { await denied(unread(), 503, { ACCESS_TEAM_NAME: "unavailable-team" }); }
  finally { globalThis.fetch = previous; consoleError.mock.restore(); }
});

test("CSRF and disabled routes fail before application body work", async () => {
  for (const headers of [{ origin: "https://other.example" }, { "sec-fetch-site": "cross-site" }, { "content-type": "text/plain" }]) {
    const req = request(path("folder"), { headers, body: {} });
    req.body.getReader = () => assert.fail("read before CSRF gate");
    await denied(req, 403);
  }
  for (const route of ["/share/fixture", "/api/emails/send", path("shares"), path("share/fixture"), path("a/share")]) {
    const req = request(route, { body: {} });
    req.body.getReader = () => assert.fail("disabled route read body");
    await denied(req, 404);
  }
  const response = await run(request("/", { method: "GET" }));
  assert.equal(await response.text(), "fixture asset");
});

test("bounded replay is used under both managed prefixes and wildcard", async () => {
  for (const WRITE_PREFIXES of [undefined, "*"]) {
    delegated.length = 0;
    const original = request(path("multipart/complete"), { body: complete() });
    original.clone = () => assert.fail("original stream was cloned");
    original.json = () => assert.fail("original JSON helper was used");
    assert.equal((await run(original, { WRITE_PREFIXES })).status, 200);
    assert.equal(delegated.length, 1);
    assert.notEqual(delegated[0], original);
    assert.deepEqual(await delegated[0].json(), complete());
    await denied(request(path("multipart/complete"), { body: { ...complete(), parts: [null] } }), 400, { WRITE_PREFIXES });
    await denied(request(path("folder"), { body: "{}", headers: { "content-length": String(CONTROL_LIMITS.bytes + 1) } }), 413, { WRITE_PREFIXES });
  }
});

test("write authorization retains source/destination and unknown-field semantics", async () => {
  const copy = (source, destination) => ({ sourceKey: encode(source), destinationKey: encode(destination), key: "ignored by pinned schema" });
  assert.equal((await run(request(path("copy"), { body: copy("outside/read", "db/write") }))).status, 200);
  await denied(request(path("copy"), { body: copy("db/read", "outside/write") }), 403);
  await denied(request(path("move"), { body: { oldKey: encode("outside/source"), newKey: encode("db/write") } }), 403);
  await denied(request(path("folder"), { body: { key: encode("outside/write") } }), 403);
  await denied(request(path("delete"), { body: { key: "%%%" } }), 400);
  await denied(request(path("unknown/route"), { body: {} }), 403);
  await denied(request(path(encode("outside/write")), { body: { customMetadata: {}, httpMetadata: {} } }), 403);
  assert.equal((await run(request(path("folder"), { body: { key: encode("db/write") }, headers: { origin: "", "sec-fetch-site": "same-origin" } }))).status, 200);
});

test("routing representations share one set of pre-delegation controls", async () => {
  const routes = ["/api/%62uckets/BACKUPS/folder", "/api/buckets/BACKUPS/%66older", "/%61pi/buckets/BACKUPS/folder"];
  for (const route of routes) {
    await denied(request(route, { body: { key: encode("outside/write") } }), 403);
    await denied(request(route, { body: { key: encode("db/write") }, headers: { "content-length": String(CONTROL_LIMITS.bytes + 1) } }), 413, { WRITE_PREFIXES: "*" });
    await denied(request(route, { body: {}, headers: { "content-type": "text/plain" } }), 403);
  }
  for (const route of ["/api/%62uckets/BACKUPS/shares", "/api/buckets/BACKUPS/a/%73hare", "/api/%65mails/send", "/%73hare/fixture"]) {
    await denied(request(route, { body: {} }), 404);
  }
  for (const WRITE_PREFIXES of [undefined, "*"]) {
    await denied(request(path("%ZZ"), { body: { customMetadata: {}, httpMetadata: {} } }), 400, { WRITE_PREFIXES });
  }
});

test("streaming upload/create/part are not mistaken for control JSON", async () => {
  for (const route of ["upload", "multipart/create", "multipart/upload"]) {
    const query = `?key=${encodeURIComponent(encode("db/file"))}&uploadId=upload&partNumber=1`;
    const original = request(path(route) + query, {
      body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); c.close(); } }),
      headers: { "content-type": "multipart/form-data" },
    });
    original.body.getReader = () => assert.fail("binary body read by wrapper");
    delegated.length = 0;
    assert.equal((await run(original)).status, 200);
    assert.equal(delegated[0], original);
  }
});

test("invalid controls and query inputs never delegate or generate rejection logs", async () => {
  const logs = [mock.method(console, "error", () => {}), mock.method(console, "warn", () => {}), mock.method(console, "log", () => {})];
  try {
    for (const body of ["", "null", "[]", "{", { ...complete(), parts: [] }, { ...complete(), parts: [null] }]) {
      await denied(request(path("multipart/complete"), { body }), 400);
    }
    await denied(request("/api/buckets/BACKUPS?" + Array(17).fill("include=httpMetadata").join("&"), { method: "GET" }), 400);
    await denied(request(path(encode("db/file")), { body: { customMetadata: [], httpMetadata: {} } }), 400);
    for (const log of logs) assert.equal(log.mock.callCount(), 0);
  } finally { for (const log of logs) log.mock.restore(); }
});
