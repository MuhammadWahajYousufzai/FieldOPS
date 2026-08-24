import { redirect } from "next/navigation";
import { Query } from "node-appwrite";
import { createAdminTablesDb } from "@fieldops/appwrite/server";
import { hasRequiredVisitEvidence, MAX_PLACE_MARK_ACCURACY_METERS, parseTerritoryBoundary } from "@fieldops/domain";
import { requireManager } from "../../lib/auth";
import { workDate } from "../../lib/mobile-auth";
import { listAllRows } from "../../lib/table-data";
import { LogoutButton } from "../logout-button";
import { ui } from "../ui";
import { ManagementForms } from "./management-forms";
import { PlaceApprovals, type ApprovedPlace, type PlaceReviewItem } from "./place-approvals";

export const dynamic = "force-dynamic";
const databaseId = process.env.APPWRITE_DATABASE_ID ?? "fieldops";

export default async function ManagementPage() {
  const actor = await requireManager();
  if (!actor) redirect("/login");
  const db = createAdminTablesDb();
  const [employeeRows, outletRows, territoryRows, assignmentRows, completedVisitRows, evidenceRows] = await Promise.all([
    listAllRows(db, databaseId, "employees", [Query.equal("status", "active")]),
    listAllRows(db, databaseId, "outlets", [Query.equal("status", "active")]),
    listAllRows(db, databaseId, "territories", [Query.equal("active", true)]),
    listAllRows(db, databaseId, "employee_assignments", []),
    listAllRows(db, databaseId, "visits", [Query.equal("status", "completed")]),
    listAllRows(db, databaseId, "visit_evidence", [], 5_000),
  ]);
  employeeRows.sort((a, b) => String(a.display_name).localeCompare(String(b.display_name)));
  outletRows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  territoryRows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const allEmployeeLabels = new Map(employeeRows.map((row) => [row.$id, String(row.display_name)]));
  const employees = employeeRows.filter((row) => row.$id !== actor.employee.$id).map((row) => ({ id: row.$id, label: String(row.display_name) }));
  const outlets = outletRows.map((row) => ({ id: row.$id, label: `${String(row.name)} · ${String(row.code)}` }));
  const territories = territoryRows.map((row) => ({ id: row.$id, name: String(row.name), code: String(row.code), boundary: parseTerritoryBoundary(row.boundary) }));
  const employeeLabels = new Map(employees.map((employee) => [employee.id, employee.label]));
  const territoryLabels = new Map(territories.map((territory) => [territory.id, territory.name]));
  const evidenceByVisit = new Map<string, typeof evidenceRows>();
  for (const evidence of evidenceRows) {
    const visitId = String(evidence.visit_id);
    const current = evidenceByVisit.get(visitId) ?? [];
    current.push(evidence);
    evidenceByVisit.set(visitId, current);
  }
  const selfVisits = completedVisitRows.filter((visit) => visit.visit_type === "self_initiated" || !visit.route_assignment_id);
  const visitById = new Map(selfVisits.map((visit) => [visit.$id, visit]));
  const pendingReviews: PlaceReviewItem[] = selfVisits
    .filter((visit) => String(visit.place_approval_status || "pending_review") === "pending_review")
    .sort((a, b) => String(b.check_out_at || b.$createdAt).localeCompare(String(a.check_out_at || a.$createdAt)))
    .map((visit) => {
      const evidence = evidenceByVisit.get(visit.$id) ?? [];
      const types = new Set(evidence.map((item) => String(item.type)));
      const latitude = Number(visit.latitude), longitude = Number(visit.longitude), accuracy = Number(visit.accuracy);
      return {
        id: visit.$id,
        employeeName: allEmployeeLabels.get(String(visit.employee_id)) ?? "Unknown salesperson",
        submittedName: String(visit.customer_name || "Unnamed marked place"),
        submittedAddress: String(visit.customer_address || ""),
        outcome: String(visit.outcome || "Visit completed"),
        notes: String(visit.notes || ""),
        workDate: String(visit.work_date || ""),
        capturedAt: String(visit.check_out_at || visit.check_in_at || visit.$createdAt),
        latitude,
        longitude,
        accuracy,
        candidateTerritoryId: String(visit.candidate_territory_id || ""),
        evidenceComplete: hasRequiredVisitEvidence({ photo: types.has("photo") || undefined, audio: types.has("audio") || undefined }),
        pointAccurate: visit.latitude !== null && visit.latitude !== undefined
          && visit.longitude !== null && visit.longitude !== undefined
          && visit.accuracy !== null && visit.accuracy !== undefined
          && Number.isFinite(latitude)
          && Number.isFinite(longitude)
          && Number.isFinite(accuracy)
          && accuracy >= 0
          && accuracy <= MAX_PLACE_MARK_ACCURACY_METERS,
        evidence: evidence.map((item) => ({
          id: item.$id,
          type: String(item.type) === "photo" ? "photo" as const : "audio" as const,
          fileId: String(item.file_id),
          filename: String(item.filename || item.type),
        })),
      };
    });
  const approvedPlaces: ApprovedPlace[] = outletRows
    .filter((outlet) => outlet.source === "salesperson_mark" || Boolean(outlet.origin_visit_id))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .map((outlet) => {
      const visit = visitById.get(String(outlet.origin_visit_id || ""));
      return {
        id: outlet.$id,
        code: String(outlet.code),
        name: String(outlet.name),
        address: String(outlet.address),
        latitude: Number(outlet.latitude),
        longitude: Number(outlet.longitude),
        territoryName: territoryLabels.get(String(outlet.territory_id)) ?? "Unknown territory",
        submittedName: visit ? String(visit.customer_name || "") : "",
        salespersonName: visit ? allEmployeeLabels.get(String(visit.employee_id)) ?? "Unknown salesperson" : "Unknown salesperson",
        approvedAt: visit ? String(visit.reviewed_at || outlet.$createdAt) : String(outlet.$createdAt),
      };
    });
  const now = Date.now();
  const territoryAssignments = assignmentRows.flatMap((row) => {
    const employeeId = String(row.employee_id), territoryId = String(row.territory_id ?? "");
    const effective = new Date(String(row.effective_from)).valueOf() <= now && (!row.effective_to || new Date(String(row.effective_to)).valueOf() > now);
    const employeeLabel = employeeLabels.get(employeeId), territoryLabel = territoryLabels.get(territoryId);
    return effective && employeeLabel && territoryLabel ? [{ employeeId, employeeLabel, territoryId, territoryLabel }] : [];
  });
  return <main className={ui.shell}>
    <aside className={ui.rail}>
      <div className={ui.brand}><span className={ui.logo}>YR</span><div><strong className="block text-sm">Yousuf Rice FieldOps</strong><small className="mt-1 block text-slate-400">Karachi operations</small></div></div>
      <nav className={ui.nav} aria-label="Primary"><a className={ui.navLink} href="/">Overview</a><a className={`${ui.navLink} ${ui.navSelected}`} href="/management">Management</a><a className={ui.navLink} href="#place-approvals">Place approvals</a><a className={ui.navLink} href="/management">Salespersons</a><a className={ui.navLink} href="/#reports">Reports</a></nav>
      <div className="mt-6 border-t border-white/15 px-2 pt-4 lg:mt-auto"><small className="mb-1 block text-slate-400">Signed in as</small><strong className="block">{actor.user.name}</strong><LogoutButton /></div>
    </aside>
    <section className={ui.workspace}>
      <header className="mb-7 flex flex-col items-start justify-between gap-5 xl:flex-row"><div><p className={ui.eyebrow}>Management control room</p><h1 className={ui.h1}>Shape the field, then assign it.</h1><p className={ui.lede}>Draw territory boundaries, place outlets directly on the map, assign or remove territory access at any time, and keep dated outlet commitments measurable beside self-directed sales work.</p></div><a className={ui.button} href="/">View completion & routes</a></header>
      <section className="mb-6 grid grid-cols-2 border-y border-slate-200 xl:grid-cols-4"><article className="border-b border-r border-slate-200 py-5 pr-4 xl:border-b-0 xl:px-6 xl:first:pl-0"><b className="block text-3xl font-black">{pendingReviews.length}</b><span className="mt-1 block text-xs text-slate-500">Marks awaiting review</span></article><article className="border-b border-slate-200 py-5 pl-4 xl:border-b-0 xl:border-r xl:px-6"><b className="block text-3xl font-black">{approvedPlaces.length}</b><span className="mt-1 block text-xs text-slate-500">Salesperson-marked places</span></article><article className="border-r border-slate-200 py-5 pr-4 xl:px-6"><b className="block text-3xl font-black">{Math.max(0, employeeRows.length - 1)}</b><span className="mt-1 block text-xs text-slate-500">Salespersons</span></article><article className="py-5 pl-4 xl:px-6"><b className="block text-3xl font-black">{territoryRows.filter((row) => parseTerritoryBoundary(row.boundary)).length}/{territoryRows.length}</b><span className="mt-1 block text-xs text-slate-500">Territories mapped</span></article></section>
      <PlaceApprovals reviews={pendingReviews} territories={territories.map(({ id, name }) => ({ id, name }))} approvedPlaces={approvedPlaces} />
      <ManagementForms employees={employees} outlets={outlets} territories={territories} territoryAssignments={territoryAssignments} today={workDate()} />
    </section>
  </main>;
}
