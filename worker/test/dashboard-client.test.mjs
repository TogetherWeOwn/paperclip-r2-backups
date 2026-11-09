import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import worker from "../src/index.ts";
import { mockBucket, signedAccess, nodeRequest } from "./fixtures.mjs";
import { seedPreviews, qualifyPreviews } from "./preview-fixtures.mjs";

const root = new URL("../dashboard/", import.meta.url);

async function launchChrome(profile, evidence) {
  const startup = evidence.startup = {
    deadlineMs: 15_000, status: "starting", stdout: "", stderr: "", exitCode: null, signalCode: null,
  };
  const chrome = spawn(process.env.CHROME_BIN || "google-chrome", [
    "--headless=new", "--no-first-run", "--disable-background-networking",
    "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const started = performance.now();
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Chrome qualification startup deadline exceeded")), startup.deadlineMs);
      const finish = (fn, value) => { clearTimeout(timer); fn(value); };
      chrome.once("error", (error) => {
        startup.spawnErrorCode = error.code;
        finish(reject, new Error("Chrome unavailable: real-client qualification prerequisite is missing"));
      });
      chrome.once("exit", (code, signal) => {
        startup.exitCode = code;
        startup.signalCode = signal;
        finish(reject, new Error(`Chrome exited before qualification: ${startup.stderr}`));
      });
      for (const stream of ["stdout", "stderr"]) {
        chrome[stream].on("data", (chunk) => {
          startup[stream] = (startup[stream] + chunk).slice(-8192);
          const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(startup[stream]);
          if (match) finish(resolve, match[1]);
        });
      }
    });
    startup.status = "ready";
    return { chrome, url };
  } catch (error) {
    startup.status = "failed";
    startup.error = String(error).slice(0, 1024);
    startup.failureElapsedMs = Math.round(performance.now() - started);
    // Inspect a silent startup before terminating it. Exclude arguments and the
    // environment; only retain this browser's bounded process tree and wait state.
    if (chrome.pid) {
      try {
        const { stdout } = await promisify(execFile)("ps", ["-eo", "pid=,ppid=,stat=,etime=,time=,wchan:32=,comm="], {
          timeout: 1000, maxBuffer: 262144,
        });
        const rows = stdout.trim().split("\n").map((line) => {
          const [pid, ppid, stat, elapsed, cpu, wait, ...command] = line.trim().split(/\s+/);
          return { pid: Number(pid), ppid: Number(ppid), stat, elapsed, cpu, wait, command: command.join(" ").slice(0, 128) };
        });
        const selected = new Set([chrome.pid]);
        for (let depth = 0; depth < 8 && selected.size < 32; depth++) {
          for (const row of rows) {
            if (selected.has(row.ppid) && selected.size < 32) selected.add(row.pid);
          }
        }
        startup.processes = rows.filter((row) => selected.has(row.pid)).slice(0, 32);
      } catch (diagnosticError) {
        startup.processDiagnosticError = String(diagnosticError).slice(0, 256);
      }
    }
    if (chrome.exitCode === null && chrome.signalCode === null && chrome.pid) {
      const exited = once(chrome, "exit");
      chrome.kill("SIGKILL");
      await exited;
    }
    throw error;
  } finally {
    startup.elapsedMs = Math.round(performance.now() - started);
  }
}

