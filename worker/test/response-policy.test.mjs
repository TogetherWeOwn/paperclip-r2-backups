import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import worker from "../src/index.ts";
import { mockBucket, signedAccess, request, keyPath } from "./fixtures.mjs";

const root = new URL("../dashboard/", import.meta.url);
const navigation = "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; sandbox allow-downloads";
const scripts = ["AuthLayout", "EmailFilePage", "ErrorNotFound", "LoginPage", "auth-store", "auth", "bus", "index"].map(name => name + ".preview-layout-v1.js");
const paths = scripts.map(name => "/assets/" + name);
const conditionalHeaders = ["if-none-match", "if-modified-since", "if-match", "if-unmodified-since", "if-range", "range"];
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
function expected(origin = "https://console.test") {
  return "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; script-src " + paths.map((path) => origin + path).join(" ") + " 'sha256-ivd6tHqEA4mIbBgQ80xHC/HM2TD8VhP3tLA5jLgSI+0='; script-src-attr 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' data:; media-src blob:; connect-src 'self' blob:; worker-src 'none'; frame-src 'self'";
}
async function fixture(t, team) {
  const access = await signedAccess(team);
  t.mock.method(globalThis, "fetch", async () => Response.json({ keys: [access.jwk] }));
  const token = await access.token();
  const state = mockBucket();
  const seen = [];
  const original = JSON.parse(await readFile(new URL("checksums.json", root), "utf8"));
  const derivative = JSON.parse(await readFile(new URL("preview-layout-v1/manifest.json", root), "utf8"));
  const env = {
    ACCESS_TEAM_NAME: team, ACCESS_AUD: "fixture-aud", BACKUPS: state.bucket,
    ASSETS: { async fetch(req) {
      seen.push(req);
      let path = new URL(req.url).pathname.slice(1);
      if (path === "preview-layout-v1/") path += "index.html";
      if (!path || !path.includes(".")) path = "index.html";
      if (!Object.hasOwn(original.files, path) && !Object.hasOwn(derivative.files, path)) return new Response("Not found", { status: 404 });
      const type = path.endsWith(".js") ? "text/javascript; charset=utf-8" : path.endsWith(".css") ? "text/css" : "text/html";
      return new Response(await readFile(new URL(path, root)), {
        headers: { "content-type": type, "cache-control": "public, max-age=86400", "content-security-policy": "default-src *", etag: '"static"' },
      });
    } },
  };
  return { ...state, env, seen, original, derivative, send(req) { req.headers.set("cf-access-jwt-assertion", token); return worker.fetch(req, env, {}); } };
}
function policy(response, value) {
  assert.equal(response.headers.get("content-security-policy"), value);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("content-security-policy-report-only"), null);
  assert.equal(response.headers.get("cache-control"), "no-store");
}

test("navigation aliases and recognized deep links select the exact disclosed derivative without changing the browser URL", async (t) => {
  const f = await fixture(t, "document-policy");
  for (const path of ["/", "/index.html", "/spa", "/spa/", "/spa/index.html", "/preview-layout-v1/", "/preview-layout-v1/index.html", "/BACKUPS/files/ZGIv/", "/spa/files/BACKUPS/db/"]) {
    for (const method of ["GET", "HEAD"]) {
      const req = request(path + "?ignored=1", { method, headers: { ...Object.fromEntries(conditionalHeaders.map(name => [name, '"old"'])), "x-forwarded-host": "untrusted.test" } });
      const before = req.url;
      const response = await f.send(req);
      assert.equal(response.status, 200);
      policy(response, expected());
      assert.equal(response.headers.get("content-location"), "/preview-layout-v1/");
      assert.equal(response.headers.get("location"), null);
      const body = Buffer.from(await response.arrayBuffer());
      assert.equal(body.length, method === "HEAD" ? 0 : 2318);
      if (method === "GET") assert.equal(digest(body), f.derivative.files["preview-layout-v1/index.html"].sha256);
      assert.equal(req.url, before);
      const fetched = f.seen.at(-1);
      assert.equal(fetched.url, "https://console.test/preview-layout-v1/");
      assert.equal(fetched.method, "GET");
      assert.equal(fetched.redirect, "manual");
      for (const name of conditionalHeaders) assert.equal(fetched.headers.get(name), null);
    }
  }
  const css = await f.send(request("/assets/index.74f0784c.css"));
  assert.equal(css.status, 200);
  assert.equal(css.headers.get("content-location"), null);
  assert.equal(digest(Buffer.from(await css.arrayBuffer())), f.original.files["assets/index.74f0784c.css"]);
  policy(css, expected());
  policy(await f.send(request("/", { method: "POST", headers: { "sec-fetch-site": "same-origin" } })), expected());
  assert.deepEqual(f.calls, []);
});

