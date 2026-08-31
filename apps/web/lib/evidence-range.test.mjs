import assert from "node:assert/strict";
import test from "node:test";

import { parseEvidenceByteRange } from "./evidence-range.ts";

test("evidence range parser supports browser audio byte requests", () => {
  assert.equal(parseEvidenceByteRange(null, 1_000), null);
  assert.deepEqual(parseEvidenceByteRange("bytes=0-499", 1_000), { start: 0, end: 499 });
  assert.deepEqual(parseEvidenceByteRange("bytes=500-", 1_000), { start: 500, end: 999 });
  assert.deepEqual(parseEvidenceByteRange("bytes=-200", 1_000), { start: 800, end: 999 });
  assert.deepEqual(parseEvidenceByteRange("bytes=900-5000", 1_000), { start: 900, end: 999 });
});

test("evidence range parser rejects malformed or unsatisfiable ranges", () => {
  assert.equal(parseEvidenceByteRange("items=0-5", 1_000), "invalid");
  assert.equal(parseEvidenceByteRange("bytes=-", 1_000), "invalid");
  assert.equal(parseEvidenceByteRange("bytes=1000-", 1_000), "invalid");
  assert.equal(parseEvidenceByteRange("bytes=500-100", 1_000), "invalid");
  assert.equal(parseEvidenceByteRange("bytes=0-1", 0), "invalid");
});
