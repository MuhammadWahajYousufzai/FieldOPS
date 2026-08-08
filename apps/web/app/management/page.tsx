import { redirect } from "next/navigation";
import { Query } from "node-appwrite";
import { createAdminTablesDb } from "@fieldops/appwrite/server";
import { requireManager } from "../../lib/auth";
import { workDate } from "../../lib/mobile-auth";
import { LogoutButton } from "../logout-button";
import { ManagementForms } from "./management-forms";

export const dynamic = "force-dynamic";
const databaseId = process.env.APPWRITE_DATABASE_ID ?? "fieldops";

export default async function ManagementPage() {
  const actor = await requireManager();
  if (!actor) redirect("/login");
  const db = createAdminTablesDb();
  const [employeesResult, outletsResult, territoriesResult] = await Promise.all([
    db.listRows({ databaseId, tableId: "employees", queries: [Query.equal("status", "active"), Query.orderAsc("display_name"), Query.limit(100)] }),
    db.listRows({ databaseId, tableId: "outlets", queries: [Query.equal("status", "active"), Query.orderAsc("name"), Query.limit(100)] }),
    db.listRows({ databaseId, tableId: "territories", queries: [Query.equal("active", true), Query.orderAsc("name"), Query.limit(100)] }),
  ]);
  const employees = employeesResult.rows.filter((row) => row.$id !== actor.employee.$id).map((row) => ({ id: row.$id, label: `${String(row.display_name)} · ${String(row.employee_code)}` }));
  const outlets = outletsResult.rows.map((row) => ({ id: row.$id, label: `${String(row.name)} · ${String(row.code)}` }));
  const territories = territoriesResult.rows.map((row) => ({ id: row.$id, label: `${String(row.name)} · ${String(row.code)}` }));
  return <main className="shell">
    <aside className="rail"><div className="brand"><span className="grain">YR</span><div><strong>Yousuf Rice FieldOps</strong><small>Karachi operations</small></div></div><nav aria-label="Primary"><a href="/">Overview</a><a className="selected" href="/management">Management</a><a href="/">Field activity</a><a href="/management">Salespersons</a><a href="/#reports">Reports</a></nav><div className="signed-in"><small>Signed in as</small><strong>{actor.user.name}</strong><LogoutButton /></div></aside>
    <section className="workspace management-page"><header><div><p className="eyebrow">Management control room</p><h1>Build tomorrow’s route.</h1><p className="lede">Create staff, maintain outlets, and publish assignments without shipping a new mobile build.</p></div><a className="button-link" href="/">View live dashboard</a></header>
      <section className="management-summary"><article><b>{employeesResult.total - 1}</b><span>Salespersons</span></article><article><b>{outletsResult.total}</b><span>Active outlets</span></article><article><b>{territoriesResult.total}</b><span>Territories</span></article></section>
      <ManagementForms employees={employees} outlets={outlets} territories={territories} today={workDate()} />
    </section>
  </main>;
}
