import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { CONTROL_LIMITS, ControlError, readControl } from "../src/control-reader.ts";

const parseBytes = (value) => JSON.parse(new TextDecoder().decode(value));
const bytes = (s) => new TextEncoder().encode(s);
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
    bytes: 4194304, milliseconds: 10000,
  });
  for (const count of [31, 32]) {
    const request = streamRequest([bytes(" ".repeat(count - 2) + "{}")]);
    const result = await readControl(request, limits);
    assert.equal(result.byteLength, count);
    assert.deepEqual(parseBytes(result), {});
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
  assert.deepEqual(parseBytes(await readControl(streamRequest([new Uint8Array(), ...oneByteChunks]), limits)), { a: 1 });
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

test("read bookkeeping is independent of chunk count", async () => {
  const race = mock.method(Promise, "race");
  try {
    const chunks = Array.from(bytes(" ".repeat(62) + "{}"), (b) => Uint8Array.of(b));
    assert.deepEqual(parseBytes(await readControl(streamRequest(chunks), { bytes: 128, milliseconds: 100 })), {});
    assert.ok(race.mock.callCount() <= 1, "do not attach a pending interruption reaction per chunk");
  } finally { race.mock.restore(); }
});

test("reader storage grows with actual bytes and returns an exact-size buffer", async () => {
  const NativeUint8Array = Uint8Array;
  const allocations = [];
  const small = streamRequest([bytes("{}")], { "content-length": "1" });
  const chunks = [new NativeUint8Array(1024), new NativeUint8Array(1025), new NativeUint8Array(4096)];
  const growing = streamRequest(chunks);
  const allocation = mock.method(globalThis, "Uint8Array", new Proxy(NativeUint8Array, {
    construct(target, args) {
      if (typeof args[0] === "number") allocations.push(args[0]);
      return Reflect.construct(target, args);
    },
  }));
  try {
    const result = await readControl(small);
    assert.equal(result.buffer.byteLength, 2, "small replay must not retain the body budget");
    assert.ok(allocations.every((size) => size <= 1024), "small controls must not reserve the body budget");
    allocations.length = 0;
    const grown = await readControl(growing, { bytes: 8192, milliseconds: 100 });
    assert.equal(grown.byteLength, 6145);
    assert.equal(grown.buffer.byteLength, 6145);
    assert.deepEqual(grown, new NativeUint8Array(6145));
    assert.ok(allocations.length <= 4, "growth must not retain bookkeeping per chunk");
    assert.ok(allocations.every((size) => size <= 8192));
  } finally { allocation.mock.restore(); }
});

test("identity encoding is accepted without cloning or parsing the request", async () => {
  const request = streamRequest([bytes('{}')], { "content-encoding": " IdEnTiTy " });
  request.clone = () => { throw new Error("clone must not be used"); };
  request.json = () => { throw new Error("json must not be used"); };
  assert.deepEqual(parseBytes(await readControl(request, limits)), {});
  assert.equal(request.body.locked, false);
});

test("deadline is enforced when a pending read completes before the timer callback", async () => {
  for (const chunk of [null, bytes('{}')]) {
    let now = 0;
    const request = new Request("https://console.example", {
      method: "POST", duplex: "half",
      body: new ReadableStream({ pull(c) { now = 5; if (chunk) c.enqueue(chunk); else c.close(); } }, { highWaterMark: 0 }),
    });
    const clock = mock.method(Date, "now", () => now);
    try { await assert.rejects(readControl(request, { bytes: 32, milliseconds: 5 }), rejected(408)); }
    finally { clock.mock.restore(); }
    assert.equal(request.body.locked, false);
  }
});

test("a read rejection after the deadline reports timeout", async () => {
  let now = 0;
  const request = new Request("https://console.example", {
    method: "POST", duplex: "half",
    body: new ReadableStream({ pull(c) { now = 5; c.error(new Error("private detail")); } }, { highWaterMark: 0 }),
  });
  const clock = mock.method(Date, "now", () => now);
  try { await assert.rejects(readControl(request, { bytes: 32, milliseconds: 5 }), rejected(408)); }
  finally { clock.mock.restore(); }
  assert.equal(request.body.locked, false);
});

test("absolute read deadline also covers a finite sequence of empty chunks", async () => {
  const req = streamRequest(Array.from({ length: 32 }, () => new Uint8Array()));
  let now = 0;
  const clock = mock.method(Date, "now", () => ++now);
  try { await assert.rejects(readControl(req, { bytes: 32, milliseconds: 5 }), rejected(408)); }
  finally { clock.mock.restore(); }
  assert.equal(req.body.locked, false);
});