test("selected document fetch rejects redirects, cache/partial responses, wrong MIME and changed HTML", async (t) => {
  const f = await fixture(t, "document-integrity");
  const html = await readFile(new URL("preview-layout-v1/index.html", root));
  const stale = await readFile(new URL("email-constructor-v1/index.html", root));
  for (const make of [
    () => new Response(stale, { headers: { "content-type": "text/html" } }),
    () => Response.redirect("https://console.test/index.html"),
    () => new Response(null, { status: 304 }),
    () => new Response(html, { status: 206, headers: { "content-type": "text/html" } }),
    () => new Response(html, { headers: { "content-type": "text/plain" } }),
    () => new Response(Buffer.from(html).fill(32, 0, 1), { headers: { "content-type": "text/html" } }),
    () => new Response(html, { headers: { location: "/index.html", "content-type": "text/html" } }),
    () => new Response("Not found", { status: 404 }),
  ]) {
    f.env.ASSETS.fetch = async () => make();
    for (const method of ["GET", "HEAD"]) {
      const response = await f.send(request("/index.html", { method }));
      assert.equal(response.status, 500);
      policy(response, expected());
    }
  }
});

test("arbitrary HTML, failed assets and redirects never become the selected SPA document", async (t) => {
  const f = await fixture(t, "fallback-identity");
  for (const make of [
    () => new Response("other HTML", { headers: { "content-type": "text/html" } }),
    () => new Response("missing", { status: 404, headers: { "content-type": "text/html" } }),
    () => Response.redirect("https://console.test/"),
  ]) {
    const asset = make();
    f.env.ASSETS.fetch = async () => asset;
    const response = await f.send(request("/unknown-file.svg"));
    assert.equal(response.status, asset.status);
    assert.equal(response.headers.get("content-location"), null);
    policy(response, expected());
  }
});

test("all eight trusted scripts retain separate selected bytes with no partial-cache or query-selected body", async (t) => {
  const f = await fixture(t, "script-identity");
  for (const path of paths) {
    for (const method of ["GET", "HEAD"]) {
      const response = await f.send(request(path + "?ignored=1", { method, headers: Object.fromEntries(conditionalHeaders.map(name => [name, '"old"'])) }));
      assert.equal(response.status, 200);
      policy(response, expected());
      assert.equal(response.headers.get("location"), null);
      assert.equal(response.headers.get("content-type"), "text/javascript; charset=utf-8");
      const bytes = Buffer.from(await response.arrayBuffer());
      if (method === "GET") {
        assert.equal(digest(bytes), f.derivative.files[path.slice(1)].sha256);
        assert.equal(bytes.length, f.derivative.files[path.slice(1)].bytes);
      } else assert.equal(bytes.length, 0);
      const fetched = f.seen.at(-1);
      assert.equal(fetched.method, "GET");
      assert.equal(fetched.url, "https://console.test" + path);
      assert.equal(fetched.redirect, "manual");
      for (const name of conditionalHeaders) assert.equal(fetched.headers.get(name), null);
    }
  }
  for (const path of paths) {
    const bytes = await readFile(new URL(path.slice(1), root));
    const stale = await readFile(new URL(path.slice(1).replace("preview-layout-v1", "email-constructor-v1"), root));
    for (const make of [
      () => new Response(stale, { headers: { "content-type": "text/javascript" } }),
      () => Response.redirect("https://console.test/api/server/config"),
      () => new Response(null, { status: 304 }),
      () => new Response(bytes, { status: 206, headers: { "content-type": "text/javascript" } }),
      () => new Response(bytes, { headers: { "content-type": "text/html" } }),
      () => new Response("<html>fallback</html>", { headers: { "content-type": "text/javascript" } }),
      () => new Response(Buffer.from(bytes).fill(32, 0, 1), { headers: { "content-type": "text/javascript" } }),
      () => new Response(bytes, { headers: { location: "/api/server/config", "content-type": "text/javascript" } }),
      () => new Response("Not found", { status: 404 }),
    ]) {
      f.env.ASSETS.fetch = async () => make();
      for (const method of ["GET", "HEAD"]) {
        const response = await f.send(request(path, { method }));
        assert.equal(response.status, 500);
        policy(response, expected());
        assert.ok((await response.text()).length < 1024);
      }
    }
  }
});

