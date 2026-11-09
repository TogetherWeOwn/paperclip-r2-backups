import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

export async function qualifyEntrypoints(cdp, origin, evidence, manifest) {
  const artifacts = new URL("../artifacts/entrypoints/", import.meta.url);
  await mkdir(artifacts, { recursive: true });
  const records = evidence.entrypoints = [];
  const paths = ["/", "/index.html", "/spa", "/spa/", "/spa/index.html",
    "/preview-layout-v1/", "/preview-layout-v1/index.html",
    "/BACKUPS/files/" + Buffer.from("db/ui-writes/").toString("base64")];
  let policy;
  try {
    for (const path of paths) {
      const record = { path, status: "unverified" };
      records.push(record);
      const loaded = cdp.event("Page.loadEventFired");
      const navigation = await cdp.call("Page.navigate", { url: origin + path });
      assert.equal(navigation.errorText, undefined);
      await loaded;
      const mounted = await cdp.call("Runtime.evaluate", {
        expression: `(async () => {
          const filename = row => [...(row.querySelector('td')?.childNodes || [])]
            .filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join('').trim();
          const ready = () => document.querySelector('#q-app .fullscreen') ||
            (document.querySelector('#q-app .q-layout tbody') && !document.querySelector('.q-table__progress') &&
              (location.pathname === '/BACKUPS/files' ||
                [...document.querySelectorAll('tbody tr')].some(row => filename(row) === 'source-café.txt')));
          if (!ready()) await new Promise((resolve, reject) => {
            const finish = () => { observer.disconnect(); clearTimeout(timer); };
            const observer = new MutationObserver(() => { if (ready()) { finish(); resolve(); } });
            const timer = setTimeout(() => { finish(); reject(new Error('Entrypoint table deadline exceeded')); }, 10000);
            observer.observe(document.body, {childList:true, subtree:true, attributes:true});
            if (ready()) { finish(); resolve(); }
          });
          return {path: location.pathname, mounted: !!document.querySelector('#q-app').__vue_app__,
            inheritedNotFound: !!document.querySelector('#q-app .fullscreen') && document.body.innerText.includes('Oops. Nothing here...'),
            names: [...document.querySelectorAll('tbody tr')].map(filename).filter(Boolean),
            scripts: performance.getEntriesByType('resource').map(r => new URL(r.name).pathname).filter(p => p.endsWith('.js'))};
        })()`,
        allowUnsafeEvalBlockedByCSP: false, awaitPromise: true, returnByValue: true,
      });
      assert.equal(mounted.exceptionDetails, undefined, JSON.stringify(mounted.exceptionDetails));
      record.rendered = mounted.result.value;
      assert.equal(record.rendered.mounted, true);
      // The retained router recognizes root and file routes, not static document
      // aliases. Qualify that inherited view explicitly, never as a working table.
      assert.equal(record.rendered.inheritedNotFound, path !== "/" && !path.startsWith("/BACKUPS/files/"));
      assert.ok(record.rendered.scripts.includes("/assets/index.preview-layout-v1.js"));
      for (const script of record.rendered.scripts) assert.ok(Object.hasOwn(manifest.files, script.slice(1)), script);
      if (path.startsWith("/BACKUPS/files/")) {
        assert.equal(record.rendered.path, path);
        assert.deepEqual(record.rendered.names, ["source-café.txt"]);
      }
      const response = evidence.network.findLast(item => item.type === "Document" && item.url === origin + path);
      assert.ok(response, "The entrypoint must retain its real document response");
      assert.equal(response.status, 200);
      const headers = Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key.toLowerCase(), value]));
      assert.equal(headers["content-location"], "/preview-layout-v1/");
      assert.equal(headers["cache-control"], "no-store");
      assert.equal(headers["x-content-type-options"], "nosniff");
      assert.match(headers["content-type"], /^text\/html(?:;|$)/);
      assert.ok(headers["content-security-policy"]);
      policy ??= headers["content-security-policy"];
      assert.equal(headers["content-security-policy"], policy);
      const body = await cdp.call("Network.getResponseBody", { requestId: response.requestId });
      const bytes = Buffer.from(body.body, body.base64Encoded ? "base64" : "utf8");
      record.document = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), headers };
      assert.equal(bytes.length, manifest.files["preview-layout-v1/index.html"].bytes);
      assert.equal(record.document.sha256, manifest.files["preview-layout-v1/index.html"].sha256);
      const { data } = await cdp.call("Page.captureScreenshot", { format: "png" });
      await writeFile(new URL(`${records.length}.png`, artifacts), Buffer.from(data, "base64"));
      if (record.rendered.inheritedNotFound) {
        const recovered = await cdp.call("Runtime.evaluate", {
          expression: `(async () => {
            const link = [...document.querySelectorAll('.fullscreen a')].find(a => a.innerText.trim() === 'Go Home');
            if (!link) throw new Error('Missing inherited Go Home control');
            link.click();
            if (!document.querySelector('#q-app .q-layout')) await new Promise((resolve, reject) => {
              const finish = () => { observer.disconnect(); clearTimeout(timer); };
              const observer = new MutationObserver(() => {
                if (document.querySelector('#q-app .q-layout')) { finish(); resolve(); }
              });
              const timer = setTimeout(() => { finish(); reject(new Error('Go Home deadline exceeded')); }, 10000);
              observer.observe(document.body, {childList:true, subtree:true});
            });
            return location.pathname;
          })()`, allowUnsafeEvalBlockedByCSP: false, awaitPromise: true, returnByValue: true,
        });
        assert.equal(recovered.exceptionDetails, undefined, JSON.stringify(recovered.exceptionDetails));
        record.recoveredPath = recovered.result.value;
        assert.equal(record.recoveredPath, "/");
      }
      record.status = "pass";
    }
  } catch (error) {
    const record = records.at(-1);
    record.status = "fail";
    record.error = String(error).slice(0, 2048);
    throw error;
  } finally {
    await writeFile(new URL("results.json", artifacts), JSON.stringify(records, null, 2));
  }
}
