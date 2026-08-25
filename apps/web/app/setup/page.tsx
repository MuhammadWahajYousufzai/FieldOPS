import { redirect } from "next/navigation";
import { Query } from "node-appwrite";
import { createAdminTablesDb } from "@fieldops/appwrite/server";
import { requireDashboardAdmin } from "../../lib/auth";
import { TerritoryForm } from "./territory-form";
import { ui } from "../ui";
export const dynamic="force-dynamic";
export default async function SetupPage(){
  if(!await requireDashboardAdmin())redirect("/login");
  const databaseId=process.env.APPWRITE_DATABASE_ID??"fieldops",db=createAdminTablesDb();
  const territories=await db.listRows({databaseId,tableId:"territories",queries:[Query.orderAsc("name"),Query.limit(100)]});
  return <main className="min-h-screen bg-slate-50 px-5 py-10 text-[#14213D] sm:px-10 lg:px-[clamp(24px,6vw,90px)]"><header className="mx-auto mb-9 flex max-w-7xl flex-col items-start justify-between gap-5 sm:flex-row"><div><p className={ui.eyebrow}>Organization setup</p><h1 className={ui.h1}>Define where your team works.</h1><p className={ui.lede}>Create the organization geography used for mapped territories and field access.</p></div><a className={ui.quietButton} href="/">Back to dashboard</a></header><section className="mx-auto grid max-w-7xl items-start gap-6 lg:grid-cols-[minmax(480px,1.15fr)_minmax(320px,.85fr)]"><TerritoryForm/><aside className={ui.card}><p className={ui.eyebrow}>Territories</p><h2 className={ui.h2}>{territories.total} configured</h2>{territories.total===0?<div className="mt-6 rounded-xl border border-dashed border-slate-300 p-6"><strong>No territory yet</strong><p className="mt-2 text-slate-500">Create Karachi’s first sales territory using the form.</p></div>:<ul className="mt-6 list-none p-0">{territories.rows.map(row=><li className="flex items-center justify-between gap-3 border-t border-slate-200 py-4" key={row.$id}><strong>{String(row.name)}</strong><small className="font-extrabold text-emerald-700">Active</small></li>)}</ul>}</aside></section></main>
}
