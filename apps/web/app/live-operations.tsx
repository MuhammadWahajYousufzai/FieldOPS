"use client";

import { buildRouteGapConnectors, buildRouteSegments, isReliableRoutePoint, type RouteTrackingPolicy } from "@fieldops/domain";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { LiveAttendance, LiveEmployee, LiveLocationPoint, LiveOperationsPayload } from "../lib/live-types";
import { type MapPoint, OperationsMap, type RouteLine } from "./operations-map";
import { ui } from "./ui";

const routeColors = ["#D8A629", "#2F75A8", "#B5523B", "#267057", "#75579B", "#CA7134"];
const staleAfterMs = 150_000;
// Mobile uploads begin immediately when connectivity is available. A short,
// visibility-aware dashboard poll makes confirmed work appear to management
// within a few seconds without polling from hidden tabs.
const pollEveryMs = 5_000;
const liveGpsCountEvent = "fieldops:live-gps-count";

type ConnectionState = "updating" | "live" | "delayed" | "history";
type RouteView = "quality" | "raw";

type LiveOperationsProps = {
  date: string;
  selectedEmployee: string;
  pollingEnabled: boolean;
  generatedAt: string;
  initialProgressRevision: string;
  staticPoints: MapPoint[];
  initialEmployees: LiveEmployee[];
  initialAttendance: LiveAttendance[];
  initialLocations: LiveLocationPoint[];
  routePolicy: RouteTrackingPolicy;
};

export function LiveGpsCount({ initialCount }: { initialCount: number }) {
  const [count, setCount] = useState(initialCount);

  useEffect(() => {
    const update = (event: Event) => setCount((event as CustomEvent<number>).detail);
    window.addEventListener(liveGpsCountEvent, update);
    return () => window.removeEventListener(liveGpsCountEvent, update);
  }, []);

  return <b>{count}</b>;
}

