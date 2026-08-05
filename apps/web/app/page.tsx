import { redirect } from "next/navigation";
import { Query } from "node-appwrite";
import { PRODUCT_NAME } from "@fieldops/domain";
import { createAdminTablesDb } from "@fieldops/appwrite/server";
import { currentUser } from "../lib/auth";
import { LogoutButton } from "./logout-button";

export const dynamic = "force-dynamic";
const databaseId = process.env.APPWRITE_DATABASE_ID ?? "fieldops";

async function count(tableId: string) {
  const result = await createAdminTablesDb().listRows({ databaseId, tableId, queries: [Query.limit(1)] });
  return result.total;
}

export default async function Dashboard() {
  const user = await currentUser();
  if (!user) redirect("/login");
  const [organizations, regions, territories, employees] = await Promise.all([
    count("organizations"), count("regions"), count("territories"), count("employees"),
  ]);
  const ready = organizations > 0 && territories > 0 && employees > 1;

  return <main className="shell">
    <aside className="rail">
      <div className="brand"><span className="grain">YR</span><div><strong>{PRODUCT_NAME}</strong><small>Karachi operations</small></div></div>
      <nav aria-label="Primary"><a className="selected" href="/">Overview</a><a href="/setup">Organization</a><a href="/setup">Territories</a><a href="/setup">Employees</a><a href="/field">Field activity</a><a href="/reports">Reports</a></nav>
      <div className="signed-in"><small>Signed in as</small><strong>{user.name}</strong><LogoutButton /></div>
    </aside>
    <section className="workspace">
      <header><div><p className="eyebrow">Live workspace</p><h1>{ready ? "Keep Karachi moving." : "Build your field network."}</h1></div><a className="button-link" href="/setup">Continue setup</a></header>
      <section className="pulse" aria-label="Workspace totals">
        <article><span>Organizations</span><b>{organizations}</b><small>Operating companies</small></article>
        <article><span>Regions</span><b>{regions}</b><small>Geographic hierarchy</small></article>
        <article><span>Territories</span><b>{territories}</b><small>Assignable sales coverage</small></article>
        <article><span>Employees</span><b>{employees}</b><small>Active and inactive profiles</small></article>
      </section>
      <section className="grid">
        <article className="route-card">
          <p className="eyebrow">Deployment checklist</p><h2>Make the first beat operational</h2>
          <ol className="checklist">
            <li className={organizations ? "complete" : ""}><span>1</span><div><strong>Secure workspace</strong><small>Organization and first administrator</small></div></li>
            <li className={territories ? "complete" : ""}><span>2</span><div><strong>Map the sales hierarchy</strong><small>Region, area and territory</small></div></li>
            <li className={employees > 1 ? "complete" : ""}><span>3</span><div><strong>Add a field representative</strong><small>Appwrite account, employee code and assignment</small></div></li>
            <li><span>4</span><div><strong>Publish a daily route</strong><small>Beat, outlets and visit order</small></div></li>
          </ol>
          <a className="button-link" href="/setup">Set up organization →</a>
        </article>
        <aside className="decision-card">
          <p className="eyebrow">System status</p><h2>Backend connected</h2>
          <ul><li><span className="flag blue">Appwrite</span><strong>Session protected</strong><small>Server-side credentials stay outside client bundles</small></li><li><span className="flag amber">Access</span><strong>Territory scope enforced next</strong><small>Assignments will control every operational query</small></li></ul>
        </aside>
      </section>
    </section>
  </main>;
}
