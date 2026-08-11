import { redirect } from "next/navigation";
import { Query } from "node-appwrite";
import { createAdminTablesDb } from "@fieldops/appwrite/server";
import { parseTerritoryBoundary } from "@fieldops/domain";
import { requireManager } from "../../lib/auth";
import { workDate } from "../../lib/mobile-auth";
import { listAllRows } from "../../lib/table-data";
import { LogoutButton } from "../logout-button";
import { ui } from "../ui";
import { ManagementForms } from "./management-forms";

export const dynamic = "force-dynamic";
const databaseId = process.env.APPWRITE_DATABASE_ID ?? "fieldops";

export default async function ManagementPage() {
  const actor = await requireManager();
  if (!actor) redirect("/login");
  const db = createAdminTablesDb();
  const [employeeRows, outletRows, territoryRows, assignmentRows] = await Promise.all([
    listAllRows(db, databaseId, "employees", [Query.equal("status", "active")]),
    listAllRows(db, databaseId, "outlets", [Query.equal("status", "active")]),
    listAllRows(db, databaseId, "territories", [Query.equal("active", true)]),
    listAllRows(db, databaseId, "employee_assignments", []),
  ]);
  employeeRows.sort((a, b) => String(a.display_name).localeCompare(String(b.display_name)));
  outletRows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  territoryRows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const employees = employeeRows.filter((row) => row.$id !== actor.employee.$id).map((row) => ({ id: row.$id, label: String(row.display_name) }));
  const outlets = outletRows.map((row) => ({ id: row.$id, label: `${String(row.name)} · ${String(row.code)}` }));
  const territories = territoryRows.map((row) => ({ id: row.$id, name: String(row.name), code: String(row.code), boundary: parseTerritoryBoundary(row.boundary) }));
  const employeeLabels = new Map(employees.map((employee) => [employee.id, employee.label]));
  const territoryLabels = new Map(territories.map((territory) => [territory.id, territory.name]));
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
      <nav className={ui.nav} aria-label="Primary"><a className={ui.navLink} href="/">Overview</a><a className={`${ui.navLink} ${ui.navSelected}`} href="/management">Management</a><a className={ui.navLink} href="/">Field activity</a><a className={ui.navLink} href="/management">Salespersons</a><a className={ui.navLink} href="/#reports">Reports</a></nav>
      <div className="mt-6 border-t border-white/15 px-2 pt-4 lg:mt-auto"><small className="mb-1 block text-slate-400">Signed in as</small><strong className="block">{actor.user.name}</strong><LogoutButton /></div>
    </aside>
    <section className={ui.workspace}>
      <header className="mb-7 flex flex-col items-start justify-between gap-5 xl:flex-row"><div><p className={ui.eyebrow}>Management control room</p><h1 className={ui.h1}>Shape the field, then assign it.</h1><p className={ui.lede}>Draw territory boundaries, place outlets directly on the map, assign or remove territory access at any time, and keep dated outlet commitments measurable beside self-directed sales work.</p></div><a className={ui.button} href="/">View completion & routes</a></header>
      <section className="mb-6 grid grid-cols-1 border-y border-slate-200 sm:grid-cols-3"><article className="py-5 sm:border-r sm:border-slate-200 sm:px-6 sm:first:pl-0"><b className="block text-3xl font-black">{Math.max(0, employeeRows.length - 1)}</b><span className="mt-1 block text-xs text-slate-500">Salespersons</span></article><article className="py-5 sm:border-r sm:border-slate-200 sm:px-6"><b className="block text-3xl font-black">{outletRows.length}</b><span className="mt-1 block text-xs text-slate-500">Visit locations</span></article><article className="py-5 sm:px-6"><b className="block text-3xl font-black">{territoryRows.filter((row) => parseTerritoryBoundary(row.boundary)).length}/{territoryRows.length}</b><span className="mt-1 block text-xs text-slate-500">Territories mapped</span></article></section>
      <ManagementForms employees={employees} outlets={outlets} territories={territories} territoryAssignments={territoryAssignments} today={workDate()} />
    </section>
  </main>;
}
