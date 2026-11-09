import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LIMITS, InputError, readControlJson, boundedString, completionParts, customMetadata,
  httpMetadata, decodeKey, decodeBase64, queryFor,
} from "../src/control-limits.ts";

const encoder = new TextEncoder();
const b64 = (text) => Buffer.from(text).toString("base64");
const invalid = (fn, status = 400) => assert.throws(fn, (error) => error instanceof InputError && error.status === status);

function input(chunks, headers = {}) {
  let index = 0;
  let cancelled = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (index === chunks.length) controller.close();
      else controller.enqueue(typeof chunks[index] === "string" ? encoder.encode(chunks[index++]) : chunks[index++]);
    },
    cancel() { cancelled++; },
  }, { highWaterMark: 0 });
  return { request: { headers: new Headers(headers), body }, cancelled: () => cancelled };
}

const small = { controlBytes: 16, controlTimeoutMs: 200 };

test("production limits retain the selected budgets", () => {
  assert.equal(LIMITS.controlBytes, 4_194_304);
  assert.equal(LIMITS.controlTimeoutMs, 10_000);
  assert.equal(LIMITS.parts, 10_000);
  assert.equal(LIMITS.etagBytes, 256);
  assert.equal(LIMITS.queryBytes, 8_192);
  assert.equal(LIMITS.customEntries, 128);
  assert.equal(LIMITS.customBytes, 8_192);
  assert.equal(LIMITS.httpBytes, 8_192);
  assert.equal(LIMITS.listObjects, 1_000);
});

test("actual-byte B-1, B and B+1 with missing and misleading lengths", async () => {
  for (const size of [15, 16, 17]) {
    for (const headers of [{}, { "content-length": "1" }, { "content-length": String(size) }]) {
      const text = JSON.stringify({ v: "x".repeat(size - 8) });
      assert.equal(encoder.encode(text).length, size);
      const { request } = input([text], headers);
      if (size <= small.controlBytes) assert.deepEqual(await readControlJson(request, small), JSON.parse(text));
      else await assert.rejects(readControlJson(request, small), { status: 413 });
      assert.equal(request.body.locked, false);
    }
  }
});

test("UTF-8 actual bytes count; many tiny and empty chunks do not accumulate references", async () => {
  const text = '{"v":"éééé"}';
  assert.equal(encoder.encode(text).length, 16);
  const bytes = encoder.encode(text);
  const { request } = input([...bytes].flatMap((byte) => [new Uint8Array(), Uint8Array.of(byte)]));
  assert.deepEqual(await readControlJson(request, small), { v: "éééé" });
  await assert.rejects(readControlJson(input([text + " "]).request, small), { status: 413 });
});

test("header rejection precedes reader acquisition", async () => {
  for (const headers of [
    { "content-length": "-1" }, { "content-length": "1.5" }, { "content-length": "bad" },
    { "content-length": "17" }, { "content-encoding": "gzip" },
  ]) {
    let cancelled = 0;
    const request = { headers: new Headers(headers), body: { cancel() { cancelled++; return Promise.resolve(); }, getReader() { assert.fail("reader acquired"); } } };
    await assert.rejects(readControlJson(request, small), InputError);
    assert.equal(cancelled, 1);
  }
});

test("large single chunk and chunked overflow cancel and release the reader", async () => {
  for (const chunks of [[new Uint8Array(17)], ["{", " ".repeat(15), "}"]]) {
    const source = input(chunks);
    await assert.rejects(readControlJson(source.request, small), { status: 413 });
    assert.equal(source.cancelled(), 1);
    assert.equal(source.request.body.locked, false);
  }
});

