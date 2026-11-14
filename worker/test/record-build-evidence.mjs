import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Actions-only data capture: no package resolution, hooks, deployment or bundled code execution.
const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "artifacts/tool-distributions");
const lockBytes = await readFile(join(root, "package-lock.json"));
const lock = JSON.parse(lockBytes);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const evidence = { head: process.env.EVIDENCE_HEAD_SHA, lockSha256: sha256(lockBytes), tools: [] };

for (const name of ["wrangler", "miniflare"]) {
  const source = join(root, "node_modules", name);
  const manifestBytes = await readFile(join(source, "package.json"));
  const manifest = JSON.parse(manifestBytes);
  const locked = lock.packages[`node_modules/${name}`];
  if (manifest.version !== locked.version) throw new Error("Installed tool version differs from lock");
  const tool = { name, version: manifest.version, resolved: locked.resolved, integrity: locked.integrity, files: [], symlinks: [] };
  async function capture(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      const pathInPackage = relative(source, path);
      if (entry.isDirectory()) await capture(path);
      else if (entry.isFile()) {
        const bytes = await readFile(path);
        tool.files.push({ path: pathInPackage, bytes: bytes.length, sha256: sha256(bytes) });
        const destination = join(output, name, pathInPackage);
        await mkdir(dirname(destination), { recursive: true });
        await copyFile(path, destination);
      } else if (entry.isSymbolicLink()) {
        // Do not follow package symlinks into unrelated installed dependencies.
        tool.symlinks.push(pathInPackage);
      } else throw new Error("Unexpected package file type");
    }
  }
  await capture(source);
  evidence.tools.push(tool);
}
await mkdir(join(root, "artifacts"), { recursive: true });
await writeFile(join(root, "artifacts/tool-distributions.json"), JSON.stringify(evidence, null, 2));
