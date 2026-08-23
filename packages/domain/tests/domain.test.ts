import { describe, expect, it } from "vitest";
import {
  MAX_VISIT_EVIDENCE_BYTES,
  canAccessTerritory,
  evaluateGeofence,
  hasRequiredVisitEvidence,
  mergeRefreshedVisits,
  parseTerritoryBoundary,
  pointInTerritory,
  retryDelayMs,
  visitEvidenceExtension,
  visitEvidenceValidationError,
  type AccessContext,
} from "../src";

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

  it("accepts only nonempty, allowlisted evidence up to 20 MiB", () => {
    expect(visitEvidenceValidationError("photo", { size: MAX_VISIT_EVIDENCE_BYTES, type: "image/jpeg" })).toBeNull();
    expect(visitEvidenceValidationError("audio", { size: 1, type: "audio/m4a" })).toBeNull();
    expect(visitEvidenceValidationError("photo", { size: 0, type: "image/jpeg" })).toMatch(/empty/);
    expect(visitEvidenceValidationError("audio", { size: MAX_VISIT_EVIDENCE_BYTES + 1, type: "audio/mp4" })).toMatch(/20 MB/);
    expect(visitEvidenceValidationError("photo", { size: 1, type: "image/jpeg; charset=binary" })).toMatch(/unsupported/);
    expect(visitEvidenceValidationError("photo", { size: 1, type: "image/webp" })).toMatch(/unsupported/);
    expect(visitEvidenceValidationError("audio", { size: 1, type: "audio/ogg" })).toMatch(/unsupported/);
    expect(visitEvidenceValidationError("audio", { size: 1, type: "application/octet-stream" })).toMatch(/unsupported/);
  });

  it("provides a safe extension that matches the evidence MIME type", () => {
    expect(visitEvidenceExtension("photo", "image/png")).toBe(".png");
    expect(visitEvidenceExtension("audio", "audio/mp4")).toBe(".m4a");
    expect(visitEvidenceExtension("photo", "application/octet-stream")).toBe(".jpg");
  });
});

describe("visit refresh", () => {
  type TestVisit = {
    routeId: string;
    id: string;
    status: "planned" | "active" | "completed";
    kind: "assigned" | "self";
    workDate: string;
  };
  const assigned: TestVisit = {
    routeId: "route-1",
    id: "outlet-1",
    status: "planned",
    kind: "assigned",
    workDate: "2026-08-19",
  };

  it("keeps an active unplanned visit when server context refreshes", () => {
    const activeSelfVisit: TestVisit = {
      routeId: "",
      id: "visit-local-1",
      status: "active",
      kind: "self",
      workDate: "2026-08-19",
    };

    expect(mergeRefreshedVisits([assigned], [assigned, activeSelfVisit], "2026-08-19"))
      .toEqual([assigned, activeSelfVisit]);
  });

  it("keeps local progress for an assigned visit", () => {
    const activeAssigned = { ...assigned, status: "active" as const };
    expect(mergeRefreshedVisits([assigned], [activeAssigned], "2026-08-19")[0]?.status).toBe("active");
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
