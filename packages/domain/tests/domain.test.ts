import { describe, expect, it } from "vitest";
import { canAccessTerritory, evaluateGeofence, hasRequiredVisitEvidence, parseTerritoryBoundary, pointInTerritory, retryDelayMs, type AccessContext } from "../src";

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

describe("visit evidence", () => {
  it("requires both a photo and an audio note before submission", () => {
    expect(hasRequiredVisitEvidence({})).toBe(false);
    expect(hasRequiredVisitEvidence({ photo: { uri: "photo.jpg" } })).toBe(false);
    expect(hasRequiredVisitEvidence({ audio: { uri: "note.m4a" } })).toBe(false);
    expect(hasRequiredVisitEvidence({ photo: { uri: "photo.jpg" }, audio: { uri: "note.m4a" } })).toBe(true);
  });
});

describe("territory boundaries", () => {
  const boundary = parseTerritoryBoundary({
    type: "Polygon",
    coordinates: [[[67.0, 24.8], [67.1, 24.8], [67.1, 24.9], [67.0, 24.9], [67.0, 24.8]]],
  });

  it("validates closed GeoJSON polygons", () => {
    expect(boundary).not.toBeNull();
    expect(parseTerritoryBoundary({ type: "Polygon", coordinates: [[[67, 24], [68, 24], [68, 25]]] })).toBeNull();
  });

  it("accepts points inside or on the boundary and rejects outside points", () => {
    expect(pointInTerritory({ latitude: 24.85, longitude: 67.05 }, boundary!)).toBe(true);
    expect(pointInTerritory({ latitude: 24.8, longitude: 67.05 }, boundary!)).toBe(true);
    expect(pointInTerritory({ latitude: 24.95, longitude: 67.05 }, boundary!)).toBe(false);
  });
});

describe("offline retry", () => {
  it("uses capped exponential backoff", () => {
    expect(retryDelayMs(0)).toBe(1000);
    expect(retryDelayMs(4)).toBe(16000);
    expect(retryDelayMs(10)).toBe(60000);
  });
});
