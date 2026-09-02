import assert from "node:assert/strict";
import test from "node:test";
import { isSameLocationFix } from "./location-idempotency.ts";

const fix = {
  employee_id: "test-employee", idempotency_key: "loc_test",
  captured_at: "2026-09-02T20:53:00.123Z", latitude: 24.81, longitude: 67.04,
  source: "foreground", accuracy: 8,
};

test("the same GPS fix delivered by both watchers is acknowledged without rewriting it", () => {
  assert.equal(isSameLocationFix(fix, { ...fix, source: "background", accuracy: 9 }), true);
  assert.equal(isSameLocationFix({ ...fix, captured_at: "2026-09-03T01:53:00.123+05:00" }, fix), true);
  assert.equal(isSameLocationFix({ ...fix, latitude: 24.810000000001 }, fix), true);
});

test("a reused key cannot acknowledge another employee, capture, or position", () => {
  for (const change of [
    { employee_id: "other" }, { idempotency_key: "other" },
    { captured_at: "2026-09-02T20:53:00.124Z" },
    { latitude: 24.810001 }, { longitude: 67.040001 },
    { captured_at: "invalid" }, { latitude: Number.NaN },
  ]) assert.equal(isSameLocationFix(fix, { ...fix, ...change }), false);
});
