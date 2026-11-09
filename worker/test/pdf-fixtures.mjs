import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

// Repackage the already-pinned Apache-licensed Roboto font for an authored PDF.
// WOFF stores the original sfnt tables; no new font, dependency or served asset.
async function embeddedFont() {
  const root = new URL("../dashboard/", import.meta.url);
  const path = "assets/KFOmCnqEu92Fr1Mu4mxM.f00fa16d.woff";
  const manifest = JSON.parse(await readFile(new URL("checksums.json", root), "utf8"));
  const woff = await readFile(new URL(path, root));
  assert.equal(createHash("sha256").update(woff).digest("hex"), manifest.files[path]);
  assert.equal(woff.toString("ascii", 0, 4), "wOFF");
  assert.equal(woff.readUInt32BE(4), 0x00010000, "TrueType sfnt flavor");
  const count = woff.readUInt16BE(12);
  assert.ok(count > 0 && count <= 64);
  const sfnt = Buffer.alloc(woff.readUInt32BE(16));
  sfnt.writeUInt32BE(woff.readUInt32BE(4), 0);
  sfnt.writeUInt16BE(count, 4);
  const power = Math.floor(Math.log2(count));
  sfnt.writeUInt16BE(16 * 2 ** power, 6);
  sfnt.writeUInt16BE(power, 8);
  sfnt.writeUInt16BE(16 * count - 16 * 2 ** power, 10);
  let offset = 12 + 16 * count;
  let head;
  for (let i = 0; i < count; i++) {
    const entry = 44 + 20 * i;
    const source = woff.readUInt32BE(entry + 4);
    const compressed = woff.readUInt32BE(entry + 8);
    const length = woff.readUInt32BE(entry + 12);
    const bytes = woff.subarray(source, source + compressed);
    const table = compressed < length ? inflateSync(bytes, { maxOutputLength: length }) : bytes;
    assert.equal(table.length, length);
    const target = 12 + 16 * i;
    woff.copy(sfnt, target, entry, entry + 4);
    sfnt.writeUInt32BE(woff.readUInt32BE(entry + 16), target + 4);
    sfnt.writeUInt32BE(offset, target + 8);
    sfnt.writeUInt32BE(length, target + 12);
    table.copy(sfnt, offset);
    if (woff.toString("ascii", entry, entry + 4) === "head") head = offset;
    offset += (length + 3) & ~3;
  }
  assert.equal(offset, sfnt.length);
  assert.notEqual(head, undefined);
  sfnt.writeUInt32BE(0, head + 8);
  let checksum = 0;
  for (let i = 0; i < sfnt.length; i += 4) checksum = (checksum + sfnt.readUInt32BE(i)) >>> 0;
  sfnt.writeUInt32BE((0xb1b0afba - checksum) >>> 0, head + 8);
  return sfnt;
}

export async function embeddedPdf() {
  const font = await embeddedFont();
  const stream = (bytes, fields = "") => {
    bytes = Buffer.from(bytes);
    return Buffer.concat([Buffer.from(`<< /Length ${bytes.length} ${fields} >>\nstream\n`), bytes, Buffer.from("\nendstream")]);
  };
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 8 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 9 0 R >>",
    `<< /Type /Font /Subtype /TrueType /BaseFont /Roboto-Regular /Encoding /WinAnsiEncoding /FirstChar 32 /LastChar 126 /Widths [${Array(95).fill(600).join(" ")}] /FontDescriptor 6 0 R >>`,
    "<< /Type /FontDescriptor /FontName /Roboto-Regular /Flags 32 /FontBBox [-665 -271 2000 1056] /ItalicAngle 0 /Ascent 928 /Descent -244 /CapHeight 711 /StemV 80 /FontFile2 7 0 R >>",
    stream(font, `/Length1 ${font.length}`),
    stream("BT /F1 20 Tf 30 240 Td (Embedded Roboto 0123456789) Tj ET"),
    // Mode 4 draws ordinary text and adds numeric glyph outlines to the path.
    // This naturally exercises FontFaceObject.getPathGenerator without disabling
    // fonts, changing PDF options, patching globals or authoring an exploit.
    stream("BT /F1 24 Tf 4 Tr 30 240 Td (0123456789) Tj ET"),
  ].map(object => Buffer.from(object));
  const chunks = [Buffer.from("%PDF-1.4\n")];
  const offsets = [0];
  let length = chunks[0].length;
  for (const [index, object] of objects.entries()) {
    offsets.push(length);
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from("\nendobj\n")]);
    chunks.push(chunk);
    length += chunk.length;
  }
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
    + offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")
    + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
  return Buffer.concat(chunks);
}

export async function cachedPdfProbe(cdp, functionId) {
  const properties = await cdp.call("Runtime.getProperties", { objectId: functionId });
  const scopes = properties.internalProperties.find(property => property.name === "[[Scopes]]")?.value.objectId;
  assert.ok(scopes, "Shipped glyph method retains inspectable closure scopes");
  const scopeList = await cdp.call("Runtime.getProperties", { objectId: scopes, ownProperties: true });
  for (const scope of scopeList.result.filter(property => /^\d+$/.test(property.name))) {
    const variables = await cdp.call("Runtime.getProperties", { objectId: scope.value.objectId, ownProperties: true });
    // In the pinned module, f is PDF.js's shared util module, not a test shim.
    const util = variables.result.find(property => property.name === "f")?.value.objectId;
    if (!util) continue;
    const result = await cdp.call("Runtime.callFunctionOn", {
      objectId: util, functionDeclaration: `function () {
        const probe = this.IsEvalSupportedCached;
        if (!probe) return null;
        const descriptor = Object.getOwnPropertyDescriptor(probe, 'value');
        return {cached: !!descriptor && Object.hasOwn(descriptor, 'value'), value: descriptor?.value};
      }`, returnByValue: true,
    });
    assert.equal(result.exceptionDetails, undefined);
    if (result.result.value) return result.result.value;
  }
  assert.fail("The real PDF.js cached eval probe was not inspectable; no inferred pass");
}
