import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO1sAAAAASUVORK5CYII=", "base64");
const note = Buffer.from("Ordinary attachment café Ω\n");
const plain = "Unicode café Ω\n<b>preview-marker</b>\nlast-line";
const html = '<p>Unicode café Ω <b>preview-marker</b></p><p>last-line</p><img alt="local CID" src="cid:fixture-image"><img alt="remote blocked" src="https://email-image.example.invalid/ordinary.png">';
const address = { name: "Fixture", address: "fixture@example.invalid" };
const headers = ["From: Fixture <fixture@example.invalid>", "To: Reader <reader@example.invalid>", "MIME-Version: 1.0"];
const multipart = [
  ...headers, "Subject: Benign multipart email", 'Content-Type: multipart/mixed; boundary="fixture-mixed"', "",
  "--fixture-mixed", 'Content-Type: multipart/alternative; boundary="fixture-alternative"', "",
  "--fixture-alternative", "Content-Type: text/plain; charset=utf-8", "", plain,
  "--fixture-alternative", "Content-Type: text/html; charset=utf-8", "", html, "--fixture-alternative--",
  "--fixture-mixed", "Content-Type: image/png", "Content-Transfer-Encoding: base64", "Content-ID: <fixture-image>",
  'Content-Disposition: inline; filename="pixel.png"', "", png.toString("base64"),
  "--fixture-mixed", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64",
  'Content-Disposition: attachment; filename="note.txt"', "", note.toString("base64"), "--fixture-mixed--", "",
].join("\r\n");

export const inlineEmails = new Map([
  ["case-html-email.eml", [...headers, "Subject: Benign HTML email", "Content-Type: text/html; charset=utf-8", "", html].join("\r\n")],
  ["case-multipart-email.eml", multipart],
]);

export function seedFullEmails(state) {
  for (const [id, body] of [["plain", null], ["html", html]]) {
    // Existing stored-email JSON is the lazy route's input, not an enabled mail
    // receiver. No /api/emails route or hidden-prefix write permission is added.
    state.objects.set(`.r2-explorer/emails/inbox/${id}.json`, {
      bytes: Buffer.from(JSON.stringify({ subject: `Full ${id} email`, from: address,
        to: [{ name: "Reader", address: "reader@example.invalid" }], date: "2026-11-01T12:00:00.000Z",
        text: plain, html: body, attachments: body ? [
          { filename: "pixel.png", contentId: "<fixture-image>", mimeType: "image/png" },
          { filename: "note.txt", mimeType: "text/plain" },
        ] : [] })),
      httpMetadata: { contentType: "application/json" }, customMetadata: { read: "true" },
    });
  }
  for (const [name, bytes, contentType] of [["pixel.png", png, "image/png"], ["note.txt", note, "text/plain"]]) {
    state.objects.set(`.r2-explorer/emails/inbox/html/${name}`, { bytes, httpMetadata: { contentType } });
  }
}

