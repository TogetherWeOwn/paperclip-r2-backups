import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { encode } from "./fixtures.mjs";

// Existing exact Wrangler tool dependencies only; no test/runtime package addition.
// This ephemeral native runtime runs in Actions and is disposed even on failure.
async function runtime() {
  const result = await build({
    stdin: {
      contents: `
        import { consoleApi } from './src/console-api.ts';
        export default { async fetch(request, env) {
          if (new URL(request.url).pathname === '/fixture/native-metadata') {
            const input = await request.json();
            const options = { customMetadata: input.customMetadata, httpMetadata: input.httpMetadata };
            if (input.nativeDate) options.httpMetadata.cacheExpiry = new Date(input.nativeDate);
            const object = await env.BACKUPS.put('db/native', 'native body', options);
            return Response.json(object);
          }
          const response = await consoleApi(request, env, ['*']);
          // Keep application headers inspectable independently of workerd's HTTP transport.
          if (['GET', 'HEAD'].includes(request.method) && response.headers.has('content-length')) {
            response.headers.set('x-fixture-content-length', response.headers.get('content-length'));
          }
          return response;
        }};
      `,
      resolveDir: fileURLToPath(new URL("../", import.meta.url)),
      sourcefile: "native-fixture.ts", loader: "ts",
    },
    bundle: true, write: false, format: "esm", platform: "browser", target: "es2022",
  });
  // The pinned v5 runtime exports its v4 converter; omitted persistence uses its temporary directory.
  const instance = new Miniflare(convertV4MiniflareOptions({ modules: true, script: result.outputFiles[0].text, compatibilityDate: "2026-11-01", r2Buckets: ["BACKUPS"] }));
  return instance;
}

const post = (instance, path, value) => instance.dispatchFetch(`https://fixture.test${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
const base = "/api/buckets/BACKUPS";

test("native R2 primitive dictionary conversions and Date/cacheExpiry match adapter wire fixtures", async () => {
  const instance = await runtime();
  try {
    const iso = "2026-11-01T00:00:00.000Z";
    const wire = { read: false, count: 2, nil: null, empty: "", date: new Date(iso) };
    const native = await post(instance, "/fixture/native-metadata", { customMetadata: wire, httpMetadata: { contentType: "text/plain" }, nativeDate: iso });
    assert.equal(native.status, 200, await native.clone().text());
    const baseline = await native.json();
    assert.deepEqual(baseline.customMetadata, { read: "false", count: "2", nil: "null", empty: "", date: iso });
    assert.equal(baseline.httpMetadata.cacheExpiry, iso);
    const response = await post(instance, `${base}/${encode("db/native")}`, { customMetadata: wire, httpMetadata: { contentType: "text/plain", cacheExpiry: iso } });
    assert.equal(response.status, 200, await response.clone().text());
    const actual = await response.json();
    assert.deepEqual(actual.customMetadata, baseline.customMetadata);
    assert.deepEqual(actual.httpMetadata, baseline.httpMetadata);
    const download = await instance.dispatchFetch(`https://fixture.test${base}/${encode("db/native")}`);
    const text = await download.text();
    const head = await instance.dispatchFetch(`https://fixture.test${base}/${encode("db/native")}`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    for (const name of ["etag", "content-type", "content-disposition", "expires", "x-fixture-content-length"]) {
      assert.equal(head.headers.get(name), download.headers.get(name), name);
    }
    await mkdir(new URL("../artifacts/", import.meta.url), { recursive: true });
    await writeFile(new URL("../artifacts/native-metadata.json", import.meta.url), JSON.stringify({
      baseline, actual, download: { status: download.status, headers: Object.fromEntries(download.headers), text },
      head: { status: head.status, headers: Object.fromEntries(head.headers) },
    }, null, 2));
    assert.equal(download.status, 200);
    // A streaming Response's manual Content-Length can be dropped at the native transport.
    // Assert the adapter's header in-isolate, and independently assert received body bytes.
    assert.equal(download.headers.get("x-fixture-content-length"), "11");
    assert.equal(Buffer.byteLength(text), 11);
    assert.equal(download.headers.get("expires"), new Date(iso).toUTCString());
    assert.equal(text, "native body");
  } finally {
    await instance.dispose();
  }
});

test("native multipart shapes, metadata preservation and head/missing-object contracts", async () => {
  const instance = await runtime();
  try {
    const key = encode("db/multipart");
    const createdResponse = await instance.dispatchFetch(`https://fixture.test${base}/multipart/create?key=${key}&httpMetadata=${encode(JSON.stringify({ contentType: "text/plain" }))}`, { method: "POST" });
    assert.equal(createdResponse.status, 200);
    const created = await createdResponse.json();
    assert.equal(created.key, "db/multipart");
    assert.equal(typeof created.uploadId, "string");
    const partResponse = await instance.dispatchFetch(`https://fixture.test${base}/multipart/upload?key=${key}&uploadId=${encodeURIComponent(created.uploadId)}&partNumber=1`, { method: "POST", body: "native part", headers: { "content-type": "multipart/form-data" } });
    assert.equal(partResponse.status, 200);
    const part = await partResponse.json();
    assert.equal(part.partNumber, 1);
    assert.equal(typeof part.etag, "string");
    const completedResponse = await post(instance, `${base}/multipart/complete`, { key, uploadId: created.uploadId, parts: [part] });
    assert.equal(completedResponse.status, 200);
    const complete = await completedResponse.json();
    assert.equal(complete.success, true);
    assert.equal(complete.str.key, "db/multipart");
    assert.equal(complete.str.httpMetadata.contentType, "text/plain");
    const head = await instance.dispatchFetch(`https://fixture.test${base}/${key}/head`);
    assert.equal((await head.json()).size, 11);
    const missing = await instance.dispatchFetch(`https://fixture.test${base}/${encode("missing")}`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { msg: "Object Not Found" });
  } finally {
    await instance.dispose();
  }
});
