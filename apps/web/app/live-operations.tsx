"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { LiveAttendance, LiveEmployee, LiveLocationPoint, LiveOperationsPayload } from "../lib/live-types";
import { type MapPoint, OperationsMap, type RouteLine } from "./operations-map";
import { ui } from "./ui";

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
  const backlogCursor = useRef("");

  useEffect(() => {
    backlogCursor.current = "";
    setEmployees(initialEmployees);
    setAttendance(initialAttendance);
    setLocations(initialLocations);
    setLastUpdatedAt(generatedAt);
    setConnection(pollingEnabled ? "updating" : "history");
  }, [date, generatedAt, initialAttendance, initialEmployees, initialLocations, pollingEnabled, selectedEmployee]);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent<number>(liveGpsCountEvent, { detail: locations.length }));
  }, [locations.length]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  // Poll by server receipt time so an old point uploaded after reconnect is not
  // hidden behind a newer device capture timestamp that is already on screen.
  const latestReceivedAt = useMemo(() => locations.reduce((latest, point) => point.receivedAt > latest ? point.receivedAt : latest, ""), [locations]);

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
        if (latestReceivedAt) params.set("since", latestReceivedAt);
        if (backlogCursor.current) params.set("cursor", backlogCursor.current);
        const response = await fetch(`/api/live-operations?${params}`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(`Live update returned ${response.status}`);
        const payload = await response.json() as LiveOperationsPayload;
        if (!active) return;
        backlogCursor.current = payload.nextCursor ?? "";
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
  }, [date, latestReceivedAt, pollingEnabled, selectedEmployee]);

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

  const connectionStyle = connection === "live" ? "bg-emerald-50 text-emerald-800" : connection === "delayed" ? "bg-red-50 text-red-800" : connection === "history" ? "bg-blue-50 text-blue-800" : "bg-amber-50 text-amber-800";
  return <><section className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.85fr)_minmax(280px,.72fr)]" id="route-history">
    <article className={ui.card}>
      <div className={ui.sectionHead}><div><p className={ui.eyebrow}>Full route history</p><h2 className={ui.h2}>{date} · {locations.length} GPS points</h2></div><span className={`inline-flex max-w-60 items-center gap-2 rounded-full px-3 py-2 text-[11px] font-extrabold ${connectionStyle}`}><i className="h-2 w-2 shrink-0 rounded-full bg-current" />{statusCopy}</span></div>
      <OperationsMap points={mapPoints} routes={routes} />
      <div className="mt-4 flex flex-wrap items-center gap-4 text-xs text-slate-500"><span className="inline-flex items-center gap-2"><i className="h-2.5 w-2.5 rounded-full bg-blue-700" /> Assigned visit</span><span className="inline-flex items-center gap-2"><i className="h-2.5 w-2.5 rounded-full bg-emerald-700" /> Completed visit</span><span className="inline-flex items-center gap-2"><i className="h-2.5 w-2.5 rounded-full bg-amber-500" /> Latest position</span>{pollingEnabled && <small className="sm:ml-auto">Checks for new server-saved GPS every 15 seconds</small>}</div>
    </article>
    <aside className="self-start rounded-2xl bg-[#14213D] p-6 text-white"><p className="text-[11px] font-black uppercase tracking-[0.13em] text-slate-400">Workday status</p><h2 className="my-1 text-2xl font-black tracking-tight text-white">{date}</h2><ul className="my-6 list-none p-0">{attendance.map((record) => {
      const points = locationsByEmployee.get(record.employeeId) ?? [];
      const latest = points.at(-1);
      const stale = record.status === "checked_in" && (!latest || clock - new Date(latest.capturedAt).valueOf() > staleAfterMs);
      const flagStyle = record.status === "checked_out" ? "bg-blue-300/20 text-blue-100" : stale ? "bg-red-300/20 text-red-100" : "bg-amber-300/20 text-amber-100";
      return <li className="border-t border-white/15 py-4" key={record.id}><span className={`inline-block rounded-md px-2 py-1 text-[10px] font-black uppercase tracking-wider ${flagStyle}`}>{record.status === "checked_out" ? "finished" : stale ? "GPS stopped" : "working live"}</span><strong className="my-2 block">{employeeById.get(record.employeeId)?.name ?? "Salesperson"}</strong><small className="block text-slate-300">{time(record.checkInAt)} → {time(record.checkOutAt)} · {points.length} route points</small>{latest && <small className="mt-2 block text-emerald-200">Last GPS {relativeTime(latest.capturedAt, clock)}</small>}</li>;
    })}</ul>{attendance.length === 0 && <p className="leading-6 text-slate-300">No one started work for this filter.</p>}</aside>
  </section>
  <details className="mt-5 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_10px_30px_rgba(20,33,61,0.055)]"><summary className="flex cursor-pointer list-none items-center justify-between gap-5 p-5 sm:p-6"><span><span className={ui.eyebrow}>Audit trail</span><strong className="mt-1 block text-xl font-black">Open minute-by-minute route log</strong></span><b className="text-sm text-emerald-700">{locations.length} points</b></summary><div className="overflow-x-auto border-t border-slate-200 px-5 pb-5 sm:px-6 sm:pb-6"><table className={ui.table}><thead><tr><th>Captured</th><th>Salesperson</th><th>Coordinates</th><th>Accuracy</th><th>Source</th><th>Server received</th></tr></thead><tbody>{locations.map((point) => <tr key={point.id}><td>{time(point.capturedAt)}</td><td>{employeeById.get(point.employeeId)?.name ?? "Unknown"}</td><td><a className="font-extrabold text-blue-700 hover:text-blue-900" href={`https://www.openstreetmap.org/?mlat=${point.latitude}&mlon=${point.longitude}#map=18/${point.latitude}/${point.longitude}`} target="_blank">{point.latitude.toFixed(6)}, {point.longitude.toFixed(6)}</a></td><td>±{Math.round(point.accuracy)} m</td><td>{point.source.replaceAll("_", " ")}</td><td>{time(point.receivedAt)}</td></tr>)}</tbody></table></div></details></>;
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
