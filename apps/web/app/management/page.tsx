import { redirect } from "next/navigation";
import { Query } from "node-appwrite";
import { createAdminTablesDb } from "@fieldops/appwrite/server";
import { hasRequiredVisitEvidence, MAX_PLACE_MARK_ACCURACY_METERS, parseTerritoryBoundary, pointInTerritory } from "@fieldops/domain";
import { requireDashboardAdmin } from "../../lib/auth";
import { workDate } from "../../lib/mobile-auth";
import { operationalPolicyFromRow } from "../../lib/operational-policy";
import { listAllRows } from "../../lib/table-data";
import { ManagementDashboardShell } from "../dashboard-shells";
import { ui } from "../ui";
import { ManagementForms } from "./management-forms";
import { PlaceApprovals, type ApprovedPlace, type PlaceReviewItem } from "./place-approvals";
import { SalesPipeline, type SalesPipelineDeal, type SalesPipelineEmployee } from "./sales-pipeline";

export const dynamic = "force-dynamic";
const databaseId = process.env.APPWRITE_DATABASE_ID ?? "fieldops";
export type ManagementView = "overview" | "sales" | "reviews" | "plan" | "places" | "territories" | "team" | "operations";

export default function ManagementPage() {
  return ManagementPageView({ view: "overview" });
}