export async function qualifyFullEmails(cdp, origin, evidence) {
  const artifacts = new URL("../artifacts/full-emails/", import.meta.url);
  await mkdir(artifacts, { recursive: true });
  const evaluate = async (body) => {
    const result = await cdp.call("Runtime.evaluate", {
      expression: `(async () => {
        const wait = (predicate, label) => new Promise((resolve, reject) => {
          const finish = () => { clearInterval(interval); clearTimeout(timer); };
          const check = () => { try { if (predicate()) { finish(); resolve(); } } catch (error) { finish(); reject(error); } };
          const interval = setInterval(check, 50);
          const timer = setTimeout(() => { finish(); reject(new Error(label)); }, 10000);
          check();
        });
        ${body}
      })()`, allowUnsafeEvalBlockedByCSP: false, awaitPromise: true, returnByValue: true,
    });
    if (result.exceptionDetails) assert.fail(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  evidence.fullEmails = [];
  for (const id of ["plain", "html"]) {
    const record = { id, status: "unverified" };
    evidence.fullEmails.push(record);
    const networkStart = evidence.network.length;
    const requestStart = evidence.requests.length;
    const failureStart = evidence.networkFailures.length;
    const consoleStart = evidence.console.length;
    try {
      const loaded = cdp.event("Page.loadEventFired");
      await cdp.call("Page.navigate", { url: `${origin}/BACKUPS/email/inbox/${Buffer.from(id + ".json").toString("base64")}` });
      await loaded;
      record.rendered = await evaluate(`
        await wait(() => document.querySelector('h5')?.textContent === ${JSON.stringify(`Full ${id} email`)}, 'Full email subject');
        await wait(() => [...document.querySelectorAll('button')].some(button => button.textContent.includes('mark_email_unread')), 'Stored read metadata');
        return {text:document.body.innerText, path:location.pathname, frames:document.querySelectorAll('iframe').length,
          lazyLoaded:performance.getEntriesByType('resource').some(resource => resource.name.endsWith('/assets/EmailFilePage.preview-layout-v1.js'))};
      `);
      assert.equal(record.rendered.lazyLoaded, true);
      for (const marker of ["fixture@example.invalid", "reader@example.invalid"]) assert.ok(record.rendered.text.includes(marker));
      if (id === "plain") {
        assert.equal(record.rendered.frames, 0);
        record.plain = await evaluate(`
          const body = document.querySelector('.email-wrapper');
          return {text:body.textContent, markupInterpreted:!!body.querySelector('b'), breaks:body.querySelectorAll('br').length};
        `);
        assert.equal(record.plain.text, "Unicode café Ωpreview-markerlast-line");
        assert.equal(record.plain.markupInterpreted, true, "Unchanged plain email still interprets markup; not an escaping claim");
        assert.equal(record.plain.breaks, 2);
      } else {
        record.frame = await evaluate(`
          const frame = () => document.querySelector('#renderWindow');
          await wait(() => frame()?.contentDocument?.body?.textContent.includes('preview-marker'), 'HTML email srcdoc');
          const image = () => frame().contentDocument.querySelector('img[alt="local CID"]');
          await wait(() => image()?.complete && image().naturalWidth === 1, 'Decoded CID image');
          const remote = () => frame().contentDocument.querySelector('img[alt="remote blocked"]');
          await wait(() => remote()?.complete, 'Remote image settles');
          const f = frame(), doc = f.contentDocument;
          const script = doc.createElement('script');
          script.textContent = 'window.__emailInline = true'; doc.body.append(script); script.remove();
          const button = doc.createElement('button'); button.setAttribute('onclick', 'window.__emailHandler = true');
          doc.body.append(button); button.click(); button.remove();
          let evalDenied = false;
          try { f.contentWindow.Function('return 7')(); } catch (error) { evalDenied = error.name === 'EvalError'; }
          await new Promise(resolve => setTimeout(resolve, 0));
          return {sandbox:[...f.sandbox], cspAttribute:f.getAttribute('csp'), srcdoc:f.srcdoc,
            violations:f.contentWindow.__policyEvents,
            text:doc.body.textContent, bold:!!doc.querySelector('b'),
            local:{url:image().src, width:image().naturalWidth, height:image().naturalHeight},
            remote:{url:remote().src, width:remote().naturalWidth},
            inlineDenied:!f.contentWindow.__emailInline, handlerDenied:!f.contentWindow.__emailHandler, evalDenied};
        `);
        assert.equal(record.rendered.frames, 1);
        assert.deepEqual(record.frame.sandbox.sort(), ["allow-popups", "allow-popups-to-escape-sandbox", "allow-same-origin"].sort());
        assert.equal(record.frame.cspAttribute, "script-src 'none'");
        assert.equal(record.frame.bold, true);
        assert.ok(record.frame.text.includes("Unicode café Ω"));
        for (const control of ["inlineDenied", "handlerDenied", "evalDenied"]) assert.equal(record.frame[control], true, control);
        assert.equal(record.frame.remote.width, 0, "Remote email imagery remains intentionally denied");
        // The srcdoc image can be blocked before the document-start DOM listener
        // observes it. Correlate engine events instead of accepting a blank image.
        const request = evidence.requests.slice(requestStart).find(event => event.url === record.frame.remote.url);
        assert.ok(request, "Remote image request must be identified");
        record.remoteDenial = {
          request,
          failure: evidence.networkFailures.slice(failureStart).find(event => event.requestId === request.requestId),
          console: evidence.console.slice(consoleStart).filter(entry => entry.source === "security" && entry.text.includes(record.frame.remote.url)),
        };
        assert.equal(record.remoteDenial.failure?.type, "Image");
        assert.equal(record.remoteDenial.failure?.blockedReason, "csp", "Remote denial must be enforced CSP, not a DNS failure");
        assert.ok(record.remoteDenial.console.some(entry => entry.text.includes("img-src") && entry.text.includes("The action has been blocked.")));
        assert.ok(!evidence.network.slice(networkStart).some(response => response.url === record.frame.remote.url));
        assert.equal(record.frame.local.height, 1);
        assert.ok(!record.frame.srcdoc.includes("cid:fixture-image"));
        const cid = evidence.network.slice(networkStart).findLast(response => response.url === record.frame.local.url);
        assert.ok(cid);
        assert.equal(cid.status, 200);
        assert.equal(cid.mimeType, "image/png");
        const cidBody = await cdp.call("Network.getResponseBody", { requestId: cid.requestId });
        const bytes = Buffer.from(cidBody.body, cidBody.base64Encoded ? "base64" : "utf8");
        record.cid = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
        assert.ok(bytes.equals(png));
        const attachment = await evaluate(`
          const card = [...document.querySelectorAll('.attachments .q-card')].find(card => card.textContent.includes('note.txt'));
          const button = card?.querySelector('button');
          if (!button) throw new Error('Attachment download button missing');
          button.scrollIntoView({block:'center'});
          const rect = button.getBoundingClientRect();
          return {x:rect.x+rect.width/2, y:rect.y+rect.height/2};
        `);
        const download = cdp.event("Page.downloadWillBegin");
        await cdp.call("Page.setDownloadBehavior", { behavior: "deny" });
        await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...attachment });
        await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...attachment });
        record.download = await download;
        assert.equal(record.download.suggestedFilename, "note.txt");
        assert.equal(record.download.url, `${origin}/api/buckets/BACKUPS/${Buffer.from('.r2-explorer/emails/inbox/html/note.txt').toString('base64')}`);
        record.attachment = await evaluate(`
          const response = await fetch(${JSON.stringify(record.download.url)});
          return {status:response.status, text:await response.text(), type:response.headers.get('content-type'),
            disposition:response.headers.get('content-disposition'), nosniff:response.headers.get('x-content-type-options'),
            policy:response.headers.get('content-security-policy')};
        `);
        assert.equal(record.attachment.status, 200);
        assert.equal(record.attachment.text, note.toString());
        assert.equal(record.attachment.type, "text/plain");
        assert.ok(record.attachment.disposition.startsWith("attachment;"));
        assert.equal(record.attachment.nosniff, "nosniff");
        assert.ok(record.attachment.policy.includes("sandbox"));
      }
      record.status = "pass";
    } catch (error) {
      record.status = "fail";
      record.error = String(error).slice(0, 4096);
    } finally {
      record.responses = evidence.network.slice(networkStart);
      const screenshot = await cdp.call("Page.captureScreenshot", { format: "png" });
      await writeFile(new URL(`${id}.png`, artifacts), Buffer.from(screenshot.data, "base64"));
      record.snapshot = await evaluate(`return {text:document.body.innerText.slice(-3000), path:location.pathname, violations:window.__policyEvents};`);
    }
  }
  await writeFile(new URL("results.json", artifacts), JSON.stringify(evidence.fullEmails, null, 2));
  assert.deepEqual(evidence.fullEmails.filter(record => record.status !== "pass"), [], "All authored full-email cases must qualify; no silent skip");
}
