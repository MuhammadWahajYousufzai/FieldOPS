import { googleMapsUrl } from "../lib/outlet-location";
import { redirect } from "next/navigation";
import { Query } from "node-appwrite";
import { createAdminTablesDb } from "@fieldops/appwrite/server";
import { requireDashboardAdmin } from "../lib/auth";
import { workDate } from "../lib/mobile-auth";
import { operationalPolicyFromRow } from "../lib/operational-policy";
import { liveProgressRevision } from "../lib/live-progress";
import { listRowsResult } from "../lib/table-data";
import type { LiveAttendance, LiveEmployee, LiveLocationPoint } from "../lib/live-types";
import { OperationsDashboardShell } from "./dashboard-shells";
import { MetricCard, WorkspaceLink } from "./dashboard-cards";
import { LiveGpsCount, LiveOperations } from "./live-operations";
import type { MapPoint } from "./operations-map";
import { ui } from "./ui";

export const dynamic = "force-dynamic";
const databaseId = process.env.APPWRITE_DATABASE_ID ?? "fieldops";
export type OperationsView = "overview" | "routes" | "visits" | "orders";
type DashboardProps = { searchParams: Promise<{ date?: string; employee?: string }> };

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

export default function Dashboard(props: DashboardProps) {
  return OperationsPage({ ...props, view: "overview" });
}