export function LiveOperations({
  date,
  selectedEmployee,
  pollingEnabled,
  generatedAt,
  initialProgressRevision,
  staticPoints,
  initialEmployees,
  initialAttendance,
  initialLocations,
  routePolicy,
}: LiveOperationsProps) {
  const router = useRouter();
  const [employees, setEmployees] = useState(initialEmployees);
  const [attendance, setAttendance] = useState(initialAttendance);
  const [locations, setLocations] = useState(initialLocations);
  const [connection, setConnection] = useState<ConnectionState>(pollingEnabled ? "updating" : "history");
  const [routeView, setRouteView] = useState<RouteView>("quality");
  const [lastUpdatedAt, setLastUpdatedAt] = useState(generatedAt);
  const [clock, setClock] = useState(() => new Date(generatedAt).valueOf());
  const requestRunning = useRef(false);
  const backlogCursor = useRef("");
  const latestReceivedAt = useRef(latestServerReceipt(initialLocations));
  const progressRevision = useRef(initialProgressRevision);

  useEffect(() => {
    backlogCursor.current = "";
    latestReceivedAt.current = latestServerReceipt(initialLocations);
    progressRevision.current = initialProgressRevision;
    setEmployees(initialEmployees);
    setAttendance(initialAttendance);
    setLocations(initialLocations);
    setLastUpdatedAt(generatedAt);
    setConnection(pollingEnabled ? "updating" : "history");
    setRouteView("quality");
  }, [date, generatedAt, initialAttendance, initialEmployees, initialLocations, initialProgressRevision, pollingEnabled, selectedEmployee]);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent<number>(liveGpsCountEvent, { detail: locations.length }));
  }, [locations.length]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!pollingEnabled) return;
    let active = true;

    async function refresh() {
      if (!active || requestRunning.current || document.visibilityState === "hidden") return;
      requestRunning.current = true;
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 8_000);
      try {
        const params = new URLSearchParams({ date, employee: selectedEmployee });
        if (latestReceivedAt.current) params.set("since", latestReceivedAt.current);
        if (backlogCursor.current) params.set("cursor", backlogCursor.current);
        const response = await fetch(`/api/live-operations?${params}`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(`Live update returned ${response.status}`);
        const payload = await response.json() as LiveOperationsPayload;
        if (!active) return;
        backlogCursor.current = payload.nextCursor ?? "";
        latestReceivedAt.current = payload.points.reduce(
          (latest, point) => point.receivedAt > latest ? point.receivedAt : latest,
          latestReceivedAt.current,
        );
        if (payload.progressRevision !== progressRevision.current) {
          progressRevision.current = payload.progressRevision;
          router.refresh();
        }
        setEmployees(payload.employees);
        setAttendance(payload.attendance);
        setLocations((current) => mergeLocations(current, payload.points));
        setLastUpdatedAt(payload.serverTime);
        setClock(new Date(payload.serverTime).valueOf());
        setConnection("live");
      } catch {
        if (active) setConnection("delayed");
      } finally {
        window.clearTimeout(timeout);
        requestRunning.current = false;
      }
    }

    void refresh();
    const timer = window.setInterval(refresh, pollEveryMs);
    const onVisibilityChange = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [date, pollingEnabled, router, selectedEmployee]);

  const employeeById = useMemo(() => new Map(employees.map((employee) => [employee.id, employee])), [employees]);
  const locationsByEmployee = useMemo(() => {
    const result = new Map<string, LiveLocationPoint[]>();
    for (const point of locations) {
      const list = result.get(point.employeeId) ?? [];
      list.push(point);
      result.set(point.employeeId, list);
    }
    for (const list of result.values()) list.sort(compareLocationPoints);
    return result;
  }, [locations]);
  const employeeColor = useMemo(() => new Map(employees.map((employee, index) => [employee.id, routeColors[index % routeColors.length]!])), [employees]);

  const routeSegmentsByEmployee = useMemo(() => new Map(
    [...locationsByEmployee.entries()].map(([employeeId, points]) => [employeeId, buildRouteSegments(points, routePolicy)]),
  ), [locationsByEmployee, routePolicy]);
  const gapConnectorsByEmployee = useMemo(() => new Map(
    [...routeSegmentsByEmployee.entries()].map(([employeeId, segments]) => [employeeId, buildRouteGapConnectors(segments, routePolicy)]),
  ), [routePolicy, routeSegmentsByEmployee]);
  const recordedRoutes = useMemo<RouteLine[]>(() => [...routeSegmentsByEmployee.entries()].flatMap(([employeeId, segments]) => (
    segments.flatMap((segment, index): RouteLine[] => segment.length < 2 ? [] : [{
      id: `${employeeId}-segment-${index}`,
      name: employeeById.get(employeeId)?.name ?? "Salesperson",
      color: employeeColor.get(employeeId) ?? routeColors[0]!,
      coordinates: segment.map((point) => [point.longitude, point.latitude]),
    }])
  )), [routeSegmentsByEmployee, employeeById, employeeColor]);
  const estimatedGapRoutes = useMemo<RouteLine[]>(() => [...gapConnectorsByEmployee.entries()].flatMap(([employeeId, connectors]) => (
    connectors.map(([from, to], index) => ({
      id: `${employeeId}-estimated-gap-${index}`,
      name: `${employeeById.get(employeeId)?.name ?? "Salesperson"} · estimated GPS gap`,
      color: employeeColor.get(employeeId) ?? routeColors[0]!,
      coordinates: [[from.longitude, from.latitude], [to.longitude, to.latitude]],
      estimated: true,
    }))
  )), [gapConnectorsByEmployee, employeeById, employeeColor]);
  const qualityRoutes = useMemo(() => [...recordedRoutes, ...estimatedGapRoutes], [recordedRoutes, estimatedGapRoutes]);
  const rawRoutes = useMemo<RouteLine[]>(() => [...locationsByEmployee.entries()].flatMap(([employeeId, points]) => {
    const coordinates = points.flatMap((point): [number, number][] => (
      Number.isFinite(point.longitude) && Number.isFinite(point.latitude)
        ? [[point.longitude, point.latitude]]
        : []
    ));
    return coordinates.length < 2 ? [] : [{
      id: `${employeeId}-raw`,
      name: `${employeeById.get(employeeId)?.name ?? "Salesperson"} · raw GPS`,
      color: employeeColor.get(employeeId) ?? routeColors[0]!,
      coordinates,
    }];
  }), [locationsByEmployee, employeeById, employeeColor]);
  const routes = routeView === "quality" ? qualityRoutes : rawRoutes;
  const recordedPointIds = useMemo(() => new Set(
    [...routeSegmentsByEmployee.values()].flatMap((segments) => (
      segments.flatMap((segment) => segment.length < 2 ? [] : segment.map((point) => point.id))
    )),
  ), [routeSegmentsByEmployee]);
  const estimatedPointIds = useMemo(() => new Set(
    [...gapConnectorsByEmployee.values()].flatMap((connectors) => (
      connectors.flatMap(([from, to]) => [from.id, to.id])
    )),
  ), [gapConnectorsByEmployee]);
  const drawnPointIds = useMemo(() => new Set([...recordedPointIds, ...estimatedPointIds]), [estimatedPointIds, recordedPointIds]);
  const drawnPointCount = drawnPointIds.size;
  const excludedPointCount = Math.max(0, locations.length - drawnPointCount);
  const estimatedGapCount = estimatedGapRoutes.length;
  const latestLocations = useMemo(() => [...locationsByEmployee.entries()].flatMap(([employeeId, points]) => {
    const point = lastReliableRoutePoint(points, routePolicy);
    if (!point) return [];
    return [{
      id: `live-${employeeId}`,
      name: `${employeeById.get(employeeId)?.name ?? "Salesperson"} · latest reliable`,
      address: `${time(point.capturedAt)} · ±${Math.round(point.accuracy)} m`,
      latitude: point.latitude,
      longitude: point.longitude,
      kind: "live" as const,
    }];
  }), [locationsByEmployee, employeeById, routePolicy]);
  const mapPoints = useMemo(() => [...staticPoints, ...latestLocations], [staticPoints, latestLocations]);
  // The one-second status clock must not rebuild thousands of GPS audit rows.
  const auditLog = useMemo(() => (
  <details className="mt-5 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_10px_30px_rgba(20,33,61,0.055)]"><summary className="flex cursor-pointer list-none items-center justify-between gap-5 p-5 sm:p-6"><span><span className={ui.eyebrow}>Audit trail</span><strong className="mt-1 block text-xl font-black">Open raw GPS audit log</strong></span><b className="text-sm text-emerald-700">{locations.length} fixes</b></summary><div className="overflow-x-auto border-t border-slate-200 px-5 pb-5 sm:px-6 sm:pb-6"><table className={ui.table}><thead><tr><th>Captured</th><th>Salesperson</th><th>Coordinates</th><th>Accuracy</th><th>Route line</th><th>Source</th><th>Server received</th></tr></thead><tbody>{locations.map((point) => { const routeStatus = recordedPointIds.has(point.id) ? "Recorded" : estimatedPointIds.has(point.id) ? "Gap endpoint" : "Excluded"; const routeStatusStyle = routeStatus === "Recorded" ? "bg-emerald-50 text-emerald-800" : routeStatus === "Gap endpoint" ? "bg-blue-50 text-blue-800" : "bg-slate-100 text-slate-600"; return <tr key={point.id}><td>{time(point.capturedAt)}</td><td>{employeeById.get(point.employeeId)?.name ?? "Unknown"}</td><td><a className="font-extrabold text-blue-700 hover:text-blue-900" href={`https://www.openstreetmap.org/?mlat=${point.latitude}&mlon=${point.longitude}#map=18/${point.latitude}/${point.longitude}`} target="_blank">{point.latitude.toFixed(6)}, {point.longitude.toFixed(6)}</a></td><td>±{Math.round(point.accuracy)} m</td><td><span className={`inline-flex rounded-full px-2 py-1 text-[10px] font-black uppercase tracking-wider ${routeStatusStyle}`}>{routeStatus}</span></td><td>{point.source.replaceAll("_", " ")}</td><td>{time(point.receivedAt)}</td></tr>; })}</tbody></table></div></details>
  ), [locations, employeeById, recordedPointIds, estimatedPointIds]);
  const statusCopy = connectionCopy(connection, lastUpdatedAt, clock);

  const connectionStyle = connection === "live" ? "bg-emerald-50 text-emerald-800" : connection === "delayed" ? "bg-red-50 text-red-800" : connection === "history" ? "bg-blue-50 text-blue-800" : "bg-amber-50 text-amber-800";
  return <><section className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.85fr)_minmax(280px,.72fr)]" id="route-history">
    <article className={ui.card}>
      <div className={ui.sectionHead}>
        <div><p className={ui.eyebrow}>Recorded route</p><h2 className={ui.h2}>{date} · quality-checked positions</h2></div>
        <span className={`inline-flex max-w-60 items-center gap-2 rounded-full px-3 py-2 text-[11px] font-extrabold ${connectionStyle}`}><i className="h-2 w-2 shrink-0 rounded-full bg-current" />{statusCopy}</span>
      </div>
      <div className="mt-4 grid overflow-hidden rounded-xl border border-slate-200 bg-slate-50 sm:grid-cols-4" aria-label="Route quality summary">
        <RouteQualityStat label="Raw fixes" value={locations.length} detail="Saved for audit" />
        <RouteQualityStat label="Drawn fixes" value={drawnPointCount} detail="Reliable positions" />
        <RouteQualityStat label="GPS gaps" value={estimatedGapCount} detail="Dashed estimates" />
        <RouteQualityStat label="Excluded" value={excludedPointCount} detail="Weak, duplicate, drift or gap" />
      </div>
      <div className="mt-4 flex flex-col gap-3 rounded-xl bg-[#14213D] p-3 text-white sm:flex-row sm:items-center sm:justify-between">
        <div className="inline-flex w-full rounded-lg bg-white/10 p-1 sm:w-auto" role="group" aria-label="Route line view">
          <RouteViewButton active={routeView === "quality"} label="Quality-checked" onPress={() => setRouteView("quality")} />
          <RouteViewButton active={routeView === "raw"} label="Raw GPS" onPress={() => setRouteView("raw")} />
        </div>
        <p className="text-xs leading-5 text-slate-300 sm:max-w-md">
          {routeView === "quality"
            ? "Solid lines are recorded movement. Dashed links show only the direction between reliable fixes after a GPS gap—not the exact path. Weak fixes and stationary drift stay in the audit log."
            : "Diagnostic view connects every saved fix, including weak and delayed points. Shapes here may not be the path actually travelled."}
        </p>
      </div>
      <OperationsMap points={mapPoints} routes={routes} />
      <div className="mt-4 flex flex-wrap items-center gap-4 text-xs text-slate-500"><span className="inline-flex items-center gap-2"><i className="h-2.5 w-2.5 rounded-full bg-blue-700" /> Assigned visit</span><span className="inline-flex items-center gap-2"><i className="h-2.5 w-2.5 rounded-full bg-emerald-700" /> Completed visit</span><span className="inline-flex items-center gap-2"><i className="h-2.5 w-2.5 rounded-full bg-amber-500" /> Latest reliable GPS</span><span className="inline-flex items-center gap-2"><i className="w-7 border-t-2 border-dashed border-slate-500" /> Estimated GPS gap</span>{pollingEnabled && <small className="sm:ml-auto">Checks confirmed GPS and progress every {pollEveryMs / 1_000} seconds</small>}</div>
    </article>
    <aside className="self-start rounded-2xl bg-[#14213D] p-6 text-white"><p className="text-[11px] font-black uppercase tracking-[0.13em] text-slate-400">Workday status</p><h2 className="my-1 text-2xl font-black tracking-tight text-white">{date}</h2><ul className="my-6 list-none p-0">{attendance.map((record) => {
      const points = locationsByEmployee.get(record.employeeId) ?? [];
      const latest = lastReliableRoutePoint(points, routePolicy);
      const stale = record.status === "checked_in" && (!latest || clock - new Date(latest.capturedAt).valueOf() > staleAfterMs);
      const flagStyle = record.status === "checked_out" ? "bg-blue-300/20 text-blue-100" : stale ? "bg-red-300/20 text-red-100" : "bg-amber-300/20 text-amber-100";
      return <li className="border-t border-white/15 py-4" key={record.id}><span className={`inline-block rounded-md px-2 py-1 text-[10px] font-black uppercase tracking-wider ${flagStyle}`}>{record.status === "checked_out" ? "finished" : stale ? "route update paused" : "working live"}</span><strong className="my-2 block">{employeeById.get(record.employeeId)?.name ?? "Salesperson"}</strong><small className="block text-slate-300">{time(record.checkInAt)} → {time(record.checkOutAt)} · {points.length} route points</small>{latest && <small className="mt-2 block text-emerald-200">Last reliable position {relativeTime(latest.capturedAt, clock)}</small>}</li>;
    })}</ul>{attendance.length === 0 && <p className="leading-6 text-slate-300">No one started work for this filter.</p>}</aside>
  </section>
  {auditLog}</>;
}

