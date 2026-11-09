import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { stripTypeScriptTypes } from "node:module";
import worker from "../src/index.ts";
import { mockBucket, signedAccess, request, keyPath } from "./fixtures.mjs";

const root = new URL("../dashboard/", import.meta.url);
const bytes = await readFile(new URL("pdf-note-v1/annotation-note.svg", root));
const hash = "f8e7b10e93f771ba1ef3a3c771bcbf59e5a3efe9832bef90baf1dbe9f66e1d07";
const digest = body => createHash("sha256").update(body).digest("hex");
const image = parameter => `/BACKUPS/files/${parameter}/annotation-note.svg`;
const folder = key => Buffer.from(key).toString("base64").replaceAll("/", "%2F");
const conditions = ["range", "if-range", "if-none-match", "if-modified-since", "if-match", "if-unmodified-since"];
async function fixture(t, team) {
  const access = await signedAccess(team);
  t.mock.method(globalThis, "fetch", async () => Response.json({ keys: [access.jwk] }));
  const token = await access.token();
  const state = mockBucket();
  const seen = [];
  const env = { BACKUPS: state.bucket, ACCESS_TEAM_NAME: team, ACCESS_AUD: "fixture-aud", ASSETS: { async fetch(req) {
    seen.push(req);
    return new Response(bytes, { headers: { "content-type": "image/svg+xml; charset=utf-8", etag: '"backend"',
      "content-length": "1083", "set-cookie": "backend=forbidden", "content-range": "bytes 0-1082/1083" } });
  } } };
  return { ...state, access, env, seen, send(req, handler = worker) {
    req.headers.set("cf-access-jwt-assertion", token);
    return handler.fetch(req, env, {});
  } };
}
function closed(response, status) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.notEqual(response.headers.get("content-type"), "text/html");
  assert.equal(response.headers.get("location"), null);
}

test("Note GET and HEAD use one full pinned internal image, never folder storage, range or validators", async t => {
  const f = await fixture(t, "note-positive");
  for (const parameter of ["IA==", folder("db/qualification/"), folder("instance/qualification/"), folder("db/???/"), folder("db/>>>/"), folder("db/é/"), folder("a".repeat(1023) + "/")]) {
    for (const method of ["GET", "HEAD"]) {
      const response = await f.send(request(image(parameter), { method, headers: Object.fromEntries(conditions.map(name => [name, '"old"'])) }));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "image/svg+xml");
      assert.equal(response.headers.get("content-length"), "1083");
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      for (const name of ["etag", "last-modified", "set-cookie", "content-encoding", "content-range", "location"]) assert.equal(response.headers.get(name), null);
      const body = Buffer.from(await response.arrayBuffer());
      assert.equal(body.length, method === "HEAD" ? 0 : 1083);
      if (method === "GET") { assert.deepEqual(body, bytes); assert.equal(digest(body), hash); }
      const fetched = f.seen.at(-1);
      assert.equal(fetched.url, "https://console.test/pdf-note-v1/annotation-note.svg");
      assert.equal(fetched.method, "GET");
      assert.equal(fetched.redirect, "manual");
      assert.equal(fetched.headers.get("accept"), "image/svg+xml");
      assert.equal(fetched.headers.get("accept-encoding"), "identity");
      for (const name of conditions) assert.equal(fetched.headers.get(name), null);
    }
  }
  assert.equal(folder("db/???/"), "ZGIvPz8%2FLw==");
  assert.deepEqual(f.calls, []);
});

