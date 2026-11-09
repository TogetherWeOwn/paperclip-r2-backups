import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONTROL_LIMITS, ControlError, checkControl, checkQuery, controlRoute, decodedKey,
  parseControl, readControl, replayControl, controlFailure,
} from "../src/control.ts";

const encode = (s) => Buffer.from(s).toString("base64");
const bytes = (s) => new TextEncoder().encode(s);
const valid = () => ({ key: encode("db/example"), uploadId: "upload", parts: [{ etag: '"opaque"', partNumber: 1 }] });
const limits = { bytes: 32, milliseconds: 100 };
const rejected = (status) => (e) => e instanceof ControlError && e.status === status;
function streamRequest(chunks, headers = {}, cancel = () => {}) {
  return new Request("https://console.example/api/buckets/BACKUPS/folder", {
    method: "POST", headers, duplex: "half",
    body: new ReadableStream({
      start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); },
      cancel,
    }),
  });
}

test("control defaults and inclusive byte boundaries", async () => {
  assert.deepEqual(CONTROL_LIMITS, {
    bytes: 4194304, milliseconds: 10000, parts: 10000, etagBytes: 256,
    keyBytes: 1024, encodedKeyBytes: 4096, uploadIdBytes: 2048,
    queryBytes: 8192, includes: 16, includeBytes: 64,
  });
  for (const count of [31, 32]) {
    const request = streamRequest([bytes(" ".repeat(count - 2) + "{}")]);
    const result = await readControl(request, limits);
    assert.equal(result.byteLength, count);
    assert.deepEqual(parseControl(result), {});
    assert.equal(request.body.locked, false);
  }
  for (const headers of [{}, { "content-length": "1" }]) {
    await assert.rejects(readControl(streamRequest([new Uint8Array(20), new Uint8Array(13)], headers), limits), rejected(413));
  }
});

test("headers cannot exempt actual bytes and rejection cancels before retention", async () => {
  for (const headers of [{ "content-length": "33" }, { "content-length": "2, 2" },
    { "content-length": "-1" }, { "content-length": "abc" }, { "content-encoding": "gzip" }]) {
    let cancelled = 0;
    const request = new Request("https://console.example", {
      method: "POST", headers, duplex: "half",
      body: new ReadableStream({ cancel() { cancelled++; } }, { highWaterMark: 0 }),
    });
    await assert.rejects(readControl(request, limits), (e) => e instanceof ControlError);
    assert.equal(cancelled, 1);
    assert.equal(request.body.locked, false);
  }
  let cancelled = 0;
  const request = new Request("https://console.example", {
    method: "POST", duplex: "half",
    body: new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(33)); },
      cancel() { cancelled++; return new Promise(() => {}); },
    }, { highWaterMark: 0 }),
  });
  await assert.rejects(readControl(request, limits), rejected(413));
  assert.equal(cancelled, 1);
  assert.equal(request.body.locked, false);
  const oneByteChunks = Array.from(bytes('{"a":1}'), (b) => Uint8Array.of(b));
  assert.deepEqual(parseControl(await readControl(streamRequest([new Uint8Array(), ...oneByteChunks]), limits)), { a: 1 });
});

test("stalled, aborted and failing streams have bounded cleanup", async () => {
  for (const abort of [false, true]) {
    let cancelled = 0;
    const controller = new AbortController();
    const request = new Request("https://console.example", {
      method: "POST", duplex: "half", signal: controller.signal,
      body: new ReadableStream({ cancel() { cancelled++; return new Promise(() => {}); } }),
    });
    const result = readControl(request, { bytes: 32, milliseconds: 5 });
    if (abort) controller.abort();
    await assert.rejects(result, rejected(abort ? 400 : 408));
    assert.equal(cancelled, 1);
    assert.equal(request.body.locked, false);
  }
  const request = new Request("https://console.example", {
    method: "POST", duplex: "half",
    body: new ReadableStream({ start(c) { c.error(new Error("private stream detail")); } }),
  });
  await assert.rejects(readControl(request, limits), rejected(400));
  assert.equal(request.body.locked, false);
});

test("bounded parsing preserves JSON semantics and rejects non-object roots", () => {
  for (const text of ["", "{", "null", "[]", "3", '"text"']) assert.throws(() => parseControl(bytes(text)), rejected(400));
  assert.deepEqual(parseControl(bytes('﻿{"a":1,"a":2}')), { a: 2 });
  assert.deepEqual(parseControl(Uint8Array.from([123, 34, 97, 34, 58, 34, 255, 34, 125])), { a: "�" });
});