async function connect(url) {
  const ws = new WebSocket(url);
  await once(ws, "open");
  let id = 0;
  const pending = new Map();
  const events = new Map();
  const listeners = new Map();
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
      for (const [name, listener] of listeners) {
        if (name === message.method) listener(message.params);
      }
      const event = events.get(message.method);
      if (event) { clearTimeout(event.timer); event.resolve(message.params); }
      events.delete(message.method);
    }
  });
  return {
    on(name, listener) { listeners.set(name, listener); },
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

test("the exact selected email-constructor derivative exercises all enabled API contracts and previews", async (t) => {
  const access = await signedAccess("dashboard-client");
  const jwt = await access.token();
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url, options) => String(url) === "https://dashboard-client.cloudflareaccess.com/cdn-cgi/access/certs" ? Response.json({ keys: [access.jwk] }) : realFetch(url, options));
  const state = mockBucket();
  const previews = seedPreviews(state);
  state.objects.set(".hidden", { bytes: new TextEncoder().encode("hidden") });
  const manifest = JSON.parse(await readFile(new URL("checksums.json", root), "utf8"));
  const derivative = JSON.parse(await readFile(new URL("email-constructor-v1/manifest.json", root), "utf8"));
  const routes = [];
  const failures = [];
  let origin;
  let pdfImageMode = "normal";
  const env = {
    BACKUPS: state.bucket, ACCESS_TEAM_NAME: access.team, ACCESS_AUD: "fixture-aud",
    ASSETS: { async fetch(request) {
      let path = new URL(request.url).pathname.slice(1);
      if (path === "email-constructor-v1/") path += "index.html";
      if (!path || !path.includes(".")) path = "index.html";
      if (path === "pdf-note-v1/annotation-note.svg") {
        const bytes = await readFile(new URL(path, root));
        if (pdfImageMode === "missing") return new Response("Not found", { status: 404 });
        if (pdfImageMode === "redirect") return Response.redirect(origin + "/index.html");
        if (pdfImageMode === "html") return new Response(await readFile(new URL("index.html", root)), { headers: { "content-type": "text/html" } });
        return new Response(pdfImageMode === "corrupt" ? Buffer.from(bytes).fill(32, 0, 1) : bytes, {
          headers: { "content-type": pdfImageMode === "mime" ? "text/html" : "image/svg+xml" },
        });
      }
      if (!Object.hasOwn(manifest.files, path) && !Object.hasOwn(derivative.files, path)) return new Response("Not found", { status: 404 });
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
      if (response.status >= 400) failures.push({ method: request.method, path: new URL(request.url).pathname, status: response.status, pdfImageMode });
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
  const browserEvidence = { network: [], console: [], exceptions: [], controls: null, version: null };
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    origin = `http://127.0.0.1:${server.address().port}`;
    launched = await launchChrome(profile, browserEvidence);
    const debugOrigin = new URL(launched.url);
    const target = await realFetch(`http://${debugOrigin.host}/json/new?about:blank`, { method: "PUT" }).then((r) => r.json());
    cdp = await connect(target.webSocketDebuggerUrl);
    await cdp.call("Page.enable");
    await cdp.call("Runtime.enable");
    await cdp.call("Log.enable");
    await cdp.call("Network.enable");
    await cdp.call("Network.setCacheDisabled", { cacheDisabled: true });
    browserEvidence.redirects = [];
    browserEvidence.networkFailures = [];
    cdp.on("Network.requestWillBeSent", ({ requestId, request, redirectResponse }) => {
      if (redirectResponse) browserEvidence.redirects.push({ requestId, from: redirectResponse.url, to: request.url, status: redirectResponse.status });
    });
    cdp.on("Network.loadingFailed", event => browserEvidence.networkFailures.push(event));
    browserEvidence.version = await cdp.call("Browser.getVersion");
    cdp.on("Network.responseReceived", ({ requestId, response, type }) => browserEvidence.network.push({ requestId, url: response.url, status: response.status, mimeType: response.mimeType, headers: response.headers, type }));
    cdp.on("Log.entryAdded", ({ entry }) => browserEvidence.console.push(entry));
    // EmailViewer catches parser errors, so exceptionThrown alone misses them.
    // Retain only this known fixture's parser diagnostic, never remote objects.
    browserEvidence.emailParserErrors = [];
    cdp.on("Runtime.consoleAPICalled", ({ type, args }) => {
      if (type !== "error" || args[0]?.value !== "Error parsing email data:" || browserEvidence.emailParserErrors.length >= 8) return;
      browserEvidence.emailParserErrors.push(args.slice(1, 3).map((arg) => ({
        type: arg.type, subtype: arg.subtype,
        message: String(arg.description || arg.value || "").split("\n", 1)[0].slice(0, 256),
      })));
    });
    cdp.on("Runtime.exceptionThrown", (event) => browserEvidence.exceptions.push(event));
    await cdp.call("Page.addScriptToEvaluateOnNewDocument", { source: `
      window.__policyEvents = [];
      document.addEventListener('securitypolicyviolation', e => window.__policyEvents.push({directive:e.effectiveDirective, blocked:e.blockedURI, disposition:e.disposition}));
    ` });
    await cdp.call("Emulation.setDeviceMetricsOverride", { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
    const loaded = cdp.event("Page.loadEventFired");
    await cdp.call("Page.navigate", { url: origin });
    await loaded;
    const controls = await cdp.call("Runtime.evaluate", {
      expression: `(async () => {
        if (!document.querySelector('#q-app .q-layout')) await new Promise((resolve, reject) => {
          const observer = new MutationObserver(() => {
            if (document.querySelector('#q-app .q-layout')) { observer.disconnect(); clearTimeout(timer); resolve(); }
          });
          const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Dashboard mount deadline exceeded')); }, 10000);
          observer.observe(document.body, {childList:true, subtree:true});
        });
        const script = document.createElement('script');
        script.textContent = 'window.__fixtureInline = true';
        document.body.append(script); script.remove();
        const button = document.createElement('button');
        button.setAttribute('onclick', 'window.__fixtureHandler = true');
        document.body.append(button); button.click(); button.remove();
        let evalDenied = false;
        try { Function('return 7')(); } catch (e) { evalDenied = e instanceof EvalError; }
        await new Promise(resolve => setTimeout(resolve, 0));
        return {inlineDenied: !window.__fixtureInline, handlerDenied: !window.__fixtureHandler, evalDenied,
          nativeResizeObserver: typeof ResizeObserver === 'function', userAgent: navigator.userAgent,
          appMounted: !!document.querySelector('#q-app .q-layout'), violations: window.__policyEvents};
      })()`,
      allowUnsafeEvalBlockedByCSP: false, awaitPromise: true, returnByValue: true,
    });
    assert.equal(controls.exceptionDetails, undefined, JSON.stringify(controls.exceptionDetails));
    browserEvidence.controls = controls.result.value;
    assert.equal(browserEvidence.controls.inlineDenied, true);
    assert.equal(browserEvidence.controls.handlerDenied, true);
    assert.equal(browserEvidence.controls.evalDenied, true);
    assert.equal(browserEvidence.controls.nativeResizeObserver, true);
    assert.equal(browserEvidence.controls.appMounted, true);
    for (const directive of ['script-src-elem', 'script-src-attr', 'script-src']) {
      assert.ok(browserEvidence.controls.violations.some(v => v.directive === directive && v.disposition === 'enforce'), directive);
    }
    const evaluated = await cdp.call("Runtime.evaluate", {
      expression: `(async () => {
        const app = document.querySelector('#q-app').__vue_app__;
        const m = await import('/assets/index.email-constructor-v1.js');
        const lazy = await import('/assets/EmailFilePage.email-constructor-v1.js');
        const graph = {sameApplication: document.querySelector('#q-app').__vue_app__ === app,
          sameMain: m === await import('/assets/index.email-constructor-v1.js'), lazyLoaded: !!lazy.default,
          scripts: performance.getEntriesByType('resource').filter(r => new URL(r.name).pathname.endsWith('.js')).map(r => new URL(r.name).pathname)};
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
        return {config, graph, listed: listed.objects.length, visible: visible.files.map(f => f.name), head: head.key,
          edited: edited.key, downloaded: new TextDecoder().decode(downloaded.data), slashKeys, complete};
      })()`,
      awaitPromise: true, returnByValue: true,
    });
    assert.equal(evaluated.exceptionDetails, undefined, JSON.stringify(evaluated.exceptionDetails));
    const result = evaluated.result.value;
    assert.equal(result.graph.sameApplication, true);
    assert.equal(result.graph.sameMain, true);
    assert.equal(result.graph.lazyLoaded, true);
    assert.ok(result.graph.scripts.includes("/assets/index.email-constructor-v1.js"));
    assert.ok(result.graph.scripts.includes("/assets/EmailFilePage.email-constructor-v1.js"));
    for (const path of result.graph.scripts) assert.ok(Object.hasOwn(derivative.files, path.slice(1)), path);
    browserEvidence.moduleGraph = result.graph;
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
    await qualifyPreviews(cdp, origin, previews, browserEvidence, mode => { pdfImageMode = mode; });
    assert.deepEqual(failures.filter(failure => failure.pdfImageMode === "normal"), [], "Ordinary click-driven previews must not introduce failed API/static requests");
    for (const failure of failures.filter(failure => failure.pdfImageMode !== "normal")) {
      assert.ok(["missing", "corrupt", "mime", "redirect", "html"].includes(failure.pdfImageMode));
      assert.equal(failure.path, "/BACKUPS/files/ZGIvcXVhbGlmaWNhdGlvbi8=/annotation-note.svg");
      assert.equal(failure.status, 500);
    }
    assert.deepEqual(browserEvidence.exceptions, [], "Click-driven previews must not introduce application runtime exceptions");
    assert.equal(new TextDecoder().decode(state.objects.get("db/qualification/case-text.txt").bytes), "saved UI marker");
  } finally {
    await mkdir(new URL("../artifacts/", import.meta.url), { recursive: true });
    if (cdp) {
      try {
        const screenshot = await cdp.call("Page.captureScreenshot", { format: "png" });
        await writeFile(new URL("../artifacts/dashboard-policy.png", import.meta.url), Buffer.from(screenshot.data, "base64"));
      } catch (error) { browserEvidence.captureError = String(error); }
    }
    await writeFile(new URL("../artifacts/dashboard-policy.json", import.meta.url), JSON.stringify(browserEvidence, null, 2));
    cdp?.close();
    if (launched?.chrome.exitCode === null && launched.chrome.signalCode === null) {
      const exited = once(launched.chrome, "exit");
      const timer = setTimeout(() => launched.chrome.kill("SIGKILL"), 3000);
      launched.chrome.kill("SIGTERM");
      try { await exited; } finally { clearTimeout(timer); }
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    // Chrome's profile-writing subprocess can outlive the parent briefly. Node's
    // bounded ENOTEMPTY retry handles that teardown race without hiding failures.
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    assert.ok(!launched || launched.chrome.exitCode !== null || launched.chrome.signalCode !== null, "Chrome process cleanup");
  }
});
