import assert from "node:assert/strict";
import test from "node:test";
import {
  EVIDENCE_RETENTION_DAYS,
  evidenceRetentionCutoff,
  evidenceRetentionState,
} from "./evidence-retention.ts";

test("visit media expires exactly seven days after capture", () => {
  assert.equal(EVIDENCE_RETENTION_DAYS, 7);
  const before = evidenceRetentionState("2026-08-01T12:00:00.000Z", new Date("2026-08-08T11:59:59.999Z"));
  const atExpiry = evidenceRetentionState("2026-08-01T12:00:00.000Z", new Date("2026-08-08T12:00:00.000Z"));
  assert.equal(before?.expired, false);
  assert.equal(before?.daysRemaining, 1);
  assert.equal(atExpiry?.expired, true);
  assert.equal(atExpiry?.daysRemaining, 0);
  assert.equal(atExpiry?.expiresAt, "2026-08-08T12:00:00.000Z");
});

test("retention cutoff and invalid timestamps are deterministic", () => {
  assert.equal(evidenceRetentionCutoff(new Date("2026-09-02T08:00:00.000Z")), "2026-08-26T08:00:00.000Z");
  assert.equal(evidenceRetentionState("not-a-date"), null);
});
