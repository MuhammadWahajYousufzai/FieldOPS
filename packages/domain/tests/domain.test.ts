import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROUTE_TRACKING_POLICY,
  MAX_VISIT_EVIDENCE_BYTES,
  buildRouteGapConnectors,
  buildRouteSegments,
  canAccessTerritory,
  evaluateGeofence,
  hasRequiredVisitEvidence,
  mergeRefreshedVisits,
  normalizeRouteTrackingPolicy,
  parseTerritoryBoundary,
  pointInTerritory,
  retryDelayMs,
  shouldCaptureRoutePoint,
  visitEvidenceExtension,
  visitEvidenceValidationError,
  type AccessContext,
  type RouteTrackPoint,
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

describe("route tracking fidelity", () => {
  const origin = { latitude: 24.9063, longitude: 66.98864 };
  const point = (
    seconds: number,
    latitude: number,
    longitude: number,
    accuracy = 6,
    id = `point-${seconds}`,
    speed: number | null = null,
  ): RouteTrackPoint => ({
    id,
    capturedAt: new Date(Date.UTC(2026, 7, 18, 8, 0, seconds)).toISOString(),
    latitude,
    longitude,
    accuracy,
    speed,
  });

  it("uses bounded, high-fidelity defaults for manager-controlled policy", () => {
    expect(DEFAULT_ROUTE_TRACKING_POLICY).toEqual({
      sampleIntervalSeconds: 15,
      distanceIntervalMeters: 10,
      maxAcceptedAccuracyMeters: 35,
      stationaryJitterMeters: 20,
      segmentGapMinutes: 5,
      maxPlausibleSpeedMps: 45,
    });
    expect(normalizeRouteTrackingPolicy({
      sampleIntervalSeconds: 0,
      distanceIntervalMeters: "15",
      maxAcceptedAccuracyMeters: 10_000,
      segmentGapMinutes: "not a number",
    })).toMatchObject({
      sampleIntervalSeconds: 5,
      distanceIntervalMeters: 15,
      maxAcceptedAccuracyMeters: 250,
      segmentGapMinutes: 5,
    });
  });

  it("keeps one reliable raw fix per configured interval", () => {
    const start = point(0, origin.latitude, origin.longitude);
    const earlyMovement: RouteTrackPoint = {
      ...point(14, origin.latitude + 0.0002, origin.longitude),
      capturedAt: "2026-08-18T08:00:14.999Z",
    };
    const stationary = point(15, origin.latitude + 0.00002, origin.longitude, 6, "stationary", 0);
    const moved = point(30, origin.latitude + 0.0002, origin.longitude);
    const weak = point(45, origin.latitude + 0.0004, origin.longitude, 82);

    expect(shouldCaptureRoutePoint(null, start)).toBe(true);
    expect(shouldCaptureRoutePoint(start, earlyMovement)).toBe(false);
    expect(shouldCaptureRoutePoint(start, stationary)).toBe(true);
    expect(shouldCaptureRoutePoint(stationary, moved)).toBe(true);
    expect(shouldCaptureRoutePoint(moved, weak)).toBe(false);
  });

  it("keeps stationary audit heartbeats while route drawing removes their drift", () => {
    const start = point(0, origin.latitude, origin.longitude, 8, "start", 0);
    const heartbeat = point(15, origin.latitude + 0.00025, origin.longitude, 8, "heartbeat", 0);
    const walking = point(30, origin.latitude + 0.0005, origin.longitude, 8, "walking", 1.2);

    expect(shouldCaptureRoutePoint(start, heartbeat)).toBe(true);
    expect(shouldCaptureRoutePoint(heartbeat, walking)).toBe(true);
    expect(buildRouteSegments([start, heartbeat, walking]).flat().map((item) => item.id))
      .toEqual(["start", "walking"]);
  });

  it("preserves an accurate outbound turn and return along the same road", () => {
    const route = [
      point(0, 24.9063, 66.98864),
      point(15, 24.9063, 66.9882),
      point(30, 24.9063, 66.98775),
      point(45, 24.90645, 66.98775),
      point(60, 24.9063, 66.98775),
      point(75, 24.9063, 66.9882),
      point(90, 24.9063, 66.98864),
    ];

    const segments = buildRouteSegments(route);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.map(({ latitude, longitude }) => [latitude, longitude])).toEqual(
      route.map(({ latitude, longitude }) => [latitude, longitude]),
    );
  });

  it("removes the weak mosque/lunch drift and never draws across a long pause", () => {
    const start = point(0, 24.9063, 66.98864, 8, "start");
    const outbound = point(15, 24.9063, 66.98765, 8, "outbound");
    const weakTriangle = point(30, 24.9058, 66.98769, 82, "weak-triangle");
    const afterPause: RouteTrackPoint = {
      ...point(45, 24.9063, 66.9882, 8, "return"),
      capturedAt: "2026-08-18T08:20:00.000Z",
    };
    const home: RouteTrackPoint = {
      ...point(60, 24.9063, 66.98864, 8, "home"),
      capturedAt: "2026-08-18T08:20:15.000Z",
    };

    const segments = buildRouteSegments([start, outbound, weakTriangle, afterPause, home]);
    expect(segments.flat().map((item) => item.id)).not.toContain("weak-triangle");
    expect(segments).toHaveLength(2);
    expect(segments[0]?.map((item) => item.id)).toEqual(["start", "outbound"]);
    expect(segments[1]?.map((item) => item.id)).toEqual(["return", "home"]);
    expect(buildRouteGapConnectors(segments).map(([from, to]) => [from.id, to.id]))
      .toEqual([["outbound", "return"]]);
  });

  it("keeps an out-and-back lunch and mosque route from becoming a triangle or oval", () => {
    const start = point(0, 24.9063, 66.98864, 7, "start", 1.4);
    const straight = point(15, 24.9063, 66.9882, 7, "straight", 1.4);
    const turn = point(30, 24.90645, 66.98775, 7, "turn", 1.1);
    const lunch = point(45, 24.90662, 66.98775, 8, "lunch", 0.8);
    const driftOne: RouteTrackPoint = {
      ...point(46, 24.90682, 66.98755, 8, "lunch-drift-one", 0),
      capturedAt: "2026-08-18T08:02:00.000Z",
    };
    const driftTwo: RouteTrackPoint = {
      ...point(47, 24.90648, 66.98748, 9, "lunch-drift-two", 0.1),
      capturedAt: "2026-08-18T08:04:00.000Z",
    };
    const mosque: RouteTrackPoint = {
      ...point(48, 24.90694, 66.98775, 7, "mosque", 1),
      capturedAt: "2026-08-18T08:12:00.000Z",
    };
    const returnTurn: RouteTrackPoint = {
      ...point(49, 24.90645, 66.98775, 7, "return-turn", 1.2),
      capturedAt: "2026-08-18T08:25:00.000Z",
    };
    const returnStraight: RouteTrackPoint = {
      ...point(50, 24.9063, 66.9882, 7, "return-straight", 1.4),
      capturedAt: "2026-08-18T08:25:15.000Z",
    };
    const home: RouteTrackPoint = {
      ...point(51, 24.9063, 66.98864, 7, "home", 1.4),
      capturedAt: "2026-08-18T08:25:30.000Z",
    };

    const segments = buildRouteSegments([
      start,
      straight,
      turn,
      lunch,
      driftOne,
      driftTwo,
      mosque,
      returnTurn,
      returnStraight,
      home,
    ]);
    const ids = segments.flat().map((item) => item.id);

    expect(ids).toEqual([
      "start",
      "straight",
      "turn",
      "lunch",
      "mosque",
      "return-turn",
      "return-straight",
      "home",
    ]);
    expect(segments.map((segment) => segment.map((item) => item.id))).toEqual([
      ["start", "straight", "turn", "lunch"],
      ["mosque"],
      ["return-turn", "return-straight", "home"],
    ]);
    expect(buildRouteGapConnectors(segments).map(([from, to]) => [from.id, to.id])).toEqual([
      ["lunch", "mosque"],
      ["mosque", "return-turn"],
    ]);
  });

  it("does not estimate stationary or very long GPS gaps", () => {
    const start = point(0, origin.latitude, origin.longitude, 6, "start");
    const samePlace: RouteTrackPoint = {
      ...point(1, origin.latitude + 0.00001, origin.longitude, 6, "same-place"),
      capturedAt: "2026-08-18T08:10:00.000Z",
    };
    const muchLater: RouteTrackPoint = {
      ...point(2, origin.latitude, origin.longitude + 0.0005, 6, "much-later"),
      capturedAt: "2026-08-18T11:00:00.000Z",
    };

    expect(buildRouteGapConnectors([[start], [samePlace], [muchLater]])).toEqual([]);
  });

  it("does not estimate a gap whose endpoints overlap within GPS uncertainty", () => {
    const start = point(0, origin.latitude, origin.longitude, 30, "start");
    const uncertainReturn: RouteTrackPoint = {
      ...point(1, origin.latitude + 0.00022, origin.longitude, 30, "uncertain-return"),
      capturedAt: "2026-08-18T08:10:00.000Z",
    };

    expect(buildRouteGapConnectors([[start], [uncertainReturn]])).toEqual([]);
  });

  it("collapses duplicate action points and stationary GPS scribble", () => {
    const start = point(0, origin.latitude, origin.longitude, 12, "foreground");
    const duplicate = point(0, origin.latitude + 0.00003, origin.longitude, 5, "shift-check-in");
    const drift = point(15, origin.latitude + 0.00002, origin.longitude + 0.00001, 8, "drift");
    const moved = point(30, origin.latitude, origin.longitude + 0.0004, 8, "moved");

    expect(buildRouteSegments([start, duplicate, drift, moved])[0]?.map((item) => item.id))
      .toEqual(["shift-check-in", "moved"]);
  });

  it("removes a one-point impossible spike without deleting a real turn", () => {
    const start = point(0, 24.9063, 66.98864, 5, "start");
    const impossible = point(15, 25.0063, 67.08864, 5, "impossible");
    const next = point(30, 24.9063, 66.9882, 5, "next");

    expect(buildRouteSegments([start, impossible, next]).flat().map((item) => item.id))
      .toEqual(["start", "next"]);
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

  it("updates a salesperson-added visit when admin review reaches the server", () => {
    const local = {
      routeId: "",
      id: "visit-local-1",
      status: "completed" as const,
      kind: "self" as const,
      workDate: "2026-08-19",
      placeApprovalStatus: "pending_review" as const,
      name: "Shop entered in field",
    };
    const reviewed = {
      ...local,
      placeApprovalStatus: "approved" as const,
      name: "Admin-corrected shop name",
    };

    expect(mergeRefreshedVisits([assigned, reviewed], [assigned, local], "2026-08-19"))
      .toContainEqual(reviewed);
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
