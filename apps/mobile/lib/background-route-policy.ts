import {
  normalizeRouteTrackingPolicy,
  shouldCaptureRoutePoint,
  type RouteTrackPoint,
  type RouteTrackingPolicy,
} from "@fieldops/domain";

export type RouteLocationLike = {
  timestamp: number;
  coords: {
    latitude: number;
    longitude: number;
    accuracy: number | null;
    speed?: number | null;
  };
};

export function routePointFromLocation(location: RouteLocationLike): RouteTrackPoint {
  const timestamp = new Date(location.timestamp);
  return {
    capturedAt: Number.isFinite(timestamp.valueOf()) ? timestamp.toISOString() : "",
    latitude: location.coords.latitude,
    longitude: location.coords.longitude,
    accuracy: location.coords.accuracy ?? Number.POSITIVE_INFINITY,
    speed: location.coords.speed ?? null,
  };
}

/**
 * Expo can deliver several background fixes in one callback. Sort that batch,
 * then apply the same accuracy, drift, speed, and heartbeat policy used by the
 * foreground watcher. The returned final point is persisted for the next
 * callback so a screen lock cannot reset the jitter filter.
 */
export function selectBackgroundRouteLocations<LocationLike extends RouteLocationLike>(
  locations: readonly LocationLike[],
  previous: RouteTrackPoint | null,
  rawPolicy: RouteTrackingPolicy,
) {
  const policy = normalizeRouteTrackingPolicy(rawPolicy);
  const accepted: LocationLike[] = [];
  let lastAccepted = previous;

  const ordered = locations
    .map((location, index) => ({ location, index }))
    .filter(({ location }) => (
      Boolean(location)
      && Number.isFinite(new Date(location.timestamp).valueOf())
      && Boolean(location.coords)
      && Number.isFinite(location.coords.latitude)
      && Number.isFinite(location.coords.longitude)
    ))
    .sort((a, b) => a.location.timestamp - b.location.timestamp || a.index - b.index);

  for (const { location } of ordered) {
    const candidate = routePointFromLocation(location);
    if (!shouldCaptureRoutePoint(lastAccepted, candidate, policy)) continue;
    accepted.push(location);
    lastAccepted = candidate;
  }

  return { accepted, lastAccepted };
}

export function backgroundSessionIsCurrent(
  value: { employeeId?: unknown; expiresAt?: unknown; active?: unknown },
  nowMs = Date.now(),
) {
  return value.active === true
    && typeof value.employeeId === "string"
    && value.employeeId.trim().length > 0
    && typeof value.expiresAt === "string"
    && Number.isFinite(new Date(value.expiresAt).valueOf())
    && new Date(value.expiresAt).valueOf() > nowMs;
}

export function secureBackgroundTokenForEmployee(
  value: { employeeId?: unknown; token?: unknown } | null | undefined,
  employeeId: string,
) {
  if (!value
    || typeof value.employeeId !== "string"
    || value.employeeId !== employeeId
    || typeof value.token !== "string"
    || value.token.trim().length === 0) return null;
  return value.token;
}