export async function ManagementPageView({ view }: { view: ManagementView }) {
  const actor = await requireDashboardAdmin();
  if (!actor) redirect("/login");
  const db = createAdminTablesDb();
  const today = workDate();
  const [employeeRows, outletRows, territoryRows, assignmentRows, salesRoleRows, completedVisitRows, evidenceRows, organizationRows, dailyRouteRows, dealRows] = await Promise.all([
    listAllRows(db, databaseId, "employees"),
    listAllRows(db, databaseId, "outlets", [Query.equal("status", "active")]),
    listAllRows(db, databaseId, "territories"),
    listAllRows(db, databaseId, "employee_assignments", []),
    listAllRows(db, databaseId, "roles", [Query.equal("code", "sales_person")], 1),
    listAllRows(db, databaseId, "visits", [Query.equal("status", "completed")]),
    listAllRows(db, databaseId, "visit_evidence", [], 5_000),
    listAllRows(db, databaseId, "organizations", [Query.equal("active", true)], 1),
    listAllRows(db, databaseId, "route_assignments", [Query.equal("work_date", today)]),
    listAllRows(db, databaseId, "sales_deals", [Query.orderDesc("$updatedAt")], 1_000),
  ]);
  const organization = organizationRows[0];
  const operationsPolicy = operationalPolicyFromRow(organization as Record<string, unknown> | undefined);
  employeeRows.sort((a, b) => String(a.display_name).localeCompare(String(b.display_name)));
  outletRows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  territoryRows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const now = Date.now();
  const salesRoleId = salesRoleRows[0]?.$id ?? "";
  const historicalSalespersonIds = new Set(assignmentRows.flatMap((assignment) => (
    String(assignment.role_id) === salesRoleId ? [String(assignment.employee_id)] : []
  )));
  const activeSalespersonIds = new Set(assignmentRows.flatMap((assignment) => (
    salesRoleRows[0]?.active === true
      && String(assignment.role_id) === salesRoleId
      && assignmentIsEffective(assignment, now)
      ? [String(assignment.employee_id)]
      : []
  )));
  const salespersonRows = employeeRows.filter((row) => historicalSalespersonIds.has(row.$id));
  const activeSalespersonRows = salespersonRows.filter((row) => row.status === "active" && activeSalespersonIds.has(row.$id));
  const allEmployeeLabels = new Map(employeeRows.map((row) => [row.$id, String(row.display_name)]));
  const employees = activeSalespersonRows.map((row) => ({ id: row.$id, label: String(row.display_name) }));
  const pipelineEmployees: SalesPipelineEmployee[] = salespersonRows.map((row) => ({
    id: row.$id,
    label: String(row.display_name),
    status: row.status === "active" && activeSalespersonIds.has(row.$id) ? "active" : "inactive",
  }));
  const outlets = outletRows.map((row) => ({ id: row.$id, label: `${String(row.name)} · ${String(row.code)}` }));
  const allTerritories = territoryRows.map((row) => ({ id: row.$id, name: String(row.name), code: String(row.code), boundary: parseTerritoryBoundary(row.boundary), active: row.active === true }));
  const territories = allTerritories.filter((territory) => territory.active);
  const territoryById = new Map(allTerritories.map((territory) => [territory.id, territory]));
  const outletMapIssues = outletRows.flatMap((outlet) => {
    const territory = territoryById.get(String(outlet.territory_id));
    const latitude = Number(outlet.latitude), longitude = Number(outlet.longitude);
    let reason = "";
    if (!territory) reason = "sales area is missing";
    else if (territory.active) {
      if (!territory.boundary) reason = `${territory.name} has no saved boundary`;
      else if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) reason = "GPS point is invalid";
      else if (!pointInTerritory({ latitude, longitude }, territory.boundary)) reason = `outside ${territory.name}`;
    }
    return reason ? [{ id: outlet.$id, name: String(outlet.name), reason }] : [];
  });
  const employeeLabels = new Map(employees.map((employee) => [employee.id, employee.label]));
  const territoryLabels = new Map(allTerritories.map((territory) => [territory.id, territory.name]));
  const outletRecords = outletRows.map((outlet) => ({
    id: outlet.$id,
    code: String(outlet.code),
    name: String(outlet.name),
    address: String(outlet.address),
    notes: String(outlet.notes || ""),
    territoryId: String(outlet.territory_id),
    territoryName: territoryLabels.get(String(outlet.territory_id)) ?? "Unknown sales area",
    territoryActive: territoryById.get(String(outlet.territory_id))?.active === true,
    source: outlet.source === "salesperson_mark" || outlet.origin_visit_id ? "Salesperson mark" : "Management",
    updatedAt: outlet.$updatedAt,
  }));
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
        territoryName: territoryLabels.get(String(outlet.territory_id)) ?? "Unknown sales area",
        submittedName: visit ? String(visit.customer_name || "") : "",
        salespersonName: visit ? allEmployeeLabels.get(String(visit.employee_id)) ?? "Unknown salesperson" : "Unknown salesperson",
        approvedAt: visit ? String(visit.reviewed_at || outlet.$createdAt) : String(outlet.$createdAt),
      };
    });
  const territoryAssignments = assignmentRows.flatMap((row) => {
    const employeeId = String(row.employee_id), territoryId = String(row.territory_id ?? "");
    const effective = new Date(String(row.effective_from)).valueOf() <= now && (!row.effective_to || new Date(String(row.effective_to)).valueOf() > now);
    const employeeLabel = employeeLabels.get(employeeId), territoryLabel = territoryLabels.get(territoryId);
    return effective && employeeLabel && territoryLabel ? [{ employeeId, employeeLabel, territoryId, territoryLabel }] : [];
  });
  const outletLabels = new Map(outletRows.map((outlet) => [outlet.$id, String(outlet.name)]));
  const pipelineDeals: SalesPipelineDeal[] = dealRows.flatMap((row) => {
    const employeeId = String(row.employee_id || "");
    const employeeLabel = allEmployeeLabels.get(employeeId);
    if (!employeeLabel || !historicalSalespersonIds.has(employeeId)) return [];
    const amount = Number(row.amount);
    return [{
      id: row.$id,
      employeeId,
      employeeLabel,
      outletLabel: outletLabels.get(String(row.outlet_id || "")) ?? "",
      customerName: String(row.customer_name || "Customer"),
      title: String(row.title || "Opportunity"),
      stage: String(row.stage || "lead"),
      amount: row.amount === null || row.amount === undefined || !Number.isFinite(amount) ? null : amount,
      nextAction: String(row.next_action || ""),
      followUpAt: String(row.follow_up_at || ""),
      notes: String(row.notes || ""),
      updatedAt: row.$updatedAt,
    }];
  }).sort((left, right) => left.followUpAt.localeCompare(right.followUpAt) || right.updatedAt.localeCompare(left.updatedAt));
  const dailyAssignments = dailyRouteRows.map((route) => ({
    id: route.$id,
    employeeLabel: allEmployeeLabels.get(String(route.employee_id)) ?? "Unknown salesperson",
    outletLabel: outletLabels.get(String(route.outlet_id)) ?? "Unknown outlet",
    sequence: Number(route.sequence || 0),
    status: String(route.status || "planned"),
  })).sort((a, b) => a.employeeLabel.localeCompare(b.employeeLabel) || a.sequence - b.sequence);
  const pageMeta = {
    overview: { eyebrow: "Operations control room", title: "What needs management attention.", lede: "See integrity issues first, then open the one management task that needs action." },
    sales: { eyebrow: "Customer opportunities", title: "Move every deal to a clear next action.", lede: "Review salesperson-entered opportunities, follow-up dates, and working estimates without inventing a forecast." },
    reviews: { eyebrow: "Place review queue", title: "Verify salesperson-marked places.", lede: "Review GPS accuracy, photo and voice evidence, then approve the official place or reject it with a clear reason." },
    plan: { eyebrow: "Daily visit plan", title: "Publish today’s outlet commitments.", lede: "Assign existing outlets to active salespeople and keep started field records locked." },
    places: { eyebrow: "Permanent field directory", title: "Manage outlets and verified points.", lede: "Create management outlets or correct official details without moving a salesperson-verified GPS point." },
    territories: { eyebrow: "Sales area control", title: "Draw and protect sales areas.", lede: "Create boundaries that contain active outlets before enforcing field access." },
    team: { eyebrow: "People & access", title: "Manage salesperson access safely.", lede: "Create, update, disable, and scope field accounts without confusing them with dashboard administrators." },
    operations: { eyebrow: "Tracking & sync", title: "Set the phone’s operating policy.", lede: "Control capture quality, route gaps, and automatic sync while preserving raw GPS evidence." },
  }[view];
  const header = <header className="mb-7 flex flex-col items-start justify-between gap-5 xl:flex-row"><div><p className={ui.eyebrow}>{pageMeta.eyebrow}</p><h1 className={ui.h1}>{pageMeta.title}</h1><p className={ui.lede}>{pageMeta.lede}</p></div><a className={ui.button} href="/routes">View live routes</a></header>;
  const overview = <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_12px_34px_rgba(20,33,61,0.07)]" aria-labelledby="operations-integrity-title">
        <div className="grid bg-[#14213D] px-5 py-4 text-white sm:grid-cols-[1fr_auto] sm:items-center sm:px-6"><div><p className="text-[10px] font-black uppercase tracking-[0.14em] text-blue-200">Operations integrity</p><h2 className="mt-1 text-xl font-black" id="operations-integrity-title">What needs management attention now</h2></div><span className={`mt-3 inline-flex w-max rounded-full px-3 py-1.5 text-xs font-black sm:mt-0 ${outletMapIssues.length || pendingReviews.length ? "bg-amber-300 text-[#14213D]" : "bg-emerald-300 text-emerald-950"}`}>{outletMapIssues.length + pendingReviews.length || "All checks clear"}</span></div>
        <div className="grid sm:grid-cols-2 xl:grid-cols-4">
          <IntegrityCell value={pendingReviews.length} label="Marks awaiting review" tone={pendingReviews.length ? "pending" : "good"} />
          <IntegrityCell value={outletMapIssues.length} label="Outlet map issues" tone={outletMapIssues.length ? "blocking" : "good"} />
          <IntegrityCell value={`${territories.filter((territory) => territory.boundary).length}/${territories.length}`} label="Sales areas mapped" tone={territories.some((territory) => !territory.boundary) ? "pending" : "good"} />
          <IntegrityCell value={employees.length} label="Active salespersons" tone="neutral" />
        </div>
        {outletMapIssues.length > 0 && <details className="border-t border-red-200 bg-red-50 px-5 py-4 sm:px-6"><summary className="cursor-pointer text-sm font-black text-red-900">Review {outletMapIssues.length} outlet {outletMapIssues.length === 1 ? "location" : "locations"} before enforcing visits</summary><ul className="mt-3 grid gap-2 text-sm text-red-800 sm:grid-cols-2">{outletMapIssues.map((issue) => <li key={issue.id}><strong>{issue.name}</strong> · {issue.reason}</li>)}</ul></details>}
      </section>;

  const managementFormsProps = { employees, outlets, outletRecords, territories, territoryAssignments, dailyAssignments, today, operationsPolicy };
  const content = {
    overview,
    sales: <SalesPipeline employees={pipelineEmployees} deals={pipelineDeals} />,
    reviews: <PlaceApprovals reviews={pendingReviews} territories={territories.map(({ id, name }) => ({ id, name }))} approvedPlaces={approvedPlaces} />,
    plan: <ManagementForms {...managementFormsProps} view="plan" />,
    places: <ManagementForms {...managementFormsProps} view="places" />,
    territories: <ManagementForms {...managementFormsProps} view="territories" />,
    team: <ManagementForms {...managementFormsProps} view="team" />,
    operations: <ManagementForms {...managementFormsProps} view="operations" />,
  }[view];
  return <ManagementDashboardShell actorName={actor.user.name}>{header}{content}</ManagementDashboardShell>;
}

function IntegrityCell({ value, label, tone }: { value: string | number; label: string; tone: "good" | "pending" | "blocking" | "neutral" }) {
  const color = tone === "good" ? "text-emerald-700" : tone === "pending" ? "text-amber-700" : tone === "blocking" ? "text-red-700" : "text-[#14213D]";
  return <article className="border-b border-slate-200 px-5 py-4 last:border-b-0 sm:border-r sm:last:border-r-0 xl:border-b-0"><b className={`block text-3xl font-black ${color}`}>{value}</b><span className="mt-1 block text-xs font-bold text-slate-500">{label}</span></article>;
}

function assignmentIsEffective(assignment: Record<string, unknown>, now: number) {
  const startsAt = new Date(String(assignment.effective_from ?? "")).valueOf();
  if (!Number.isFinite(startsAt) || startsAt > now) return false;
  if (!assignment.effective_to) return true;
  const endsAt = new Date(String(assignment.effective_to)).valueOf();
  return Number.isFinite(endsAt) && endsAt > now;
}
