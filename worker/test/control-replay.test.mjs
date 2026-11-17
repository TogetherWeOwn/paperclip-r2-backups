import { test } from "node:test";
import assert from "node:assert/strict";
import { readControl } from "../src/control-reader.ts";
import { replayControl } from "../src/control-replay.ts";
import { parseControl } from "../src/control-validation.ts";

const url = "https://console.example/api/buckets/BACKUPS/folder?include=httpMetadata";

test("replay preserves request properties and exact consumed bytes without cloning the original", async () => {
  const bytes = new TextEncoder().encode('{"key":"ZGIvZmlsZQ==", "value":"☃"}');
  const controller = new AbortController();
  const request = new Request(url, {
    method: "POST", redirect: "manual", signal: controller.signal, duplex: "half",
    headers: { "content-length": "1", "content-encoding": "identity", "x-example": "retained", "content-type": "application/json" },
    body: new ReadableStream({
      start(stream) { stream.enqueue(bytes.subarray(0, 5)); stream.enqueue(bytes.subarray(5)); stream.close(); },
    }),
  });
  request.clone = () => assert.fail("original clone used");
  request.json = () => assert.fail("original JSON helper used");
  const result = await readControl(request, { bytes: 128, milliseconds: 1000 });
  assert.equal(request.bodyUsed, true);
  const replay = replayControl(request, result);
  assert.notEqual(replay.body, request.body);
  assert.equal(replay.method, request.method);
  assert.equal(replay.url, request.url);
  assert.equal(replay.redirect, request.redirect);
  assert.equal(replay.headers.get("content-length"), null);
  assert.equal(replay.headers.get("content-encoding"), null);
  assert.equal(replay.headers.get("x-example"), "retained");
  assert.equal(replay.headers.get("content-type"), "application/json");
  assert.equal(request.headers.get("content-length"), "1");
  assert.equal(request.headers.get("content-encoding"), "identity");
  assert.deepEqual(await replay.clone().json(), parseControl(result));
  assert.deepEqual(new Uint8Array(await replay.arrayBuffer()), bytes);
  controller.abort();
  assert.equal(replay.signal.aborted, true);
});

test("already aborted signals propagate to replay", () => {
  const controller = new AbortController();
  controller.abort("cancelled");
  const request = new Request(url, { method: "POST", body: "{}", signal: controller.signal });
  const replay = replayControl(request, new TextEncoder().encode("{}"));
  assert.equal(replay.signal.aborted, true);
  assert.equal(replay.signal.reason, "cancelled");
});
