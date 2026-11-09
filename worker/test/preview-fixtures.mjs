import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";

const folder = "db/qualification/";
const text = "Unicode café Ω\n<b>preview-marker</b>\nlast-line";

// Authored ordinary PDF: two pages, standard-font fallback and a local annotation.
// Embedded-font and numeric-glyph-path qualification remain separate requirements.
function ordinaryPdf() {
  const stream = (body) => `<< /Length ${Buffer.byteLength(body)} >>\nstream\n${body}\nendstream`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R /Annots [8 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    stream("BT /F1 24 Tf 30 240 Td (PDF page one 0123456789) Tj ET"),
    stream("BT /F1 24 Tf 30 240 Td (PDF page two 9876543210) Tj ET"),
    "<< /Type /Annot /Subtype /Text /Rect [30 180 50 200] /Contents (Ordinary annotation) >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

export function seedPreviews(state) {
  const corpus = [
    ["case-text.txt", text, "text/plain"],
    ["case-json.json", JSON.stringify({ message: text }), "application/json"],
    ["case-html.html", text, "text/html"],
    ["case-markdown.md", `# Heading\n\n${text}\n\n**ordinary-bold**`, "text/markdown"],
    ["case-csv.csv", "name,value\nUnicode café,<b>preview-marker</b>\nlast-line,7", "text/csv"],
    ["case-fallback.xyz", text, "application/octet-stream"],
    ["case-log.log.gz", gzipSync(text), "application/gzip"],
    ["case-email.eml", [
      "From: Fixture <fixture@example.invalid>", "To: Reader <reader@example.invalid>",
      "Subject: Benign inline email", "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", text,
    ].join("\r\n"), "message/rfc822"],
    ["case-image.png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO1sAAAAASUVORK5CYII=", "base64"), "image/png"],
    ["case-pdf.pdf", ordinaryPdf(), "application/pdf"],
  ];
  for (const [name, body, contentType] of corpus) {
    state.objects.set(folder + name, { bytes: Buffer.from(body), httpMetadata: { contentType } });
  }
  // The generic adapter mock deliberately does not simulate listing semantics.
  // This UI fixture needs real prefix/delimiter filtering to verify navigation.
  const list = state.bucket.list.bind(state.bucket);
  state.bucket.list = async (options) => {
    const result = await list(options);
    const prefix = options.prefix || "";
    const prefixes = new Set();
    result.objects = result.objects.filter(({ key }) => {
      if (!key.startsWith(prefix)) return false;
      const rest = key.slice(prefix.length);
      const split = options.delimiter ? rest.indexOf(options.delimiter) : -1;
      if (split < 0) return true;
      prefixes.add(prefix + rest.slice(0, split + options.delimiter.length));
      return false;
    });
    return { ...result, delimitedPrefixes: [...prefixes] };
  };
  return corpus.map(([name]) => name);
}

export async function qualifyPreviews(cdp, origin, names, evidence) {
  const artifacts = new URL("../artifacts/previews/", import.meta.url);
  await mkdir(artifacts, { recursive: true });
  evidence.previews = [];
  const evaluate = async (expression) => {
    const result = await cdp.call("Runtime.evaluate", {
      expression: `(async () => {
        const wait = (predicate, label) => new Promise((resolve, reject) => {
          const finish = () => { clearInterval(interval); clearTimeout(timer); };
          const check = () => { try { if (predicate()) { finish(); resolve(true); } } catch (error) { finish(); reject(error); } };
          const interval = setInterval(check, 50);
          const timer = setTimeout(() => { finish(); reject(new Error(label + ': ' + document.body.innerText.slice(-1500))); }, 10000);
          check();
        });
        ${expression}
      })()`,
      allowUnsafeEvalBlockedByCSP: false, awaitPromise: true, returnByValue: true,
    });
    if (result.exceptionDetails) assert.fail(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const url = `${origin}/BACKUPS/files/${encodeURIComponent(Buffer.from(folder).toString("base64"))}`;
  for (const name of names) {
    const record = { name, url, status: "unverified" };
    evidence.previews.push(record);
    try {
      const loaded = cdp.event("Page.loadEventFired");
      await cdp.call("Page.navigate", { url });
      await loaded;
      const point = await evaluate(`
        const name = ${JSON.stringify(name)};
        // The name cell contains both an icon element and the filename text node.
        const filename = row => [...(row.querySelector('td')?.childNodes || [])]
          .filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join('').trim();
        const row = () => [...document.querySelectorAll('tbody tr')].find(row => filename(row) === name);
        await wait(() => !!row(), 'File listing');
        const selected = row();
        selected.scrollIntoView({block:'center'});
        const rect = selected.querySelector('td').getBoundingClientRect();
        return {x: rect.x + Math.min(40, rect.width / 2), y: rect.y + rect.height / 2};
      `);
      await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
      for (const clickCount of [1, 2]) {
        await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount, ...point });
        await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount, ...point });
      }
      record.openedPath = await evaluate(`
        await wait(() => !!document.querySelector('.q-dialog .q-card__section.scroll'), 'Preview dialog');
        await wait(() => decodeURIComponent(location.pathname).endsWith('/' + ${JSON.stringify(Buffer.from(name).toString("base64"))}), 'Selected file route');
        return location.pathname;
      `);
      if (name.endsWith(".pdf")) {
        record.actual = await evaluate(`
          await wait(() => document.querySelectorAll('#pdfvuer canvas').length === 2 && [...document.querySelectorAll('#pdfvuer .page')].every(page => page.dataset.loaded === 'true'), 'Two rendered PDF pages');
          const canvases = [...document.querySelectorAll('#pdfvuer canvas')];
          const pages = canvases.map(canvas => {
            const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
            let ink = 0;
            for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] && pixels[i] < 200 && pixels[i + 1] < 200 && pixels[i + 2] < 200) ink++;
            return {width: canvas.width, height: canvas.height, ink};
          });
          return {pages, annotation: !!document.querySelector('#pdfvuer .annotationLayer'), workers: performance.getEntriesByType('resource').filter(r => /worker/i.test(r.name)).map(r => r.name)};
        `);
        assert.equal(record.actual.pages.length, 2);
        assert.ok(record.actual.pages.every((page) => page.width > 0 && page.height > 0 && page.ink > 100), "Both PDF canvases contain visible glyphs");
      } else if (name.endsWith(".png")) {
        record.actual = await evaluate(`
          await wait(() => document.querySelector('.preview-image')?.naturalWidth === 1, 'Decoded local image');
          return {width: document.querySelector('.preview-image').naturalWidth};
        `);
        assert.equal(record.actual.width, 1);
      } else {
        record.actual = await evaluate(`
          const content = () => document.querySelector('.q-dialog .q-card__section.scroll');
          await wait(() => content()?.textContent.includes('preview-marker'), 'Preview semantic marker');
          return {text: content().textContent, markupInterpreted: !!content().querySelector('b'), html: content().innerHTML, path: location.pathname};
        `);
        assert.ok(record.actual.text.includes("preview-marker"));
        assert.equal(record.actual.markupInterpreted, true, "Pinned renderer still interprets inert markup; never claim escaping");
        if (name.endsWith(".csv")) assert.ok(record.actual.html.includes("<table"));
        if (name.endsWith(".md")) assert.ok(record.actual.html.includes("<h1"));
      }
      // Exercise the real edit/cancel/save UI on one ordinary managed text object.
      if (name === "case-text.txt") {
        record.edit = await evaluate(`
          const button = label => [...document.querySelectorAll('.q-dialog button')].find(button => button.textContent.trim().toLowerCase().endsWith(label));
          button('edit').click();
          await wait(() => !!document.querySelector('.q-dialog textarea'), 'Edit input');
          let input = document.querySelector('.q-dialog textarea');
          input.value = 'cancelled edit'; input.dispatchEvent(new Event('input', {bubbles:true}));
          button('cancel').click();
          await wait(() => !document.querySelector('.q-dialog textarea'), 'Cancelled edit');
          const cancelled = document.querySelector('.q-dialog').textContent.includes('preview-marker');
          button('edit').click();
          await wait(() => !!document.querySelector('.q-dialog textarea'), 'Second edit input');
          input = document.querySelector('.q-dialog textarea');
          input.value = 'saved UI marker'; input.dispatchEvent(new Event('input', {bubbles:true}));
          button('save').click();
          await wait(() => !document.querySelector('.q-dialog textarea') && document.querySelector('.q-dialog').textContent.includes('saved UI marker'), 'Saved edit');
          return {cancelled, saved: true};
        `);
        assert.deepEqual(record.edit, { cancelled: true, saved: true });
      }
      record.status = "pass";
    } catch (error) {
      record.status = "fail";
      record.error = String(error).slice(0, 4096);
    } finally {
      const screenshot = await cdp.call("Page.captureScreenshot", { format: "png" });
      await writeFile(new URL(`${name}.png`, artifacts), Buffer.from(screenshot.data, "base64"));
      record.snapshot = await evaluate(`return {path:location.pathname, text:document.body.innerText.slice(-3000), violations:window.__policyEvents};`);
    }
  }
  await writeFile(new URL("results.json", artifacts), JSON.stringify(evidence.previews, null, 2));
  const failed = evidence.previews.filter((record) => record.status !== "pass");
  assert.equal(failed.length, 0, `Every authored click-driven preview must qualify; no silent skip:\n${failed.map(record => `${record.name}: ${record.error}`).join("\n")}`);
}
