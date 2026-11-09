import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../src/index.ts";
import { encode, keyPath, mockBucket, request, signedAccess } from "./fixtures.mjs";

const base = "/api/buckets/BACKUPS";

async function authenticated(t, team) {
  const access = await signedAccess(team);
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.equal(String(url), `https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`);
    return Response.json({ keys: [access.jwk] });
  });
  const token = await access.token();
  const state = mockBucket();
  let assets = 0;
  const env = {
    BACKUPS: state.bucket, ACCESS_TEAM_NAME: team, ACCESS_AUD: "fixture-aud",
    ASSETS: { fetch: async () => { assets++; return new Response("protected snapshot"); } },
  };
  return {
    ...state, env, access, assets: () => assets,
    send: (req, selected = token) => {
      if (selected !== null) req.headers.set("cf-access-jwt-assertion", selected);
      return worker.fetch(req, env, {});
    },
  };
}

function unread(path, headers = {}) {
  const req = request(path, { method: "POST", raw: new ReadableStream(), headers });
  Object.defineProperty(req.body, "getReader", { value() { assert.fail("unauthorized/disabled body read"); } });
  return req;
}

test("missing config/token and rejected JWTs read no body, reach no R2 or assets", async (t) => {
  const state = await authenticated(t, "negative-jwt");
  assert.equal((await worker.fetch(unread(`${base}/delete`), {}, {})).status, 500);
  assert.equal((await state.send(unread(`${base}/delete`), null)).status, 403);
  for (const claims of [
    { iss: "https://wrong.cloudflareaccess.com" }, { aud: "wrong" },
    { exp: Math.floor(Date.now() / 1000) - 31 }, { nbf: Math.floor(Date.now() / 1000) + 31 },
    { nbf: "invalid" }, { exp: null },
  ]) assert.equal((await state.send(unread(`${base}/delete`), await state.access.token(claims))).status, 403);
  for (const token of ["malformed", "bm9uZQ.bm9uZQ.eA", await state.access.token({}, { alg: "none" }), await state.access.token({}, { kid: "absent" })]) {
    assert.equal((await state.send(unread(`${base}/delete`), token)).status, 403);
  }
  const valid = await state.access.token();
  const segments = valid.split(".");
  const corrupt = Buffer.from(segments[2], "base64url");
  corrupt[0] ^= 1;
  assert.equal((await state.send(unread(`${base}/delete`), `${segments[0]}.${segments[1]}.${corrupt.toString("base64url")}`)).status, 403);
  assert.deepEqual(state.calls, []);
  assert.equal(state.assets(), 0);
});

test("Access key-fetch failures preserve a safe 503, without internal error reflection", async (t) => {
  const state = await authenticated(t, "key-fetch-failure");
  t.mock.method(globalThis, "fetch", async () => { throw new Error("private infrastructure detail"); });
  const log = t.mock.method(console, "error", () => {});
  const response = await state.send(unread(`${base}/delete`));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(await response.text(), "Access verification unavailable");
  assert.equal(log.mock.callCount(), 1);
  assert.deepEqual(log.mock.calls[0].arguments, ["Access verification unavailable"]);
  assert.deepEqual(state.calls, []);
});

test("audience array and clock skew remain compatible; protected GET/HEAD assets run after auth", async (t) => {
  const state = await authenticated(t, "positive-jwt");
  const token = await state.access.token({ aud: ["other", "fixture-aud"], exp: Math.floor(Date.now() / 1000) - 20, nbf: Math.floor(Date.now() / 1000) + 20 });
  for (const path of ["/", "/assets/index.97b9144c.js", "/spa/", "/files/BACKUPS"]) {
    assert.equal((await state.send(request(path), token)).status, 200);
    assert.equal((await state.send(request(path, { method: "HEAD" }), token)).status, 200);
  }
  assert.equal(state.assets(), 8);
  assert.equal((await state.send(request("/assets/index.97b9144c.js"), null)).status, 403);
  assert.equal(state.assets(), 8);
});

test("all disabled share/email paths and aliases fail before body reads", async (t) => {
  const state = await authenticated(t, "disabled-routes");
  for (const path of ["/share/id", "/api/emails", "/api/emails/send", `${base}/shares`, `${base}/share/id`, `${base}/${keyPath("db/key")}/share`]) {
    assert.equal((await state.send(unread(path))).status, 404);
  }
  assert.deepEqual(state.calls, []);
  assert.equal(state.assets(), 0);
});

test("CSRF fetch-site, Origin and control media checks reject before body", async (t) => {
  const state = await authenticated(t, "csrf-routes");
  for (const headers of [
    { origin: "https://outside.test", "content-type": "application/json" },
    { "sec-fetch-site": "cross-site", "content-type": "application/json" },
    { "sec-fetch-site": "same-site", "content-type": "application/json" },
    { "sec-fetch-site": "none", "content-type": "application/json" },
    { origin: "null", "content-type": "application/json" },
    { "content-type": "text/plain" },
    { "content-type": "application/json-unrecognized" },
    { "content-type": "multipart/form-data" },
  ]) assert.equal((await state.send(unread(`${base}/delete`, headers))).status, 403);
  for (const key of ["db/???.txt", "db/???"]) {
    assert.equal((await state.send(unread(`${base}/${encode(key)}`, { "content-type": "text/plain" }))).status, 403);
  }
  assert.deepEqual(state.calls, []);
});

test("same-origin JSON controls and raw multipart/form-data upload preserve their separate media contracts", async (t) => {
  const state = await authenticated(t, "csrf-positive");
  const folder = { key: encode("db/folder") };
  assert.equal((await state.send(request(`${base}/folder`, { method: "POST", body: folder }))).status, 200);
  assert.equal((await state.send(request(`${base}/folder`, { method: "POST", body: folder, headers: { origin: "https://outside.test", "sec-fetch-site": "same-origin" } }))).status, 200);
  assert.equal((await state.send(request(`${base}/upload?key=${encode("db/raw")}`, { method: "POST", raw: "raw", headers: { "content-type": "multipart/form-data" } }))).status, 200);
});

test("wildcard still takes the single bounded interpretation; prefixes are never reflected", async (t) => {
  const state = await authenticated(t, "prefixes");
  const outside = request(`${base}/delete`, { method: "POST", body: { key: encode("outside/key") } });
  const response = await state.send(outside);
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { msg: "Forbidden" });
  assert.deepEqual(state.calls, []);
  state.env.WRITE_PREFIXES = "*";
  assert.equal((await state.send(request(`${base}/delete`, { method: "POST", body: { key: encode("outside/key") } }))).status, 200);
  assert.deepEqual(state.calls, [["delete", "outside/key"]]);
});