test("malformed JSON/UTF-8, non-record JSON and stream failure have fixed errors", async () => {
  for (const chunk of ["", "[1]", "null", "42", "{", Uint8Array.of(0xff)]) {
    await assert.rejects(readControlJson(input([chunk]).request, small), { message: "Invalid request", status: 400 });
  }
  const body = new ReadableStream({ pull(controller) { controller.error(new Error("private source detail")); } });
  await assert.rejects(readControlJson({ headers: new Headers(), body }, small), { message: "Invalid request", status: 400 });
  assert.equal(body.locked, false);
});

test("absolute deadline cancels a stalled source without awaiting cancel and clears timer", async (t) => {
  const timers = new Set();
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  t.mock.method(globalThis, "setTimeout", (fn, delay) => {
    const id = realSet(fn, delay);
    timers.add(id);
    return id;
  });
  t.mock.method(globalThis, "clearTimeout", (id) => { timers.delete(id); realClear(id); });
  let cancelled = 0;
  const body = new ReadableStream({
    pull() { return new Promise(() => {}); },
    cancel() { cancelled++; return new Promise(() => {}); },
  }, { highWaterMark: 0 });
  await assert.rejects(readControlJson({ headers: new Headers(), body }, { ...small, controlTimeoutMs: 15 }), { status: 408 });
  assert.equal(cancelled, 1);
  assert.equal(body.locked, false);
  assert.equal(timers.size, 0);
  await readControlJson(input(["{}"]).request, small);
  assert.equal(timers.size, 0);
});

test("already-resolved empty reads cannot starve the absolute deadline", async () => {
  let cancelled = 0;
  const body = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array()); },
    cancel() { cancelled++; },
  }, { highWaterMark: 0 });
  await assert.rejects(readControlJson({ headers: new Headers(), body }, { ...small, controlTimeoutMs: 15 }), { status: 408 });
  assert.equal(cancelled, 1);
});

test("multipart type/count validation precedes every item access", () => {
  for (const value of [null, {}, "parts", [], new Array(3)]) {
    if (Array.isArray(value) && value.length) Object.defineProperty(value, 0, { get() { assert.fail("item accessed"); } });
    invalid(() => completionParts(value, 2));
  }
  const parts = [{ etag: '"opaque"', partNumber: 7 }, { etag: "same", partNumber: 1 }];
  assert.deepEqual(completionParts(parts, 2), parts);
  assert.deepEqual(completionParts([{ etag: "same", partNumber: 1 }, { etag: "same", partNumber: 1 }], 2),
    [{ etag: "same", partNumber: 1 }, { etag: "same", partNumber: 1 }]);
});

test("multipart first failure, last failure, number and UTF-8 etag boundaries", () => {
  const untouched = { get etag() { assert.fail("validation continued"); } };
  invalid(() => completionParts([{ etag: 1, partNumber: 1 }, untouched]));
  invalid(() => completionParts([{ etag: "ok", partNumber: 1 }, { etag: "bad", partNumber: 0 }]));
  for (const number of [0, 10_001, 1.1, "1", NaN, Infinity]) invalid(() => completionParts([{ etag: "ok", partNumber: number }]));
  for (const number of [1, 10_000]) assert.equal(completionParts([{ etag: "ok", partNumber: number }])[0].partNumber, number);
  for (const bytes of [255, 256, 257]) {
    const etag = "x".repeat(bytes);
    if (bytes <= 256) assert.equal(completionParts([{ etag, partNumber: 1 }])[0].etag, etag);
    else invalid(() => completionParts([{ etag, partNumber: 1 }]));
  }
  invalid(() => completionParts([{ etag: "é".repeat(129), partNumber: 1 }]));
});

test("metadata K+1 counts own entries before getters; first invalid value stops", () => {
  const over = {};
  for (let i = 0; i < 3; i++) Object.defineProperty(over, `k${i}`, { enumerable: true, get() { assert.fail("value accessed"); } });
  invalid(() => customMetadata(over, 2));
  const inherited = Object.create({ notOwn: "ignored" });
  inherited.own = "valid";
  assert.deepEqual({ ...customMetadata(inherited, 1) }, { own: "valid" });
  const bad = { first: {} };
  Object.defineProperty(bad, "last", { enumerable: true, get() { assert.fail("continued past first failure"); } });
  invalid(() => customMetadata(bad));
});

