import { test } from "node:test";
import assert from "node:assert/strict";
import { checkControlHeaders, ControlError } from "../src/control-headers.ts";

function request(headers = {}, cancel = () => {}) {
  let pulls = 0;
  const body = new ReadableStream({ pull() { pulls++; }, cancel }, { highWaterMark: 0 });
  return { value: new Request("https://console.example", { method: "POST", headers, body, duplex: "half" }), pulls: () => pulls };
}

const rejected = (status) => (error) => error instanceof ControlError
  && error.status === status && error.message === "Control request rejected";

test("accepts absent or identity encoding and inclusive decimal lengths without reading", () => {
  for (const headers of [{}, { "content-encoding": " IdEnTiTy ", "content-length": "032" },
    { "content-length": "0" }, { "content-length": "1" }]) {
    const req = request(headers);
    assert.equal(checkControlHeaders(req.value, 32), undefined);
    assert.equal(req.pulls(), 0);
    assert.equal(req.value.body.locked, false);
  }
});

test("rejects unsupported encoding and malformed or oversized length before reading", () => {
  for (const [headers, status] of [
    [{ "content-encoding": "gzip" }, 415], [{ "content-encoding": "" }, 415],
    [{ "content-encoding": "identity, gzip" }, 415], [{ "content-length": "2, 2" }, 400],
    [{ "content-length": "-1" }, 400], [{ "content-length": "abc" }, 400],
    [{ "content-length": "" }, 400], [{ "content-length": "33" }, 413],
    [{ "content-length": "9".repeat(400) }, 413],
    [{ "content-encoding": "gzip", "content-length": "abc" }, 415],
  ]) {
    let cancelled = 0;
    const req = request(headers, () => { cancelled++; return new Promise(() => {}); });
    assert.throws(() => checkControlHeaders(req.value, 32), rejected(status));
    assert.equal(cancelled, 1);
    assert.equal(req.pulls(), 0);
    assert.equal(req.value.body.locked, false);
  }
});

test("missing bodies are rejected and cancellation failures do not replace status", async () => {
  assert.throws(() => checkControlHeaders(new Request("https://console.example"), 32), rejected(400));
  const req = request({ "content-length": "33" }, () => Promise.reject(new Error("private detail")));
  assert.throws(() => checkControlHeaders(req.value, 32), rejected(413));
  await Promise.resolve();
});
