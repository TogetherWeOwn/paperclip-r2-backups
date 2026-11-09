import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";

const folder = "db/ui-contracts/";
const names = [".hidden.txt", ...Array.from({ length: 60 }, (_, i) => `item-${String(i).padStart(2, "0")}.txt`),
  "needle-café.txt", "needle-one.txt", "needle-two.txt"];

export function seedListing(state) {
  for (const name of [...names, "child/inside.txt"]) {
    state.objects.set(folder + name, { bytes: Buffer.from(`listing ${name}`), httpMetadata: { contentType: "text/plain" } });
  }
  const pages = [];
  const list = state.bucket.list.bind(state.bucket);
  state.bucket.list = async (options) => {
    const result = await list(options);
    if (!options.prefix?.startsWith(folder)) return result;
    // Apply deterministic small backend pages only to this corpus. The adapter
    // and pinned client still exchange the normal opaque R2 cursor unchanged.
    const rows = [...result.objects.map(object => ({ key: object.key, object })),
      ...result.delimitedPrefixes.map(key => ({ key }))].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    assert.ok(!options.cursor || /^ui-page-(25|50)$/.test(options.cursor));
    const offset = options.cursor ? Number(options.cursor.slice(8)) : 0;
    const page = rows.slice(offset, offset + 25);
    const truncated = offset + page.length < rows.length;
    const cursor = truncated ? `ui-page-${offset + page.length}` : undefined;
    pages.push({ prefix: options.prefix, delimiter: options.delimiter, include: options.include,
      inputCursor: options.cursor ?? null, outputCursor: cursor ?? null, truncated, keys: page.map(row => row.key) });
    return { ...result, objects: page.filter(row => row.object).map(row => row.object),
      delimitedPrefixes: page.filter(row => !row.object).map(row => row.key), truncated, cursor };
  };
  return pages;
}

