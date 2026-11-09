import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import worker from "../src/index.ts";
import { mockBucket, signedAccess, request, keyPath } from "./fixtures.mjs";

const root = new URL("../dashboard/", import.meta.url);
const navigation = "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; sandbox allow-downloads";
const scripts = ["AuthLayout.db6e752c.js", "EmailFilePage.8578c819.js", "ErrorNotFound.1cad377e.js", "LoginPage.c1ee667f.js", "auth-store.ba1aa298.js", "auth.315647f3.js", "bus.2c308485.js", "index.97b9144c.js"];
const paths = ["/assets/", "/spa/assets/"].flatMap((prefix) => scripts.map((name) => prefix + name));
function expected(origin = "https://console.test") {
  return "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; script-src " + paths.map((path) => origin + path).join(" ") + " 'sha256-ivd6tHqEA4mIbBgQ80xHC/HM2TD8VhP3tLA5jLgSI+0='; script-src-attr 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' data:; media-src blob:; connect-src 'self' blob:; worker-src 'none'; frame-src 'self'";
}
async function fixture(t, team) {
  const access = await signedAccess(team);
  t.mock.method(globalThis, "fetch", async () => Response.json({ keys: [access.jwk] }));
  const token = await access.token();
  const state = mockBucket();
  const seen = [];
  const env = {
    ACCESS_TEAM_NAME: team, ACCESS_AUD: "fixture-aud", BACKUPS: state.bucket,
    ASSETS: { async fetch(req) {
      seen.push(req);
      const path = new URL(req.url).pathname.slice(1);
      const script = paths.includes("/" + path);
      return new Response(script ? await readFile(new URL(path, root)) : "original document", {
        headers: { "content-type": script ? "text/javascript; charset=utf-8" : "text/html", "cache-control": "public, max-age=86400", "content-security-policy": "default-src *", etag: '"static"' },
      });
    } },
  };
  return { ...state, env, seen, send(req) { req.headers.set("cf-access-jwt-assertion", token); return worker.fetch(req, env, {}); } };
}
function policy(response, value) {
  assert.equal(response.headers.get("content-security-policy"), value);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("content-security-policy-report-only"), null);
}

