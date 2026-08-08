"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

type Option = { id: string; label: string };

async function submitJson(path: string, form: HTMLFormElement) {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.fromEntries(new FormData(form))) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Request failed.");
  return result;
}

export function ManagementForms({ employees, outlets, territories, today }: { employees: Option[]; outlets: Option[]; territories: Option[]; today: string }) {
  const router = useRouter();
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState("");
  async function run(event: FormEvent<HTMLFormElement>, path: string, label: string) {
    event.preventDefault(); setBusy(label); setStatus("");
    const form = event.currentTarget;
    try { await submitJson(path, form); form.reset(); setStatus(`${label} saved. The assignment is available to the app after refresh.`); router.refresh(); }
    catch (error) { setStatus(error instanceof Error ? error.message : "Could not save."); }
    finally { setBusy(""); }
  }
  return <>
    {status && <p className={status.includes("saved") ? "form-success global-message" : "form-error global-message"}>{status}</p>}
    <section className="management-grid">
      <form className="management-form" onSubmit={(event) => run(event, "/api/management/employees", "Salesperson")}>
        <div><p className="eyebrow">People</p><h2>Create salesperson</h2><p className="lede">Creates a login and assigns a territory.</p></div>
        <label>Full name<input name="name" placeholder="Ali Raza" required /></label>
        <div className="field-pair"><label>Email<input name="email" type="email" placeholder="ali@sherazwaqar.tech" required /></label><label>Employee code<input name="employeeCode" placeholder="SR-015" required /></label></div>
        <label>Territory<select name="territoryId" required><option value="">Select territory</option>{territories.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label>Initial password<input name="password" type="password" placeholder="Uses the management password if blank" minLength={8} /></label>
        <button disabled={Boolean(busy)}>{busy === "Salesperson" ? "Creating…" : "Create salesperson"}</button>
      </form>
      <form className="management-form" onSubmit={(event) => run(event, "/api/management/outlets", "Outlet")}>
        <div><p className="eyebrow">Stores</p><h2>Add and assign outlet</h2><p className="lede">Coordinates become the visit geofence and map marker.</p></div>
        <div className="field-pair"><label>Store code<input name="code" placeholder="KHI-001" required /></label><label>Store name<input name="name" placeholder="Restaurant or retailer" required /></label></div>
        <label>Address<input name="address" placeholder="Full Karachi address" required /></label>
        <div className="field-pair"><label>Latitude<input name="latitude" inputMode="decimal" placeholder="24.8173" required /></label><label>Longitude<input name="longitude" inputMode="decimal" placeholder="67.0407" required /></label></div>
        <div className="field-pair"><label>Territory<select name="territoryId" required><option value="">Select territory</option>{territories.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label><label>Assign to<select name="employeeId"><option value="">Assign later</option>{employees.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label></div>
        <label>Notes<input name="notes" placeholder="Contact, preferred visit time, instructions" /></label>
        <button disabled={Boolean(busy)}>{busy === "Outlet" ? "Saving…" : "Save outlet"}</button>
      </form>
      <form className="management-form assignment-form" onSubmit={(event) => run(event, "/api/management/assignments", "Assignment")}>
        <div><p className="eyebrow">Daily route</p><h2>Assign an existing store</h2><p className="lede">It will appear automatically in that salesperson’s app for the chosen date. They can choose their own visit order.</p></div>
        <label>Outlet<select name="outletId" required><option value="">Select outlet</option>{outlets.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label>Salesperson<select name="employeeId" required><option value="">Select salesperson</option>{employees.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label>Work date<input name="workDate" type="date" defaultValue={today} required /></label>
        <button disabled={Boolean(busy)}>{busy === "Assignment" ? "Publishing…" : "Publish assignment"}</button>
      </form>
    </section>
  </>;
}
