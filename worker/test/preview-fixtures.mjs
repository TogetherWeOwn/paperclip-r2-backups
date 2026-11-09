import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { embeddedPdf, cachedPdfProbe, pdfComponentsExpression } from "./pdf-fixtures.mjs";
import { inlineEmails } from "./email-fixtures.mjs";

const folder = "db/qualification/";
const text = "Unicode café Ω\n<b>preview-marker</b>\nlast-line";
const email = [
  "From: Fixture <fixture@example.invalid>", "To: Reader <reader@example.invalid>",
  "Subject: Benign inline email", "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", text,
].join("\r\n");

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

export async function seedPreviews(state) {
  const corpus = [
    ["case-text.txt", text, "text/plain"],
    ["case-json.json", JSON.stringify({ message: text }), "application/json"],
    ["case-html.html", text, "text/html"],
    ["case-markdown.md", `# Heading\n\n${text}\n\n**ordinary-bold**`, "text/markdown"],
    ["case-csv.csv", "name,value\nUnicode café,<b>preview-marker</b>\nlast-line,7", "text/csv"],
    ["case-fallback.xyz", text, "application/octet-stream"],
    ["case-log.log.gz", gzipSync(text), "application/gzip"],
    ["case-email.eml", email, "message/rfc822"],
    ...[...inlineEmails].map(([name, body]) => [name, body, "message/rfc822"]),
    ["case-image.png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO1sAAAAASUVORK5CYII=", "base64"), "image/png"],
    ["case-pdf.pdf", ordinaryPdf(), "application/pdf"],
    ["case-embedded.pdf", await embeddedPdf(), "application/pdf"],
  ];
  for (const [name, body, contentType] of corpus) {
    state.objects.set(folder + name, { bytes: Buffer.from(body), httpMetadata: { contentType } });
  }
  const artifacts = new URL("../artifacts/previews/", import.meta.url);
  await mkdir(artifacts, { recursive: true });
  await writeFile(new URL("case-embedded.pdf", artifacts), state.objects.get(folder + "case-embedded.pdf").bytes);
  for (const prefix of ["", "instance/qualification/", "db/???/"]) {
    state.objects.set(prefix + "case-pdf.pdf", { bytes: ordinaryPdf(), httpMetadata: { contentType: "application/pdf" } });
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

function acceptAnnotationImages(images, responses, expectedUrl) {
  assert.ok(images.length > 0, "PDF annotation images observed");
  for (const image of images) {
    assert.equal(image.url, expectedUrl, "Unchanged renderer uses the selected same-origin relative URL");
    assert.equal(image.complete, true);
    assert.ok(image.width > 0 && image.height > 0, "Every observed PDF annotation image must decode; no missing-icon waiver");
    const response = responses.findLast(response => response.url === image.url);
    assert.ok(response, "Every image observation, including duplicates, correlates to a captured full response");
    assert.equal(response.status, 200);
    assert.equal(response.mimeType, "image/svg+xml");
    const headers = new Headers(response.headers);
    assert.equal(headers.get("content-type"), "image/svg+xml");
    assert.equal(headers.get("content-length"), "1083");
    assert.equal(headers.get("x-content-type-options"), "nosniff");
    assert.equal(headers.get("cache-control"), "no-store");
    assert.equal(headers.get("location"), null);
    assert.equal(response.redirects.length, 0);
    assert.equal(response.bytes, 1083);
    assert.equal(response.sha256, "f8e7b10e93f771ba1ef3a3c771bcbf59e5a3efe9832bef90baf1dbe9f66e1d07");
  }
}

export async function qualifyPreviews(cdp, origin, names, evidence, setPdfImageMode, { onlyEmbedded = false, artifactDirectory = "previews" } = {}) {
  const artifacts = new URL(`../artifacts/${artifactDirectory}/`, import.meta.url);
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
  const cases = [
    ...names.map(name => ({ name, prefix: folder, mode: "normal", id: name })),
    ...["", "instance/qualification/", "db/???/"].map((prefix, index) => ({ name: "case-pdf.pdf", prefix, mode: "normal", id: `pdf-folder-${index}` })),
    ...["missing", "corrupt", "mime", "redirect", "html"].map(mode => ({ name: "case-pdf.pdf", prefix: folder, mode, id: `pdf-control-${mode}` })),
  ].filter(record => !onlyEmbedded || record.name === "case-embedded.pdf");
  for (const { name, prefix, mode, id } of cases) {
    // Match Vue Router's parameter encoder: slash only, not encodeURIComponent's
    // %3D/%2B aliases. Root is the client's single-space sentinel.
    const parameter = Buffer.from(prefix || " ").toString("base64").replaceAll("/", "%2F");
    const url = `${origin}/BACKUPS/files/${parameter}`;
    setPdfImageMode(mode);
    const networkStart = evidence.network.length;
    const record = { name, id, url, mode, status: "unverified" };
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
          const canvases = () => [...document.querySelectorAll('#pdfvuer canvas')];
          const measure = (canvas, threshold = Infinity) => {
            if (!canvas.width || !canvas.height) return {width:canvas.width, height:canvas.height, ink:0};
            const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
            let ink = 0;
            for (let i = 0; i < pixels.length; i += 4) {
              if (pixels[i + 3] && pixels[i] < 200 && pixels[i + 1] < 200 && pixels[i + 2] < 200) ink++;
              if (ink > threshold) break;
            }
            return {width: canvas.width, height: canvas.height, ink};
          };
          // PDF.js sets data-loaded when drawing starts, before its asynchronous
          // paint task resolves. Require the same visible glyphs before sampling.
          await wait(() => canvases().length === 2 && canvases().every(canvas => measure(canvas, 100).ink > 100), 'Both PDF canvases contain visible glyphs');
          const pages = canvases().map(canvas => measure(canvas));
          return {pages, annotation: !!document.querySelector('#pdfvuer .annotationLayer'), workers: performance.getEntriesByType('resource').filter(r => /worker/i.test(r.name)).map(r => r.name)};
        `);
        assert.equal(record.actual.pages.length, 2);
        assert.ok(record.actual.pages.every((page) => page.width > 0 && page.height > 0 && page.ink > 100), "Both PDF canvases contain visible glyphs");
        if (name === "case-embedded.pdf") {
          record.fonts = await evaluate(`
            const components = ${pdfComponentsExpression};
            if (components.length !== 2 || components.some(component => !component.pdf)) throw new Error('PDF component state missing');
            const documentProxy = components[0].pdf;
            const worker = documentProxy.loadingTask._worker;
            const entries = Object.entries(documentProxy._transport.commonObjs._objs);
            const fonts = entries.filter(([, entry]) => entry.data?.compiledGlyphs).map(([id, entry]) => {
              const font = entry.data;
              const paths = entries.filter(([key]) => key.startsWith(font.loadedName + '_path_')).map(([, path]) => path.data);
              return {id, loadedName:font.loadedName, missingFile:font.missingFile, disableFontFace:font.disableFontFace,
                isEvalSupported:font.isEvalSupported, dataReleased:font.data === null,
                glyphs:Object.values(font.compiledGlyphs).map(glyph => glyph.toString()),
                numericPaths:paths.length > 0 && paths.every(path => path.every(operation =>
                  !operation.args || operation.args.every(argument => typeof argument === 'number' && Number.isFinite(argument))))};
            });
            const text = [];
            for (let number = 1; number <= 2; number++) {
              const page = await documentProxy.getPage(number);
              text.push((await page.getTextContent()).items.map(item => item.str).join(''));
            }
            await document.fonts.ready;
            return {fonts, text, fontExtraProperties:documentProxy._transport._params.fontExtraProperties,
              fakeWorker:!!worker && worker._webWorker === null && worker.port.constructor.name === 'LoopbackPort',
              fontFaces:[...document.fonts].filter(font => fonts.some(entry => font.family.replaceAll('"', '') === entry.loadedName))
                .map(font => ({family:font.family, status:font.status}))};
          `);
          assert.equal(record.fonts.fakeWorker, true, "The real PDF loading task uses the bundled loopback worker");
          assert.deepEqual(record.fonts.text, ["Embedded Roboto 0123456789", "0123456789"]);
          assert.ok(record.fonts.fonts.length > 0);
          assert.equal(record.fonts.fontExtraProperties, false, "No test override retains font debug data");
          assert.ok(record.fonts.fontFaces.length > 0 && record.fonts.fontFaces.every(font => font.status === "loaded"), "Embedded font faces actually load");
          for (const font of record.fonts.fonts) {
            assert.equal(font.missingFile, false);
            assert.equal(font.disableFontFace, false);
            // PDF.js releases raw font data after binding unless debug extras are enabled.
            // Loaded native faces and painted embedded text above prove the normal path.
            assert.equal(font.dataReleased, true);
            assert.equal(font.isEvalSupported, true, "No test override of the renderer's eval option");
            assert.equal(font.numericPaths, true);
            assert.ok(font.glyphs.length >= 10, "All ten numeric glyph paths were compiled by normal rendering");
            assert.ok(font.glyphs.every(source => source.includes(".apply(") && source.includes("q.cmd")), "Every cached glyph uses the shipped non-eval interpreter");
          }
          const glyphMethod = await cdp.call("Runtime.evaluate", {
            expression: `Object.values((${pdfComponentsExpression})[0].pdf._transport.commonObjs._objs)
              .find(entry => entry.data?.compiledGlyphs).data.getPathGenerator`,
            allowUnsafeEvalBlockedByCSP: false,
          });
          assert.equal(glyphMethod.exceptionDetails, undefined);
          record.evalProbe = await cachedPdfProbe(cdp, glyphMethod.result.objectId);
          assert.deepEqual(record.evalProbe, { cached: true, value: false }, "Inspect the actual cached PDF.js feature probe, not a substitute Function test");
          const measureResize = async (previousWidth) => evaluate(`
            const canvases = () => [...document.querySelectorAll('#pdfvuer canvas')];
            await wait(() => canvases().length === 2 && canvases().every(canvas => canvas.width > 0 && canvas.width !== ${previousWidth}), 'PDF resize dimensions');
            const ink = canvas => {
              if (!canvas.width || !canvas.height) return 0;
              const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
              let count = 0;
              for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] && pixels[i] < 200 && pixels[i + 1] < 200 && pixels[i + 2] < 200) count++;
              return count;
            };
            await wait(() => canvases().every(canvas => ink(canvas) > 100), 'PDF resize glyph painting');
            return canvases().map(canvas => ({width:canvas.width, height:canvas.height, ink:ink(canvas)}));
          `);
          const resizeLayout = () => evaluate(`
            const box = element => {
              const style = getComputedStyle(element);
              const rect = element.getBoundingClientRect();
              return {tag:element.tagName, id:element.id, class:element.className,
                width:rect.width, height:rect.height, clientWidth:element.clientWidth,
                scrollWidth:element.scrollWidth, minWidth:style.minWidth, overflow:style.overflow};
            };
            const components = ${pdfComponentsExpression};
            return {width:innerWidth, height:innerHeight, documentWidth:document.documentElement.clientWidth,
              dialog:[...document.querySelectorAll('.q-dialog__inner, .q-dialog .q-card, .q-dialog .q-card__section.scroll, #pdfvuer')].map(box),
              pages:components.map(component => ({scale:component.scale, resize:component.resize,
                container:box(component.$refs.container), viewport:{width:component.pdfViewer.viewport.width, height:component.pdfViewer.viewport.height},
                sensors:component.$.subTree.children[1].children.filter(node => node.component)
                  // Copy numeric fields: CDP serializes the nested reactive proxy as {}.
                  .map(node => ({size:{width:node.component.proxy.size.width, height:node.component.proxy.size.height}, box:box(node.component.proxy.$el),
                    scroll:[...node.component.proxy.$el.children].map(element => ({left:element.scrollLeft, top:element.scrollTop, width:element.scrollWidth, height:element.scrollHeight}))}))})),
              canvases:[...document.querySelectorAll('#pdfvuer canvas')].map(canvas => ({width:canvas.width, height:canvas.height}))};
          `);
          record.resizeLayout = {initial:await resizeLayout()};
          await evaluate(`await wait(() => document.getAnimations().every(animation => animation.playState !== 'running'), 'Settled preview transition');`);
          record.initialSettled = await measureResize(0);
          record.resizeLayout.initialSettled = await resizeLayout();
          assert.deepEqual(record.initialSettled.map(page => [page.width, page.height]), record.actual.pages.map(page => [page.width, page.height]), "Transition settling does not replace the initial baseline");
          const initialScreenshot = await cdp.call("Page.captureScreenshot", { format: "png" });
          await writeFile(new URL(`${id}-initial.png`, artifacts), Buffer.from(initialScreenshot.data, "base64"));
          try {
            await cdp.call("Emulation.setDeviceMetricsOverride", { width: 900, height: 700, deviceScaleFactor: 1, mobile: false });
            try {
              record.narrow = await measureResize(record.actual.pages[0].width);
            } finally {
              // Retain the actual narrow layout even when the dimension assertion
              // fails; restoring first hides viewport/container/sensor mismatches.
              record.resizeLayout.narrow = await resizeLayout();
              const screenshot = await cdp.call("Page.captureScreenshot", { format: "png" });
              await writeFile(new URL(`${id}-narrow.png`, artifacts), Buffer.from(screenshot.data, "base64"));
            }
          } finally {
            await cdp.call("Emulation.setDeviceMetricsOverride", { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
          }
          record.restored = await measureResize(record.narrow[0].width);
          record.resizeLayout.restored = await resizeLayout();
          assert.deepEqual(record.restored.map(page => [page.width, page.height]), record.actual.pages.map(page => [page.width, page.height]));
          const initial = record.resizeLayout.initialSettled;
          const narrow = record.resizeLayout.narrow;
          const restored = record.resizeLayout.restored;
          for (let index = 1; index < initial.dialog.length; index++) {
            assert.ok(narrow.dialog[index].clientWidth > 0 && narrow.dialog[index].clientWidth < initial.dialog[index].clientWidth, "Card, section and PDF layout boxes actually contract");
            assert.ok(narrow.dialog[index].scrollWidth <= narrow.dialog[index].clientWidth + 1, "No horizontally clipped preview content");
            assert.equal(restored.dialog[index].clientWidth, initial.dialog[index].clientWidth);
          }
          for (let index = 0; index < 2; index++) {
            const before = initial.pages[index], after = narrow.pages[index], back = restored.pages[index];
            assert.ok(Number.isFinite(after.scale) && after.scale > 0 && after.scale < before.scale);
            assert.ok(after.container.clientWidth < before.container.clientWidth);
            assert.equal(back.container.clientWidth, before.container.clientWidth);
            assert.equal(back.scale, before.scale);
            assert.ok(after.sensors.length > 0);
            for (let sensor = 0; sensor < after.sensors.length; sensor++) {
              assert.ok(after.sensors[sensor].box.clientWidth < before.sensors[sensor].box.clientWidth);
              assert.ok(after.sensors[sensor].size.width > 0 && after.sensors[sensor].size.width < before.sensors[sensor].size.width);
              assert.equal(back.sensors[sensor].box.clientWidth, before.sensors[sensor].box.clientWidth);
            }
            assert.ok(record.narrow[index].width < record.actual.pages[index].width);
          }
          assert.deepEqual(evidence.network.slice(networkStart).filter(response => response.type === "Worker" || /\.worker[.-]/i.test(response.url)), [], "No separately fetched real or remote PDF worker");
        } else {
          record.actual.annotationImages = await evaluate(`
            const images = () => [...document.querySelectorAll('#pdfvuer .annotationLayer img')];
            await wait(() => images().length > 0 && images().every(image => image.complete), 'PDF annotation image responses');
            return images().map(image => ({url:image.src, complete:image.complete, width:image.naturalWidth, height:image.naturalHeight}));
          `);
          const expectedImage = `${origin}/BACKUPS/files/${parameter}/annotation-note.svg`;
          const responses = evidence.network.slice(networkStart).filter(response => record.actual.annotationImages.some(image => image.url === response.url));
          record.actual.annotationResponses = [];
          for (const response of responses) {
            const body = await cdp.call("Network.getResponseBody", { requestId: response.requestId });
            // Only the authored annotation subresource is retained, not object bytes.
            const bytes = Buffer.from(body.body, body.base64Encoded ? "base64" : "utf8");
            record.actual.annotationResponses.push({ ...response, bytes: bytes.length,
              sha256: createHash("sha256").update(bytes).digest("hex"),
              redirects: evidence.redirects.filter(redirect => redirect.requestId === response.requestId) });
          }
          const accept = () => acceptAnnotationImages(record.actual.annotationImages, record.actual.annotationResponses, expectedImage);
          if (mode === "normal") accept();
          else {
            assert.ok(record.actual.annotationResponses.length > 0, "Controlled image failure retained its actual network response");
            assert.ok(record.actual.annotationResponses.every(response => response.status === 500));
            assert.throws(accept, assert.AssertionError, "The same passing-image helper must reject every backend failure control");
            record.rejectionControl = true;
          }
        }
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
        assert.equal(record.actual.markupInterpreted, name !== "case-html-email.eml", "Record actual plain-text markup interpretation versus HTML-to-text conversion; never claim escaping");
        if (inlineEmails.has(name)) {
          const subject = name === "case-html-email.eml" ? "Benign HTML email" : "Benign multipart email";
          for (const expected of [subject, "fixture@example.invalid", "reader@example.invalid", "Unicode café Ω", "last-line"]) {
            assert.ok(record.actual.text.includes(expected), expected);
          }
          if (name === "case-multipart-email.eml") {
            for (const expected of ["2 attachment(s)", "pixel.png", "note.txt"]) assert.ok(record.actual.text.includes(expected), expected);
          }
        }
        if (name.endsWith(".csv")) assert.ok(record.actual.html.includes("<table"));
        if (name.endsWith(".md")) assert.ok(record.actual.html.includes("<h1"));
      }
      if (name === "case-email.eml") {
        for (const expected of ["Benign inline email", "fixture@example.invalid", "reader@example.invalid", "Unicode café Ω", "preview-marker", "last-line"]) {
          assert.ok(record.actual.text.includes(expected), expected);
        }
        record.emailReady = await evaluate(`
          const content = document.querySelector('.q-dialog .q-card__section.scroll');
          return {spinner: !!content.querySelector('.q-spinner')};
        `);
        assert.equal(record.emailReady.spinner, false);
        const reopenPoint = await evaluate(`
          const close = [...document.querySelectorAll('.q-dialog button')].find(button => button.textContent.trim().toLowerCase().endsWith('close'));
          if (!close) throw new Error('Preview close button missing');
          close.click();
          await wait(() => !document.querySelector('.q-dialog'), 'Closed email preview');
          const row = [...document.querySelectorAll('tbody tr')].find(row => [...(row.querySelector('td')?.childNodes || [])]
            .filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join('').trim() === 'case-email.eml');
          if (!row) throw new Error('Email listing row missing on reopen');
          row.scrollIntoView({block:'center'});
          const rect = row.querySelector('td').getBoundingClientRect();
          return {x:rect.x + Math.min(40, rect.width / 2), y:rect.y + rect.height / 2};
        `);
        for (const clickCount of [1, 2]) {
          await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount, ...reopenPoint });
          await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount, ...reopenPoint });
        }
        record.reopened = await evaluate(`
          const content = () => document.querySelector('.q-dialog .q-card__section.scroll');
          await wait(() => content()?.textContent.includes('preview-marker'), 'Reopened parsed email');
          return {text:content().textContent, spinner:!!content().querySelector('.q-spinner'), path:location.pathname};
        `);
        assert.equal(record.reopened.text, record.actual.text);
        assert.equal(record.reopened.spinner, false);
        assert.equal(record.reopened.path, record.openedPath);
        assert.deepEqual(evidence.emailParserErrors, []);
        assert.deepEqual(evidence.exceptions, []);
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
      await writeFile(new URL(`${id}.png`, artifacts), Buffer.from(screenshot.data, "base64"));
      record.snapshot = await evaluate(`
        const dialog = document.querySelector('.q-dialog .q-card__section.scroll');
        return {path:location.pathname, text:document.body.innerText.slice(-3000),
          dialog: dialog ? {text:dialog.textContent.slice(0, 2048), html:dialog.innerHTML.slice(0, 4096)} : null,
          annotationImages:[...document.querySelectorAll('#pdfvuer .annotationLayer img')].slice(0, 8)
            .map(image => ({url:image.src, complete:image.complete, width:image.naturalWidth})),
          violations:window.__policyEvents};
      `);
      if (name.endsWith(".eml")) {
        const expectedEmail = inlineEmails.get(name) || email;
        record.parserErrors = evidence.emailParserErrors;
        try {
          const path = `/api/buckets/BACKUPS/${Buffer.from(folder + name).toString("base64")}`;
          const response = evidence.network.findLast(response => decodeURIComponent(new URL(response.url).pathname) === path);
          assert.ok(response, "Email object response was observed");
          const body = await cdp.call("Network.getResponseBody", { requestId: response.requestId });
          // Only authored small email fixtures are retrieved, never an arbitrary
          // object stream. Retain equality/count, not the transferred content.
          const bytes = Buffer.from(body.body, body.base64Encoded ? "base64" : "utf8");
          record.transfer = {status:response.status, mimeType:response.mimeType,
            bytes:bytes.length, expectedBytes:Buffer.byteLength(expectedEmail), equal:bytes.equals(Buffer.from(expectedEmail))};
          assert.equal(record.transfer.status, 200);
          assert.equal(record.transfer.mimeType, "message/rfc822");
          assert.equal(record.transfer.equal, true, "Email response preserves authored bytes");
        } catch (error) {
          record.status = "fail";
          record.transferError = String(error).slice(0, 1024);
          record.error ||= record.transferError;
        }
      }
    }
  }
  setPdfImageMode("normal");
  await writeFile(new URL("results.json", artifacts), JSON.stringify(evidence.previews, null, 2));
  const failed = evidence.previews.filter((record) => record.status !== "pass");
  assert.equal(failed.length, 0, `Every authored click-driven preview must qualify; no silent skip:\n${failed.map(record => `${record.name}: ${record.error}`).join("\n")}`);
}
