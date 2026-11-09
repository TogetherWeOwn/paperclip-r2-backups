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
  assert.equal(all.length, 62); // 56 originals plus six provenance/license/inventory files.
  assert.equal(digest(await readFile(new URL("EXPLORER-LICENSE", dashboard))), "479887d33bb0120f0f8c21aab2062fb2434eba4c84b006edf255ceefe2d7e84c");
  for (const path of Object.keys(manifest.files).filter((name) => !name.startsWith("spa/"))) {
    assert.equal(manifest.files[`spa/${path}`], manifest.files[path]);
  }
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
