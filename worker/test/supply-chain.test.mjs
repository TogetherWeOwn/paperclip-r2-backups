import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exec = promisify(execFile);

test("native npm enforces the project release-age policy and refuses root/dependency hooks", async () => {
  const root = await mkdtemp(join(tmpdir(), "console-npm-policy-"));
  const project = join(root, "project");
  const archives = join(root, "archives");
  await mkdir(project);
  await mkdir(archives);
  const npmrc = await readFile(new URL("../.npmrc", import.meta.url), "utf8");
  await writeFile(join(project, ".npmrc"), npmrc);
  const hook = 'node -e "require(\'node:fs\').writeFileSync(\'hook-ran\',\'unexpected\')"';
  await writeFile(join(project, "package.json"), JSON.stringify({ name: "native-policy-root", version: "1.0.0", private: true, scripts: { preinstall: hook, install: hook, postinstall: hook, prepare: hook }, dependencies: { "console-policy-fixture": "*" } }));
  const artifacts = {};
  for (const version of ["1.0.0", "2.0.0"]) {
    const source = join(root, `source-${version}`);
    await mkdir(join(source, "package"), { recursive: true });
    await writeFile(join(source, "package/package.json"), JSON.stringify({ name: "console-policy-fixture", version, scripts: { preinstall: hook, install: hook, postinstall: hook } }));
    const archive = join(archives, `${version}.tgz`);
    await exec("tar", ["-czf", archive, "-C", source, "package"]);
    artifacts[version] = await readFile(archive);
  }
  let origin;
  const server = createServer((request, response) => {
    if (request.url === "/console-policy-fixture") {
      const version = (name) => ({ name: "console-policy-fixture", version: name, scripts: { install: hook }, dist: { tarball: `${origin}/${name}.tgz`, integrity: "sha512-" + createHash("sha512").update(artifacts[name]).digest("base64") } });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ name: "console-policy-fixture", "dist-tags": { latest: "2.0.0" }, versions: { "1.0.0": version("1.0.0"), "2.0.0": version("2.0.0") }, time: { "1.0.0": new Date(Date.now() - 10 * 86400_000).toISOString(), "2.0.0": new Date(Date.now() - 3600_000).toISOString() } }));
    } else {
      const bytes = artifacts[request.url?.slice(1, -4)];
      response.writeHead(bytes ? 200 : 404);
      response.end(bytes);
    }
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    origin = `http://127.0.0.1:${server.address().port}`;
    // Native manager invocations against inert first-party fixtures, not a replacement installer.
    const options = { cwd: project, env: { PATH: process.env.PATH, HOME: root, CI: "true", npm_config_cache: join(root, "cache") }, timeout: 60_000, maxBuffer: 1024 * 1024 };
    assert.equal((await exec("npm", ["--version"], options)).stdout.trim(), "11.19.0");
    assert.equal((await exec("npm", ["config", "get", "min-release-age"], options)).stdout.trim(), "3");
    assert.equal((await exec("npm", ["config", "get", "ignore-scripts"], options)).stdout.trim(), "true");
    await exec("npm", ["install", "--no-audit", "--no-fund", `--registry=${origin}`], options);
    const installed = JSON.parse(await readFile(join(project, "node_modules/console-policy-fixture/package.json"), "utf8"));
    assert.equal(installed.version, "1.0.0", "fresh 2.0.0 must be filtered by native release-age policy");
    for (const path of ["hook-ran", "node_modules/console-policy-fixture/hook-ran"]) await assert.rejects(access(join(project, path)), { code: "ENOENT" });
    await exec("npm", ["ci", "--no-audit", "--no-fund", `--registry=${origin}`], options);
    for (const path of ["hook-ran", "node_modules/console-policy-fixture/hook-ran"]) await assert.rejects(access(join(project, path)), { code: "ENOENT" });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
