import { describe, expect, it } from "vitest";
import { canAccessTerritory, evaluateGeofence, retryDelayMs, type AccessContext } from "../src";

describe("territory authorization", () => {
  const actor: AccessContext = {
    permissions: new Set(["orders:create"]),
    scope: { regionIds: ["karachi"], territoryIds: ["clifton"] },
  };
  it("requires both permission and assignment", () => {
    expect(canAccessTerritory(actor, "orders:create", "clifton")).toBe(true);
    expect(canAccessTerritory(actor, "orders:create", "korangi")).toBe(false);
    expect(canAccessTerritory(actor, "payments:receive", "clifton")).toBe(false);
  });
});

describe("visit geofence", () => {
  it("enforces the configured radius without expanding it for poor accuracy", () => {
    const outlet = { latitude: 24.8138, longitude: 67.0305 };
    const nearby = { latitude: 24.8141, longitude: 67.0305 };
    const result = evaluateGeofence(outlet, nearby, 25, 50);
    expect(result.accepted).toBe(false);
    expect(result.distanceMeters).toBeGreaterThan(30);
  });

  it("accepts a point inside the 70 metre visit boundary", () => {
    const outlet = { latitude: 24.8138, longitude: 67.0305 };
    const nearby = { latitude: 24.8141, longitude: 67.0305 };
    expect(evaluateGeofence(outlet, nearby, 70, 0).accepted).toBe(true);
  });
});

describe("offline retry", () => {
  it("uses capped exponential backoff", () => {
    expect(retryDelayMs(0)).toBe(1000);
    expect(retryDelayMs(4)).toBe(16000);
    expect(retryDelayMs(10)).toBe(60000);
  });
});