export async function OperationsPage({ searchParams, view }: DashboardProps & { view: OperationsView }) {
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
  const evidenceResults = await Promise.all(chunk(rawVisitRows.map((visit) => visit.$id), 75).map((visitIds) => listRowsResult(
    db,
    databaseId,
    "visit_evidence",
    [Query.equal("visit_id", visitIds)],
    Math.max(100, visitIds.length * 3),
  )));
  const evidenceRows = evidenceResults.flatMap((result) => result.rows);
  const dataErrors = [...initialResults, ...evidenceResults].filter((result) => result.error);
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
  // Completed visits remain visible even when an evidence lookup fails. The row
  // then reports the missing attachment instead of hiding the entire visit.
  const visitRows = rawVisitRows;
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

  const tableLink = "font-extrabold text-blue-700 hover:text-blue-900";
  const pagePath = view === "overview" ? "/" : `/${view}`;
  const queryString = new URLSearchParams({ date, employee: selectedEmployee }).toString();
  const pageMeta = {
    overview: { eyebrow: "Your field team, at a glance", title: "Today’s overview", lede: "Track visits, follow up on open assignments, and see the day’s orders." },
    routes: { eyebrow: "Team activity", title: "Routes & live locations", lede: "See where your team is and review their recorded routes." },
    visits: { eyebrow: "Field reports", title: "Visits & evidence", lede: "Review visit outcomes, location checks, photos, and voice reports." },
    orders: { eyebrow: "Sales activity", title: "Customer orders", lede: "Review orders by salesperson, customer, value, and time." },
  }[view];
  const header = <>
    <header className={ui.pageHeader}><div><p className={ui.eyebrow}>{pageMeta.eyebrow}</p><h1 className={ui.h1}>{pageMeta.title}</h1><p className={ui.lede}>{pageMeta.lede}</p></div><a className={ui.quietButton} href="/management/plan"><span aria-hidden="true">＋</span> Plan visits</a></header>
    {dataErrors.length > 0 && <section className="mb-6 border-l-4 border-amber-600 bg-amber-50 p-4 text-amber-950" role="alert"><strong className="block">Some dashboard records could not be loaded.</strong><p className="mt-1 text-sm leading-6">The visible totals may be incomplete; an unavailable table is not being reported as zero. Refresh to retry: {[...new Set(dataErrors.map((result) => result.tableId.replaceAll("_", " ")))].join(", ")}.</p><a className="mt-3 inline-flex font-black text-amber-950 underline decoration-2 underline-offset-4" href={`${pagePath}?${queryString}`}>Retry dashboard data</a></section>}
    <form className="mb-6 flex flex-col items-stretch gap-3 rounded-[20px] border border-[var(--line)] bg-white/80 p-4 sm:flex-row sm:flex-wrap sm:items-end" method="get" action={pagePath} id="reports">
      <label className={`${ui.label} sm:min-w-48`}>Date<input className={ui.input} type="date" name="date" defaultValue={date} /></label>
      <label className={`${ui.label} sm:min-w-56`}>Salesperson<select className={ui.input} name="employee" defaultValue={selectedEmployee}><option value="all">All salespersons</option>{employeeRows.filter((employee) => !dashboardAdminEmployeeId || employee.$id !== dashboardAdminEmployeeId).map((employee) => <option key={employee.$id} value={employee.$id}>{String(employee.display_name)}</option>)}</select></label>
      <button className={ui.button}>Apply filters</button>
      <a className={ui.quietButton} href={pagePath}>Reset</a>
    </form>
  </>;
  const overview = <>
      <section className="mb-7 grid grid-cols-1 gap-4 min-[480px]:grid-cols-2 xl:grid-cols-4" aria-label="Filtered totals">
        <MetricCard featured icon="today" label="Assigned visits completed" value={`${assignedCompleted}/${visibleRoutes.length}`} detail={`${assignedPending} still need follow-up`} />
        <MetricCard icon="visits" label="Visits recorded" value={completedVisits} detail={`${selfInitiatedVisits} added by salespeople`} />
        <MetricCard icon="orders" label="Orders recorded" value={orderRows.length} detail={`PKR ${sales.toLocaleString()}`} />
        <MetricCard icon="routes" label="GPS route points" value={<LiveGpsCount initialCount={locationRows.length} />} detail="Recorded location fixes" />
      </section>
      <section className="mb-7 grid gap-3 xl:grid-cols-3" aria-label="Explore the selected day">
        <WorkspaceLink href={`/routes?${queryString}`} title="Follow your team" detail="Live locations & route history" icon="routes" />
        <WorkspaceLink href={`/visits?${queryString}`} title="Review field reports" detail="Visit photos & voice notes" icon="visits" />
        <WorkspaceLink href={`/orders?${queryString}`} title="See customer orders" detail="Order values & customer details" icon="orders" />
      </section>
      <section className={ui.tableCard} id="assignments"><div className={ui.sectionHead}><div><p className={ui.eyebrow}>Daily plan</p><h2 className={ui.h2}>Assigned visits</h2></div><span className="rounded-full bg-[#FFF0D9] px-3 py-1.5 text-xs font-semibold text-[#805717]">{assignedPending} need follow-up</span></div>
        <div className={ui.tableWrap}><table className={ui.table}><thead><tr><th>Salesperson</th><th>Assigned customer</th><th>Sequence</th><th>Status</th><th>Completed</th></tr></thead><tbody>
          {visibleRoutes.map((route) => <tr key={route.$id}><td>{String(employees.get(String(route.employee_id))?.display_name ?? "Unknown")}</td><td><strong>{String(outlets.get(String(route.outlet_id))?.name ?? "Unknown")}</strong><small>{String(outlets.get(String(route.outlet_id))?.address ?? "")}</small></td><td>{Number(route.sequence)}</td><td><span className={route.status === "completed" ? "font-extrabold text-emerald-700" : "font-extrabold text-amber-700"}>{String(route.status).replaceAll("_", " ")}</span></td><td>{time(route.completed_at)}</td></tr>)}
          {visibleRoutes.length === 0 && <tr><td colSpan={5} className="py-9 text-center text-slate-500">No visits were assigned for this filter.</td></tr>}
        </tbody></table></div>
      </section>
  </>;
  const routes = <LiveOperations key={`${date}:${selectedEmployee}`} date={date} selectedEmployee={selectedEmployee} pollingEnabled={date === workDate()} generatedAt={new Date().toISOString()} initialProgressRevision={initialProgressRevision} staticPoints={staticMapPoints} initialEmployees={liveEmployees} initialAttendance={liveAttendance} initialLocations={liveLocations} routePolicy={operationsPolicy} />;
  const visitsWithCompleteEvidence = visitRows.filter((visit) => {
    const types = new Set((evidence.get(visit.$id) ?? []).map((item) => String(item.type)));
    return types.has("photo") && types.has("audio");
  }).length;
  const visits = <section className="grid gap-5" id="visits">
    <div className="grid overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_10px_30px_rgba(20,33,61,0.055)] sm:grid-cols-[1fr_auto] sm:items-stretch">
      <div className="p-5 sm:p-6"><p className={ui.eyebrow}>Evidence ledger</p><h2 className={ui.h2}>Confirmed media on the server</h2><p className={ui.lede}>A photo or voice note appears here only after the phone receives a successful server confirmation and remains available for seven days.</p><a className="mt-4 inline-flex font-extrabold text-[#B41438] underline decoration-2 underline-offset-4" href="/management/media">Manage retained media</a></div>
      <div className="grid grid-cols-2 border-t border-slate-200 sm:border-l sm:border-t-0">
        <div className="grid min-w-32 place-content-center border-r border-slate-200 p-5 text-center"><b className="text-3xl font-black text-emerald-700">{visitsWithCompleteEvidence}</b><small className="mt-1 text-xs font-bold text-slate-500">Complete</small></div>
        <div className="grid min-w-32 place-content-center p-5 text-center"><b className={`text-3xl font-black ${visitRows.length - visitsWithCompleteEvidence ? "text-amber-700" : "text-slate-400"}`}>{visitRows.length - visitsWithCompleteEvidence}</b><small className="mt-1 text-xs font-bold text-slate-500">Missing media</small></div>
      </div>
    </div>
    {visitRows.map((visit) => {
      const assigned = Boolean(visit.route_assignment_id);
      const approvalStatus = assigned ? "not_applicable" : String(visit.place_approval_status || "pending_review");
      const outlet = outlets.get(String(visit.approved_outlet_id || visit.outlet_id));
      const submittedName = String(visit.customer_name || "");
      const officialName = String(outlet?.name || submittedName || "Unknown visit");
      const visitEvidence = evidence.get(visit.$id) ?? [];
      const photo = visitEvidence.find((item) => String(item.type) === "photo");
      const audio = visitEvidence.find((item) => String(item.type) === "audio");
      const approvalLabel = assigned ? "Assigned visit" : approvalStatus === "approved" ? "Permanent place" : approvalStatus === "rejected" ? "Place rejected" : "Awaiting place review";
      return <article className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_10px_30px_rgba(20,33,61,0.055)]" key={visit.$id}>
        <div className="grid xl:grid-cols-[minmax(0,1fr)_440px]">
          <div className="p-5 sm:p-6">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start"><div><span className={`inline-flex rounded-full px-2.5 py-1 text-[10px] font-black uppercase tracking-wider ${assigned ? "bg-blue-50 text-blue-800" : "bg-emerald-50 text-emerald-800"}`}>{approvalLabel}</span><h3 className="mt-3 text-2xl font-black tracking-[-0.025em] text-[#2D2729]">{officialName}</h3><p className="mt-1 text-sm leading-6 text-slate-500">{String(outlet?.address || visit.customer_address || "GPS location saved")}</p></div><div className="text-left sm:text-right"><strong className="block text-sm">{String(employees.get(String(visit.employee_id))?.display_name ?? "Unknown salesperson")}</strong><small className="mt-1 block text-slate-500">{time(visit.check_in_at)}{visit.check_out_at ? `–${time(visit.check_out_at)}` : " · in progress"}</small></div></div>
            <dl className="mt-6 grid gap-4 border-y border-slate-200 py-5 sm:grid-cols-3"><div><dt className="text-[10px] font-black uppercase tracking-wider text-slate-500">Outcome</dt><dd className="mt-1 font-extrabold">{String(visit.outcome ?? visit.status)}</dd></div><div><dt className="text-[10px] font-black uppercase tracking-wider text-slate-500">Location check</dt><dd className="mt-1 font-extrabold">{assigned ? `${Math.round(Number(visit.geofence_distance_m))} m from outlet` : `${Math.round(Number(visit.completion_distance_m ?? 0))} m from start`}</dd></div><div><dt className="text-[10px] font-black uppercase tracking-wider text-slate-500">GPS point</dt><dd className="mt-1"><a className={tableLink} href={googleMapsUrl(Number(visit.latitude), Number(visit.longitude))} target="_blank" rel="noreferrer">Open in Google Maps</a></dd></div></dl>
            {visit.notes && <div className="mt-5"><p className="text-[10px] font-black uppercase tracking-wider text-slate-500">Field notes</p><p className="mt-2 text-sm leading-6 text-slate-700">{String(visit.notes)}</p></div>}
          </div>
          <div className="grid gap-4 border-t border-slate-200 bg-slate-50 p-5 sm:grid-cols-2 xl:grid-cols-1 xl:border-l xl:border-t-0">
            {photo ? <a className="group block" href={`/api/evidence/${photo.file_id}`} target="_blank" rel="noreferrer"><img className="h-52 w-full rounded-xl border border-slate-200 bg-white object-cover shadow-sm transition group-hover:brightness-95" src={`/api/evidence/${photo.file_id}`} alt={`Storefront evidence for ${officialName}`} loading="lazy" /><span className={`${tableLink} mt-2 block text-xs`}>Open full photo</span></a> : <MissingEvidence kind="photo" />}
            <div className="grid content-start gap-2">{audio ? <><p className="text-[10px] font-black uppercase tracking-wider text-slate-500">Voice sales report</p><audio className="h-11 w-full" controls preload="metadata" src={`/api/evidence/${audio.file_id}`}>Voice note playback is not supported by this browser.</audio><a className={`${tableLink} text-xs`} href={`/api/evidence/${audio.file_id}`} target="_blank" rel="noreferrer">Open voice-note file</a></> : <MissingEvidence kind="voice note" />}</div>
          </div>
        </div>
      </article>;
    })}
    {visitRows.length === 0 && <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-14 text-center"><strong className="block text-xl text-[#2D2729]">No confirmed visits for this filter</strong><p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-slate-500">Photos and voice notes remain on the phone until the visit upload is confirmed. Check Activity & Sync in the mobile app for anything still queued or rejected.</p></div>}
  </section>;
  const orders = <section className={`${ui.tableCard} !mt-0`} id="orders"><div className={ui.sectionHead}><div><p className={ui.eyebrow}>Order history</p><h2 className={ui.h2}>GPS-verified field orders</h2></div><span className="text-sm font-bold text-slate-500">{orderRows.length} records</span></div><div className={ui.tableWrap}><table className={ui.table}><thead><tr><th>Time</th><th>Salesperson</th><th>Customer</th><th>Product</th><th>Quantity</th><th>Total</th><th>Location</th></tr></thead><tbody>{orderRows.map((order) => <tr key={order.$id}><td>{time(order.captured_at)}</td><td>{String(employees.get(String(order.employee_id))?.display_name ?? "Unknown")}</td><td><strong>{String(order.customer_name)}</strong><small>{String(order.phone || order.address || "")}</small></td><td>{String(order.product_name)}</td><td>{Number(order.quantity_kg).toLocaleString()} kg</td><td>PKR {Number(order.total_amount).toLocaleString()}</td><td><a className={tableLink} href={googleMapsUrl(Number(order.latitude), Number(order.longitude))} target="_blank" rel="noreferrer">Open in Google Maps</a></td></tr>)}{orderRows.length === 0 && <tr><td colSpan={7} className="py-9 text-center text-slate-500">No orders are recorded for this filter.</td></tr>}</tbody></table></div></section>;

  const content = { overview, routes, visits, orders }[view];
  return <OperationsDashboardShell actorName={actor.user.name} queryString={queryString}>{header}{content}</OperationsDashboardShell>;
}

function validPoint(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && value.every((coordinate) => Number.isFinite(Number(coordinate)));
}

function storedSpeed(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function MissingEvidence({ kind }: { kind: "photo" | "voice note" }) {
  return <div className="grid min-h-28 place-content-center rounded-xl border border-amber-200 bg-amber-50 p-4 text-center text-amber-900">
    <strong className="text-sm capitalize">{kind} not uploaded</strong>
    <small className="mt-1 max-w-56 leading-5 text-amber-800">The server has no confirmed {kind} file for this visit.</small>
  </div>;
}

function chunk<T>(values: T[], size: number) {
  const groups: T[][] = [];
  for (let index = 0; index < values.length; index += size) groups.push(values.slice(index, index + size));
  return groups;
}