export async function qualifyListing(cdp, origin, evidence, pages) {
  const artifacts = new URL("../artifacts/listing/", import.meta.url);
  await mkdir(artifacts, { recursive: true });
  const record = evidence.listing = { status: "unverified", pages, snapshots: {}, scrolls: [] };
  const evaluate = async (source) => {
    const result = await cdp.call("Runtime.evaluate", {
      expression: `(async () => {
        const filenames = () => [...document.querySelectorAll('tbody tr')].map(row => [...(row.querySelector('td')?.childNodes || [])]
          .filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join('').trim()).filter(Boolean);
        const settled = () => !document.querySelector('.q-table__progress') && !document.body.innerText.includes('Loading more files...');
        const wait = (predicate, label) => new Promise((resolve, reject) => {
          const finish = () => { clearInterval(interval); clearTimeout(timer); };
          const check = () => { try { if (predicate()) { finish(); resolve(); } } catch (error) { finish(); reject(error); } };
          const interval = setInterval(check, 50);
          const timer = setTimeout(() => { finish(); reject(new Error(label + ': ' + document.body.innerText.slice(-1500))); }, 10000);
          check();
        });
        ${source}
      })()`, allowUnsafeEvalBlockedByCSP: false, awaitPromise: true, returnByValue: true,
    });
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const screenshot = async (name) => {
    const { data } = await cdp.call("Page.captureScreenshot", { format: "png" });
    await writeFile(new URL(`${name}.png`, artifacts), Buffer.from(data, "base64"));
  };
  const search = async (text) => {
    await evaluate(`const input = document.querySelector('input[placeholder="Search by prefix..."]');
      if (!input) throw new Error('Pinned prefix search input missing'); input.focus(); input.select();`);
    await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
    await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
    if (text) await cdp.call("Input.insertText", { text });
    await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  };
  try {
    const loaded = cdp.event("Page.loadEventFired");
    await cdp.call("Page.navigate", { url: `${origin}/BACKUPS/files/${Buffer.from(folder).toString("base64")}` });
    await loaded;
    record.snapshots.first = await evaluate(`await wait(() => settled() && filenames().length === 24, 'First bounded page'); return filenames();`);
    assert.ok(!record.snapshots.first.some(name => name.startsWith(".")), "Hidden backend object is filtered by the actual client");
    await screenshot("first-page");
    for (const [page, count] of [[2, 49], [3, 64]]) {
      const scroll = await evaluate(`const container = [...document.querySelectorAll('div')].find(el => el.style.overflowY === 'auto' && el.style.height === '100vh');
        if (!container || container.scrollHeight <= container.clientHeight) throw new Error('Scrollable file page missing');
        const box = container.getBoundingClientRect(); return {x: Math.min(innerWidth - 30, box.right - 30), y: Math.min(innerHeight - 80, box.bottom - 80),
          top: container.scrollTop, height: container.scrollHeight, viewport: container.clientHeight,
          deltaY: Math.ceil(container.scrollHeight - container.clientHeight - container.scrollTop)};`);
      assert.ok(scroll.deltaY > 0, "Each page requires an actual downward scroll");
      record.scrolls.push({ page, ...scroll });
      // Stop at the current bottom: an oversized wheel can consume the next
      // appended page before its intermediate row-count assertion observes it.
      await cdp.call("Input.dispatchMouseEvent", { type: "mouseWheel", x: scroll.x, y: scroll.y, deltaX: 0, deltaY: scroll.deltaY });
      record.snapshots[`page${page}`] = await evaluate(`await wait(() => settled() && filenames().length === ${count}, 'Scroll-driven page ${page}'); return filenames();`);
    }
    const all = record.snapshots.page3;
    assert.equal(new Set(all).size, all.length, "No duplicate append across cursors");
    assert.deepEqual([...all].sort(), [...names.filter(name => !name.startsWith(".")), "child/"].sort());
    await evaluate(`await wait(() => document.body.innerText.includes('No more files to load'), 'Terminal page marker');`);
    assert.deepEqual(pages.slice(0, 3).map(page => [page.inputCursor, page.outputCursor, page.truncated]),
      [[null, "ui-page-25", true], ["ui-page-25", "ui-page-50", true], ["ui-page-50", null, false]]);
    assert.ok(pages[0].keys.includes(folder + ".hidden.txt"));
    for (const page of pages) {
      assert.equal(page.prefix, folder);
      assert.equal(page.delimiter, "/");
      assert.deepEqual([...page.include].sort(), ["customMetadata", "httpMetadata"]);
      assert.ok(page.keys.length <= 25);
    }
    await screenshot("last-page");
    // Scroll back before typing so the actual input is visible and focused.
    await evaluate(`document.querySelector('input[placeholder="Search by prefix..."]').scrollIntoView({block:'center'});`);
    await search("needle-");
    record.snapshots.search = await evaluate(`await wait(() => settled() && filenames().length === 3 && filenames().every(name => name.startsWith('needle-')), 'Prefix search'); return filenames();`);
    assert.deepEqual([...record.snapshots.search].sort(), names.filter(name => name.startsWith("needle-")).sort());
    assert.equal(pages.at(-1).prefix, folder + "needle-");
    assert.equal(pages.at(-1).inputCursor, null, "A changed search resets the old pagination cursor");
    await screenshot("prefix-search");
    await search("absent-prefix-");
    record.snapshots.empty = await evaluate(`await wait(() => settled() && filenames().length === 0 && document.body.innerText.includes('This folder is empty'), 'Empty search'); return filenames();`);
    assert.equal(pages.at(-1).prefix, folder + "absent-prefix-");
    assert.equal(pages.at(-1).inputCursor, null);
    await screenshot("empty-search");
    await search("");
    record.snapshots.reset = await evaluate(`await wait(() => settled() && filenames().length === 24, 'Search reset'); return filenames();`);
    assert.deepEqual(record.snapshots.reset, record.snapshots.first);
    assert.equal(pages.at(-1).prefix, folder);
    assert.equal(pages.at(-1).inputCursor, null);
    record.status = "pass";
  } catch (error) {
    record.status = "fail";
    record.error = String(error).slice(0, 2048);
    try { await screenshot("failure"); } catch (captureError) { record.captureError = String(captureError).slice(0, 256); }
    throw error;
  } finally {
    await writeFile(new URL("listing.json", artifacts), JSON.stringify(record, null, 2));
  }
}
