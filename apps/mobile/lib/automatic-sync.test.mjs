import assert from "node:assert/strict";
import test from "node:test";

import { networkSyncMode, shouldAttemptImmediateUpload } from "./automatic-sync.ts";

test("first online result and reconnect bypass stale retry backoff", () => {
  assert.equal(networkSyncMode(null, true), "force");
  assert.equal(networkSyncMode(false, true), "force");
});

test("repeated online notifications retain normal server backoff", () => {
  assert.equal(networkSyncMode(true, true), "normal");
});

test("known offline work waits safely for the connectivity listener", () => {
  assert.equal(networkSyncMode(true, false), "none");
  assert.equal(shouldAttemptImmediateUpload(false), false);
  assert.equal(shouldAttemptImmediateUpload(null), true);
  assert.equal(shouldAttemptImmediateUpload(true), true);
});
