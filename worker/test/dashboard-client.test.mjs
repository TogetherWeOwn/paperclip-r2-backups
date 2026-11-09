import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import worker from "../src/index.ts";
import { mockBucket, signedAccess, nodeRequest } from "./fixtures.mjs";

const root = new URL("../dashboard/", import.meta.url);

async function launchChrome(profile) {
  const chrome = spawn(process.env.CHROME_BIN || "google-chrome", [
    "--headless=new", "--no-first-run", "--disable-background-networking",
    "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let diagnostics = "";
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Chrome qualification startup deadline exceeded")), 15_000);
      const finish = (fn, value) => { clearTimeout(timer); fn(value); };
      chrome.once("error", () => finish(reject, new Error("Chrome unavailable: real-client qualification prerequisite is missing")));
      chrome.once("exit", () => finish(reject, new Error(`Chrome exited before qualification: ${diagnostics}`)));
      chrome.stderr.on("data", (chunk) => {
        diagnostics = (diagnostics + chunk).slice(-8192);
        const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(diagnostics);
        if (match) finish(resolve, match[1]);
      });
    });
    return { chrome, url };
  } catch (error) {
    if (chrome.exitCode === null && chrome.pid) { chrome.kill("SIGKILL"); await once(chrome, "exit"); }
    throw error;
  }
}

async function connect(url) {
  const ws = new WebSocket(url);
  await once(ws, "open");
  let id = 0;
  const pending = new Map();
  const events = new Map();
  ws.addEventListener("message", ({ data }) => {
    const message = JSON.parse(String(data));
    if (message.id) {
      const call = pending.get(message.id);
      if (!call) return;
      clearTimeout(call.timer);
      pending.delete(message.id);
      if (message.error) call.reject(new Error(message.error.message));
      else call.resolve(message.result);
    } else {
      const event = events.get(message.method);
      if (event) { clearTimeout(event.timer); event.resolve(message.params); }
      events.delete(message.method);
    }
  });
  return {
    call(method, params = {}) {
      return new Promise((resolve, reject) => {
        const key = ++id;
        const timer = setTimeout(() => { pending.delete(key); reject(new Error(`CDP ${method} deadline exceeded`)); }, 30_000);
        pending.set(key, { resolve, reject, timer });
        ws.send(JSON.stringify({ id: key, method, params }));
      });
    },
    event(name) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { events.delete(name); reject(new Error(`CDP ${name} deadline exceeded`)); }, 30_000);
        events.set(name, { resolve, timer });
      });
    },
    close() {
      for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error("Qualification closed")); }
      pending.clear();
      for (const event of events.values()) { clearTimeout(event.timer); event.resolve(); }
      events.clear();
      ws.close();
    },
  };
}

