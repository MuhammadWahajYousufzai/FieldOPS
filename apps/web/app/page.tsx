import { redirect } from "next/navigation";
import { Query } from "node-appwrite";
import { createAdminTablesDb } from "@fieldops/appwrite/server";
import { requireManager } from "../lib/auth";
import { workDate } from "../lib/mobile-auth";
import { LogoutButton } from "./logout-button";
import { MapPoint, OperationsMap } from "./operations-map";

export const dynamic = "force-dynamic";
const databaseId = process.env.APPWRITE_DATABASE_ID ?? "fieldops";

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ date?: string; employee?: string }> }) {
  const actor = await requireManager();
  if (!actor) redirect("/login");
  const params = await searchParams;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(params.date ?? "") ? String(params.date) : workDate();
  const selectedEmployee = params.employee ?? "all";
  const db = createAdminTablesDb();
  const [employeeList, outletsResult, routesResult, attendanceResult] = await Promise.all([
    db.listRows({ databaseId, tableId: "employees", queries: [Query.equal("status", "active"), Query.orderAsc("display_name"), Query.limit(100)] }),
    db.listRows({ databaseId, tableId: "outlets", queries: [Query.equal("status", "active"), Query.orderAsc("name"), Query.limit(100)] }),
    db.listRows({ databaseId, tableId: "route_assignments", queries: [Query.equal("work_date", date), Query.limit(100)] }),
    db.listRows({ databaseId, tableId: "attendance_records", queries: [Query.equal("work_date", date), Query.limit(100)] }),
  ]);
  const visitQueries = [Query.equal("work_date", date), Query.orderDesc("check_in_at"), Query.limit(100)];
  if (selectedEmployee !== "all") visitQueries.unshift(Query.equal("employee_id", selectedEmployee));
  const visitsResult = await db.listRows({ databaseId, tableId: "visits", queries: visitQueries });
  const evidenceResult = await db.listRows({ databaseId, tableId: "visit_evidence", queries: [Query.orderDesc("captured_at"), Query.limit(100)] });
  const employees = new Map(employeeList.rows.map((row) => [row.$id, row]));
  const outlets = new Map(outletsResult.rows.map((row) => [row.$id, row]));
  const evidence = new Map<string, typeof evidenceResult.rows>();
  for (const item of evidenceResult.rows) {
    const list = evidence.get(String(item.visit_id)) ?? [];
    list.push(item);
    evidence.set(String(item.visit_id), list);
  }
  const visibleRoutes = routesResult.rows.filter((row) => selectedEmployee === "all" || row.employee_id === selectedEmployee);
  const visibleOutlets = outletsResult.rows.filter((row) => selectedEmployee === "all" || row.assigned_employee_id === selectedEmployee);
  const completed = visitsResult.rows.filter((row) => row.status === "completed").length;
  const sales = visitsResult.rows.reduce((sum, row) => sum + Number(row.order_amount ?? 0), 0);
  const mapPoints: MapPoint[] = [
    ...visibleOutlets.map((outlet) => ({ id: outlet.$id, name: String(outlet.name), address: String(outlet.address), latitude: Number(outlet.latitude), longitude: Number(outlet.longitude), kind: "outlet" as const })),
    ...visitsResult.rows.map((visit) => ({ id: visit.$id, name: `${String(employees.get(String(visit.employee_id))?.display_name ?? "Salesperson")} · ${String(outlets.get(String(visit.outlet_id))?.name ?? "Visit")}`, address: `${Math.round(Number(visit.geofence_distance_m))}m from assigned outlet`, latitude: Number(visit.latitude), longitude: Number(visit.longitude), kind: "visit" as const })),
  ];

  return <main className="shell">
    <aside className="rail">
      <div className="brand"><span className="grain">YR</span><div><strong>Yousuf Rice FieldOps</strong><small>Karachi operations</small></div></div>
      <nav aria-label="Primary"><a className="selected" href="/">Overview</a><a href="/management">Management</a><a href="/?date=">Field activity</a><a href="/management">Salespersons</a><a href="#reports">Reports</a></nav>
      <div className="signed-in"><small>Signed in as</small><strong>{actor.user.name}</strong><LogoutButton /></div>
    </aside>
    <section className="workspace">
      <header className="dashboard-head"><div><p className="eyebrow">Production workspace</p><h1>Karachi in one view.</h1><p className="lede">Assignments, GPS evidence, visit photos, audio notes, and sales results update from the field app.</p></div><a className="button-link" href="/management">Manage team & stores</a></header>
      <form className="filter-bar" method="get" id="reports">
        <label>Date<input type="date" name="date" defaultValue={date} /></label>
        <label>Salesperson<select name="employee" defaultValue={selectedEmployee}><option value="all">All salespersons</option>{employeeList.rows.map((employee) => <option key={employee.$id} value={employee.$id}>{String(employee.display_name)}</option>)}</select></label>
        <button>View report</button>
      </form>
      <section className="pulse" aria-label="Filtered totals">
        <article><span>Assigned stops</span><b>{visibleRoutes.length}</b><small>{date}</small></article>
        <article><span>Completed visits</span><b>{completed}</b><small>{visitsResult.total} captured visits</small></article>
        <article><span>Sales recorded</span><b>PKR {sales.toLocaleString()}</b><small>Server-confirmed outcomes</small></article>
        <article><span>Checked in</span><b>{attendanceResult.rows.filter((row) => row.status === "checked_in" && (selectedEmployee === "all" || row.employee_id === selectedEmployee)).length}</b><small>Active shifts</small></article>
      </section>
      <section className="dashboard-grid">
        <article className="map-card"><div className="section-head"><div><p className="eyebrow">OpenStreetMap · MapLibre</p><h2>Assigned and captured locations</h2></div><span className="live">Live data</span></div><OperationsMap points={mapPoints} /><p className="map-key"><i className="key-outlet" /> Assigned outlet <i className="key-visit" /> Captured visit point</p></article>
        <aside className="decision-card"><p className="eyebrow">Route progress</p><h2>{date}</h2><ul>{visibleRoutes.slice(0, 8).map((route) => {
          const outlet = outlets.get(String(route.outlet_id)); const employee = employees.get(String(route.employee_id));
          return <li key={route.$id}><span className={`flag ${route.status === "completed" ? "blue" : "amber"}`}>{String(route.status)}</span><strong>{String(outlet?.name ?? "Removed outlet")}</strong><small>{String(employee?.display_name ?? "Unassigned")} · stop {String(route.sequence)}</small></li>;
        })}</ul>{visibleRoutes.length === 0 && <p className="muted-on-dark">No published stops for this filter.</p>}</aside>
      </section>
      <section className="table-card visits-card"><div className="section-head"><div><p className="eyebrow">Evidence report</p><h2>Visits by date and salesperson</h2></div><span>{visitsResult.total} records</span></div>
        <div className="table-scroll"><table><thead><tr><th>Time</th><th>Salesperson</th><th>Outlet</th><th>GPS</th><th>Outcome</th><th>Evidence</th><th>Sales</th></tr></thead><tbody>
          {visitsResult.rows.map((visit) => <tr key={visit.$id}>
            <td>{new Date(String(visit.check_in_at)).toLocaleTimeString("en-PK", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Karachi" })}</td>
            <td>{String(employees.get(String(visit.employee_id))?.display_name ?? "Unknown")}</td>
            <td><strong>{String(outlets.get(String(visit.outlet_id))?.name ?? "Unknown")}</strong><small>{String(outlets.get(String(visit.outlet_id))?.address ?? "")}</small></td>
            <td><span className={visit.geofence_accepted ? "ok" : "warn"}>{Math.round(Number(visit.geofence_distance_m))} m</span><small>±{Math.round(Number(visit.accuracy))} m accuracy</small></td>
            <td>{String(visit.outcome ?? visit.status)}</td>
            <td><div className="evidence-links">{(evidence.get(visit.$id) ?? []).map((item) => item.type === "photo" ? <a key={item.$id} href={`/api/evidence/${item.file_id}`} target="_blank">Photo</a> : <audio key={item.$id} controls preload="none" src={`/api/evidence/${item.file_id}`} />)}</div></td>
            <td>{visit.order_amount ? `PKR ${Number(visit.order_amount).toLocaleString()}` : "—"}</td>
          </tr>)}
          {visitsResult.total === 0 && <tr><td colSpan={7} className="empty-table">No visits are recorded for this filter yet. Complete a visit in the app to see it here.</td></tr>}
        </tbody></table></div>
      </section>
    </section>
  </main>;
}