test("exact document policy covers entrypoints, SPA fallback, cache responses and method/auth errors", async (t) => {
  const f = await fixture(t, "document-policy");
  for (const path of ["/", "/index.html", "/spa/", "/spa/index.html", "/files/BACKUPS/db/", "/spa/files/BACKUPS/db/", "/assets/index.8a66f01f.css"]) {
    for (const method of ["GET", "HEAD"]) {
      const response = await f.send(request(path, { method, headers: { "if-none-match": '"old-html"', "x-forwarded-host": "untrusted.test" } }));
      assert.equal(response.status, 200);
      policy(response, expected());
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
  }
  f.env.ASSETS.fetch = async () => new Response(null, { status: 304, headers: { etag: '"old-html"' } });
  const cached = await f.send(request("/index.html"));
  assert.equal(cached.status, 304);
  policy(cached, expected());
  assert.equal(cached.headers.get("cache-control"), "no-store");
  policy(await f.send(request("/", { method: "POST", headers: { "sec-fetch-site": "same-origin" } })), expected());
  policy(await worker.fetch(request("/"), {}, {}), expected());
  policy(await worker.fetch(request("/api/server/config"), {}, {}), navigation);
  assert.deepEqual(f.calls, []);
});

test("all 16 trusted scripts retain manifest bytes and MIME without redirects, query aliases or partial-cache reuse", async (t) => {
  const f = await fixture(t, "script-identity");
  const manifest = JSON.parse(await readFile(new URL("checksums.json", root), "utf8"));
  for (const path of paths) {
    for (const method of ["GET", "HEAD"]) {
      const response = await f.send(request(path + "?ignored=1", { method, headers: { "if-none-match": '"old"', "if-modified-since": "Sun, 01 Nov 2026 00:00:00 GMT", range: "bytes=0-1" } }));
      assert.equal(response.status, 200);
      policy(response, expected());
      assert.equal(response.headers.get("location"), null);
      assert.equal(response.headers.get("content-type"), "text/javascript; charset=utf-8");
      const bytes = Buffer.from(await response.arrayBuffer());
      if (method === "GET") assert.equal(createHash("sha256").update(bytes).digest("hex"), manifest.files[path.slice(1)]);
      else assert.equal(bytes.length, 0);
      const fetched = f.seen.at(-1);
      assert.equal(fetched.method, "GET");
      assert.equal(fetched.url, "https://console.test" + path);
      assert.equal(fetched.redirect, "manual");
      for (const name of ["if-none-match", "if-modified-since", "range"]) assert.equal(fetched.headers.get(name), null);
    }
  }
  for (const make of [
    () => Response.redirect("https://console.test/api/server/config"),
    () => new Response(null, { status: 304 }),
    () => new Response("partial", { status: 206, headers: { "content-type": "text/javascript" } }),
    () => new Response("fallback", { headers: { "content-type": "text/html" } }),
    () => new Response("not the pinned bytes", { headers: { "content-type": "text/javascript" } }),
    () => new Response("not followed", { headers: { location: "/api/server/config", "content-type": "text/javascript" } }),
  ]) {
    f.env.ASSETS.fetch = async () => make();
    const response = await f.send(request(paths[0]));
    assert.equal(response.status, 500);
    policy(response, expected());
    assert.ok((await response.text()).length < 1024);
  }
});

test("API navigation policy wins after object metadata without buffering or modifying download bytes", async (t) => {
  const f = await fixture(t, "api-policy");
  const bytes = new TextEncoder().encode("ordinary Unicode ☃ <b>markup</b>");
  f.objects.set("db/preview.html", { bytes, httpMetadata: { contentType: "text/html", cacheControl: "private, max-age=60" } });
  const path = "/api/buckets/BACKUPS/" + keyPath("db/preview.html");
  for (const method of ["GET", "HEAD"]) {
    const response = await f.send(request(path, { method }));
    policy(response, navigation);
    assert.equal(response.headers.get("content-type"), "text/html");
    assert.match(response.headers.get("content-disposition"), /^attachment;/);
    assert.equal(response.headers.get("cache-control"), "private, max-age=60");
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), method === "HEAD" ? new Uint8Array() : bytes);
  }
  for (const path of ["/api", "/api/unknown", "/api/server/config", "/api/buckets/BACKUPS/" + keyPath("absent")]) policy(await f.send(request(path)), navigation);
  assert.equal(f.seen.length, 0);
});

test("policy origin uses only validated effective URL origin, allowing HTTP only for loopback fixtures", async (t) => {
  const f = await fixture(t, "policy-origin");
  for (const origin of ["http://127.0.0.1:12345", "http://[::1]:12345", "https://console.test:8443"]) {
    const response = await f.send(new Request(origin + "/", { headers: { "x-forwarded-host": "ignored.test" } }));
    assert.equal(response.status, 200);
    policy(response, expected(origin));
  }
  const before = f.seen.length;
  const response = await f.send(new Request("http://public.test/"));
  assert.equal(response.status, 500);
  policy(response, navigation);
  assert.equal(f.seen.length, before);
});

test("the sole inline bootstrap hash still identifies both original HTML script bodies", async () => {
  for (const path of ["index.html", "spa/index.html"]) {
    const html = await readFile(new URL(path, root), "utf8");
    // Exact delimiters in the integrity-pinned fixture, not an HTML sanitizer.
    const start = html.indexOf("<script>");
    assert.ok(start >= 0);
    assert.equal(html.indexOf("<script>", start + 1), -1);
    const bodyStart = start + "<script>".length;
    const end = html.indexOf("</script>", bodyStart);
    assert.ok(end > bodyStart);
    assert.equal(createHash("sha256").update(html.slice(bodyStart, end)).digest("base64"), "ivd6tHqEA4mIbBgQ80xHC/HM2TD8VhP3tLA5jLgSI+0=");
  }
});