test("metadata scalar, key, count and byte bounds", () => {
  assert.deepEqual({ ...customMetadata({ read: false, count: 2, text: "é" }) }, { read: "false", count: "2", text: "é" });
  assert.deepEqual({ ...customMetadata({ a: null }) }, { a: "null" });
  for (const value of [undefined, {}, [], NaN, Infinity]) invalid(() => customMetadata({ a: value }));
  for (const size of [127, 128, 129]) {
    if (size <= 128) customMetadata({ ["x".repeat(size)]: "" });
    else invalid(() => customMetadata({ ["x".repeat(size)]: "" }));
  }
  for (const size of [2047, 2048, 2049]) {
    if (size <= 2048) customMetadata({ a: "x".repeat(size) });
    else invalid(() => customMetadata({ a: "x".repeat(size) }));
  }
  const metadata = Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`k${i}`, ""]));
  customMetadata(metadata);
  invalid(() => customMetadata({ ...metadata, extra: "" }));
  const unsafe = JSON.parse('{"__proto__":"ordinary metadata"}');
  assert.equal(customMetadata(unsafe).__proto__, "ordinary metadata");
});

test("HTTP metadata field allowlist, scalar and Date/cacheExpiry conversion", () => {
  const iso = "2026-11-01T00:00:00.000Z";
  const values = { contentType: "text/plain", contentLanguage: "en", contentDisposition: "inline", contentEncoding: "gzip", cacheControl: "max-age=30", cacheExpiry: iso };
  assert.equal(httpMetadata(values).cacheExpiry.toISOString(), iso);
  assert.equal(httpMetadata({ cacheExpiry: new Date(iso) }).cacheExpiry.toISOString(), iso);
  for (const metadata of [{ cacheExpiry: "invalid" }, { cacheExpiry: new Date(NaN) }, { contentType: {} }, { contentType: "x\r\ny" }, { unknown: "x" }]) {
    invalid(() => httpMetadata(metadata));
  }
  for (const size of [1023, 1024, 1025]) {
    if (size <= 1024) httpMetadata({ contentType: "x".repeat(size) });
    else invalid(() => httpMetadata({ contentType: "x".repeat(size) }));
  }
});

test("query budget is raw UTF-8, repeats included, before coercion or decoding", () => {
  for (const bytes of [8191, 8192, 8193]) {
    const raw = "q=" + "x".repeat(bytes - 2);
    if (bytes <= 8192) assert.equal(queryFor(`https://console.test/?${raw}`).get("q").length, bytes - 2);
    else invalid(() => queryFor(`https://console.test/?${raw}`));
  }
  invalid(() => queryFor("https://console.test/?" + "x=%78&".repeat(1400)));
  invalid(() => queryFor("https://console.test/?q=" + "é".repeat(4096)));
});

test("decoded key and encoded/decoded metadata boundaries precede parse", () => {
  for (const bytes of [1023, 1024, 1025]) {
    if (bytes <= 1024) assert.equal(decodeKey(b64("x".repeat(bytes))).length, bytes);
    else invalid(() => decodeKey(b64("x".repeat(bytes))));
  }
  invalid(() => decodeKey(b64("é".repeat(513))));
  invalid(() => decodeKey("%bad"));
  invalid(() => decodeKey("/w=="));
  invalid(() => decodeKey(""));
  assert.equal(decodeKey("", true), "");
  for (const size of [3071, 3072, 3073]) {
    const text = "x".repeat(size);
    if (size <= 3072) assert.equal(decodeBase64(b64(text), 4096, 3072), text);
    else invalid(() => decodeBase64(b64(text), 4096, 3072));
  }
  invalid(() => boundedString("éé", 3));
});
