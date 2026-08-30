import {
  DEFAULT_ROUTE_TRACKING_POLICY,
  normalizeRouteTrackingPolicy,
  type RouteTrackingPolicy,
} from "@fieldops/domain";

export const DEFAULT_SYNC_INTERVAL_SECONDS = 15;

export type OperationalPolicy = RouteTrackingPolicy & {
  syncIntervalSeconds: number;
  updatedAt: string;
};

export function normalizeSyncInterval(value: unknown) {
  const parsed = typeof value === "number" || typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed)
    ? Math.min(120, Math.max(10, Math.round(parsed)))
    : DEFAULT_SYNC_INTERVAL_SECONDS;
}

export function operationalPolicyFromRow(row: Record<string, unknown> | null | undefined): OperationalPolicy {
  return {
    ...normalizeRouteTrackingPolicy({
      sampleIntervalSeconds: row?.route_sample_seconds,
      distanceIntervalMeters: row?.route_distance_meters,
      maxAcceptedAccuracyMeters: row?.route_max_accuracy_meters,
      stationaryJitterMeters: row?.route_stationary_jitter_meters,
      segmentGapMinutes: row?.route_segment_gap_minutes,
      maxPlausibleSpeedMps: row?.route_max_speed_mps,
    }),
    syncIntervalSeconds: normalizeSyncInterval(row?.mobile_sync_interval_seconds),
    updatedAt: typeof row?.$updatedAt === "string" ? row.$updatedAt : "",
  };
}

export function validateOperationalPolicy(value: Record<string, unknown>): OperationalPolicy | null {
  const ranges: Array<[keyof RouteTrackingPolicy, number, number]> = [
    ["sampleIntervalSeconds", 5, 60],
    ["distanceIntervalMeters", 3, 50],
    ["maxAcceptedAccuracyMeters", 10, 75],
    ["stationaryJitterMeters", 5, 50],
    ["segmentGapMinutes", 2, 15],
    ["maxPlausibleSpeedMps", 10, 60],
  ];
  const parsed = Object.fromEntries(ranges.map(([key]) => [key, Number(value[key])])) as Record<keyof RouteTrackingPolicy, number>;
  if (ranges.some(([key, minimum, maximum]) => !Number.isFinite(parsed[key]) || parsed[key] < minimum || parsed[key] > maximum)) return null;
  const syncIntervalSeconds = Number(value.syncIntervalSeconds);
  if (!Number.isFinite(syncIntervalSeconds) || syncIntervalSeconds < 10 || syncIntervalSeconds > 120) return null;
  return {
    ...normalizeRouteTrackingPolicy(parsed),
    syncIntervalSeconds: normalizeSyncInterval(syncIntervalSeconds),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
  };
}

export function operationalPolicyMatches(
  row: Record<string, unknown> | null | undefined,
  requested: OperationalPolicy,
) {
  const current = operationalPolicyFromRow(row);
  return current.sampleIntervalSeconds === requested.sampleIntervalSeconds
    && current.distanceIntervalMeters === requested.distanceIntervalMeters
    && current.maxAcceptedAccuracyMeters === requested.maxAcceptedAccuracyMeters
    && current.stationaryJitterMeters === requested.stationaryJitterMeters
    && current.segmentGapMinutes === requested.segmentGapMinutes
    && current.maxPlausibleSpeedMps === requested.maxPlausibleSpeedMps
    && current.syncIntervalSeconds === requested.syncIntervalSeconds;
}

export const preciseOperationalPolicy: OperationalPolicy = {
  ...DEFAULT_ROUTE_TRACKING_POLICY,
  sampleIntervalSeconds: 15,
  distanceIntervalMeters: 5,
  maxAcceptedAccuracyMeters: 25,
  stationaryJitterMeters: 12,
  segmentGapMinutes: 3,
  syncIntervalSeconds: 15,
  updatedAt: "",
};
