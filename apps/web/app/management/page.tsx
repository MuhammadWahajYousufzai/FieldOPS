import { redirect } from "next/navigation";
import { Query } from "node-appwrite";
import { createAdminTablesDb } from "@fieldops/appwrite/server";
import { parseTerritoryBoundary } from "@fieldops/domain";
import { requireManager } from "../../lib/auth";
import { workDate } from "../../lib/mobile-auth";
import { listAllRows } from "../../lib/table-data";
import { LogoutButton } from "../logout-button";
import { ManagementForms } from "./management-forms";

export const dynamic = "force-dynamic";
const databaseId = process.env.APPWRITE_DATABASE_ID ?? "fieldops";

export default async function ManagementPage() {
  const actor = await requireManager();
  if (!actor) redirect("/login");
  const db = createAdminTablesDb();
  const [employeeRows, outletRows, territoryRows, areaRows, assignmentRows] = await Promise.all([
    listAllRows(db, databaseId, "employees", [Query.equal("status", "active")]),
    listAllRows(db, databaseId, "outlets", [Query.equal("status", "active")]),
    listAllRows(db, databaseId, "territories", [Query.equal("active", true)]),
    listAllRows(db, databaseId, "areas", [Query.equal("active", true)]),
    listAllRows(db, databaseId, "employee_assignments", []),
  ]);
  employeeRows.sort((a, b) => String(a.display_name).localeCompare(String(b.display_name)));
  outletRows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  territoryRows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  areaRows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const employees = employeeRows.filter((row) => row.$id !== actor.employee.$id).map((row) => ({ id: row.$id, label: `${String(row.display_name)} · ${String(row.employee_code)}` }));
  const outlets = outletRows.map((row) => ({ id: row.$id, label: `${String(row.name)} · ${String(row.code)}` }));
  const territories = territoryRows.map((row) => ({ id: row.$id, name: String(row.name), code: String(row.code), boundary: parseTerritoryBoundary(row.boundary) }));
  const areas = areaRows.map((row) => ({ id: row.$id, label: `${String(row.name)} · ${String(row.code)}` }));
  const employeeLabels = new Map(employees.map((employee) => [employee.id, employee.label]));
  const territoryLabels = new Map(territories.map((territory) => [territory.id, `${territory.name} · ${territory.code}`]));
  const now = Date.now();
  const territoryAssignments = assignmentRows.flatMap((row) => {
    const employeeId = String(row.employee_id), territoryId = String(row.territory_id ?? "");
    const effective = new Date(String(row.effective_from)).valueOf() <= now && (!row.effective_to || new Date(String(row.effective_to)).valueOf() > now);
    const employeeLabel = employeeLabels.get(employeeId), territoryLabel = territoryLabels.get(territoryId);
    return effective && employeeLabel && territoryLabel ? [{ employeeId, employeeLabel, territoryId, territoryLabel }] : [];
  });
  return <main className="shell">
    <aside className="rail"><div className="brand"><span className="grain">YR</span><div><strong>Yousuf Rice FieldOps</strong><small>Karachi operations</small></div></div><nav aria-label="Primary"><a href="/">Overview</a><a className="selected" href="/management">Management</a><a href="/">Field activity</a><a href="/management">Salespersons</a><a href="/#reports">Reports</a></nav><div className="signed-in"><small>Signed in as</small><strong>{actor.user.name}</strong><LogoutButton /></div></aside>
    <section className="workspace management-page"><header><div><p className="eyebrow">Management control room</p><h1>Shape the field, then assign it.</h1><p className="lede">Draw territory boundaries, place outlets directly on the map, assign or remove territory access at any time, and keep dated outlet commitments measurable beside self-directed sales work.</p></div><a className="button-link" href="/">View completion & routes</a></header>
      <section className="management-summary"><article><b>{Math.max(0, employeeRows.length - 1)}</b><span>Salespersons</span></article><article><b>{outletRows.length}</b><span>Visit locations</span></article><article><b>{territoryRows.filter((row) => parseTerritoryBoundary(row.boundary)).length}/{territoryRows.length}</b><span>Territories mapped</span></article></section>
      <ManagementForms employees={employees} outlets={outlets} territories={territories} areas={areas} territoryAssignments={territoryAssignments} today={workDate()} />
    </section>
  </main>;
}
