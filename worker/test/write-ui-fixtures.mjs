import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";

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
  const mutations = () => state.calls.filter(([operation, key]) =>
    ["put", "delete", "create", "resume"].includes(operation) && typeof key === "string" && key.startsWith(folder))
    .map(([operation, key]) => [operation, key]);
  const evaluate = async (source) => {
    const result = await cdp.call("Runtime.evaluate", {
      expression: `(async () => {
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
      })()`, allowUnsafeEvalBlockedByCSP: false, awaitPromise: true, returnByValue: true,
    });
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
    await evaluate(`const row = rows().find(row => filename(row) === ${JSON.stringify(name)});
      if (!row) throw new Error('Missing source row');
      const button = row.querySelector('button'); if (!button) throw new Error('Missing row menu'); button.click();
      await wait(() => document.querySelector('.q-menu .q-item'), 'File menu');
      click('.q-menu .q-item', ${JSON.stringify(action)});`);
  };
  const dialog = async (action) => evaluate(`await wait(() => control('.q-dialog button', ${JSON.stringify(action)}), 'Write dialog control');
    click('.q-dialog button', ${JSON.stringify(action)});`);
  const closed = async () => evaluate("await wait(() => !document.querySelector('.q-dialog'), 'Closed write dialog');");
  const names = async (expected) => {
    const actual = await evaluate(`await wait(() => !document.querySelector('.q-table__progress') &&
      JSON.stringify(names().sort()) === ${JSON.stringify(JSON.stringify([...expected].sort()))}, 'Updated file rows'); return names();`);
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
    const loaded = cdp.event("Page.loadEventFired");
    await cdp.call("Page.navigate", { url: `${origin}/BACKUPS/files/${Buffer.from(folder).toString("base64")}` });
    await loaded;
    await names([original]);
    assert.deepEqual(mutations(), []);

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
    record.status = "pass";
  } catch (error) {
    record.status = "fail";
    record.error = String(error).slice(0, 2048);
    try { await snapshot("failure"); } catch (captureError) { record.captureError = String(captureError).slice(0, 256); }
    throw error;
  } finally {
    await writeFile(new URL("write-ui.json", artifacts), JSON.stringify(record, null, 2));
  }
}