test("cardinality precedes item access and item validation stops on first failure", () => {
  const parts = new Array(CONTROL_LIMITS.parts + 1);
  Object.defineProperty(parts, 0, { get() { assert.fail("item accessed"); } });
  assert.throws(() => checkControl("multipart/complete", { ...valid(), parts }), rejected(400));
  for (const parts of [null, {}, [], [null], [{ etag: 3, partNumber: 1 }]]) {
    assert.throws(() => checkControl("multipart/complete", { ...valid(), parts }), rejected(400));
  }
  const later = { get etag() { assert.fail("walk continued after failure"); } };
  assert.throws(() => checkControl("multipart/complete", { ...valid(), parts: [null, later] }), rejected(400));
  const body = valid();
  body.parts = [{ etag: "b", partNumber: 2 }, { etag: '"a"', partNumber: 1 }];
  checkControl("multipart/complete", body);
  assert.deepEqual(body.parts, [{ etag: "b", partNumber: 2 }, { etag: '"a"', partNumber: 1 }]);
  body.parts = Array.from({ length: CONTROL_LIMITS.parts }, (_, i) => ({ etag: "etag", partNumber: i + 1 }));
  checkControl("multipart/complete", body);
  assert.ok(bytes(JSON.stringify(body)).length < CONTROL_LIMITS.bytes);
});

test("bounded scalars count UTF-8 and preserve opaque values", () => {
  for (const partNumber of [0, 10001, 1.5, "1", null]) {
    assert.throws(() => checkControl("multipart/complete", { ...valid(), parts: [{ etag: "ok", partNumber }] }), rejected(400));
  }
  for (const [field, value] of [["uploadId", "é".repeat(1025)], ["key", encode("é".repeat(513))]]) {
    assert.throws(() => checkControl("multipart/complete", { ...valid(), [field]: value }), rejected(400));
  }
  const body = valid();
  body.uploadId = "é".repeat(1024);
  body.key = encode("é".repeat(512));
  body.parts = [{ etag: "é".repeat(128), partNumber: 10000 }];
  checkControl("multipart/complete", body);
  body.parts[0].etag += "a";
  assert.throws(() => checkControl("multipart/complete", body), rejected(400));
  assert.equal(decodedKey(encode("db/☃")), "db/☃");
  assert.equal(decodedKey("%%%"), null);
  assert.equal(decodedKey("a".repeat(4097)), null);
});

test("fixed fields and metadata retain unknown-field stripping compatibility", () => {
  checkControl("copy", { sourceKey: encode("outside/source"), destinationKey: encode("db/destination"), extra: [] });
  checkControl("metadata", { customMetadata: { label: "value", nested: { a: [1, 2] } }, httpMetadata: {} });
  for (const customMetadata of [null, [], "text"]) {
    assert.throws(() => checkControl("metadata", { customMetadata, httpMetadata: {} }), rejected(400));
  }
  assert.throws(() => checkControl("move", { oldKey: encode("db/a"), newKey: {} }), rejected(400));
});

test("query limits match repeated-name representation before downstream coercion", () => {
  const url = (q) => new URL(`https://console.example/api/buckets/BACKUPS?${q}`);
  checkQuery(url(Array(16).fill("include=httpMetadata").join("&")));
  assert.throws(() => checkQuery(url(Array(17).fill("include=httpMetadata").join("&"))), rejected(400));
  checkQuery(url("%69nclude=customMetadata&include=httpMetadata"));
  for (const q of ["include=httpMetadata,customMetadata", "include=%5B%22httpMetadata%22%5D", "include=", `include=${"é".repeat(33)}`]) {
    assert.throws(() => checkQuery(url(q)), rejected(400));
  }
  checkQuery(url(`x=${"a".repeat(8190)}`));
  assert.throws(() => checkQuery(url(`x=${"a".repeat(8191)}`)), rejected(400));
});

test("classification and replay do not clone or reuse the consumed stream", async () => {
  const base = "https://console.example/api/buckets/BACKUPS/";
  for (const route of ["move", "copy", "folder", "delete", "multipart/complete"]) {
    assert.equal(controlRoute("POST", new URL(base + route)), route);
  }
  assert.equal(controlRoute("POST", new URL(base + encode("db/file"))), "metadata");
  for (const route of ["upload", "multipart/create", "multipart/upload", "multipart/complete/"]) {
    assert.equal(controlRoute("POST", new URL(base + route)), null);
  }
  assert.equal(controlRoute("PUT", new URL(base + "folder")), null);
  const request = streamRequest([bytes('{"key":"ZGIvZmlsZQ=="}')], { "content-length": "1", "content-encoding": "identity", "x-example": "retained" });
  request.clone = () => assert.fail("original clone used");
  request.json = () => assert.fail("original JSON helper used");
  const result = await readControl(request, limits);
  const replay = replayControl(request, result);
  assert.equal(replay.headers.get("content-length"), null);
  assert.equal(replay.headers.get("content-encoding"), null);
  assert.equal(replay.headers.get("x-example"), "retained");
  assert.deepEqual(await replay.clone().json(), parseControl(result));
  assert.deepEqual(await replay.json(), parseControl(result));
  for (const status of [400, 408, 413, 415, 500]) {
    const response = controlFailure(status);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.ok(bytes(await response.text()).length <= 1024);
  }
});