test("the exact unmodified dashboard client exercises all enabled API contracts", async (t) => {
  const access = await signedAccess("dashboard-client");
  const jwt = await access.token();
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url, options) => String(url) === "https://dashboard-client.cloudflareaccess.com/cdn-cgi/access/certs" ? Response.json({ keys: [access.jwk] }) : realFetch(url, options));
  const state = mockBucket();
  state.objects.set(".hidden", { bytes: new TextEncoder().encode("hidden") });
  const manifest = JSON.parse(await readFile(new URL("checksums.json", root), "utf8"));
  const routes = [];
  const failures = [];
  let origin;
  const env = {
    BACKUPS: state.bucket, ACCESS_TEAM_NAME: access.team, ACCESS_AUD: "fixture-aud",
    ASSETS: { async fetch(request) {
      let path = new URL(request.url).pathname.slice(1);
      if (!path || !path.includes(".")) path = "index.html";
      if (!Object.hasOwn(manifest.files, path)) return new Response("Not found", { status: 404 });
      const extension = path.split(".").pop();
      const types = { js: "text/javascript", css: "text/css", html: "text/html", svg: "image/svg+xml", png: "image/png", woff: "font/woff", woff2: "font/woff2", ico: "image/x-icon" };
      return new Response(await readFile(new URL(path, root)), { headers: { "content-type": types[extension] || "application/octet-stream" } });
    } },
  };
  const server = createServer(async (incoming, outgoing) => {
    try {
      const request = nodeRequest(incoming, origin, { "cf-access-jwt-assertion": jwt });
      if (incoming.url.startsWith("/api/")) routes.push({ method: request.method, path: new URL(request.url).pathname });
      const response = await worker.fetch(request, env, {});
      if (response.status >= 400) failures.push({ method: request.method, path: new URL(request.url).pathname, status: response.status });
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) Readable.fromWeb(response.body).pipe(outgoing);
      else outgoing.end();
    } catch {
      outgoing.writeHead(500); outgoing.end("Qualification fixture failed");
    }
  });
  const profile = await mkdtemp(join(tmpdir(), "backup-dashboard-chrome-"));
  let launched;
  let cdp;
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    origin = `http://127.0.0.1:${server.address().port}`;
    launched = await launchChrome(profile);
    const debugOrigin = new URL(launched.url);
    const target = await realFetch(`http://${debugOrigin.host}/json/new?about:blank`, { method: "PUT" }).then((r) => r.json());
    cdp = await connect(target.webSocketDebuggerUrl);
    await cdp.call("Page.enable");
    await cdp.call("Emulation.setDeviceMetricsOverride", { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
    const loaded = cdp.event("Page.loadEventFired");
    await cdp.call("Page.navigate", { url: origin });
    await loaded;
    const evaluated = await cdp.call("Runtime.evaluate", {
      expression: `(async () => {
        const m = await import('/assets/index.97b9144c.js');
        const config = (await m.a.get('/server/config')).data;
        const store = m.u();
        store.showHiddenFiles = config.config.showHiddenFiles;
        const file = new File(['pinned client bytes'], 'client.txt', {type: 'text/plain'});
        await m.G.createFolder('db/client', 'BACKUPS');
        await m.G.uploadObjects(file, 'db/client.txt', 'BACKUPS', () => {});
        const listed = (await m.G.listObjects('BACKUPS', 'db/', '/')).data;
        const visible = await m.G.fetchFilePage('BACKUPS', '', '/');
        const head = await m.G.headFile('BACKUPS', 'db/client.txt');
        await m.a.head('/buckets/BACKUPS/' + m.E('db/client.txt'));
        const edited = await m.G.updateMetadata('BACKUPS', 'db/client.txt', {read: false}, {contentType: 'text/plain'});
        await m.G.copyObject('BACKUPS', 'db/client.txt', 'db/copy.txt');
        await m.G.renameObject('BACKUPS', 'db/copy.txt', 'db/moved.txt');
        const downloaded = await m.G.downloadFile('BACKUPS', 'db/client.txt', {downloadType: 'blob'});
        const slashKeys = [];
        for (const key of ['db/???.txt', 'db/???', 'db/??????']) {
          await m.G.uploadObjects(file, key, 'BACKUPS', () => {});
          const slashHead = await m.G.headFile('BACKUPS', key);
          await m.a.head('/buckets/BACKUPS/' + m.E(key));
          const slashEdited = await m.G.updateMetadata('BACKUPS', key, {read: true}, {contentType: 'text/plain'});
          const slashDownloaded = await m.G.downloadFile('BACKUPS', key, {downloadType: 'blob'});
          slashKeys.push({key, head: slashHead.key, edited: slashEdited.key, text: new TextDecoder().decode(slashDownloaded.data)});
        }
        const upload = (await m.G.multipartCreate(file, 'db/parts.txt', 'BACKUPS')).data;
        const part = (await m.G.multipartUpload(upload.uploadId, 1, 'BACKUPS', 'db/parts.txt', file, () => {})).data;
        const complete = (await m.G.multipartComplete(file, 'db/parts.txt', 'BACKUPS', [part], upload.uploadId)).data;
        await m.G.deleteObject('db/moved.txt', 'BACKUPS');
        return {config, listed: listed.objects.length, visible: visible.files.map(f => f.name), head: head.key,
          edited: edited.key, downloaded: new TextDecoder().decode(downloaded.data), slashKeys, complete};
      })()`,
      awaitPromise: true, returnByValue: true,
    });
    assert.equal(evaluated.exceptionDetails, undefined, JSON.stringify(evaluated.exceptionDetails));
    const result = evaluated.result.value;
    assert.equal(result.config.dashboardVersion, "1.2.0");
    assert.equal(result.config.config.showHiddenFiles, false);
    assert.ok(result.listed > 0);
    assert.ok(result.visible.every((name) => !name.startsWith(".")));
    assert.equal(result.head, "db/client.txt");
    assert.equal(result.edited, "db/client.txt");
    assert.equal(result.downloaded, "pinned client bytes");
    assert.deepEqual(result.slashKeys, ["db/???.txt", "db/???", "db/??????"].map((key) => ({ key, head: key, edited: key, text: "pinned client bytes" })));
    assert.equal(result.complete.success, true);
    assert.equal(result.complete.str.key, "db/parts.txt");
    assert.deepEqual(failures, []);
    const expected = [
      ["GET", "/api/server/config"], ["GET", "/api/buckets/BACKUPS"],
      ...["move", "copy", "folder", "delete", "upload", "multipart/create", "multipart/upload", "multipart/complete"].map((path) => ["POST", `/api/buckets/BACKUPS/${path}`]),
      ["GET", "/api/buckets/BACKUPS/ZGIvY2xpZW50LnR4dA=="],
      ["HEAD", "/api/buckets/BACKUPS/ZGIvY2xpZW50LnR4dA=="],
      ["GET", "/api/buckets/BACKUPS/ZGIvY2xpZW50LnR4dA==/head"],
      ["POST", "/api/buckets/BACKUPS/ZGIvY2xpZW50LnR4dA=="],
    ];
    for (const [method, path] of expected) assert.ok(routes.some((route) => route.method === method && route.path === path), `${method} ${path}`);
    await mkdir(new URL("../artifacts/", import.meta.url), { recursive: true });
    await writeFile(new URL("../artifacts/dashboard-client.json", import.meta.url), JSON.stringify({ dashboardVersion: "1.2.0", routes, failures, result }, null, 2));
    const screenshot = await cdp.call("Page.captureScreenshot", { format: "png" });
    await writeFile(new URL("../artifacts/dashboard-client.png", import.meta.url), Buffer.from(screenshot.data, "base64"));
  } finally {
    cdp?.close();
    if (launched?.chrome.exitCode === null && launched.chrome.signalCode === null) { launched.chrome.kill("SIGKILL"); await once(launched.chrome, "exit"); }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(profile, { recursive: true, force: true });
    assert.ok(!launched || launched.chrome.exitCode !== null || launched.chrome.signalCode !== null, "Chrome process cleanup");
  }
});
