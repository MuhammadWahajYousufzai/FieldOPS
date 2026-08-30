import { redirect } from "next/navigation";
import { Query } from "node-appwrite";
import { createAdminTablesDb } from "@fieldops/appwrite/server";
import { hasRequiredVisitEvidence } from "@fieldops/domain";
import { requireDashboardAdmin } from "../lib/auth";
import { workDate } from "../lib/mobile-auth";
import { operationalPolicyFromRow } from "../lib/operational-policy";
import { liveProgressRevision } from "../lib/live-progress";
import { listRowsResult } from "../lib/table-data";
import type { LiveAttendance, LiveEmployee, LiveLocationPoint } from "../lib/live-types";
import { LogoutButton } from "./logout-button";
import { LiveGpsCount, LiveOperations } from "./live-operations";
import type { MapPoint } from "./operations-map";
import { ui } from "./ui";

export const dynamic = "force-dynamic";
const databaseId = process.env.APPWRITE_DATABASE_ID ?? "fieldops";

function time(value: unknown) {
  if (!value) return "—";
  return new Date(String(value)).toLocaleTimeString("en-PK", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Karachi" });
}

function latestAttendanceByEmployee<T extends object>(rows: T[]) {
  const latest = new Map<string, T>();
  for (const row of [...rows].sort((a, b) => String((b as Record<string, unknown>).check_in_at).localeCompare(String((a as Record<string, unknown>).check_in_at)))) {
    const employeeId = String((row as Record<string, unknown>).employee_id);
    if (!latest.has(employeeId)) latest.set(employeeId, row);
  }
  return [...latest.values()];
}

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ date?: string; employee?: string }> }) {
  const actor = await requireDashboardAdmin();
  if (!actor) redirect("/login");
  const params = await searchParams;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(params.date ?? "") ? String(params.date) : workDate();
  const selectedEmployee = params.employee ?? "all";
  const db = createAdminTablesDb();
  const employeeFilter = selectedEmployee === "all" ? [] : [Query.equal("employee_id", selectedEmployee)];
  const initialResults = await Promise.all([
    listRowsResult(db, databaseId, "employees", [Query.equal("status", "active")]),
    listRowsResult(db, databaseId, "outlets", [Query.equal("status", "active")]),
    listRowsResult(db, databaseId, "route_assignments", [Query.equal("work_date", date)]),
    listRowsResult(db, databaseId, "attendance_records", [Query.equal("work_date", date)]),
    listRowsResult(db, databaseId, "visits", [Query.equal("work_date", date), Query.equal("status", "completed"), ...employeeFilter]),
    listRowsResult(db, databaseId, "location_points", [Query.equal("work_date", date), ...employeeFilter]),
    listRowsResult(db, databaseId, "orders", [Query.equal("work_date", date), ...employeeFilter]),
    listRowsResult(db, databaseId, "organizations", [Query.equal("active", true), Query.orderAsc("$createdAt")], 1),
  ]);
  const [employeeResult, outletResult, routeResult, attendanceResult, visitResult, locationResult, orderResult, organizationResult] = initialResults;
  const employeeRows = employeeResult.rows, outletRows = outletResult.rows, routeRows = routeResult.rows;
  const dashboardAdminEmployeeId = employeeRows.find((employee) => String(employee.user_id) === actor.user.$id)?.$id;
  const attendanceRows = attendanceResult.rows, rawVisitRows = visitResult.rows, locationRows = locationResult.rows, orderRows = orderResult.rows;
  const operationsPolicy = operationalPolicyFromRow(organizationResult.rows[0] as Record<string, unknown> | undefined);
  const evidenceResult = rawVisitRows.length > 0 ? await listRowsResult(db, databaseId, "visit_evidence", [], 5_000) : null;
  const evidenceRows = evidenceResult?.rows ?? [];
  const dataErrors = [...initialResults, ...(evidenceResult ? [evidenceResult] : [])].filter((result) => result.error);
  employeeRows.sort((a, b) => String(a.display_name).localeCompare(String(b.display_name)));
  outletRows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  locationRows.sort((a, b) => String(a.captured_at).localeCompare(String(b.captured_at)));
  orderRows.sort((a, b) => String(b.captured_at).localeCompare(String(a.captured_at)));
  const employees = new Map(employeeRows.map((row) => [row.$id, row]));
  const outlets = new Map(outletRows.map((row) => [row.$id, row]));
  const visitIds = new Set(rawVisitRows.map((row) => row.$id));
  const evidence = new Map<string, typeof evidenceRows>();
  for (const item of evidenceRows) {
    if (!visitIds.has(String(item.visit_id))) continue;
    const list = evidence.get(String(item.visit_id)) ?? [];
    list.push(item);
    evidence.set(String(item.visit_id), list);
  }
  const visitRows = rawVisitRows.filter((visit) => {
    const types = new Set((evidence.get(visit.$id) ?? []).map((item) => String(item.type)));
    return hasRequiredVisitEvidence({ photo: types.has("photo"), audio: types.has("audio") });
  });
  visitRows.sort((a, b) => String(b.check_in_at).localeCompare(String(a.check_in_at)));
  const visibleRoutes = routeRows.filter((row) => selectedEmployee === "all" || row.employee_id === selectedEmployee);
  const assignedOutletIds = new Set(visibleRoutes.map((row) => String(row.outlet_id)));
  const visibleOutlets = outletRows.filter((row) => assignedOutletIds.has(row.$id));
  const visibleAttendance = latestAttendanceByEmployee(attendanceRows.filter((row) => selectedEmployee === "all" || row.employee_id === selectedEmployee));
  const completedVisits = visitRows.filter((row) => row.status === "completed").length;
  const assignedCompleted = visibleRoutes.filter((row) => row.status === "completed").length;
  const assignedPending = visibleRoutes.length - assignedCompleted;
  const selfInitiatedVisits = visitRows.filter((row) => row.visit_type === "self_initiated" || !row.route_assignment_id).length;
  const sales = orderRows.reduce((sum, row) => sum + Number(row.total_amount ?? 0), 0) + visitRows.reduce((sum, row) => sum + Number(row.order_amount ?? 0), 0);

  const staticMapPoints: MapPoint[] = [
    ...visibleOutlets.map((outlet) => ({ id: outlet.$id, name: String(outlet.name), address: String(outlet.address), latitude: Number(outlet.latitude), longitude: Number(outlet.longitude), kind: "outlet" as const })),
    ...visitRows.map((visit) => {
      const assigned = Boolean(visit.route_assignment_id);
      const officialOutlet = outlets.get(String(visit.approved_outlet_id || visit.outlet_id));
      const officialName = String(officialOutlet?.name || visit.customer_name || "Visit");
      const submittedName = String(visit.customer_name || "");
      const approvalStatus = String(visit.place_approval_status || "pending_review");
      const address = assigned
        ? `${Math.round(Number(visit.geofence_distance_m))} m from assigned location`
        : approvalStatus === "approved"
          ? `Permanent place${submittedName && submittedName !== officialName ? ` · submitted as ${submittedName}` : ""}`
          : approvalStatus === "rejected"
            ? "Salesperson-marked point rejected by management"
            : "Salesperson-marked point awaiting review";
      return { id: visit.$id, name: `${String(employees.get(String(visit.employee_id))?.display_name ?? "Salesperson")} · ${officialName}`, address, latitude: Number(visit.latitude), longitude: Number(visit.longitude), kind: "visit" as const };
    }),
  ];
  const liveEmployees: LiveEmployee[] = employeeRows.map((row) => ({ id: row.$id, name: String(row.display_name ?? "Salesperson") }));
  const liveAttendance: LiveAttendance[] = visibleAttendance.map((row) => ({ id: row.$id, employeeId: String(row.employee_id), status: String(row.status), checkInAt: String(row.check_in_at), checkOutAt: row.check_out_at ? String(row.check_out_at) : null }));
  const liveLocations: LiveLocationPoint[] = locationRows.map((row) => {
    const coordinates = validPoint(row.coordinates) ? row.coordinates : [Number(row.longitude), Number(row.latitude)];
    return { id: row.$id, employeeId: String(row.employee_id), capturedAt: String(row.captured_at), receivedAt: String(row.received_at), latitude: Number(coordinates[1]), longitude: Number(coordinates[0]), accuracy: Number(row.accuracy), speed: storedSpeed(row.speed), source: String(row.source) };
  });
  const initialProgressRevision = liveProgressRevision([
    { name: "routes", rows: visibleRoutes },
    { name: "visits", rows: rawVisitRows },
    { name: "orders", rows: orderRows },
  ]);

  const metricClass = "border-b border-slate-200 py-5 sm:border-b-0 sm:border-r sm:px-6 sm:first:pl-0 sm:last:border-r-0";
  const metricValue = "my-2 block text-3xl font-black";
  const metricLabel = "block text-sm text-slate-600";
  const metricDetail = "block text-xs text-slate-500";
  const tableLink = "font-extrabold text-blue-700 hover:text-blue-900";
  return <main className={ui.shell}>
    <aside className={ui.rail}>
      <div className={ui.brand}><span className={ui.logo}>YR</span><div><strong className="block text-sm">Yousuf Rice FieldOps</strong><small className="mt-1 block text-slate-400">Field operations</small></div></div>
      <nav className={ui.nav} aria-label="Primary"><a className={`${ui.navLink} ${ui.navSelected}`} href="/">Overview</a><a className={ui.navLink} href="/management">Management</a><a className={ui.navLink} href="#route-history">Route history</a><a className={ui.navLink} href="#visits">Visit history</a><a className={ui.navLink} href="#orders">Orders</a></nav>
      <div className="mt-6 border-t border-white/15 px-2 pt-4 lg:mt-auto"><small className="mb-1 block text-slate-400">Signed in as</small><strong className="block">{actor.user.name}</strong><LogoutButton /></div>
    </aside>
    <section className={ui.workspace}>
      <header className="mb-7 flex flex-col items-start justify-between gap-5 xl:flex-row"><div><p className={ui.eyebrow}>Date-wise field record</p><h1 className={ui.h1}>Every commitment and field visit.</h1><p className={ui.lede}>Quality-checked route history, unfinished assignments, salesperson-marked places, photo and voice evidence, and territory-aware orders.</p></div><a className={ui.button} href="/management">Open management controls</a></header>
      {dataErrors.length > 0 && <section className="mb-6 border-l-4 border-amber-600 bg-amber-50 p-4 text-amber-950" role="alert"><strong className="block">Some dashboard records could not be loaded.</strong><p className="mt-1 text-sm leading-6">The visible totals may be incomplete; an unavailable table is not being reported as zero. Refresh to retry: {dataErrors.map((result) => result.tableId.replaceAll("_", " ")).join(", ")}.</p><a className="mt-3 inline-flex font-black text-amber-950 underline decoration-2 underline-offset-4" href={`/?date=${date}&employee=${selectedEmployee}`}>Retry dashboard data</a></section>}
      <form className="mb-7 flex flex-col items-stretch gap-3 rounded-2xl border border-slate-200 bg-white p-4 sm:flex-row sm:items-end" method="get" id="reports">
        <label className={`${ui.label} sm:min-w-48`}>Date<input className={ui.input} type="date" name="date" defaultValue={date} /></label>
        <label className={`${ui.label} sm:min-w-56`}>Salesperson<select className={ui.input} name="employee" defaultValue={selectedEmployee}><option value="all">All salespersons</option>{employeeRows.filter((employee) => !dashboardAdminEmployeeId || employee.$id !== dashboardAdminEmployeeId).map((employee) => <option key={employee.$id} value={employee.$id}>{String(employee.display_name)}</option>)}</select></label>
        <button className={ui.button}>View history</button>
      </form>
      <section className="mb-7 grid border-y border-slate-200 sm:grid-cols-2 xl:grid-cols-4" aria-label="Filtered totals">
        <article className={metricClass}><span className={metricLabel}>Assigned completion</span><b className={metricValue}>{assignedCompleted}/{visibleRoutes.length}</b><small className={metricDetail}>{assignedPending} still need follow-up</small></article>
        <article className={metricClass}><span className={metricLabel}>Visits recorded</span><b className={metricValue}>{completedVisits}</b><small className={metricDetail}>{selfInitiatedVisits} added by salespeople</small></article>
        <article className={metricClass}><span className={metricLabel}>Orders recorded</span><b className={metricValue}>{orderRows.length}</b><small className={metricDetail}>PKR {sales.toLocaleString()}</small></article>
        <article className={metricClass}><span className={metricLabel}>GPS route points</span><span className={metricValue}><LiveGpsCount initialCount={locationRows.length} /></span><small className={metricDetail}>Raw fixes preserved for audit</small></article>
      </section>
      <LiveOperations key={`${date}:${selectedEmployee}`} date={date} selectedEmployee={selectedEmployee} pollingEnabled={date === workDate()} generatedAt={new Date().toISOString()} initialProgressRevision={initialProgressRevision} staticPoints={staticMapPoints} initialEmployees={liveEmployees} initialAttendance={liveAttendance} initialLocations={liveLocations} routePolicy={operationsPolicy} />
      <section className={ui.tableCard} id="assignments"><div className={ui.sectionHead}><div><p className={ui.eyebrow}>Management commitments</p><h2 className={ui.h2}>Assigned visit completion status</h2></div><span className="text-sm font-bold text-slate-500">{assignedPending} need follow-up</span></div>
        <div className={ui.tableWrap}><table className={ui.table}><thead><tr><th>Salesperson</th><th>Assigned customer</th><th>Sequence</th><th>Status</th><th>Completed</th></tr></thead><tbody>
          {visibleRoutes.map((route) => <tr key={route.$id}><td>{String(employees.get(String(route.employee_id))?.display_name ?? "Unknown")}</td><td><strong>{String(outlets.get(String(route.outlet_id))?.name ?? "Unknown")}</strong><small>{String(outlets.get(String(route.outlet_id))?.address ?? "")}</small></td><td>{Number(route.sequence)}</td><td><span className={route.status === "completed" ? "font-extrabold text-emerald-700" : "font-extrabold text-amber-700"}>{String(route.status).replaceAll("_", " ")}</span></td><td>{time(route.completed_at)}</td></tr>)}
          {visibleRoutes.length === 0 && <tr><td colSpan={5} className="py-9 text-center text-slate-500">No visits were assigned for this filter.</td></tr>}
        </tbody></table></div>
      </section>
      <section className={ui.tableCard} id="visits"><div className={ui.sectionHead}><div><p className={ui.eyebrow}>Visit history</p><h2 className={ui.h2}>Location, evidence, and place approval</h2></div><span className="text-sm font-bold text-slate-500">{visitRows.length} records</span></div>
        <div className={ui.tableWrap}><table className={ui.table}><thead><tr><th>Time</th><th>Salesperson</th><th>Visit</th><th>Place approval</th><th>Location check</th><th>Outcome</th><th>Required evidence</th></tr></thead><tbody>
          {visitRows.map((visit) => {
            const assigned = Boolean(visit.route_assignment_id);
            const approvalStatus = assigned ? "not_applicable" : String(visit.place_approval_status || "pending_review");
            const outlet = outlets.get(String(visit.approved_outlet_id || visit.outlet_id));
            const submittedName = String(visit.customer_name || "");
            const officialName = String(outlet?.name || submittedName || "Unknown");
            const submittedNameChanged = !assigned && approvalStatus === "approved" && Boolean(submittedName) && submittedName !== officialName;
            const approvalLabel = assigned ? "Not required" : approvalStatus === "approved" ? "Permanent place" : approvalStatus === "rejected" ? "Rejected" : "Awaiting admin";
            const approvalStyle = assigned ? "bg-slate-100 text-slate-700" : approvalStatus === "approved" ? "bg-emerald-50 text-emerald-800" : approvalStatus === "rejected" ? "bg-red-50 text-red-800" : "bg-amber-50 text-amber-800";
            return <tr key={visit.$id}><td>{time(visit.check_in_at)}<small>{visit.check_out_at ? `Finished ${time(visit.check_out_at)}` : "In progress"}</small></td><td>{String(employees.get(String(visit.employee_id))?.display_name ?? "Unknown")}</td><td><span className={`mb-2 block w-max rounded-full px-2 py-1 text-[9px] font-black uppercase tracking-wider ${assigned ? "bg-blue-50 text-blue-800" : "bg-emerald-50 text-emerald-800"}`}>{assigned ? "Assigned" : "Salesperson-added"}</span><strong>{officialName}</strong><small>{String(outlet?.address || visit.customer_address || "GPS location saved")}</small>{submittedNameChanged && <small className="font-bold text-blue-700">Submitted as “{submittedName}”</small>}</td><td><span className={`inline-flex rounded-full px-2.5 py-1 text-[10px] font-black uppercase tracking-wider ${approvalStyle}`}>{approvalLabel}</span>{!assigned && visit.reviewed_at && <small>Reviewed {time(visit.reviewed_at)}</small>}{!assigned && visit.review_note && <small>{String(visit.review_note)}</small>}</td><td><a className={tableLink} href={`https://www.openstreetmap.org/?mlat=${visit.latitude}&mlon=${visit.longitude}#map=18/${visit.latitude}/${visit.longitude}`} target="_blank">Open visit point</a><small>{assigned ? `${Math.round(Number(visit.geofence_distance_m))} m at check-in` : `${Math.round(Number(visit.completion_distance_m ?? 0))} m from start at finish`} · maximum 70 m</small></td><td>{String(visit.outcome ?? visit.status)}</td><td><div className="grid gap-2">{(evidence.get(visit.$id) ?? []).map((item) => item.type === "photo" ? <a className={tableLink} key={item.$id} href={`/api/evidence/${item.file_id}`} target="_blank">View photo</a> : <audio className="h-9 w-48" key={item.$id} controls preload="none" src={`/api/evidence/${item.file_id}`} />)}</div></td></tr>;
          })}
          {visitRows.length === 0 && <tr><td colSpan={7} className="py-9 text-center text-slate-500">No visits are recorded for this filter.</td></tr>}
        </tbody></table></div>
      </section>
      <section className={ui.tableCard} id="orders"><div className={ui.sectionHead}><div><p className={ui.eyebrow}>Order history</p><h2 className={ui.h2}>GPS-verified field orders</h2></div><span className="text-sm font-bold text-slate-500">{orderRows.length} records</span></div><div className={ui.tableWrap}><table className={ui.table}><thead><tr><th>Time</th><th>Salesperson</th><th>Customer</th><th>Product</th><th>Quantity</th><th>Total</th><th>Location</th></tr></thead><tbody>{orderRows.map((order) => <tr key={order.$id}><td>{time(order.captured_at)}</td><td>{String(employees.get(String(order.employee_id))?.display_name ?? "Unknown")}</td><td><strong>{String(order.customer_name)}</strong><small>{String(order.phone || order.address || "")}</small></td><td>{String(order.product_name)}</td><td>{Number(order.quantity_kg).toLocaleString()} kg</td><td>PKR {Number(order.total_amount).toLocaleString()}</td><td><a className={tableLink} href={`https://www.openstreetmap.org/?mlat=${order.latitude}&mlon=${order.longitude}#map=18/${order.latitude}/${order.longitude}`} target="_blank">Open map</a></td></tr>)}{orderRows.length === 0 && <tr><td colSpan={7} className="py-9 text-center text-slate-500">No orders are recorded for this filter.</td></tr>}</tbody></table></div></section>
    </section>
  </main>;
}

function validPoint(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && value.every((coordinate) => Number.isFinite(Number(coordinate)));
}

function storedSpeed(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
