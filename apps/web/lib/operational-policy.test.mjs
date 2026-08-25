import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SYNC_INTERVAL_SECONDS,
  normalizeSyncInterval,
  operationalPolicyFromRow,
  operationalPolicyMatches,
  validateOperationalPolicy,
} from "./operational-policy.ts";

test("operational policy uses safe route and sync defaults", () => {
  const policy = operationalPolicyFromRow(null);
  assert.equal(policy.sampleIntervalSeconds, 15);
  assert.equal(policy.maxAcceptedAccuracyMeters, 35);
  assert.equal(policy.syncIntervalSeconds, DEFAULT_SYNC_INTERVAL_SECONDS);
});

test("operational policy maps stored organization controls", () => {
  const policy = operationalPolicyFromRow({
    route_sample_seconds: 10,
    route_distance_meters: 5,
    route_max_accuracy_meters: 25,
    route_stationary_jitter_meters: 12,
    route_segment_gap_minutes: 3,
    route_max_speed_mps: 40,
    mobile_sync_interval_seconds: 10,
    $updatedAt: "2026-08-25T10:00:00.000Z",
  });
  assert.equal(policy.distanceIntervalMeters, 5);
  assert.equal(policy.syncIntervalSeconds, 10);
  assert.equal(policy.updatedAt, "2026-08-25T10:00:00.000Z");
});

test("management policy validation rejects unsafe values instead of silently saving them", () => {
  const valid = {
    sampleIntervalSeconds: 15,
    distanceIntervalMeters: 10,
    maxAcceptedAccuracyMeters: 35,
    stationaryJitterMeters: 20,
    segmentGapMinutes: 5,
    maxPlausibleSpeedMps: 45,
    syncIntervalSeconds: 15,
  };
  assert.ok(validateOperationalPolicy(valid));
  assert.equal(validateOperationalPolicy({ ...valid, sampleIntervalSeconds: 1 }), null);
  assert.equal(validateOperationalPolicy({ ...valid, syncIntervalSeconds: 500 }), null);
  assert.equal(normalizeSyncInterval("bad"), DEFAULT_SYNC_INTERVAL_SECONDS);
});

test("operationalPolicyMatches ignores row version but compares every saved control", () => {
  const row = {
    route_sample_seconds: 10,
    route_distance_meters: 5,
    route_max_accuracy_meters: 25,
    route_stationary_jitter_meters: 12,
    route_segment_gap_minutes: 3,
    route_max_speed_mps: 40,
    mobile_sync_interval_seconds: 10,
    $updatedAt: "new-version",
  };
  const requested = { ...operationalPolicyFromRow(row), updatedAt: "old-version" };
  assert.equal(operationalPolicyMatches(row, requested), true);
  assert.equal(operationalPolicyMatches(row, { ...requested, distanceIntervalMeters: 6 }), false);
});
