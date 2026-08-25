import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_ROUTE_TRACKING_POLICY } from "../../../packages/domain/src/index.ts";
import {
  backgroundSessionIsCurrent,
  routePointFromLocation,
  secureBackgroundTokenForEmployee,
  selectBackgroundRouteLocations,
} from "./background-route-policy.ts";

const point = (timestamp, latitude, longitude, accuracy = 8, speed = null) => ({
  timestamp,
  coords: { latitude, longitude, accuracy, speed },
});

test("background batches use the route policy and retain the latest accepted point", () => {
  const start = Date.parse("2026-08-25T08:00:00.000Z");
  const weak = point(start + 15_000, 24.8208, 67.0313, 82);
  const moved = point(start + 30_000, 24.82115, 67.0313);
  const jitter = point(start + 45_000, 24.82116, 67.03131);
  const initial = routePointFromLocation(point(start, 24.8208, 67.0313));

  const result = selectBackgroundRouteLocations(
    [jitter, moved, weak],
    initial,
    DEFAULT_ROUTE_TRACKING_POLICY,
  );

  assert.deepEqual(result.accepted, [moved]);
  assert.equal(result.lastAccepted?.capturedAt, new Date(moved.timestamp).toISOString());
});

test("background batches are sorted before filtering", () => {
  const start = Date.parse("2026-08-25T08:00:00.000Z");
  const first = point(start, 24.8208, 67.0313);
  const second = point(start + 15_000, 24.8212, 67.0313);
  const result = selectBackgroundRouteLocations(
    [second, first],
    null,
    DEFAULT_ROUTE_TRACKING_POLICY,
  );
  assert.deepEqual(result.accepted, [first, second]);
});

test("stationary GPS wander is retained only as a periodic audit heartbeat", () => {
  const start = Date.parse("2026-08-25T08:00:00.000Z");
  const initial = routePointFromLocation(point(start, 24.8208, 67.0313, 8, 0));
  const earlyDrift = point(start + 15_000, 24.82105, 67.0313, 8, 0);
  const heartbeat = point(start + 120_000, 24.82105, 67.0313, 8, 0);

  const result = selectBackgroundRouteLocations(
    [heartbeat, earlyDrift],
    initial,
    DEFAULT_ROUTE_TRACKING_POLICY,
  );

  assert.deepEqual(result.accepted, [heartbeat]);
  assert.equal(result.lastAccepted?.capturedAt, new Date(heartbeat.timestamp).toISOString());
});

test("malformed native fixes are ignored without discarding the valid batch", () => {
  const start = Date.parse("2026-08-25T08:00:00.000Z");
  const valid = point(start, 24.8208, 67.0313);
  const result = selectBackgroundRouteLocations([
    { timestamp: Number.NaN, coords: { latitude: 24.82, longitude: 67.03, accuracy: 5 } },
    { timestamp: 1e30, coords: { latitude: 24.82, longitude: 67.03, accuracy: 5 } },
    { timestamp: start + 10, coords: { latitude: Number.NaN, longitude: 67.03, accuracy: 5 } },
    valid,
  ], null, DEFAULT_ROUTE_TRACKING_POLICY);
  assert.deepEqual(result.accepted, [valid]);
});

test("expired or signed-out background sessions are rejected", () => {
  const now = Date.parse("2026-08-25T08:00:00.000Z");
  assert.equal(backgroundSessionIsCurrent({
    employeeId: "employee-1",
    expiresAt: "2026-08-25T09:00:00.000Z",
    active: true,
  }, now), true);
  assert.equal(backgroundSessionIsCurrent({
    employeeId: "employee-1",
    expiresAt: "2026-08-25T07:59:59.000Z",
    active: true,
  }, now), false);
  assert.equal(backgroundSessionIsCurrent({
    employeeId: "employee-1",
    expiresAt: "2026-08-25T09:00:00.000Z",
    active: false,
  }, now), false);
  assert.equal(backgroundSessionIsCurrent({
    employeeId: "   ",
    expiresAt: "2026-08-25T09:00:00.000Z",
    active: true,
  }, now), false);
});

test("the headless route token must belong to the active employee", () => {
  assert.equal(secureBackgroundTokenForEmployee({
    employeeId: "employee-1",
    token: "secure-token",
  }, "employee-1"), "secure-token");
  assert.equal(secureBackgroundTokenForEmployee({
    employeeId: "employee-2",
    token: "secure-token",
  }, "employee-1"), null);
  assert.equal(secureBackgroundTokenForEmployee({
    employeeId: "employee-1",
    token: "   ",
  }, "employee-1"), null);
  assert.equal(secureBackgroundTokenForEmployee(null, "employee-1"), null);
});
