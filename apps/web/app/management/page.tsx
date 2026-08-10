import { redirect } from "next/navigation";
import { Query } from "node-appwrite";
import { createAdminTablesDb } from "@fieldops/appwrite/server";
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
  const [employeeRows, outletRows, territoryRows] = await Promise.all([
    listAllRows(db, databaseId, "employees", [Query.equal("status", "active")]),
    listAllRows(db, databaseId, "outlets", [Query.equal("status", "active")]),
    listAllRows(db, databaseId, "territories", [Query.equal("active", true)]),
  ]);
  employeeRows.sort((a, b) => String(a.display_name).localeCompare(String(b.display_name)));
  outletRows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  territoryRows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const employees = employeeRows.filter((row) => row.$id !== actor.employee.$id).map((row) => ({ id: row.$id, label: `${String(row.display_name)} · ${String(row.employee_code)}` }));
  const outlets = outletRows.map((row) => ({ id: row.$id, label: `${String(row.name)} · ${String(row.code)}` }));
  const territories = territoryRows.map((row) => ({ id: row.$id, label: `${String(row.name)} · ${String(row.code)}` }));
  return <main className="shell">
    <aside className="rail"><div className="brand"><span className="grain">YR</span><div><strong>Yousuf Rice FieldOps</strong><small>Karachi operations</small></div></div><nav aria-label="Primary"><a href="/">Overview</a><a className="selected" href="/management">Management</a><a href="/">Field activity</a><a href="/management">Salespersons</a><a href="/#reports">Reports</a></nav><div className="signed-in"><small>Signed in as</small><strong>{actor.user.name}</strong><LogoutButton /></div></aside>
    <section className="workspace management-page"><header><div><p className="eyebrow">Management control room</p><h1>Assign visits by date.</h1><p className="lede">Create staff with separate passwords, maintain visit locations, and publish dated assignments. Salespeople do not need territories.</p></div><a className="button-link" href="/">View route history</a></header>
      <section className="management-summary"><article><b>{Math.max(0, employeeRows.length - 1)}</b><span>Salespersons</span></article><article><b>{outletRows.length}</b><span>Visit locations</span></article><article><b>{territoryRows.length}</b><span>Outlet areas</span></article></section>
      <ManagementForms employees={employees} outlets={outlets} territories={territories} today={workDate()} />
    </section>
  </main>;
}