test("legacy root and SPA scripts stay original and authenticated but are absent from executable policy", async (t) => {
  const f = await fixture(t, "legacy-identity");
  for (const path of Object.keys(f.original.files).filter(path => path.endsWith(".js"))) {
    const response = await f.send(request("/" + path));
    assert.equal(response.status, 200);
    assert.equal(digest(Buffer.from(await response.arrayBuffer())), f.original.files[path]);
    assert.equal(response.headers.get("content-security-policy").split("; script-src ")[1].split(";", 1)[0].includes("https://console.test/" + path), false);
  }
  for (const path of ["/assets/index.preview-layout-v1.js", "/spa/assets/index.preview-layout-v1.js", "/preview-layout-v1/manifest.json", "/index.html", "/BACKUPS/files/ZGIv/"]) {
    const before = f.seen.length;
    const response = await worker.fetch(request(path), f.env, {});
    assert.equal(response.status, 403);
    assert.equal(f.seen.length, before);
    policy(response, expected());
  }
  for (const path of ["/spa/assets/index.preview-layout-v1.js", "/other/index.preview-layout-v1.js"]) {
    const response = await f.send(request(path));
    assert.equal(response.status, 404);
    policy(response, expected());
  }
});

test("superseded constructor graph is authenticated but never served as a stale alias or CSP source", async (t) => {
  const f = await fixture(t, "superseded-identity");
  const old = JSON.parse(await readFile(new URL("email-constructor-v1/manifest.json", root), "utf8"));
  for (const path of ["/email-constructor-v1", "/email-constructor-v1/", "/email-constructor-v1/index.html", ...Object.keys(old.files).map(path => "/" + path)]) {
    for (const method of ["GET", "HEAD"]) {
      const before = f.seen.length;
      const denied = await worker.fetch(request(path, { method }), f.env, {});
      assert.equal(denied.status, 403);
      const response = await f.send(request(path, { method }));
      assert.equal(response.status, 404);
      assert.equal(response.headers.get("content-location"), null);
      assert.equal(f.seen.length, before);
      policy(response, expected());
      assert.equal(response.headers.get("content-security-policy").includes("email-constructor-v1"), false);
    }
  }
  assert.deepEqual(f.calls, []);
});

test("API navigation policy wins after object metadata without buffering or modifying download bytes", async (t) => {
  const f = await fixture(t, "api-policy");
  const bytes = new TextEncoder().encode("ordinary Unicode ☃ <b>markup</b>");
  f.objects.set("db/preview.html", { bytes, httpMetadata: { contentType: "text/html", cacheControl: "private, max-age=60" } });
  const path = "/api/buckets/BACKUPS/" + keyPath("db/preview.html");
  for (const method of ["GET", "HEAD"]) {
    const response = await f.send(request(path, { method }));
    assert.equal(response.headers.get("content-security-policy"), navigation);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("content-type"), "text/html");
    assert.match(response.headers.get("content-disposition"), /^attachment;/);
    assert.equal(response.headers.get("cache-control"), "private, max-age=60");
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), method === "HEAD" ? new Uint8Array() : bytes);
  }
  for (const path of ["/api", "/api/unknown", "/api/server/config", "/api/buckets/BACKUPS/" + keyPath("absent")]) assert.equal((await f.send(request(path))).headers.get("content-security-policy"), navigation);
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

test("the sole inline bootstrap is identical across original and derivative HTML", async () => {
  for (const path of ["index.html", "spa/index.html", "preview-layout-v1/index.html"]) {
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
