import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const execute = promisify(execFile);

export async function mediaFixtures(artifacts) {
  const directory = await mkdtemp(join(tmpdir(), "backup-media-fixtures-"));
  try {
    // Use only the runner's existing encoder. Never install a tool or download
    // sample media: both sources below are authored, finite lavfi signals.
    const { stdout } = await execute("ffmpeg", ["-version"], { timeout: 5000, maxBuffer: 65536 });
    const corpus = [];
    const receipts = { encoder: stdout.split("\n", 1)[0], files: [] };
    for (const [name, contentType, input, codec] of [
      ["case-audio.mp3", "audio/mpeg", "sine=frequency=440:sample_rate=44100:duration=1", ["-c:a", "libmp3lame", "-b:a", "64k"]],
      ["case-video.mp4", "video/mp4", "testsrc2=size=64x48:rate=10:duration=1", ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart"]],
    ]) {
      const path = join(directory, name);
      const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "1", "-f", "lavfi", "-i", input, ...codec, "-threads", "1", "-y", path];
      await execute("ffmpeg", args, { timeout: 10000, maxBuffer: 65536 });
      const bytes = await readFile(path);
      assert.ok(bytes.length > 100 && bytes.length < 65536, "Authored media stays below the fixture byte bound");
      corpus.push([name, bytes, contentType]);
      receipts.files.push({ name, contentType, source: input, args, bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex") });
      await writeFile(new URL(name, artifacts), bytes);
    }
    await writeFile(new URL("media-sources.json", artifacts), JSON.stringify(receipts, null, 2));
    return corpus;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function qualifyMedia(cdp, evaluate, name, record, responses, expected) {
  const tag = name.endsWith(".mp3") ? "audio" : "video";
  record.actual = await evaluate(`
    const media = () => document.querySelector('.q-dialog ${tag}');
    await wait(() => media()?.readyState >= 2 || !!media()?.error, 'Media decode');
    const element = media();
    if (element.error) throw new Error('Media decode error ' + element.error.code);
    const initial = {controls:element.controls, duration:element.duration, readyState:element.readyState,
      source:element.currentSrc, width:element.videoWidth || null, height:element.videoHeight || null};
    element.muted = true;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Media play deadline')), 10000);
      element.play().then(resolve, reject).finally(() => clearTimeout(timer));
    });
    await wait(() => element.currentTime > 0.1 && !element.paused, 'Media playback progression');
    const progressed = element.currentTime;
    element.pause();
    element.currentTime = 0.5;
    await wait(() => !element.seeking && Math.abs(element.currentTime - 0.5) < 0.05, 'Media seek');
    let pixels = null;
    if (${JSON.stringify(tag)} === 'video') {
      const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 48;
      const context = canvas.getContext('2d'); context.drawImage(element, 0, 0, 64, 48);
      const data = context.getImageData(0, 0, 64, 48).data;
      pixels = {colored:0, min:255, max:0};
      for (let i = 0; i < data.length; i += 4) {
        if (Math.max(data[i], data[i+1], data[i+2]) - Math.min(data[i], data[i+1], data[i+2]) > 30) pixels.colored++;
        pixels.min = Math.min(pixels.min, data[i], data[i+1], data[i+2]);
        pixels.max = Math.max(pixels.max, data[i], data[i+1], data[i+2]);
      }
    }
    return {...initial, progressed, paused:element.paused, seeked:element.currentTime,
      error:element.error?.code || null, pixels};
  `);
  assert.equal(record.actual.controls, true);
  assert.ok(record.actual.source.startsWith("blob:"), "Use the unchanged client's object-URL media path");
  assert.ok(record.actual.duration >= 0.9 && record.actual.duration <= 1.2);
  assert.ok(record.actual.progressed > 0.1);
  assert.equal(record.actual.paused, true);
  assert.ok(Math.abs(record.actual.seeked - 0.5) < 0.05);
  assert.equal(record.actual.error, null);
  if (tag === "video") {
    assert.equal(record.actual.width, 64);
    assert.equal(record.actual.height, 48);
    assert.ok(record.actual.pixels.colored > 100);
    assert.ok(record.actual.pixels.max - record.actual.pixels.min > 100, "Decoded video must contain the authored pattern, not a blank frame");
  }
  const response = responses.findLast(response => new URL(response.url).pathname === `/api/buckets/BACKUPS/${Buffer.from(expected.key).toString("base64")}`);
  assert.ok(response, "Media object request observed");
  const body = await cdp.call("Network.getResponseBody", { requestId: response.requestId });
  const bytes = Buffer.from(body.body, body.base64Encoded ? "base64" : "utf8");
  record.transfer = { status: response.status, mimeType: response.mimeType, bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"), equal: bytes.equals(expected.bytes) };
  assert.equal(record.transfer.status, 200);
  assert.equal(record.transfer.mimeType, expected.contentType);
  assert.equal(record.transfer.equal, true);
}
