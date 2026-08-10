"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { LiveAttendance, LiveEmployee, LiveLocationPoint, LiveOperationsPayload } from "../lib/live-types";
import { type MapPoint, OperationsMap, type RouteLine } from "./operations-map";

const routeColors = ["#D8A629", "#2F75A8", "#B5523B", "#267057", "#75579B", "#CA7134"];
const staleAfterMs = 150_000;
const pollEveryMs = 15_000;
const liveGpsCountEvent = "fieldops:live-gps-count";

type ConnectionState = "updating" | "live" | "delayed" | "history";

type LiveOperationsProps = {
  date: string;
  selectedEmployee: string;
  pollingEnabled: boolean;
  generatedAt: string;
  staticPoints: MapPoint[];
  initialEmployees: LiveEmployee[];
  initialAttendance: LiveAttendance[];
  initialLocations: LiveLocationPoint[];
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
  staticPoints,
  initialEmployees,
  initialAttendance,
  initialLocations,
}: LiveOperationsProps) {
  const [employees, setEmployees] = useState(initialEmployees);
  const [attendance, setAttendance] = useState(initialAttendance);
  const [locations, setLocations] = useState(initialLocations);
  const [connection, setConnection] = useState<ConnectionState>(pollingEnabled ? "updating" : "history");
  const [lastUpdatedAt, setLastUpdatedAt] = useState(generatedAt);
  const [clock, setClock] = useState(() => new Date(generatedAt).valueOf());
  const requestRunning = useRef(false);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent<number>(liveGpsCountEvent, { detail: locations.length }));
  }, [locations.length]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const latestCapturedAt = useMemo(() => locations.reduce((latest, point) => point.capturedAt > latest ? point.capturedAt : latest, ""), [locations]);

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
        if (latestCapturedAt) params.set("since", latestCapturedAt);
        const response = await fetch(`/api/live-operations?${params}`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(`Live update returned ${response.status}`);
        const payload = await response.json() as LiveOperationsPayload;
        if (!active) return;
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
  }, [date, latestCapturedAt, pollingEnabled, selectedEmployee]);

  const employeeById = useMemo(() => new Map(employees.map((employee) => [employee.id, employee])), [employees]);
  const locationsByEmployee = useMemo(() => {
    const result = new Map<string, LiveLocationPoint[]>();
    for (const point of locations) {
      const list = result.get(point.employeeId) ?? [];
      list.push(point);
      result.set(point.employeeId, list);
    }
    for (const list of result.values()) list.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
    return result;
  }, [locations]);
  const employeeColor = useMemo(() => new Map(employees.map((employee, index) => [employee.id, routeColors[index % routeColors.length]!])), [employees]);

  const routes: RouteLine[] = [...locationsByEmployee.entries()].map(([employeeId, points]) => ({
    id: employeeId,
    name: employeeById.get(employeeId)?.name ?? "Salesperson",
    color: employeeColor.get(employeeId) ?? routeColors[0]!,
    coordinates: points.map((point) => [point.longitude, point.latitude]),
  }));
  const latestLocations = [...locationsByEmployee.entries()].flatMap(([employeeId, points]) => {
    const point = points.at(-1);
    if (!point) return [];
    return [{
      id: `live-${employeeId}`,
      name: `${employeeById.get(employeeId)?.name ?? "Salesperson"} · latest`,
      address: `${time(point.capturedAt)} · ±${Math.round(point.accuracy)} m`,
      latitude: point.latitude,
      longitude: point.longitude,
      kind: "live" as const,
    }];
  });
  const mapPoints = [...staticPoints, ...latestLocations];
  const statusCopy = connectionCopy(connection, lastUpdatedAt, clock);

  return <><section className="dashboard-grid" id="route-history">
    <article className="map-card">
      <div className="section-head"><div><p className="eyebrow">Full route history</p><h2>{date} · {locations.length} GPS points</h2></div><span className={`live-feed ${connection}`}><i />{statusCopy}</span></div>
      <OperationsMap points={mapPoints} routes={routes} />
      <div className="map-key"><span><i className="key-outlet" /> Assigned visit</span><span><i className="key-visit" /> Completed visit</span><span><i className="key-live" /> Latest position</span>{pollingEnabled && <small>Checks for new server-saved GPS every 15 seconds</small>}</div>
    </article>
    <aside className="decision-card"><p className="eyebrow">Workday status</p><h2>{date}</h2><ul>{attendance.map((record) => {
      const points = locationsByEmployee.get(record.employeeId) ?? [];
      const latest = points.at(-1);
      const stale = record.status === "checked_in" && (!latest || clock - new Date(latest.capturedAt).valueOf() > staleAfterMs);
      return <li key={record.id}><span className={`flag ${record.status === "checked_out" ? "blue" : stale ? "red" : "amber"}`}>{record.status === "checked_out" ? "finished" : stale ? "GPS stopped" : "working live"}</span><strong>{employeeById.get(record.employeeId)?.name ?? "Salesperson"}</strong><small>{time(record.checkInAt)} → {time(record.checkOutAt)} · {points.length} route points</small>{latest && <small className="last-fix">Last GPS {relativeTime(latest.capturedAt, clock)}</small>}</li>;
    })}</ul>{attendance.length === 0 && <p className="muted-on-dark">No one started work for this filter.</p>}</aside>
  </section>
  <details className="table-card route-log"><summary><span><span className="eyebrow">Audit trail</span><strong>Open minute-by-minute route log</strong></span><b>{locations.length} points</b></summary><div className="table-scroll"><table><thead><tr><th>Captured</th><th>Salesperson</th><th>Coordinates</th><th>Accuracy</th><th>Source</th><th>Server received</th></tr></thead><tbody>{locations.map((point) => <tr key={point.id}><td>{time(point.capturedAt)}</td><td>{employeeById.get(point.employeeId)?.name ?? "Unknown"}</td><td><a href={`https://www.openstreetmap.org/?mlat=${point.latitude}&mlon=${point.longitude}#map=18/${point.latitude}/${point.longitude}`} target="_blank">{point.latitude.toFixed(6)}, {point.longitude.toFixed(6)}</a></td><td>±{Math.round(point.accuracy)} m</td><td>{point.source.replaceAll("_", " ")}</td><td>{time(point.receivedAt)}</td></tr>)}</tbody></table></div></details></>;
}

function mergeLocations(current: LiveLocationPoint[], additions: LiveLocationPoint[]) {
  if (additions.length === 0) return current;
  const byId = new Map(current.map((point) => [point.id, point]));
  for (const point of additions) byId.set(point.id, point);
  return [...byId.values()].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
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
