import { redirect } from "next/navigation";
import { Query } from "node-appwrite";
import { createAdminTablesDb } from "@fieldops/appwrite/server";
import { requireSuperAdmin } from "../../lib/auth";
import { TerritoryForm } from "./territory-form";
export const dynamic="force-dynamic";
export default async function SetupPage(){
  if(!await requireSuperAdmin())redirect("/login");
  const databaseId=process.env.APPWRITE_DATABASE_ID??"fieldops",db=createAdminTablesDb();
  const territories=await db.listRows({databaseId,tableId:"territories",queries:[Query.orderAsc("name"),Query.limit(100)]});
  return <main className="setup-page"><header><div><p className="eyebrow">Organization setup</p><h1>Define where your team works.</h1><p className="lede">Use stable short codes from your existing sales reports. They become the backbone for employee, outlet and report access.</p></div><a className="quiet-link" href="/">← Dashboard</a></header><section className="setup-grid"><TerritoryForm/><aside className="existing"><p className="eyebrow">Territories</p><h2>{territories.total} configured</h2>{territories.total===0?<div className="empty"><strong>No territory yet</strong><p>Create Karachi’s first sales territory using the form.</p></div>:<ul>{territories.rows.map(row=><li key={row.$id}><span>{String(row.code)}</span><strong>{String(row.name)}</strong><small>Active</small></li>)}</ul>}</aside></section></main>
}
