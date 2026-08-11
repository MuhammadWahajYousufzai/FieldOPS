"use client";

import type { TerritoryBoundary } from "@fieldops/domain";
import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { PointMapPicker, TerritoryBoundaryEditor, type SelectedPoint, type TerritoryMapOption } from "./map-editors";
import { ui } from "../ui";

type Option = { id: string; label: string };
type TerritoryAssignment = { employeeId: string; employeeLabel: string; territoryId: string; territoryLabel: string };

async function requestJson(path: string, body: object, method = "POST") {
  const response = await fetch(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Request failed.");
  return result;
}

export function ManagementForms({ employees, outlets, territories, territoryAssignments, today }: {
  employees: Option[];
  outlets: Option[];
  territories: TerritoryMapOption[];
  territoryAssignments: TerritoryAssignment[];
  today: string;
}) {
  const router = useRouter();
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState("");
  const [outletPoint, setOutletPoint] = useState<SelectedPoint | null>(null);
  const [outletTerritoryId, setOutletTerritoryId] = useState("");
  const [newBoundary, setNewBoundary] = useState<TerritoryBoundary | null>(null);
  const [selectedEmployees, setSelectedEmployees] = useState<string[]>([]);
  const [editorKey, setEditorKey] = useState(0);

  function showSuccess(message: string) {
    setStatus(message);
    router.refresh();
  }

  async function runForm(event: FormEvent<HTMLFormElement>, path: string, label: string, extras: object = {}) {
    event.preventDefault();
    setBusy(label); setStatus("");
    const form = event.currentTarget;
    try {
      await requestJson(path, { ...Object.fromEntries(new FormData(form)), ...extras });
      form.reset();
      showSuccess(`${label} saved. The mobile app will receive the change after refresh.`);
      if (label === "Outlet") { setOutletPoint(null); setOutletTerritoryId(""); }
    } catch (error) { setStatus(error instanceof Error ? error.message : "Could not save."); }
    finally { setBusy(""); }
  }

  async function createTerritory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!newBoundary) { setStatus("Add at least three points on the territory map before saving."); return; }
    setBusy("Territory"); setStatus("");
    const form = event.currentTarget;
    try {
      await requestJson("/api/management/territories", { ...Object.fromEntries(new FormData(form)), boundary: newBoundary, employeeIds: selectedEmployees });
      form.reset(); setSelectedEmployees([]); setNewBoundary(null); setEditorKey((value) => value + 1);
      showSuccess("Territory saved. Its boundary is now active for assigned salespeople.");
    } catch (error) { setStatus(error instanceof Error ? error.message : "Could not save territory."); }
    finally { setBusy(""); }
  }

  async function removeTerritory(employeeId: string, territoryId: string, label: string) {
    setBusy(`Remove:${employeeId}:${territoryId}`); setStatus("");
    try {
      await requestJson("/api/management/territory-assignments", { employeeId, territoryId }, "DELETE");
      showSuccess(`${label} removed. If no territories remain, that salesperson can visit and take orders anywhere.`);
    } catch (error) { setStatus(error instanceof Error ? error.message : "Could not remove territory."); }
    finally { setBusy(""); }
  }

  return <>
    {status && <p role="status" aria-live="polite" className={`mb-5 ${status.includes("saved") || status.includes("removed") ? ui.messageSuccess : ui.messageError}`}>{status}</p>}
    <section className="grid items-start gap-5 lg:grid-cols-2">
      <form className={`${ui.card} grid gap-4`} onSubmit={(event) => runForm(event, "/api/management/employees", "Salesperson")}>
        <div><p className={ui.eyebrow}>People</p><h2 className={ui.h2}>Create salesperson</h2><p className={ui.lede}>Creates a field-only login. Territory access can be assigned now or later.</p></div>
        <label className={ui.label}>Full name<input className={ui.input} name="name" placeholder="Ali Raza" required /></label>
        <label className={ui.label}>Email<input className={ui.input} name="email" type="email" placeholder="ali@example.com" autoComplete="email" required /></label>
        <label className={ui.label}>Salesperson password<input className={ui.input} name="password" type="password" placeholder="Create a separate password" minLength={8} autoComplete="new-password" required /></label>
        <button className={ui.button} disabled={Boolean(busy)}>{busy === "Salesperson" ? "Creating…" : "Create salesperson"}</button>
      </form>

      <form className={`${ui.card} grid gap-4`} onSubmit={createTerritory}>
        <div><p className={ui.eyebrow}>Territory control</p><h2 className={ui.h2}>Draw a territory</h2><p className={ui.lede}>Tap around the area to create a closed boundary. Assigning salespeople is optional.</p></div>
        <label className={ui.label}>Territory name<input className={ui.input} name="name" placeholder="Karachi South" required /></label>
        <TerritoryBoundaryEditor key={editorKey} onChange={setNewBoundary} />
        <fieldset className="grid grid-cols-1 gap-2 rounded-xl border border-slate-200 p-4 sm:grid-cols-2"><legend className="px-2 text-xs font-black">Assign salespeople now <span className="font-medium text-slate-500">optional</span></legend>{employees.map((employee) => <label className="flex min-h-10 items-center gap-2 text-xs font-bold" key={employee.id}><input className="h-[18px] w-[18px]" type="checkbox" checked={selectedEmployees.includes(employee.id)} onChange={(event) => setSelectedEmployees((current) => event.target.checked ? [...current, employee.id] : current.filter((id) => id !== employee.id))} />{employee.label}</label>)}</fieldset>
        <button className={ui.button} disabled={Boolean(busy) || !newBoundary}>{busy === "Territory" ? "Saving territory…" : "Save territory"}</button>
      </form>

      <form className={`${ui.card} grid gap-4 lg:col-span-2`} onSubmit={(event) => runForm(event, "/api/management/outlets", "Outlet", outletPoint ?? {})}>
        <div><p className={ui.eyebrow}>Stores</p><h2 className={ui.h2}>Add and assign outlet</h2><p className={ui.lede}>Choose a territory, then tap its shaded map area to place the visit marker.</p></div>
        <div className="grid gap-3 sm:grid-cols-2"><label className={ui.label}>Store code<input className={ui.input} name="code" placeholder="KHI-001" required /></label><label className={ui.label}>Store name<input className={ui.input} name="name" placeholder="Restaurant or retailer" required /></label></div>
        <label className={ui.label}>Address<input className={ui.input} name="address" placeholder="Full Karachi address" required /></label>
        <label className={ui.label}>Territory<select className={ui.input} name="territoryId" value={outletTerritoryId} onChange={(event) => { setOutletTerritoryId(event.target.value); setOutletPoint(null); }} required><option value="">Select territory</option>{territories.map((item) => <option key={item.id} value={item.id}>{item.name}{item.boundary ? "" : " · map required"}</option>)}</select></label>
        <PointMapPicker territories={territories} selectedTerritoryId={outletTerritoryId} value={outletPoint} onChange={setOutletPoint} />
        <input type="hidden" name="latitude" value={outletPoint?.latitude ?? ""} /><input type="hidden" name="longitude" value={outletPoint?.longitude ?? ""} />
        <label className={ui.label}>Assign to<select className={ui.input} name="employeeId"><option value="">Assign later</option>{employees.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label className={ui.label}>Notes<input className={ui.input} name="notes" placeholder="Contact, preferred visit time, instructions" /></label>
        <button className={ui.button} disabled={Boolean(busy) || !outletPoint || !outletTerritoryId}>{busy === "Outlet" ? "Saving…" : "Save outlet"}</button>
      </form>

      <section className={`${ui.card} grid gap-2`} aria-labelledby="territory-library-title">
        <div><p className={ui.eyebrow}>Saved map areas</p><h2 className={ui.h2} id="territory-library-title">Territory boundaries</h2><p className={ui.lede}>Redraw a legacy or changed territory before assigning it.</p></div>
        {territories.map((territory) => <BoundaryUpdateCard key={territory.id} territory={territory} busy={busy} setBusy={setBusy} setStatus={setStatus} onSaved={() => showSuccess(`${territory.name} boundary saved.`)} />)}
      </section>

      <form className={`${ui.card} grid gap-4 lg:col-span-2 lg:grid-cols-[1.35fr_1fr_1fr_auto] lg:items-end`} onSubmit={(event) => runForm(event, "/api/management/territory-assignments", "Territory assignment")}>
        <div className="self-start"><p className={ui.eyebrow}>Access boundaries</p><h2 className={ui.h2}>Assign territory access</h2><p className={ui.lede}>One salesperson can have one, two, or more territories. With none, field activity is unrestricted.</p></div>
        <label className={ui.label}>Salesperson<select className={ui.input} name="employeeId" required><option value="">Select salesperson</option>{employees.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label className={ui.label}>Territory<select className={ui.input} name="territoryId" required><option value="">Select territory</option>{territories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <button className={ui.button} disabled={Boolean(busy)}>{busy === "Territory assignment" ? "Assigning…" : "Assign territory"}</button>
      </form>

      <section className={`${ui.card} grid gap-0`}>
        <div><p className={ui.eyebrow}>Current access</p><h2 className={ui.h2}>Salesperson territories</h2><p className={ui.lede}>Removing the last territory immediately returns that salesperson to unrestricted field access.</p></div>
        {territoryAssignments.length === 0 ? <p className="m-0 py-4 text-slate-500">No territory restrictions are active.</p> : territoryAssignments.map((assignment) => <div className="flex items-center justify-between gap-3 border-t border-slate-200 py-3" key={`${assignment.employeeId}:${assignment.territoryId}`}><span><strong className="block">{assignment.employeeLabel}</strong><small className="mt-1 block text-slate-500">{assignment.territoryLabel}</small></span><button type="button" className={ui.dangerButton} disabled={Boolean(busy)} onClick={() => removeTerritory(assignment.employeeId, assignment.territoryId, `${assignment.territoryLabel} from ${assignment.employeeLabel}`)}>{busy === `Remove:${assignment.employeeId}:${assignment.territoryId}` ? "Removing…" : "Remove"}</button></div>)}
      </section>

      <form className={`${ui.card} grid gap-4 lg:col-span-2 lg:grid-cols-[1.35fr_1fr_1fr_1fr_auto] lg:items-end`} onSubmit={(event) => runForm(event, "/api/management/assignments", "Outlet assignment")}>
        <div className="self-start"><p className={ui.eyebrow}>Daily commitments</p><h2 className={ui.h2}>Assign an existing outlet</h2><p className={ui.lede}>Completion stays separate from salesperson-added visits and orders in reports.</p></div>
        <label className={ui.label}>Outlet<select className={ui.input} name="outletId" required><option value="">Select outlet</option>{outlets.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label className={ui.label}>Salesperson<select className={ui.input} name="employeeId" required><option value="">Select salesperson</option>{employees.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label className={ui.label}>Work date<input className={ui.input} name="workDate" type="date" defaultValue={today} required /></label>
        <button className={ui.button} disabled={Boolean(busy)}>{busy === "Outlet assignment" ? "Publishing…" : "Publish outlet assignment"}</button>
      </form>
    </section>
  </>;
}

function BoundaryUpdateCard({ territory, busy, setBusy, setStatus, onSaved }: {
  territory: TerritoryMapOption;
  busy: string;
  setBusy: (value: string) => void;
  setStatus: (value: string) => void;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [boundary, setBoundary] = useState<TerritoryBoundary | null>(territory.boundary);
  const busyKey = `Boundary:${territory.id}`;
  return <article className="grid grid-cols-[1fr_auto] items-center gap-3 border-t border-slate-200 py-3">
    <div><strong className="block">{territory.name}</strong><small className="mt-1 block text-slate-500">{territory.boundary ? "Map boundary saved" : "Boundary required before enforcement"}</small></div>
    <button type="button" className={ui.quietButton} onClick={() => setOpen((value) => !value)}>{open ? "Close editor" : territory.boundary ? "Redraw" : "Draw boundary"}</button>
    {open && <div className="col-span-2 grid gap-3 pt-1"><TerritoryBoundaryEditor initialBoundary={territory.boundary} onChange={setBoundary} /><button type="button" className={`${ui.button} justify-self-start`} disabled={Boolean(busy) || !boundary} onClick={async () => { setBusy(busyKey); setStatus(""); try { await requestJson("/api/management/territories", { territoryId: territory.id, boundary }, "PATCH"); onSaved(); setOpen(false); } catch (error) { setStatus(error instanceof Error ? error.message : "Could not update boundary."); } finally { setBusy(""); } }}>{busy === busyKey ? "Saving…" : "Save boundary"}</button></div>}
  </article>;
}