test("Note backend status, MIME, length, full digest, encoding, fetch/read and pin failures stay closed for GET and HEAD", async t => {
  const f = await fixture(t, "note-backend");
  const html = await readFile(new URL("email-constructor-v1/index.html", root));
  const make = (body = bytes, headers = {}, status = 200) => new Response(body, { status, headers: { "content-type": "image/svg+xml", ...headers } });
  const variants = [
    ...[404, 301, 302, 307, 308, 206].map(status => () => make(bytes, {}, status)),
    () => new Response(null, { status: 304 }),
    () => make(bytes, { location: "/index.html" }),
    () => new Response(bytes),
    ...["text/html", "application/octet-stream"].map(type => () => make(bytes, { "content-type": type })),
    () => make(html, { "content-type": "text/html" }),
    () => make(html), () => make(new Uint8Array()),
    () => make(Buffer.from(bytes).fill(32, 0, 1)),
    () => make(bytes.subarray(0, -1)), () => make(Buffer.concat([bytes, Buffer.from("x")])),
    () => make(bytes, { "content-length": "1082" }),
    () => make(bytes, { "content-encoding": "gzip" }),
    () => { throw new Error("backend private error"); },
    () => make(new ReadableStream({ start(controller) { controller.error(new Error("private read error")); } })),
  ];
  for (const variant of variants) {
    f.env.ASSETS.fetch = async () => variant();
    for (const method of ["GET", "HEAD"]) {
      const response = await f.send(request(image("IA=="), { method }));
      closed(response, 500);
      const text = await response.text();
      assert.ok(Buffer.byteLength(text) <= 1024);
      assert.ok(!text.includes("private") && !text.includes("<html"));
      if (method === "HEAD") assert.equal(text, "");
    }
  }
  // Mutation controls change only the compiled fixture's constant. No runtime
  // environment override, test-only asset bypass or production pin default exists.
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  for (const replacement of ['const PDF_NOTE_PIN = undefined;', 'const PDF_NOTE_PIN = {bytes:1083, hash:"wrong"};']) {
    const changed = source.replace(/const PDF_NOTE_PIN = [^;]+;/, replacement)
      .replace('"./console-api.ts"', JSON.stringify(new URL("../src/console-api.ts", import.meta.url).href));
    assert.notEqual(changed, source);
    const mutant = (await import("data:text/javascript;base64," + Buffer.from(stripTypeScriptTypes(changed)).toString("base64"))).default;
    f.env.ASSETS.fetch = async () => make();
    for (const method of ["GET", "HEAD"]) {
      const response = await f.send(request(image("IA=="), { method }), mutant);
      closed(response, 500);
      if (method === "HEAD") assert.equal(await response.text(), "");
    }
  }
  assert.deepEqual(f.calls, []);
});

test("Note backend overflow and empty-chunk work are bounded and cancelled", async t => {
  const f = await fixture(t, "note-overflow");
  for (const chunk of [new Uint8Array(1084), new Uint8Array(1_000_000), new Uint8Array()]) {
    let pulls = 0, cancelled = false;
    f.env.ASSETS.fetch = async () => new Response(new ReadableStream({
      pull(controller) { pulls++; controller.enqueue(chunk); }, cancel() { cancelled = true; },
    }), { headers: { "content-type": "image/svg+xml" } });
    closed(await f.send(request(image("IA=="))), 500);
    assert.equal(cancelled, true);
    assert.ok(pulls <= 1086, String(pulls));
  }
});

test("Note stalled reads expire at an absolute deadline and cancel the backend body", async t => {
  const f = await fixture(t, "note-deadline");
  let cancelled = false;
  f.env.ASSETS.fetch = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "image/svg+xml" } });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const scheduled = globalThis.setTimeout;
  let armed;
  const ready = new Promise(resolve => { armed = resolve; });
  t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
    const timer = scheduled(callback, delay, ...args);
    if (delay === 10_000) armed();
    return timer;
  });
  const pending = f.send(request(image("IA==")));
  // JWT verification crosses native crypto tasks before the body timer exists.
  // Advance only after registration, never after an assumed event-loop turn.
  await ready;
  t.mock.timers.tick(9_999);
  assert.equal(cancelled, false);
  t.mock.timers.tick(1);
  closed(await pending, 500);
  assert.equal(cancelled, true);
  t.mock.restoreAll();
  t.mock.timers.reset();
});

test("observable noncanonical Note/annotation resources never reach ASSETS, R2 or SPA fallback", async t => {
  const f = await fixture(t, "note-paths");
  const invalidFolders = ["", "IA", "IB==", "IA%3D%3D", " IA==", "_A==", "====", "ZGIvPj4%2BLw==", "ZGIvPj4 Lw==", "ZGIvPz8%2fLw==", "ZGIvPz8%252FLw==", "ZGIvPz8/Lw==", "%2E", "%2e", "%252e", "%5C", "bad%", "a".repeat(4097),
    Buffer.from([0xff, 0x2f]).toString("base64"), ...["/db/", "db/./", "db/../", "db//", "db/%2e/", "db/\\/", "db/\0/", "db/\n/", "db/\x7f/", "db", "a".repeat(1024) + "/"].map(folder)];
  const invalidPaths = [
    ...invalidFolders.map(image),
    "/annotation-note.svg", "/assets/annotation-note.svg", "/spa/annotation-note.svg", "/BACKUPS/files/annotation-note.svg",
    "/OTHER/files/IA==/annotation-note.svg", "/BACKUPS/emails/IA==/annotation-note.svg",
    image("IA==") + "/", image("IA==") + "?", image("IA==") + "?x=1", image("IA==") + "#", image("IA==") + "#x",
    "/BACKUPS//files/IA==/annotation-note.svg", "/BACKUPS/files/IA==/extra/annotation-note.svg",
    "/pdf-note-v1", "/pdf-note-v1/", "/pdf-note-v1/annotation-note.svg", "/pdf-note-v1/LICENSE", "/pdf-note-v1/provenance.json",
    ...["annotation-comment.svg", "annotation-help.svg", "Annotation-Note.svg", "annotation-note.SVG", "%61nnotation-note.svg", "annotation-note%2Esvg", "%2561nnotation-note.svg", "annotation-note.svg%2F", "prefix%2Fannotation-note.svg", "annotation-note.svg%", "other.svg"].map(leaf => `/BACKUPS/files/IA==/${leaf}`),
  ];
  for (const path of invalidPaths) {
    const response = await f.send(request(path));
    closed(response, 404);
    assert.equal(f.seen.length, 0, path);
    assert.equal(f.calls.length, 0, path);
  }
  const normalized = [];
  for (const path of ["/BACKUPS/files/unused/../IA==/annotation-note.svg", "/BACKUPS/files/%2e/IA==/annotation-note.svg", "/BACKUPS\\files\\IA==\\annotation-note.svg"]) {
    const req = request(path);
    const response = await f.send(req);
    normalized.push({ input: path, requestUrl: req.url, status: response.status });
    if (new URL(req.url).pathname === image("IA==")) {
      assert.equal(response.status, 200); assert.equal(digest(Buffer.from(await response.arrayBuffer())), hash);
    } else closed(response, 404);
  }
  await mkdir(new URL("../artifacts/", import.meta.url), { recursive: true });
  await writeFile(new URL("../artifacts/pdf-note-normalization.json", import.meta.url), JSON.stringify(normalized, null, 2));
});

