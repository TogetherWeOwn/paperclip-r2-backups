import { test } from "node:test";
import assert from "node:assert/strict";
import { ControlError } from "../src/control-headers.ts";
import { CONTROL_LIMITS } from "../src/control-reader.ts";
import { VALIDATION_LIMITS, checkControl, decodedKey, parseControl } from "../src/control-validation.ts";

const encode = (s) => Buffer.from(s).toString("base64");
const bytes = (s) => new TextEncoder().encode(s);
const valid = () => ({ key: encode("db/example"), uploadId: "upload", parts: [{ etag: '"opaque"', partNumber: 1 }] });
const rejected = (status) => (e) => e instanceof ControlError && e.status === status;

test("control validation defaults", () => {
  assert.deepEqual(VALIDATION_LIMITS, {
    parts: 10000, etagBytes: 256, keyBytes: 1024, encodedKeyBytes: 4096, uploadIdBytes: 2048,
  });
});

test("folder budgets include the effective trailing separator", () => {
  checkControl("folder", { key: encode("a".repeat(1023)) });
  checkControl("folder", { key: encode("a".repeat(1023) + "/") });
  assert.throws(() => checkControl("folder", { key: encode("a".repeat(1024)) }), rejected(400));
  checkControl("folder", { key: encode("é".repeat(511) + "a") });
  assert.throws(() => checkControl("folder", { key: encode("é".repeat(512)) }), rejected(400));
});

test("bounded parsing preserves JSON semantics and rejects non-object roots", () => {
  for (const text of ["", "{", "null", "[]", "3", '"text"']) assert.throws(() => parseControl(bytes(text)), rejected(400));
  assert.deepEqual(parseControl(bytes('﻿{"a":1,"a":2}')), { a: 2 });
  assert.deepEqual(parseControl(Uint8Array.from([123, 34, 97, 34, 58, 34, 255, 34, 125])), { a: "�" });
});

test("cardinality precedes item access and item validation stops on first failure", () => {
  const parts = new Array(VALIDATION_LIMITS.parts + 1);
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
  body.parts = Array.from({ length: VALIDATION_LIMITS.parts }, (_, i) => ({ etag: "etag", partNumber: i + 1 }));
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
  const padded = encode("db/example").padEnd(4096);
  assert.equal(decodedKey(padded), "db/example");
  assert.equal(decodedKey(padded + " "), null);
});

test("fixed fields and metadata retain unknown-field stripping compatibility", () => {
  checkControl("copy", { sourceKey: encode("outside/source"), destinationKey: encode("db/destination"), extra: [] });
  checkControl("metadata", { customMetadata: { label: "value", nested: { a: [1, 2] } }, httpMetadata: {} });
  for (const customMetadata of [null, [], "text"]) {
    assert.throws(() => checkControl("metadata", { customMetadata, httpMetadata: {} }), rejected(400));
  }
  assert.throws(() => checkControl("move", { oldKey: encode("db/a"), newKey: {} }), rejected(400));
});