function RouteQualityStat({ label, value, detail }: { label: string; value: number; detail: string }) {
  return <div className="border-b border-slate-200 px-4 py-3 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0">
    <span className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-500">{label}</span>
    <strong className="ml-2 text-xl font-black text-[#14213D] sm:ml-0 sm:mt-1 sm:block">{value.toLocaleString()}</strong>
    <small className="ml-2 text-xs text-slate-500 sm:ml-0 sm:block">{detail}</small>
  </div>;
}

function RouteViewButton({ active, label, onPress }: { active: boolean; label: string; onPress: () => void }) {
  return <button
    type="button"
    aria-pressed={active}
    className={`min-h-10 flex-1 rounded-md px-3 text-xs font-black transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#D8A629] sm:flex-none ${active ? "bg-[#D8A629] text-[#14213D]" : "text-white hover:bg-white/10"}`}
    onClick={onPress}
  >{label}</button>;
}

function mergeLocations(current: LiveLocationPoint[], additions: LiveLocationPoint[]) {
  if (additions.length === 0) return current;
  const byId = new Map(current.map((point) => [point.id, point]));
  for (const point of additions) byId.set(point.id, point);
  return [...byId.values()].sort(compareLocationPoints);
}

function latestServerReceipt(points: readonly LiveLocationPoint[]) {
  return points.reduce((latest, point) => point.receivedAt > latest ? point.receivedAt : latest, "");
}

function compareLocationPoints(a: LiveLocationPoint, b: LiveLocationPoint) {
  return new Date(a.capturedAt).valueOf() - new Date(b.capturedAt).valueOf() || a.id.localeCompare(b.id);
}

function lastReliableRoutePoint(points: readonly LiveLocationPoint[], policy: RouteTrackingPolicy) {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const point = points[index];
    if (point && isReliableRoutePoint(point, policy)) return point;
  }
  return undefined;
}

function connectionCopy(connection: ConnectionState, updatedAt: string, clock: number) {
  if (connection === "history") return "Saved history";
  if (connection === "updating") return "Connecting live feed";
  if (connection === "delayed") return "Update delayed · last position kept";
  return `Live · checked ${relativeTime(updatedAt, clock)}`;
}

function relativeTime(value: string, clock: number) {
  const seconds = Math.max(0, Math.floor((clock - new Date(value).valueOf()) / 1_000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ago`;
}

function time(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleTimeString("en-PK", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Karachi" });
}
