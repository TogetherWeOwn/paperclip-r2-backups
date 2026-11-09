import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const folder = "db/ui-writes/";
const original = "source-café.txt";
const duplicate = "source-café (copy).txt";
const renamed = "renamed-Ω.txt";
const body = "Authored write UI bytes café Ω\n";
const metadata = { fixture: "write-ui", read: "false" };

export function seedWriteUi(state) {
  state.objects.set(folder + original, { bytes: Buffer.from(body),
    httpMetadata: { contentType: "text/plain" }, customMetadata: { ...metadata } });
}

export async function qualifyWriteUi(cdp, origin, evidence, state) {
  const artifacts = new URL("../artifacts/write-ui/", import.meta.url);
  await mkdir(artifacts, { recursive: true });
  const record = evidence.writeUi = { status: "unverified", steps: [] };
  const uploadDirectory = await mkdtemp(join(tmpdir(), "backup-dashboard-upload-"));
  const uploadName = "uploaded-café.txt";
  const uploadBytes = Buffer.from("Authored file chooser upload café Ω\n");
  const mutations = () => state.calls.filter(([operation, key]) =>
    ["put", "delete", "create", "resume"].includes(operation) && typeof key === "string" && key.startsWith(folder))
    .map(([operation, key]) => [operation, key]);
  const evaluate = async (source, values = []) => {
    const global = await cdp.call("Runtime.evaluate", { expression: "globalThis", allowUnsafeEvalBlockedByCSP: false });
    assert.equal(global.exceptionDetails, undefined);
    const result = await cdp.call("Runtime.callFunctionOn", {
      objectId: global.result.objectId,
      arguments: [{ value: values }],
      functionDeclaration: `async function(values) {
        const filename = row => [...(row.querySelector('td')?.childNodes || [])]
          .filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join('').trim();
        const rows = () => [...document.querySelectorAll('tbody tr')].filter(row => filename(row));
        const names = () => rows().map(filename);
        const wait = (predicate, label) => new Promise((resolve, reject) => {
          const finish = () => { clearInterval(interval); clearTimeout(timer); };
          const check = () => { try { if (predicate()) { finish(); resolve(); } } catch (error) { finish(); reject(error); } };
          const interval = setInterval(check, 50);
          const timer = setTimeout(() => { finish(); reject(new Error(label + ': ' + document.body.innerText.slice(-1500))); }, 10000);
          check();
        });
        const control = (selector, label) => [...document.querySelectorAll(selector)].find(el =>
          el.getBoundingClientRect().width > 0 && !el.disabled &&
          el.innerText.trim().toLowerCase().endsWith(label.toLowerCase()));
        const click = (selector, label) => {
          const element = control(selector, label);
          if (!element) throw new Error('Missing pinned control: ' + label);
          element.click();
        };
        ${source}
      }`, awaitPromise: true, returnByValue: true,
    }).finally(() => cdp.call("Runtime.releaseObject", { objectId: global.result.objectId }));
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const snapshot = async (step) => {
    record.steps.push({ step, names: await evaluate("return names();"), mutations: mutations(),
      dialog: await evaluate(`return [...document.querySelectorAll('.q-dialog .q-card')].map(card => ({
        text: card.textContent.slice(0, 2048), buttons: [...card.querySelectorAll('button')].map(button => ({
          text: button.textContent, visibleText: button.innerText, disabled: button.disabled,
          width: button.getBoundingClientRect().width })) }));`) });
    const { data } = await cdp.call("Page.captureScreenshot", { format: "png" });
    await writeFile(new URL(`${step}.png`, artifacts), Buffer.from(data, "base64"));
  };
  const menu = async (name, action) => {
    const point = await evaluate(`await wait(() => !document.querySelector('.q-menu'), 'Previous file menu closed');
      const row = rows().find(row => filename(row) === values[0]);
      if (!row) throw new Error('Missing source row');
      const button = row.querySelector('button'); if (!button) throw new Error('Missing row menu'); button.click();
      await wait(() => {
        const item = control('.q-menu .q-item', values[1]);
        if (!item) return false;
        const rect = item.getBoundingClientRect();
        return item.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
      }, 'File menu control');
      const rect = control('.q-menu .q-item', values[1]).getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };`, [name, action]);
    await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
    await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
    await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
    (record.fileMenuClicks ??= []).push({ name, action, ...point });
    await evaluate("await wait(() => !document.querySelector('.q-menu'), 'Selected file menu closed');");
  };
  const newMenu = async (action) => {
    const point = await evaluate(`await wait(() => control('button', 'New'), 'New button');
      click('button', 'New');
      await wait(() => {
        const item = control('.q-menu .q-item', values[0]);
        if (!item) return false;
        const rect = item.getBoundingClientRect();
        return item.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
      }, 'New menu control');
      const rect = control('.q-menu .q-item', values[0]).getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };`, [action]);
    await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
    await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
    await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
    (record.newMenuClicks ??= []).push({ action, ...point });
  };
  const enterName = async (value) => {
    await evaluate(`await wait(() => document.querySelector('.q-dialog input')?.getBoundingClientRect().width > 0, 'New name input');
      const input = document.querySelector('.q-dialog input'); input.focus(); input.select();`);
    await cdp.call("Input.insertText", { text: value });
  };
  const dialog = async (action) => evaluate(`await wait(() => control('.q-dialog button', values[0]), 'Write dialog control');
    click('.q-dialog button', values[0]);`, [action]);
  const closed = async () => evaluate("await wait(() => !document.querySelector('.q-dialog'), 'Closed write dialog');");
  const names = async (expected) => {
    const actual = await evaluate(`await wait(() => !document.querySelector('.q-table__progress') &&
      JSON.stringify(names().sort()) === JSON.stringify(values[0]), 'Updated file rows'); return names();`, [[...expected].sort()]);
    assert.deepEqual(actual.sort(), [...expected].sort());
  };
  const retained = (name) => {
    const object = state.objects.get(folder + name);
    assert.ok(object, name);
    assert.equal(Buffer.from(object.bytes).toString(), body);
    assert.deepEqual(object.customMetadata, metadata);
    assert.equal(object.httpMetadata.contentType, "text/plain");
  };
  try {
    await writeFile(join(uploadDirectory, uploadName), uploadBytes);
    const loaded = cdp.event("Page.loadEventFired");
    await cdp.call("Page.navigate", { url: `${origin}/BACKUPS/files/${Buffer.from(folder).toString("base64")}` });
    await loaded;
    await names([original]);
    assert.deepEqual(mutations(), []);

    record.download = { status: "unverified", progress: [] };
    const downloadRequestStart = evidence.requests.length;
    let downloadTimer;
    await cdp.call("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: uploadDirectory, eventsEnabled: true });
    try {
      const completed = new Promise((resolve, reject) => {
        downloadTimer = setTimeout(() => reject(new Error("File download completion deadline exceeded")), 10000);
        cdp.on("Browser.downloadProgress", event => {
          if (record.download.progress.length < 16) record.download.progress.push(event);
          if (event.state === "completed") resolve(event);
          if (event.state === "canceled") reject(new Error("File download canceled"));
        });
      });
      const [download, completion] = await Promise.all([
        cdp.event("Browser.downloadWillBegin"), completed, menu(original, "Download"),
      ]);
      assert.equal(download.suggestedFilename, original);
      assert.ok(download.url.startsWith(`blob:${origin}/`), "The pinned client downloads its fetched Blob, not a direct API navigation");
      assert.equal(completion.guid, download.guid);
      assert.equal(completion.receivedBytes, Buffer.byteLength(body));
      assert.equal(completion.totalBytes, Buffer.byteLength(body));
      assert.match(download.guid, /^[0-9a-f-]{36}$/i);
      const bytes = await readFile(join(uploadDirectory, download.guid));
      assert.deepEqual(bytes, Buffer.from(body), "The actual completed browser download preserves exact Unicode bytes");
      const objectUrl = `${origin}/api/buckets/BACKUPS/${Buffer.from(folder + original).toString("base64")}`;
      assert.ok(evidence.requests.slice(downloadRequestStart).some(({ url }) => url === objectUrl));
      const response = evidence.network.findLast(({ url }) => url === objectUrl);
      assert.equal(response.status, 200);
      assert.equal(response.mimeType, "text/plain");
      assert.equal(response.headers["X-Content-Type-Options"] || response.headers["x-content-type-options"], "nosniff");
      retained(original);
      assert.deepEqual(mutations(), [], "Downloading a file must not mutate storage");
      record.download = { ...record.download, status: "pass", suggestedFilename: download.suggestedFilename,
        bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), exactBody: true,
        completed: completion.state, objectUrl, blobUrl: download.url };
      await snapshot("file-download");
    } finally {
      clearTimeout(downloadTimer);
      await cdp.call("Browser.setDownloadBehavior", { behavior: "deny", eventsEnabled: false });
    }

    await menu(original, "Rename");
    await dialog("Cancel");
    await closed();
    await names([original]);
    retained(original);
    assert.deepEqual(mutations(), [], "Cancelling rename must not write or delete");
    await snapshot("rename-cancel");

    await menu(original, "Duplicate");
    await names([original, duplicate]);
    retained(original);
    retained(duplicate);
    assert.deepEqual(mutations(), [["put", folder + duplicate]]);
    await snapshot("duplicate");

    await menu(duplicate, "Rename");
    await evaluate(`await wait(() => document.querySelector('.q-dialog input'), 'Rename input');
      const input = document.querySelector('.q-dialog input'); input.focus(); input.select();`);
    await cdp.call("Input.insertText", { text: renamed });
    await dialog("Rename");
    await closed();
    await names([original, renamed]);
    retained(original);
    retained(renamed);
    assert.equal(state.objects.has(folder + duplicate), false);
    const afterRename = [["put", folder + duplicate], ["put", folder + renamed], ["delete", folder + duplicate]];
    assert.deepEqual(mutations(), afterRename, "Rename copies before deleting only the old key");
    await snapshot("rename");

    await menu(renamed, "Delete");
    await dialog("Cancel");
    await closed();
    await names([original, renamed]);
    retained(renamed);
    assert.deepEqual(mutations(), afterRename, "Cancelling deletion must not mutate storage");
    await snapshot("delete-cancel");

    await menu(renamed, "Delete");
    await dialog("Delete");
    await closed();
    await names([original]);
    retained(original);
    assert.equal(state.objects.has(folder + renamed), false);
    assert.deepEqual(mutations(), [...afterRename, ["delete", folder + renamed]]);
    await snapshot("delete");
    const afterDelete = mutations();

    await newMenu("New Folder");
    await enterName("cancelled-Ω");
    await dialog("Cancel");
    await closed();
    await names([original]);
    assert.deepEqual(mutations(), afterDelete, "Cancelling a new folder must not create its marker");
    await snapshot("folder-cancel");

    const child = "created-Ω/";
    await newMenu("New Folder");
    await enterName(child.slice(0, -1));
    await dialog("Create");
    await closed();
    await names([original, child]);
    assert.equal(state.objects.get(folder + child).bytes.length, 0);
    assert.deepEqual(mutations(), [...afterDelete, ["put", folder + child]]);
    await snapshot("folder-create");

    const folderPoint = await evaluate(`const row = rows().find(row => filename(row) === values[0]);
      if (!row) throw new Error('Missing created folder');
      row.scrollIntoView({ block: 'center' });
      const rect = row.querySelector('td').getBoundingClientRect();
      return { x: rect.x + Math.min(40, rect.width / 2), y: rect.y + rect.height / 2 };`, [child]);
    await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...folderPoint });
    for (const clickCount of [1, 2]) {
      await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount, ...folderPoint });
      await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount, ...folderPoint });
    }
    record.folderPath = await evaluate(`await wait(() => location.pathname === values[0] &&
      names().length === 0 && !document.querySelector('.q-table__progress'), 'Created folder navigation');
      return location.pathname;`, ['/BACKUPS/files/' + Buffer.from(folder + child).toString('base64')]);
    await snapshot("folder-open");

    await newMenu("New File");
    await enterName("cancelled.txt");
    await dialog("Cancel");
    await closed();
    await names([]);
    assert.deepEqual(mutations(), [...afterDelete, ["put", folder + child]]);
    await snapshot("file-cancel");

    const empty = "empty-café.txt";
    await newMenu("New File");
    await enterName(empty);
    await dialog("Create");
    await closed();
    await names([empty]);
    const emptyObject = state.objects.get(folder + child + empty);
    assert.equal(emptyObject.bytes.length, 0);
    assert.deepEqual(emptyObject.httpMetadata, { contentType: "text/plain" });
    assert.deepEqual(mutations(), [...afterDelete, ["put", folder + child], ["put", folder + child + empty]]);
    await snapshot("file-create");

    await cdp.call("Page.setInterceptFileChooserDialog", { enabled: true });
    try {
      const chooser = cdp.event("Page.fileChooserOpened");
      await newMenu("Upload Files");
      const { backendNodeId, mode } = await chooser;
      assert.equal(mode, "selectMultiple");
      await cdp.call("DOM.setFileInputFiles", { backendNodeId, files: [join(uploadDirectory, uploadName)] });
      await names([empty, uploadName]);
      await evaluate("await wait(() => document.body.innerText.includes('Files Uploaded!'), 'Completed upload notification');");
    } finally {
      await cdp.call("Page.setInterceptFileChooserDialog", { enabled: false });
    }
    const uploaded = state.objects.get(folder + child + uploadName);
    assert.deepEqual(Buffer.from(uploaded.bytes), uploadBytes);
    assert.deepEqual(uploaded.httpMetadata, { contentType: "text/plain" });
    const uploadRequest = evidence.requests.map(({ url }) => new URL(url)).find(url =>
      url.pathname === "/api/buckets/BACKUPS/upload" &&
      Buffer.from(url.searchParams.get("key") || "", "base64").toString() === folder + child + uploadName);
    assert.ok(uploadRequest, "The chooser must issue the expected raw upload request");
    assert.equal(uploadRequest.searchParams.has("customMetadata"), false, "The chooser omits the custom metadata query parameter");
    assert.equal(uploaded.customMetadata, undefined, "The adapter passes undefined for omitted custom metadata");
    const uploadedHead = await state.bucket.head(folder + child + uploadName);
    assert.deepEqual(uploadedHead.customMetadata, {}, "R2 object details normalize omitted custom metadata");
    assert.deepEqual(uploadedHead.httpMetadata, { contentType: "text/plain" });
    assert.equal(uploadedHead.size, uploadBytes.length);
    assert.deepEqual(mutations(), [...afterDelete, ["put", folder + child],
      ["put", folder + child + empty], ["put", folder + child + uploadName]]);
    retained(original);
    record.upload = { name: uploadName, bytes: uploadBytes.length, httpMetadata: uploadedHead.httpMetadata,
      customMetadataQueryPresent: uploadRequest.searchParams.has("customMetadata"),
      customMetadataOption: uploaded.customMetadata === undefined ? "undefined" : uploaded.customMetadata,
      customMetadata: uploadedHead.customMetadata, exactBody: true };
    await snapshot("file-upload");

    const client = await readFile(new URL("../dashboard/assets/index.preview-layout-v1.js", import.meta.url), "utf8");
    assert.ok(client.includes("Y=95*1024*1024;try{if(w.size>Y)"), "Use the unchanged pinned chooser threshold");
    const partBytes = 95 * 1024 * 1024;
    const largeName = "multipart-café.txt";
    const largeKey = folder + child + largeName;
    const largePath = join(uploadDirectory, largeName);
    const totalBytes = partBytes + 37;
    const input = await open(largePath, "wx");
    try {
      await input.truncate(totalBytes);
      for (const [offset, marker] of [[0, "start café"], [partBytes - 8, "boundary-Ω"], [totalBytes - 12, "end-marker"]]) {
        await input.write(Buffer.from(marker), 0, Buffer.byteLength(marker), offset);
      }
    } finally {
      await input.close();
    }
    const sourceHash = createHash("sha256");
    for await (const chunk of createReadStream(largePath)) sourceHash.update(chunk);
    const sha256 = sourceHash.digest("hex");
    const callStart = state.calls.length;
    const requestStart = evidence.requests.length;
    record.multipart = { status: "unverified", name: largeName, bytes: totalBytes, partBytes, sha256 };
    await cdp.call("Page.setInterceptFileChooserDialog", { enabled: true });
    try {
      const chooser = cdp.event("Page.fileChooserOpened");
      await newMenu("Upload Files");
      const { backendNodeId, mode } = await chooser;
      assert.equal(mode, "selectMultiple");
      await cdp.call("DOM.setFileInputFiles", { backendNodeId, files: [largePath] });
      await names([empty, uploadName, largeName]);
      await evaluate("await wait(() => document.body.innerText.includes('Files Uploaded!'), 'Completed multipart notification');");
    } finally {
      await cdp.call("Page.setInterceptFileChooserDialog", { enabled: false });
    }
    const multipartCalls = state.calls.slice(callStart).filter(([operation]) => ["create", "resume", "part", "complete", "put", "delete"].includes(operation));
    record.multipart.operations = multipartCalls.map(([operation]) => operation);
    assert.deepEqual(record.multipart.operations, ["create", "resume", "part", "resume", "part", "resume", "complete"]);
    const [[, createdKey, options], [, resumedKey, uploadId]] = multipartCalls;
    assert.equal(createdKey, largeKey);
    assert.equal(resumedKey, largeKey);
    assert.deepEqual(options.httpMetadata, { contentType: "text/plain" });
    assert.equal(options.customMetadata, undefined);
    for (const [, key, id] of multipartCalls.filter(([operation]) => operation === "resume")) {
      assert.equal(key, largeKey);
      assert.equal(id, uploadId);
    }
    const parts = state.pending.get(uploadId).parts;
    assert.deepEqual([...parts.keys()], [1, 2]);
    assert.deepEqual([...parts.values()].map(bytes => bytes.length), [partBytes, 37]);
    assert.deepEqual(multipartCalls.at(-1)[1], [{ partNumber: 1, etag: "part-1" }, { partNumber: 2, etag: "part-2" }]);
    const stored = state.objects.get(largeKey);
    assert.equal(stored.bytes.length, totalBytes);
    assert.equal(createHash("sha256").update(stored.bytes).digest("hex"), sha256);
    const largeHead = await state.bucket.head(largeKey);
    assert.equal(largeHead.size, totalBytes);
    assert.deepEqual(largeHead.httpMetadata, { contentType: "text/plain" });
    assert.deepEqual(largeHead.customMetadata, {});
    const requests = evidence.requests.slice(requestStart).map(({ url }) => new URL(url))
      .filter(url => url.pathname.startsWith("/api/buckets/BACKUPS/multipart/"));
    assert.deepEqual(requests.map(url => url.pathname.split("/").at(-1)), ["create", "upload", "upload", "complete"]);
    for (const url of requests.slice(0, 3)) assert.equal(Buffer.from(url.searchParams.get("key"), "base64").toString(), largeKey);
    assert.deepEqual(requests.slice(1, 3).map(url => url.searchParams.get("partNumber")), ["1", "2"]);
    for (const url of requests.slice(1, 3)) assert.equal(url.searchParams.get("uploadId"), uploadId);
    retained(original);
    record.multipart = { ...record.multipart, status: "pass", partSizes: [partBytes, 37],
      completedParts: multipartCalls.at(-1)[1], httpMetadata: largeHead.httpMetadata,
      customMetadata: largeHead.customMetadata, exactBody: true };
    await snapshot("multipart-upload");

    const reloaded = cdp.event("Page.loadEventFired");
    await cdp.call("Page.navigate", { url: `${origin}/BACKUPS/files/${Buffer.from(folder).toString("base64")}` });
    await reloaded;
    await names([original, child]);
    const beforeMetadata = mutations();
    await menu(original, "Update Metadata");
    await dialog("Cancel");
    await closed();
    retained(original);
    assert.deepEqual(mutations(), beforeMetadata, "Cancelling metadata must not rewrite the object");
    await snapshot("metadata-cancel");

    await menu(original, "Update Metadata");
    await evaluate(`await wait(() => [...document.querySelectorAll('.q-dialog input')].some(input => input.value === 'read'), 'Metadata fields');
      const key = [...document.querySelectorAll('.q-dialog input')].find(input => input.value === 'read');
      const input = key.closest('.flex.row').querySelectorAll('input')[1];
      if (input.value !== 'false') throw new Error('Missing original metadata value');
      input.focus(); input.select();`);
    await cdp.call("Input.insertText", { text: "true" });
    const metadataCallStart = state.calls.length;
    const metadataRequestStart = evidence.network.length;
    await dialog("Update Metadata");
    await closed();
    await names([original, child]);
    await evaluate("await wait(() => document.body.innerText.includes('File Updated!'), 'Completed metadata notification');");
    const updated = state.objects.get(folder + original);
    assert.deepEqual(Buffer.from(updated.bytes), Buffer.from(body), "Metadata editing must preserve exact downloaded Unicode bytes");
    assert.deepEqual(updated.customMetadata, { ...metadata, read: "true" });
    assert.deepEqual(updated.httpMetadata, { contentType: "text/plain" });
    assert.deepEqual(mutations(), [...beforeMetadata, ["put", folder + original]]);
    const metadataCalls = state.calls.slice(metadataCallStart).filter(([operation]) => ["get", "put", "delete"].includes(operation));
    assert.deepEqual(metadataCalls.map(([operation, key]) => [operation, key]), [["get", folder + original], ["put", folder + original]]);
    const metadataUrl = `${origin}/api/buckets/BACKUPS/${Buffer.from(folder + original).toString("base64")}`;
    const metadataResponse = evidence.network.slice(metadataRequestStart).find(({ url }) => url === metadataUrl);
    assert.equal(metadataResponse?.status, 200);
    const metadataHead = await state.bucket.head(folder + original);
    assert.deepEqual(metadataHead.customMetadata, { ...metadata, read: "true" });
    assert.deepEqual(metadataHead.httpMetadata, { contentType: "text/plain" });
    assert.equal(metadataHead.size, Buffer.byteLength(body));
    record.metadata = { status: "pass", customMetadata: metadataHead.customMetadata,
      httpMetadata: metadataHead.httpMetadata, bytes: metadataHead.size,
      sha256: createHash("sha256").update(updated.bytes).digest("hex"), exactBody: true,
      operations: metadataCalls.map(([operation]) => operation), responseStatus: metadataResponse.status };
    await snapshot("metadata-update");
    record.status = "pass";
  } catch (error) {
    record.status = "fail";
    record.error = String(error).slice(0, 2048);
    try { await snapshot("failure"); } catch (captureError) { record.captureError = String(captureError).slice(0, 256); }
    throw error;
  } finally {
    await rm(uploadDirectory, { recursive: true, force: true });
    record.uploadInputCleanup = "removed";
    await writeFile(new URL("write-ui.json", artifacts), JSON.stringify(record, null, 2));
  }
}
