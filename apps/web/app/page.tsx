import { redirect } from "next/navigation";
import { Query } from "node-appwrite";
import { createAdminTablesDb } from "@fieldops/appwrite/server";
import { requireManager } from "../lib/auth";
import { workDate } from "../lib/mobile-auth";
import { listAllRows, listAllRowsOrEmpty } from "../lib/table-data";
import { LogoutButton } from "./logout-button";
import { MapPoint, OperationsMap, RouteLine } from "./operations-map";

export const dynamic = "force-dynamic";
const databaseId = process.env.APPWRITE_DATABASE_ID ?? "fieldops";
const routeColors = ["#D8A629", "#2F75A8", "#B5523B", "#267057", "#75579B", "#CA7134"];

function time(value: unknown) {
  if (!value) return "—";
  return new Date(String(value)).toLocaleTimeString("en-PK", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Karachi" });
}

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ date?: string; employee?: string }> }) {
  const actor = await requireManager();
  if (!actor) redirect("/login");
  const params = await searchParams;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(params.date ?? "") ? String(params.date) : workDate();
  const selectedEmployee = params.employee ?? "all";
  const db = createAdminTablesDb();
  const employeeFilter = selectedEmployee === "all" ? [] : [Query.equal("employee_id", selectedEmployee)];
  const [employeeRows, outletRows, routeRows, attendanceRows, visitRows, evidenceRows, locationRows, orderRows] = await Promise.all([
    listAllRows(db, databaseId, "employees", [Query.equal("status", "active")]),
    listAllRows(db, databaseId, "outlets", [Query.equal("status", "active")]),
    listAllRows(db, databaseId, "route_assignments", [Query.equal("work_date", date)]),
    listAllRows(db, databaseId, "attendance_records", [Query.equal("work_date", date)]),
    listAllRows(db, databaseId, "visits", [Query.equal("work_date", date), ...employeeFilter]),
    listAllRowsOrEmpty(db, databaseId, "visit_evidence"),
    listAllRowsOrEmpty(db, databaseId, "location_points", [Query.equal("work_date", date), ...employeeFilter]),
    listAllRowsOrEmpty(db, databaseId, "orders", [Query.equal("work_date", date), ...employeeFilter]),
  ]);
  employeeRows.sort((a, b) => String(a.display_name).localeCompare(String(b.display_name)));
  outletRows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  visitRows.sort((a, b) => String(b.check_in_at).localeCompare(String(a.check_in_at)));
  locationRows.sort((a, b) => String(a.captured_at).localeCompare(String(b.captured_at)));
  orderRows.sort((a, b) => String(b.captured_at).localeCompare(String(a.captured_at)));
  const employees = new Map(employeeRows.map((row) => [row.$id, row]));
  const outlets = new Map(outletRows.map((row) => [row.$id, row]));
  const visitIds = new Set(visitRows.map((row) => row.$id));
  const evidence = new Map<string, typeof evidenceRows>();
  for (const item of evidenceRows) {
    if (!visitIds.has(String(item.visit_id))) continue;
    const list = evidence.get(String(item.visit_id)) ?? [];
    list.push(item);
    evidence.set(String(item.visit_id), list);
  }
  const visibleRoutes = routeRows.filter((row) => selectedEmployee === "all" || row.employee_id === selectedEmployee);
  const assignedOutletIds = new Set(visibleRoutes.map((row) => String(row.outlet_id)));
  const visibleOutlets = outletRows.filter((row) => assignedOutletIds.has(row.$id));
  const visibleAttendance = attendanceRows.filter((row) => selectedEmployee === "all" || row.employee_id === selectedEmployee);
  const completedVisits = visitRows.filter((row) => row.status === "completed").length;
  const assignedCompleted = visibleRoutes.filter((row) => row.status === "completed").length;
  const assignedPending = visibleRoutes.length - assignedCompleted;
  const selfInitiatedVisits = visitRows.filter((row) => row.visit_type === "self_initiated" || !row.route_assignment_id).length;
  const sales = orderRows.reduce((sum, row) => sum + Number(row.total_amount ?? 0), 0) + visitRows.reduce((sum, row) => sum + Number(row.order_amount ?? 0), 0);

  const byEmployee = new Map<string, typeof locationRows>();
  for (const point of locationRows) {
    const list = byEmployee.get(String(point.employee_id)) ?? [];
    list.push(point);
    byEmployee.set(String(point.employee_id), list);
  }
  const routeLines: RouteLine[] = [...byEmployee.entries()].map(([employeeId, points], index) => ({
    id: employeeId,
    name: String(employees.get(employeeId)?.display_name ?? "Salesperson"),
    color: routeColors[index % routeColors.length]!,
    coordinates: points.map((point) => [Number(point.longitude), Number(point.latitude)] as [number, number]),
  }));
  const latestPoints: MapPoint[] = [...byEmployee.entries()].flatMap(([employeeId, points]) => {
    const last = points.at(-1);
    if (!last) return [];
    return [{ id: last.$id, name: `${String(employees.get(employeeId)?.display_name ?? "Salesperson")} · latest`, address: `${time(last.captured_at)} · ±${Math.round(Number(last.accuracy))} m`, latitude: Number(last.latitude), longitude: Number(last.longitude), kind: "live" as const }];
  });
  const mapPoints: MapPoint[] = [
    ...visibleOutlets.map((outlet) => ({ id: outlet.$id, name: String(outlet.name), address: String(outlet.address), latitude: Number(outlet.latitude), longitude: Number(outlet.longitude), kind: "outlet" as const })),
    ...visitRows.map((visit) => ({ id: visit.$id, name: `${String(employees.get(String(visit.employee_id))?.display_name ?? "Salesperson")} · ${String(visit.customer_name || outlets.get(String(visit.outlet_id))?.name || "Visit")}`, address: visit.route_assignment_id ? `${Math.round(Number(visit.geofence_distance_m))} m from assigned location` : "Salesperson-added visit point", latitude: Number(visit.latitude), longitude: Number(visit.longitude), kind: "visit" as const })),
    ...latestPoints,
  ];

  return <main className="shell">
    <aside className="rail">
      <div className="brand"><span className="grain">YR</span><div><strong>Yousuf Rice FieldOps</strong><small>Field operations</small></div></div>
      <nav aria-label="Primary"><a className="selected" href="/">Overview</a><a href="/management">Management</a><a href="#route-history">Route history</a><a href="#visits">Visit history</a><a href="#orders">Orders</a></nav>
      <div className="signed-in"><small>Signed in as</small><strong>{actor.user.name}</strong><LogoutButton /></div>
    </aside>
    <section className="workspace">
      <header className="dashboard-head"><div><p className="eyebrow">Date-wise field record</p><h1>Every commitment and field visit.</h1><p className="lede">Minute-by-minute route history, unfinished management assignments, salesperson-added visits, required photo and audio evidence, and orders taken anywhere.</p></div><a className="button-link" href="/management">Assign visits & manage team</a></header>
      <form className="filter-bar" method="get" id="reports">
        <label>Date<input type="date" name="date" defaultValue={date} /></label>
        <label>Salesperson<select name="employee" defaultValue={selectedEmployee}><option value="all">All salespersons</option>{employeeRows.filter((employee) => employee.$id !== actor.employee.$id).map((employee) => <option key={employee.$id} value={employee.$id}>{String(employee.display_name)}</option>)}</select></label>
        <button>View history</button>
      </form>
      <section className="pulse" aria-label="Filtered totals">
        <article><span>Assigned completion</span><b>{assignedCompleted}/{visibleRoutes.length}</b><small>{assignedPending} still need follow-up</small></article>
        <article><span>Visits recorded</span><b>{completedVisits}</b><small>{selfInitiatedVisits} added by salespeople</small></article>
        <article><span>Orders recorded</span><b>{orderRows.length}</b><small>PKR {sales.toLocaleString()}</small></article>
        <article><span>GPS route points</span><b>{locationRows.length}</b><small>Minute-by-minute history</small></article>
      </section>
      <section className="dashboard-grid" id="route-history">
        <article className="map-card"><div className="section-head"><div><p className="eyebrow">Full route history</p><h2>{date} · {locationRows.length} GPS points</h2></div><span className="live">Server saved</span></div><OperationsMap points={mapPoints} routes={routeLines} /><p className="map-key"><i className="key-outlet" /> Assigned visit <i className="key-visit" /> Completed visit <i className="key-live" /> Latest position</p></article>
        <aside className="decision-card"><p className="eyebrow">Workday status</p><h2>{date}</h2><ul>{visibleAttendance.map((attendance) => {
          const points = byEmployee.get(String(attendance.employee_id)) ?? [];
          const latest = points.at(-1);
          const stale = attendance.status === "checked_in" && (!latest || Date.now() - new Date(String(latest.captured_at)).valueOf() > 150_000);
          return <li key={attendance.$id}><span className={`flag ${attendance.status === "checked_out" ? "blue" : stale ? "red" : "amber"}`}>{attendance.status === "checked_out" ? "finished" : stale ? "GPS stopped" : "working"}</span><strong>{String(employees.get(String(attendance.employee_id))?.display_name ?? "Salesperson")}</strong><small>{time(attendance.check_in_at)} → {time(attendance.check_out_at)} · {points.length} route points</small></li>;
        })}</ul>{visibleAttendance.length === 0 && <p className="muted-on-dark">No one started work for this filter.</p>}</aside>
      </section>
      <details className="table-card route-log"><summary><span><span className="eyebrow">Audit trail</span><strong>Open minute-by-minute route log</strong></span><b>{locationRows.length} points</b></summary><div className="table-scroll"><table><thead><tr><th>Captured</th><th>Salesperson</th><th>Coordinates</th><th>Accuracy</th><th>Source</th><th>Server received</th></tr></thead><tbody>{locationRows.map((point) => <tr key={point.$id}><td>{time(point.captured_at)}</td><td>{String(employees.get(String(point.employee_id))?.display_name ?? "Unknown")}</td><td><a href={`https://www.openstreetmap.org/?mlat=${point.latitude}&mlon=${point.longitude}#map=18/${point.latitude}/${point.longitude}`} target="_blank">{Number(point.latitude).toFixed(6)}, {Number(point.longitude).toFixed(6)}</a></td><td>±{Math.round(Number(point.accuracy))} m</td><td>{String(point.source).replaceAll("_", " ")}</td><td>{time(point.received_at)}</td></tr>)}</tbody></table></div></details>
      <section className="table-card visits-card" id="assignments"><div className="section-head"><div><p className="eyebrow">Management commitments</p><h2>Assigned visit completion status</h2></div><span>{assignedPending} need follow-up</span></div>
        <div className="table-scroll"><table><thead><tr><th>Salesperson</th><th>Assigned customer</th><th>Sequence</th><th>Status</th><th>Completed</th></tr></thead><tbody>
          {visibleRoutes.map((route) => <tr key={route.$id}><td>{String(employees.get(String(route.employee_id))?.display_name ?? "Unknown")}</td><td><strong>{String(outlets.get(String(route.outlet_id))?.name ?? "Unknown")}</strong><small>{String(outlets.get(String(route.outlet_id))?.address ?? "")}</small></td><td>{Number(route.sequence)}</td><td><span className={route.status === "completed" ? "ok" : "warn"}>{String(route.status).replaceAll("_", " ")}</span></td><td>{time(route.completed_at)}</td></tr>)}
          {visibleRoutes.length === 0 && <tr><td colSpan={5} className="empty-table">No visits were assigned for this filter.</td></tr>}
        </tbody></table></div>
      </section>
      <section className="table-card visits-card" id="visits"><div className="section-head"><div><p className="eyebrow">Visit history</p><h2>Location, photo, and audio by date</h2></div><span>{visitRows.length} records</span></div>
        <div className="table-scroll"><table><thead><tr><th>Time</th><th>Salesperson</th><th>Visit</th><th>Location check</th><th>Outcome</th><th>Required evidence</th></tr></thead><tbody>
          {visitRows.map((visit) => { const assigned = Boolean(visit.route_assignment_id); const outlet = outlets.get(String(visit.outlet_id)); return <tr key={visit.$id}><td>{time(visit.check_in_at)}<small>{visit.check_out_at ? `Finished ${time(visit.check_out_at)}` : "In progress"}</small></td><td>{String(employees.get(String(visit.employee_id))?.display_name ?? "Unknown")}</td><td><span className={assigned ? "visit-kind assigned" : "visit-kind self"}>{assigned ? "Assigned" : "Salesperson-added"}</span><strong>{String(visit.customer_name || outlet?.name || "Unknown")}</strong><small>{String(visit.customer_address || outlet?.address || "GPS location saved")}</small></td><td><a href={`https://www.openstreetmap.org/?mlat=${visit.latitude}&mlon=${visit.longitude}#map=18/${visit.latitude}/${visit.longitude}`} target="_blank">Open visit point</a><small>{assigned ? `${Math.round(Number(visit.geofence_distance_m))} m at check-in` : `${Math.round(Number(visit.completion_distance_m ?? 0))} m from start at finish`} · maximum 70 m</small></td><td>{String(visit.outcome ?? visit.status)}</td><td><div className="evidence-links">{(evidence.get(visit.$id) ?? []).map((item) => item.type === "photo" ? <a key={item.$id} href={`/api/evidence/${item.file_id}`} target="_blank">View photo</a> : <audio key={item.$id} controls preload="none" src={`/api/evidence/${item.file_id}`} />)}</div></td></tr>; })}
          {visitRows.length === 0 && <tr><td colSpan={6} className="empty-table">No visits are recorded for this filter.</td></tr>}
        </tbody></table></div>
      </section>
      <section className="table-card visits-card" id="orders"><div className="section-head"><div><p className="eyebrow">Order history</p><h2>Orders taken from any location</h2></div><span>{orderRows.length} records</span></div><div className="table-scroll"><table><thead><tr><th>Time</th><th>Salesperson</th><th>Customer</th><th>Product</th><th>Quantity</th><th>Total</th><th>Location</th></tr></thead><tbody>{orderRows.map((order) => <tr key={order.$id}><td>{time(order.captured_at)}</td><td>{String(employees.get(String(order.employee_id))?.display_name ?? "Unknown")}</td><td><strong>{String(order.customer_name)}</strong><small>{String(order.phone || order.address || "")}</small></td><td>{String(order.product_name)}</td><td>{Number(order.quantity_kg).toLocaleString()} kg</td><td>PKR {Number(order.total_amount).toLocaleString()}</td><td><a href={`https://www.openstreetmap.org/?mlat=${order.latitude}&mlon=${order.longitude}#map=18/${order.latitude}/${order.longitude}`} target="_blank">Open map</a></td></tr>)}{orderRows.length === 0 && <tr><td colSpan={7} className="empty-table">No orders are recorded for this filter.</td></tr>}</tbody></table></div></section>
    </section>
  </main>;
}
