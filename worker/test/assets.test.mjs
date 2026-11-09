import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";

const dashboard = new URL("../dashboard/", import.meta.url);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("immutable dashboard snapshot, supplied spa layout and MIT license remain exact", async () => {
  const manifest = JSON.parse(await readFile(new URL("checksums.json", dashboard), "utf8"));
  assert.equal(manifest.algorithm, "sha256");
  assert.equal(manifest.fileCount, 56);
  assert.equal(manifest.totalBytes, 4_937_484);
  assert.equal(Object.keys(manifest.files).length, 56);
  let total = 0;
  for (const [path, expected] of Object.entries(manifest.files)) {
    assert.ok(!path.includes("..") && !path.startsWith("/"));
    const bytes = await readFile(new URL(path, dashboard));
    total += bytes.length;
    assert.equal(digest(bytes), expected, path);
  }
  assert.equal(total, manifest.totalBytes);
  const all = (await readdir(dashboard, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile());
  assert.equal(all.length, 75); // 56 originals, six evidence, nine derivatives, one manifest, three separate PDF files.
  for (const [path, hash] of Object.entries({
    "checksums.json": "9d0d73c0c2f4f4be8390c5389e75a4dc4131831460e56d3858bb4609b4303f3d",
    "PROVENANCE.md": "14c74775a834af1842e804dc253ebba7f591e601c556d99132d4326582f5a3b9",
    "EXPLORER-LICENSE": "479887d33bb0120f0f8c21aab2062fb2434eba4c84b006edf255ceefe2d7e84c",
    "COMPONENTS.md": "47be965620049e2d494deab9a20caa1388cedb38e9fb5979dab5529c35656ad6",
    "source-notices.json": "002bebe9d815f68623774222495af586e8099e022734abd9347ba128297a5182",
    "THIRD-PARTY-NOTICES.md": "06daf56649c06f63c03a6d903ac4cc054869a2b30b15d09014def3fca7b139d4",
  })) assert.equal(digest(await readFile(new URL(path, dashboard))), hash, path);
  for (const path of Object.keys(manifest.files).filter((name) => !name.startsWith("spa/"))) {
    assert.equal(manifest.files[`spa/${path}`], manifest.files[path]);
  }
});

test("email derivative is exactly the selected constructor and complete module-reference transformation", async () => {
  const encoded = await readFile(new URL("email-constructor-v1/manifest.json", dashboard));
  assert.equal(encoded.length, 4871);
  assert.equal(digest(encoded), "391ae96f4e26a6171cd587dc1ebc235b4fdd1588c00599ed80f2a4be3920fcdd");
  const manifest = JSON.parse(encoded);
  assert.equal(Object.keys(manifest.files).length, 9);
  const { constructor: operation, mainPrefix, basenameReplacements } = manifest.operations;
  assert.equal(Object.keys(basenameReplacements).length, 8);
  let total = 0;
  for (const [path, pin] of Object.entries(manifest.files)) {
    const source = await readFile(new URL(pin.originalPaths[0], dashboard));
    assert.equal(source.length, pin.originalBytes);
    assert.equal(digest(source), pin.originalSha256);
    assert.deepEqual(source, await readFile(new URL(pin.originalPaths[1], dashboard)));
    let expected = source.toString("utf8");
    if (path === "assets/index.email-constructor-v1.js") {
      assert.equal(expected.split(operation.from).length - 1, 1);
      expected = mainPrefix + expected.replace(operation.from, operation.to);
    }
    for (const [oldName, newName] of Object.entries(basenameReplacements)) expected = expected.split(oldName).join(newName);
    const actual = await readFile(new URL(path, dashboard));
    assert.deepEqual(actual, Buffer.from(expected), path);
    assert.equal(actual.length, pin.bytes);
    assert.equal(digest(actual), pin.sha256);
    for (const oldName of Object.keys(basenameReplacements)) assert.equal(expected.includes(oldName), false, path + ": " + oldName);
    total += actual.length;
  }
  assert.equal(total, 1_666_162);
});

test("PDF Note is exactly the separately selected original member, license and provenance, never an inventory rewrite", async () => {
  const pins = {
    "annotation-note.svg": [1083, "f8e7b10e93f771ba1ef3a3c771bcbf59e5a3efe9832bef90baf1dbe9f66e1d07"],
    "LICENSE": [10351, "eb3d7b5485466acbd81f2b496f595ab637d2792e268206b27d99e793bdb67549"],
    "provenance.json": [1891, "d68f82d437c1be33585f8c8d9aa1cdbebaa61bca8304fe0f65d881f1c65b6f8a"],
  };
  const directory = new URL("pdf-note-v1/", dashboard);
  assert.deepEqual((await readdir(directory)).sort(), Object.keys(pins).sort());
  for (const [name, [length, hash]] of Object.entries(pins)) {
    const body = await readFile(new URL(name, directory));
    assert.equal(body.length, length); assert.equal(digest(body), hash);
  }
  const source = JSON.parse(await readFile(new URL("provenance.json", directory)));
  assert.equal(source.source.url, "https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-2.5.207.tgz");
  assert.equal(source.source.bytes, 5134962);
  assert.equal(source.source.sha256, "642a362f5390b074cd6f76f2ef6e7c23dd67ab6302d2eca5e082f8d70d4dfba1");
  assert.equal(source.source.integrity, "sha512-xGDUhnCYPfHy+unMXCLCJtlpZaaZ17Ew3WIL0tnSgKFUZXHAPD49GO9xScyszSsQMoutNDgRb+rfBXIaX/lJbw==");
  assert.equal(source.asset.member, "package/web/images/annotation-note.svg");
  assert.equal(source.asset.path, "pdf-note-v1/annotation-note.svg");
  assert.equal(source.asset.bytes, pins["annotation-note.svg"][0]);
  assert.equal(source.asset.sha256, pins["annotation-note.svg"][1]);
  assert.equal(source.asset.mime, "image/svg+xml");
  assert.equal(source.license.member, "package/LICENSE");
  assert.equal(source.license.spdx, "Apache-2.0");
  assert.equal(source.license.path, "pdf-note-v1/LICENSE");
  assert.equal(source.license.bytes, pins.LICENSE[0]);
  assert.equal(source.license.sha256, pins.LICENSE[1]);
  assert.equal(source.delivery.pathFamily, "/BACKUPS/files/<folder-param>/annotation-note.svg");
  assert.equal(source.delivery.underlyingAssetPath, "/pdf-note-v1/annotation-note.svg");
  assert.equal(source.delivery.rootFolderParam, "IA==");
  assert.equal(source.delivery.publicCanonicalAssetRoute, false);
});

test("source-candidate notices and exact original font attribution remain pinned", async () => {
  const bytes = await readFile(new URL("source-notices.json", dashboard));
  assert.equal(digest(bytes), "002bebe9d815f68623774222495af586e8099e022734abd9347ba128297a5182");
  assert.equal(digest(await readFile(new URL("THIRD-PARTY-NOTICES.md", dashboard))), "06daf56649c06f63c03a6d903ac4cc054869a2b30b15d09014def3fca7b139d4");
  const source = JSON.parse(bytes);
  assert.equal(source.sourceCommit, "d8fefacf3eef29dcd9eb12bd911f2e8fa7da692e");
  assert.equal(source.originalLockSha256, "eb6b47517dd2571a28e7c83ce5fbbe2f478e47c3ad640c4380374b40d014b1cf");
  assert.equal(source.packages.length, 28);
  assert.equal(source.fontByteMatches.length, 8);
  for (const font of source.fontByteMatches) {
    assert.equal(digest(await readFile(new URL(font.dashboardPath, dashboard))), font.sha256);
  }
});

test("static assets stay worker-first with only the reviewed bucket and compatibility date", async () => {
  const text = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(text, /"directory": "dashboard"/);
  assert.match(text, /"run_worker_first": true/);
  assert.match(text, /"compatibility_date": "2026-11-01"/);
  assert.match(text, /"binding": "BACKUPS"/);
  assert.match(text, /"workers_dev": false/);
  assert.match(text, /"preview_urls": false/);
});

test("runtime dependencies and all selected orphan parser/server nodes are removed", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  assert.deepEqual(pkg.dependencies ?? {}, {});
  assert.deepEqual(pkg.devDependencies, { "@cloudflare/workers-types": "5.20261101.1", typescript: "7.0.2", wrangler: "4.156.1" });
  for (const name of ["r2-explorer", "@hono/cloudflare-access", "hono", "chanfana", "zod", "@asteasolutions/zod-to-openapi", "openapi3-ts", "postal-mime", "js-yaml", "argparse", "yargs-parser", "yaml"]) {
    assert.equal(lock.packages[`node_modules/${name}`], undefined, name);
  }
  assert.equal(Object.keys(lock.packages).length, 114);
  const retained = Object.entries(lock.packages).filter(([path]) => path !== "").sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  assert.equal(digest(JSON.stringify(retained)), "d16c5026adc1e4d5dc666e5c70ec55ba5a39595c14bcd9e7ba4379955d58b055", "all retained package objects must match the reviewed baseline exactly");
  const npmrc = await readFile(new URL("../.npmrc", import.meta.url), "utf8");
  assert.match(npmrc, /^min-release-age=3$/m);
  assert.match(npmrc, /^ignore-scripts=true$/m);
});