test("Note authorization/configuration/verifier and method/CSRF checks precede all image work", async t => {
  const f = await fixture(t, "note-auth");
  for (const token of [null, "invalid", await f.access.token({ exp: 1 }), await f.access.token({ aud: "wrong" }), (await f.access.token()) + "x"]) {
    const req = request(image("IA=="));
    if (token) req.headers.set("cf-access-jwt-assertion", token);
    closed(await worker.fetch(req, f.env, {}), 403);
  }
  for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
    closed(await f.send(request(image("IA=="), { method })), 405);
    if (method !== "OPTIONS") closed(await f.send(request(image("IA=="), { method, headers: { "sec-fetch-site": "cross-site" } })), 403);
  }
  f.env.ACCESS_AUD = "";
  closed(await f.send(request(image("IA=="))), 500);
  f.env.ACCESS_AUD = "fixture-aud";
  f.env.ACCESS_TEAM_NAME = "note-unavailable";
  t.mock.method(globalThis, "fetch", async () => { throw new Error("key service unavailable"); });
  closed(await f.send(request(image("IA=="))), 503);
  assert.deepEqual(f.seen, []); assert.deepEqual(f.calls, []);
});

test("Note helper never shadows R2 names or API dispatch; ordinary navigation and original assets stay unchanged", async t => {
  const f = await fixture(t, "note-collisions");
  for (const key of ["annotation-note.svg", "db/annotation-help.svg", "pdf-note-v1/annotation-note.svg"]) {
    f.objects.set(key, { bytes: Buffer.from("stored object, not icon"), httpMetadata: { contentType: "text/plain" } });
    const before = f.calls.length;
    assert.equal((await f.send(request(image("IA==")))).status, 200);
    assert.equal(f.calls.length, before);
    const path = "/api/buckets/BACKUPS/" + keyPath(key);
    const response = await f.send(request(path));
    assert.equal(await response.text(), "stored object, not icon");
    assert.equal((await f.send(request(path, { method: "HEAD" }))).status, 200);
    assert.equal((await (await f.send(request(path + "/head"))).json()).key, key);
    if (key.startsWith("db/")) {
      assert.equal((await f.send(request(path, { method: "POST", body: { customMetadata: { changed: true }, httpMetadata: {} } }))).status, 200);
      assert.equal(Buffer.from(f.objects.get(key).bytes).toString(), "stored object, not icon");
      assert.equal(f.objects.get(key).customMetadata.changed, "true");
    }
  }
  const seen = f.seen.length;
  for (const path of ["/api/buckets/BACKUPS/IA==/annotation-note.svg", "/api/emails/IA==/annotation-note.svg"]) {
    assert.equal((await f.send(request(path))).status, 404);
    assert.equal(f.seen.length, seen);
  }
  const original = JSON.parse(await readFile(new URL("checksums.json", root), "utf8"));
  f.env.ASSETS.fetch = async req => {
    const path = new URL(req.url).pathname;
    return new Response(await readFile(new URL(path.endsWith("logo-white.svg") ? "logo-white.svg" : path === "/email-constructor-v1/" ? "email-constructor-v1/index.html" : "index.html", root)), { headers: { "content-type": path.endsWith(".svg") ? "image/svg+xml" : "text/html" } });
  };
  assert.equal((await f.send(request("/BACKUPS/files/ZGIv/"))).headers.get("content-location"), "/email-constructor-v1/");
  const logo = await f.send(request("/logo-white.svg"));
  assert.equal(logo.status, 200);
  assert.equal(digest(Buffer.from(await logo.arrayBuffer())), original.files["logo-white.svg"]);
});
