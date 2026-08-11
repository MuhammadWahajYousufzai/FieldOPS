"use client";

import type { TerritoryBoundary } from "@fieldops/domain";
import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { PointMapPicker, TerritoryBoundaryEditor, type SelectedPoint, type TerritoryMapOption } from "./map-editors";

type Option = { id: string; label: string };
type TerritoryAssignment = { employeeId: string; employeeLabel: string; territoryId: string; territoryLabel: string };

async function requestJson(path: string, body: object, method = "POST") {
  const response = await fetch(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Request failed.");
  return result;
}

export function ManagementForms({ employees, outlets, territories, areas, territoryAssignments, today }: {
  employees: Option[];
  outlets: Option[];
  territories: TerritoryMapOption[];
  areas: Option[];
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
    {status && <p role="status" aria-live="polite" className={status.includes("saved") || status.includes("removed") ? "form-success global-message" : "form-error global-message"}>{status}</p>}
    <section className="management-grid">
      <form className="management-form" onSubmit={(event) => runForm(event, "/api/management/employees", "Salesperson")}>
        <div><p className="eyebrow">People</p><h2>Create salesperson</h2><p className="lede">Creates a field-only login. Territory access can be assigned now or later.</p></div>
        <label>Full name<input name="name" placeholder="Ali Raza" required /></label>
        <div className="field-pair"><label>Email<input name="email" type="email" placeholder="ali@example.com" autoComplete="email" required /></label><label>Employee code<input name="employeeCode" placeholder="SR-015" required /></label></div>
        <label>Salesperson password<input name="password" type="password" placeholder="Create a separate password" minLength={8} autoComplete="new-password" required /></label>
        <button disabled={Boolean(busy)}>{busy === "Salesperson" ? "Creating…" : "Create salesperson"}</button>
      </form>

      <form className="management-form territory-create-form" onSubmit={createTerritory}>
        <div><p className="eyebrow">Territory control</p><h2>Draw a territory</h2><p className="lede">Tap around the area to create a closed boundary. Assigning salespeople is optional.</p></div>
        <div className="field-pair"><label>Territory code<input name="code" placeholder="KHI-SOUTH" required /></label><label>Territory name<input name="name" placeholder="Karachi South" required /></label></div>
        <label>Parent area<select name="areaId" required><option value="">Select area</option>{areas.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <TerritoryBoundaryEditor key={editorKey} onChange={setNewBoundary} />
        <fieldset className="employee-checks"><legend>Assign salespeople now <span>optional</span></legend>{employees.map((employee) => <label key={employee.id}><input type="checkbox" checked={selectedEmployees.includes(employee.id)} onChange={(event) => setSelectedEmployees((current) => event.target.checked ? [...current, employee.id] : current.filter((id) => id !== employee.id))} />{employee.label}</label>)}</fieldset>
        <button disabled={Boolean(busy) || !newBoundary}>{busy === "Territory" ? "Saving territory…" : "Save territory"}</button>
      </form>

      <form className="management-form outlet-form" onSubmit={(event) => runForm(event, "/api/management/outlets", "Outlet", outletPoint ?? {})}>
        <div><p className="eyebrow">Stores</p><h2>Add and assign outlet</h2><p className="lede">Choose a territory, then tap its shaded map area to place the visit marker.</p></div>
        <div className="field-pair"><label>Store code<input name="code" placeholder="KHI-001" required /></label><label>Store name<input name="name" placeholder="Restaurant or retailer" required /></label></div>
        <label>Address<input name="address" placeholder="Full Karachi address" required /></label>
        <label>Territory<select name="territoryId" value={outletTerritoryId} onChange={(event) => { setOutletTerritoryId(event.target.value); setOutletPoint(null); }} required><option value="">Select territory</option>{territories.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.code}{item.boundary ? "" : " · map required"}</option>)}</select></label>
        <PointMapPicker territories={territories} selectedTerritoryId={outletTerritoryId} value={outletPoint} onChange={setOutletPoint} />
        <input type="hidden" name="latitude" value={outletPoint?.latitude ?? ""} /><input type="hidden" name="longitude" value={outletPoint?.longitude ?? ""} />
        <label>Assign to<select name="employeeId"><option value="">Assign later</option>{employees.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label>Notes<input name="notes" placeholder="Contact, preferred visit time, instructions" /></label>
        <button disabled={Boolean(busy) || !outletPoint || !outletTerritoryId}>{busy === "Outlet" ? "Saving…" : "Save outlet"}</button>
      </form>

      <section className="management-form territory-library" aria-labelledby="territory-library-title">
        <div><p className="eyebrow">Saved map areas</p><h2 id="territory-library-title">Territory boundaries</h2><p className="lede">Redraw a legacy or changed territory before assigning it.</p></div>
        {territories.map((territory) => <BoundaryUpdateCard key={territory.id} territory={territory} busy={busy} setBusy={setBusy} setStatus={setStatus} onSaved={() => showSuccess(`${territory.name} boundary saved.`)} />)}
      </section>

      <form className="management-form assignment-form" onSubmit={(event) => runForm(event, "/api/management/territory-assignments", "Territory assignment")}>
        <div><p className="eyebrow">Access boundaries</p><h2>Assign territory access</h2><p className="lede">One salesperson can have one, two, or more territories. With none, field activity is unrestricted.</p></div>
        <label>Salesperson<select name="employeeId" required><option value="">Select salesperson</option>{employees.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label>Territory<select name="territoryId" required><option value="">Select territory</option>{territories.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.code}</option>)}</select></label>
        <button disabled={Boolean(busy)}>{busy === "Territory assignment" ? "Assigning…" : "Assign territory"}</button>
      </form>

      <section className="management-form current-assignments">
        <div><p className="eyebrow">Current access</p><h2>Salesperson territories</h2><p className="lede">Removing the last territory immediately returns that salesperson to unrestricted field access.</p></div>
        {territoryAssignments.length === 0 ? <p className="empty-inline">No territory restrictions are active.</p> : territoryAssignments.map((assignment) => <div className="assignment-chip" key={`${assignment.employeeId}:${assignment.territoryId}`}><span><strong>{assignment.employeeLabel}</strong><small>{assignment.territoryLabel}</small></span><button type="button" className="danger-quiet" disabled={Boolean(busy)} onClick={() => removeTerritory(assignment.employeeId, assignment.territoryId, `${assignment.territoryLabel} from ${assignment.employeeLabel}`)}>{busy === `Remove:${assignment.employeeId}:${assignment.territoryId}` ? "Removing…" : "Remove"}</button></div>)}
      </section>

      <form className="management-form route-assignment-form" onSubmit={(event) => runForm(event, "/api/management/assignments", "Outlet assignment")}>
        <div><p className="eyebrow">Daily commitments</p><h2>Assign an existing outlet</h2><p className="lede">Completion stays separate from salesperson-added visits and orders in reports.</p></div>
        <label>Outlet<select name="outletId" required><option value="">Select outlet</option>{outlets.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label>Salesperson<select name="employeeId" required><option value="">Select salesperson</option>{employees.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label>Work date<input name="workDate" type="date" defaultValue={today} required /></label>
        <button disabled={Boolean(busy)}>{busy === "Outlet assignment" ? "Publishing…" : "Publish outlet assignment"}</button>
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
  return <article className="territory-row"><div><strong>{territory.name}</strong><small>{territory.code} · {territory.boundary ? "Map boundary saved" : "Boundary required before enforcement"}</small></div><button type="button" className="quiet" onClick={() => setOpen((value) => !value)}>{open ? "Close editor" : territory.boundary ? "Redraw" : "Draw boundary"}</button>{open && <div className="territory-redraw"><TerritoryBoundaryEditor initialBoundary={territory.boundary} onChange={setBoundary} /><button type="button" disabled={Boolean(busy) || !boundary} onClick={async () => { setBusy(busyKey); setStatus(""); try { await requestJson("/api/management/territories", { territoryId: territory.id, boundary }, "PATCH"); onSaved(); setOpen(false); } catch (error) { setStatus(error instanceof Error ? error.message : "Could not update boundary."); } finally { setBusy(""); } }}>{busy === busyKey ? "Saving…" : "Save boundary"}</button></div>}</article>;
}
