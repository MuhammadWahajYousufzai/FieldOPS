"use client";

import type { TerritoryBoundary } from "@fieldops/domain";
import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PointMapPicker, TerritoryBoundaryEditor, type SelectedPoint, type TerritoryMapOption } from "./map-editors";
import { ui } from "../ui";
import { preciseOperationalPolicy, type OperationalPolicy } from "../../lib/operational-policy";

type Option = { id: string; label: string };
type TerritoryAssignment = { employeeId: string; employeeLabel: string; territoryId: string; territoryLabel: string };
type DailyAssignment = {
  id: string;
  employeeLabel: string;
  outletLabel: string;
  sequence: number;
  status: string;
};
type OutletRecord = {
  id: string;
  code: string;
  name: string;
  address: string;
  notes: string;
  territoryId: string;
  territoryName: string;
  source: string;
  updatedAt: string;
};

async function requestJson(path: string, body: object, method = "POST") {
  const response = await fetch(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const affected = Array.isArray(result.affectedOutlets)
      ? result.affectedOutlets.map((outlet: { name?: unknown }) => String(outlet.name || "Unnamed outlet")).join(", ")
      : "";
    throw new Error(`${result.error || "Request failed."}${affected ? ` Affected: ${affected}.` : ""}`);
  }
  return result;
}

type ControlView = "plan" | "places" | "territories" | "team" | "operations";

export function ManagementForms({ employees, outlets, outletRecords, territories, territoryAssignments, dailyAssignments, today, operationsPolicy }: {
  employees: Option[];
  outlets: Option[];
  outletRecords: OutletRecord[];
  territories: TerritoryMapOption[];
  territoryAssignments: TerritoryAssignment[];
  dailyAssignments: DailyAssignment[];
  today: string;
  operationsPolicy: OperationalPolicy;
}) {
  const router = useRouter();
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [view, setView] = useState<ControlView>("plan");
  const [outletPoint, setOutletPoint] = useState<SelectedPoint | null>(null);
  const [outletTerritoryId, setOutletTerritoryId] = useState("");
  const [newBoundary, setNewBoundary] = useState<TerritoryBoundary | null>(null);
  const [selectedEmployees, setSelectedEmployees] = useState<string[]>([]);
  const [editorKey, setEditorKey] = useState(0);
  const [policyDraft, setPolicyDraft] = useState(operationsPolicy);

  useEffect(() => {
    const openControl = (event: Event) => {
      const requested = (event as CustomEvent<string>).detail;
      if (["plan", "places", "territories", "team", "operations"].includes(requested)) {
        setView(requested as ControlView);
      }
    };
    window.addEventListener("fieldops:open-management-control", openControl);
    return () => window.removeEventListener("fieldops:open-management-control", openControl);
  }, []);

  function setActionBusy(key: string, value: boolean) {
    setBusy((current) => {
      const next = { ...current };
      if (value) next[key] = true;
      else delete next[key];
      return next;
    });
  }

  function showSuccess(message: string) {
    setStatus(message);
    router.refresh();
  }

  async function runForm(event: FormEvent<HTMLFormElement>, path: string, label: string, extras: object = {}) {
    event.preventDefault();
    setActionBusy(label, true); setStatus("");
    const form = event.currentTarget;
    try {
      await requestJson(path, { ...Object.fromEntries(new FormData(form)), ...extras });
      form.reset();
      showSuccess(`${label} saved. The mobile app will receive the change after refresh.`);
      if (label === "Outlet") { setOutletPoint(null); setOutletTerritoryId(""); }
    } catch (error) { setStatus(error instanceof Error ? error.message : "Could not save."); }
    finally { setActionBusy(label, false); }
  }

  async function createTerritory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!newBoundary) { setStatus("Add at least three points on the territory map before saving."); return; }
    setActionBusy("Territory", true); setStatus("");
    const form = event.currentTarget;
    try {
      await requestJson("/api/management/territories", { ...Object.fromEntries(new FormData(form)), boundary: newBoundary, employeeIds: selectedEmployees });
      form.reset(); setSelectedEmployees([]); setNewBoundary(null); setEditorKey((value) => value + 1);
      showSuccess("Territory saved. Its boundary is now active for assigned salespeople.");
    } catch (error) { setStatus(error instanceof Error ? error.message : "Could not save territory."); }
    finally { setActionBusy("Territory", false); }
  }

  async function removeTerritory(employeeId: string, territoryId: string, label: string) {
    const isLastTerritory = territoryAssignments.filter((assignment) => assignment.employeeId === employeeId).length === 1;
    if (isLastTerritory && !window.confirm(
      "This is the salesperson’s last territory. Removing it will allow visits and orders in every area. Continue?",
    )) return;
    const busyKey = `Remove:${employeeId}:${territoryId}`;
    setActionBusy(busyKey, true); setStatus("");
    try {
      await requestJson("/api/management/territory-assignments", {
        employeeId,
        territoryId,
        confirmUnrestricted: isLastTerritory,
      }, "DELETE");
      showSuccess(`${label} removed.${isLastTerritory ? " Unrestricted field access is now active." : " Other territory limits remain active."}`);
    } catch (error) { setStatus(error instanceof Error ? error.message : "Could not remove territory."); }
    finally { setActionBusy(busyKey, false); }
  }

  async function removeDailyAssignment(assignment: DailyAssignment) {
    if (!window.confirm(`Remove ${assignment.outletLabel} from ${assignment.employeeLabel}’s plan for today?`)) return;
    const busyKey = `Unpublish:${assignment.id}`;
    setActionBusy(busyKey, true); setStatus("");
    try {
      await requestJson("/api/management/assignments", {
        routeId: assignment.id,
        reason: "Removed from today’s plan in the management dashboard",
      }, "DELETE");
      showSuccess(`${assignment.outletLabel} removed from today’s plan.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not remove the planned visit.");
    } finally {
      setActionBusy(busyKey, false);
    }
  }

  function updatePolicy(key: keyof OperationalPolicy, value: number) {
    setPolicyDraft((current) => ({ ...current, [key]: value }));
  }

  async function saveOperationalPolicy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const busyKey = "Operations policy";
    setActionBusy(busyKey, true); setStatus("");
    try {
      const result = await requestJson("/api/management/operations-policy", {
        ...policyDraft,
        expectedUpdatedAt: policyDraft.updatedAt,
      }, "PATCH") as { policy?: OperationalPolicy };
      if (result.policy) setPolicyDraft(result.policy);
      showSuccess("Tracking and sync controls saved. Phones will apply them after their next work update.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save tracking controls.");
    } finally {
      setActionBusy(busyKey, false);
    }
  }

  return <>
    {status && <p role="status" aria-live="polite" className={`mb-5 ${status.includes("saved") || status.includes("removed") ? ui.messageSuccess : ui.messageError}`}>{status}</p>}
    <section className="sticky top-3 z-20 mb-5 scroll-mt-5 rounded-2xl border border-slate-200 bg-white/95 p-2 shadow-[0_12px_32px_rgba(20,33,61,0.10)] backdrop-blur" id="management-controls" aria-label="Management tasks">
      <div className="grid grid-cols-2 gap-1 sm:grid-cols-5">
        {([
          ["plan", "Daily plan", "Assign today"],
          ["places", "Places", "Create outlets"],
          ["territories", "Territories", "Draw boundaries"],
          ["team", "Team & access", "People and scope"],
          ["operations", "Tracking & sync", "Phone policy"],
        ] as const).map(([key, label, detail]) => <button
          type="button"
          key={key}
          className={`cursor-pointer rounded-xl px-3 py-2.5 text-left transition focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-blue-300 ${view === key ? "bg-[#14213D] text-white shadow-sm" : "text-slate-600 hover:bg-slate-100"}`}
          aria-pressed={view === key}
          onClick={() => setView(key)}
        ><strong className="block text-sm">{label}</strong><small className={`mt-0.5 block text-[10px] ${view === key ? "text-slate-300" : "text-slate-500"}`}>{detail}</small></button>)}
      </div>
    </section>
    <section className="grid items-start gap-5 lg:grid-cols-2">
      {view === "team" && <form className={`${ui.card} grid gap-4`} onSubmit={(event) => runForm(event, "/api/management/employees", "Salesperson")}>
        <div><p className={ui.eyebrow}>People</p><h2 className={ui.h2}>Create salesperson</h2><p className={ui.lede}>Creates a field-only login. Territory access can be assigned now or later.</p></div>
        <label className={ui.label}>Full name<input className={ui.input} name="name" placeholder="Ali Raza" required /></label>
        <label className={ui.label}>Email<input className={ui.input} name="email" type="email" placeholder="ali@example.com" autoComplete="email" required /></label>
        <label className={ui.label}>Phone <span className="font-medium text-slate-500">optional</span><input className={ui.input} name="phone" type="tel" placeholder="+92 300 1234567" autoComplete="tel" /></label>
        <label className={ui.label}>Salesperson password<input className={ui.input} name="password" type="password" placeholder="Create a separate password" minLength={8} autoComplete="new-password" required /></label>
        <button className={ui.button} disabled={Boolean(busy.Salesperson)}>{busy.Salesperson ? "Creating…" : "Create salesperson"}</button>
      </form>}

      {view === "territories" && <form className={`${ui.card} grid gap-4`} onSubmit={createTerritory}>
        <div><p className={ui.eyebrow}>Territory control</p><h2 className={ui.h2}>Draw a territory</h2><p className={ui.lede}>Tap around the area to create a closed boundary. Assigning salespeople is optional.</p></div>
        <label className={ui.label}>Territory name<input className={ui.input} name="name" placeholder="Karachi South" required /></label>
        <TerritoryBoundaryEditor key={editorKey} onChange={setNewBoundary} />
        <fieldset className="grid grid-cols-1 gap-2 rounded-xl border border-slate-200 p-4 sm:grid-cols-2"><legend className="px-2 text-xs font-black">Assign salespeople now <span className="font-medium text-slate-500">optional</span></legend>{employees.map((employee) => <label className="flex min-h-10 items-center gap-2 text-xs font-bold" key={employee.id}><input className="h-[18px] w-[18px]" type="checkbox" checked={selectedEmployees.includes(employee.id)} onChange={(event) => setSelectedEmployees((current) => event.target.checked ? [...current, employee.id] : current.filter((id) => id !== employee.id))} />{employee.label}</label>)}</fieldset>
        <button className={ui.button} disabled={Boolean(busy.Territory) || !newBoundary}>{busy.Territory ? "Saving territory…" : "Save territory"}</button>
      </form>}

      {view === "places" && <form className={`${ui.card} grid gap-4 lg:col-span-2`} onSubmit={(event) => runForm(event, "/api/management/outlets", "Outlet", outletPoint ?? {})}>
        <div><p className={ui.eyebrow}>Stores</p><h2 className={ui.h2}>Add and assign outlet</h2><p className={ui.lede}>Choose a territory, then tap its shaded map area to place the visit marker.</p></div>
        <div className="grid gap-3 sm:grid-cols-2"><label className={ui.label}>Store code<input className={ui.input} name="code" placeholder="KHI-001" required /></label><label className={ui.label}>Store name<input className={ui.input} name="name" placeholder="Restaurant or retailer" required /></label></div>
        <label className={ui.label}>Address<input className={ui.input} name="address" placeholder="Full Karachi address" required /></label>
        <label className={ui.label}>Territory<select className={ui.input} name="territoryId" value={outletTerritoryId} onChange={(event) => { setOutletTerritoryId(event.target.value); setOutletPoint(null); }} required><option value="">Select territory</option>{territories.map((item) => <option key={item.id} value={item.id}>{item.name}{item.boundary ? "" : " · map required"}</option>)}</select></label>
        <PointMapPicker territories={territories} selectedTerritoryId={outletTerritoryId} value={outletPoint} onChange={setOutletPoint} />
        <input type="hidden" name="latitude" value={outletPoint?.latitude ?? ""} /><input type="hidden" name="longitude" value={outletPoint?.longitude ?? ""} />
        <label className={ui.label}>Assign to<select className={ui.input} name="employeeId"><option value="">Assign later</option>{employees.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label className={ui.label}>Notes<input className={ui.input} name="notes" placeholder="Contact, preferred visit time, instructions" /></label>
        <button className={ui.button} disabled={Boolean(busy.Outlet) || !outletPoint || !outletTerritoryId}>{busy.Outlet ? "Saving…" : "Save outlet"}</button>
      </form>}

      {view === "places" && <OutletDirectory records={outletRecords} territories={territories} onSaved={(name) => showSuccess(`${name} updated. The verified GPS point was not changed.`)} setStatus={setStatus} />}

      {view === "territories" && <section className={`${ui.card} grid gap-2`} aria-labelledby="territory-library-title">
        <div><p className={ui.eyebrow}>Saved map areas</p><h2 className={ui.h2} id="territory-library-title">Territory boundaries</h2><p className={ui.lede}>Redraw a legacy or changed territory before assigning it.</p></div>
        {territories.map((territory) => <BoundaryUpdateCard key={territory.id} territory={territory} busy={Boolean(busy[`Boundary:${territory.id}`])} setBusy={(value) => setActionBusy(`Boundary:${territory.id}`, value)} setStatus={setStatus} onSaved={() => showSuccess(`${territory.name} boundary saved.`)} />)}
      </section>}

      {view === "team" && <form className={`${ui.card} grid gap-4 lg:col-span-2 lg:grid-cols-[1.35fr_1fr_1fr_auto] lg:items-end`} onSubmit={(event) => runForm(event, "/api/management/territory-assignments", "Territory assignment")}>
        <div className="self-start"><p className={ui.eyebrow}>Access boundaries</p><h2 className={ui.h2}>Assign territory access</h2><p className={ui.lede}>One salesperson can have one, two, or more territories. With none, field activity is unrestricted.</p></div>
        <label className={ui.label}>Salesperson<select className={ui.input} name="employeeId" required><option value="">Select salesperson</option>{employees.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label className={ui.label}>Territory<select className={ui.input} name="territoryId" required><option value="">Select territory</option>{territories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <button className={ui.button} disabled={Boolean(busy["Territory assignment"])}>{busy["Territory assignment"] ? "Assigning…" : "Assign territory"}</button>
      </form>}

      {view === "team" && <section className={`${ui.card} grid gap-0`}>
        <div><p className={ui.eyebrow}>Current access</p><h2 className={ui.h2}>Salesperson territories</h2><p className={ui.lede}>Removing the last territory requires a separate warning because it enables unrestricted field access.</p></div>
        {territoryAssignments.length === 0 ? <p className="m-0 py-4 text-slate-500">No territory restrictions are active.</p> : territoryAssignments.map((assignment) => { const busyKey = `Remove:${assignment.employeeId}:${assignment.territoryId}`; return <div className="flex items-center justify-between gap-3 border-t border-slate-200 py-3" key={`${assignment.employeeId}:${assignment.territoryId}`}><span><strong className="block">{assignment.employeeLabel}</strong><small className="mt-1 block text-slate-500">{assignment.territoryLabel}</small></span><button type="button" className={ui.dangerButton} disabled={Boolean(busy[busyKey])} onClick={() => removeTerritory(assignment.employeeId, assignment.territoryId, `${assignment.territoryLabel} from ${assignment.employeeLabel}`)}>{busy[busyKey] ? "Removing…" : "Remove"}</button></div>; })}
      </section>}

      {view === "plan" && <form className={`${ui.card} grid gap-4 lg:col-span-2 lg:grid-cols-[1.35fr_1fr_1fr_1fr_auto] lg:items-end`} onSubmit={(event) => runForm(event, "/api/management/assignments", "Outlet assignment")}>
        <div className="self-start"><p className={ui.eyebrow}>Daily commitments</p><h2 className={ui.h2}>Assign an existing outlet</h2><p className={ui.lede}>Completion stays separate from salesperson-added visits and orders in reports.</p></div>
        <label className={ui.label}>Outlet<select className={ui.input} name="outletId" required><option value="">Select outlet</option>{outlets.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label className={ui.label}>Salesperson<select className={ui.input} name="employeeId" required><option value="">Select salesperson</option>{employees.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label className={ui.label}>Work date<input className={ui.input} name="workDate" type="date" defaultValue={today} required /></label>
        <button className={ui.button} disabled={Boolean(busy["Outlet assignment"])}>{busy["Outlet assignment"] ? "Publishing…" : "Publish outlet assignment"}</button>
      </form>}

      {view === "plan" && <section className={`${ui.card} grid gap-3 lg:col-span-2`} aria-labelledby="today-plan-title">
        <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-end"><div><p className={ui.eyebrow}>Published today</p><h2 className={ui.h2} id="today-plan-title">Today’s outlet plan</h2><p className={ui.lede}>Planned work can be removed safely. Started or completed visits stay locked in the field record.</p></div><span className="text-sm font-black text-slate-500">{dailyAssignments.length} visits</span></div>
        <div className="divide-y divide-slate-200 border-y border-slate-200">
          {dailyAssignments.map((assignment) => {
            const canRemove = assignment.status === "planned";
            const busyKey = `Unpublish:${assignment.id}`;
            return <article className="grid gap-3 py-4 sm:grid-cols-[auto_1fr_auto] sm:items-center" key={assignment.id}>
              <span className="grid h-9 w-9 place-items-center rounded-lg bg-slate-100 text-xs font-black text-[#14213D]">{assignment.sequence}</span>
              <div><strong className="block text-[#14213D]">{assignment.outletLabel}</strong><small className="mt-1 block text-slate-500">{assignment.employeeLabel} · {assignment.status.replaceAll("_", " ")}</small></div>
              {canRemove
                ? <button type="button" className={ui.dangerButton} disabled={Boolean(busy[busyKey])} onClick={() => removeDailyAssignment(assignment)}>{busy[busyKey] ? "Removing…" : "Remove from plan"}</button>
                : <span className="inline-flex rounded-full bg-slate-100 px-3 py-2 text-xs font-black text-slate-600">Field record locked</span>}
            </article>;
          })}
          {dailyAssignments.length === 0 && <p className="py-7 text-center text-sm text-slate-500">No outlet visits have been published for today.</p>}
        </div>
      </section>}

      {view === "operations" && <form className={`${ui.card} grid gap-5 lg:col-span-2`} onSubmit={saveOperationalPolicy}>
        <div className="grid gap-3 border-b border-slate-200 pb-5 lg:grid-cols-[1fr_auto] lg:items-start">
          <div><p className={ui.eyebrow}>Phone operations policy</p><h2 className={ui.h2}>Tracking quality and automatic sync</h2><p className={ui.lede}>These guarded controls change future phone captures and dashboard route drawing without another code release. Raw GPS points remain available for audit.</p></div>
          <div className="flex flex-wrap gap-2" aria-label="Policy presets">
            <button type="button" className={ui.quietButton} onClick={() => setPolicyDraft((current) => ({ ...preciseOperationalPolicy, updatedAt: current.updatedAt }))}>Use precise preset</button>
            <button type="button" className={ui.quietButton} onClick={() => setPolicyDraft((current) => ({ ...current, sampleIntervalSeconds: 30, distanceIntervalMeters: 20, maxAcceptedAccuracyMeters: 50, stationaryJitterMeters: 30, segmentGapMinutes: 8, maxPlausibleSpeedMps: 45, syncIntervalSeconds: 30 }))}>Use battery saver</button>
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <PolicyNumber label="Capture check" detail="Seconds between GPS checks · 5–60" value={policyDraft.sampleIntervalSeconds} min={5} max={60} suffix="sec" onChange={(value) => updatePolicy("sampleIntervalSeconds", value)} />
          <PolicyNumber label="Movement step" detail="Minimum useful movement · 3–50" value={policyDraft.distanceIntervalMeters} min={3} max={50} suffix="m" onChange={(value) => updatePolicy("distanceIntervalMeters", value)} />
          <PolicyNumber label="Weak-fix cutoff" detail="Exclude larger ± readings · 10–75" value={policyDraft.maxAcceptedAccuracyMeters} min={10} max={75} suffix="m" onChange={(value) => updatePolicy("maxAcceptedAccuracyMeters", value)} />
          <PolicyNumber label="Stop drift radius" detail="Ignore movement while stationary · 5–50" value={policyDraft.stationaryJitterMeters} min={5} max={50} suffix="m" onChange={(value) => updatePolicy("stationaryJitterMeters", value)} />
          <PolicyNumber label="Route gap" detail="Start a new line after · 2–15" value={policyDraft.segmentGapMinutes} min={2} max={15} suffix="min" onChange={(value) => updatePolicy("segmentGapMinutes", value)} />
          <PolicyNumber label="Automatic sync" detail="Send queued work every · 10–120" value={policyDraft.syncIntervalSeconds} min={10} max={120} suffix="sec" onChange={(value) => updatePolicy("syncIntervalSeconds", value)} />
        </div>
        <details className="rounded-xl border border-slate-200 bg-slate-50 p-4"><summary className="cursor-pointer text-sm font-black text-[#14213D]">Advanced route safety</summary><div className="mt-4 max-w-sm"><PolicyNumber label="Impossible-speed cutoff" detail="Break physically implausible jumps · 10–60 m/s" value={policyDraft.maxPlausibleSpeedMps} min={10} max={60} suffix="m/s" step={0.5} onChange={(value) => updatePolicy("maxPlausibleSpeedMps", value)} /></div></details>
        <div className="flex flex-col items-start justify-between gap-3 border-t border-slate-200 pt-4 sm:flex-row sm:items-center"><p className="max-w-2xl text-xs leading-5 text-slate-500">Recommended for Karachi field work: 10–15 second checks, 5–10 m movement, and a weak-fix cutoff between ±25 m and ±35 m. Smaller accuracy values are more precise.</p><button className={ui.button} disabled={Boolean(busy["Operations policy"])}>{busy["Operations policy"] ? "Saving controls…" : "Save tracking controls"}</button></div>
      </form>}
    </section>
  </>;
}

function PolicyNumber({ label, detail, value, min, max, suffix, step = 1, onChange }: {
  label: string;
  detail: string;
  value: number;
  min: number;
  max: number;
  suffix: string;
  step?: number;
  onChange: (value: number) => void;
}) {
  return <label className={ui.label}>{label}<span className="relative"><input className={`${ui.input} pr-14`} type="number" inputMode="decimal" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))} required /><span className="pointer-events-none absolute inset-y-0 right-3 grid place-items-center text-xs font-black text-slate-400">{suffix}</span></span><small className="font-medium leading-4 text-slate-500">{detail}</small></label>;
}

function OutletDirectory({ records, territories, onSaved, setStatus }: {
  records: OutletRecord[];
  territories: TerritoryMapOption[];
  onSaved: (name: string) => void;
  setStatus: (message: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState("");
  const [busy, setBusy] = useState("");
  const [draft, setDraft] = useState({ name: "", address: "", notes: "", territoryId: "", expectedUpdatedAt: "" });
  const normalized = query.trim().toLowerCase();
  const visible = records.filter((record) => !normalized || [record.name, record.code, record.address, record.territoryName].some((value) => value.toLowerCase().includes(normalized)));

  function begin(record: OutletRecord) {
    setEditing(record.id);
    setDraft({
      name: record.name,
      address: record.address,
      notes: record.notes,
      territoryId: record.territoryId,
      expectedUpdatedAt: record.updatedAt,
    });
  }

  async function save(record: OutletRecord) {
    setBusy(record.id); setStatus("");
    try {
      await requestJson(`/api/management/outlets/${record.id}`, {
        mode: "metadata",
        ...draft,
      }, "PATCH");
      setEditing("");
      onSaved(draft.name.trim() || record.name);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not update the outlet.");
    } finally {
      setBusy("");
    }
  }

  return <section className={`${ui.card} grid gap-4 lg:col-span-2`} aria-labelledby="outlet-directory-title">
    <div className="grid gap-3 sm:grid-cols-[1fr_minmax(220px,.55fr)] sm:items-end"><div><p className={ui.eyebrow}>Permanent field directory</p><h2 className={ui.h2} id="outlet-directory-title">Manage saved outlets</h2><p className={ui.lede}>Edit official details or move an outlet to a territory that contains its locked GPS point.</p></div><label className={ui.label}>Search outlets<input className={ui.input} type="search" value={query} placeholder="Name, code, address, territory" onChange={(event) => setQuery(event.target.value)} /></label></div>
    <div className="divide-y divide-slate-200 border-y border-slate-200">
      {visible.map((record) => editing === record.id
        ? <article className="grid gap-3 py-4" key={record.id}>
          <div className="flex items-center justify-between gap-3"><span><strong>{record.code}</strong><small className="ml-2 text-slate-500">{record.source}</small></span><span className="text-xs font-bold text-slate-500">GPS locked</span></div>
          <div className="grid gap-3 sm:grid-cols-2"><label className={ui.label}>Official name<input className={ui.input} value={draft.name} maxLength={160} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} /></label><label className={ui.label}>Territory<select className={ui.input} value={draft.territoryId} onChange={(event) => setDraft((current) => ({ ...current, territoryId: event.target.value }))}>{territories.map((territory) => <option key={territory.id} value={territory.id}>{territory.name}{territory.boundary ? "" : " · boundary missing"}</option>)}</select></label></div>
          <label className={ui.label}>Address<input className={ui.input} value={draft.address} maxLength={500} onChange={(event) => setDraft((current) => ({ ...current, address: event.target.value }))} /></label>
          <label className={ui.label}>Notes<textarea className={`${ui.input} min-h-20 resize-y`} value={draft.notes} maxLength={4000} onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))} /></label>
          <div className="flex flex-wrap gap-2"><button type="button" className={ui.button} disabled={busy === record.id || !draft.name.trim() || !draft.address.trim() || !draft.territoryId} onClick={() => save(record)}>{busy === record.id ? "Saving…" : "Save outlet details"}</button><button type="button" className={ui.quietButton} disabled={busy === record.id} onClick={() => setEditing("")}>Cancel</button></div>
        </article>
        : <article className="grid gap-3 py-4 sm:grid-cols-[1fr_auto] sm:items-center" key={record.id}><div><span className="inline-flex rounded-md bg-slate-100 px-2 py-1 text-[10px] font-black uppercase tracking-wider text-slate-600">{record.code} · {record.source}</span><strong className="mt-2 block text-[#14213D]">{record.name}</strong><small className="mt-1 block leading-5 text-slate-500">{record.address}<br />{record.territoryName}</small></div><button type="button" className={ui.quietButton} onClick={() => begin(record)}>Edit details</button></article>)}
      {visible.length === 0 && <p className="py-7 text-center text-sm text-slate-500">No outlets match this search.</p>}
    </div>
  </section>;
}

function BoundaryUpdateCard({ territory, busy, setBusy, setStatus, onSaved }: {
  territory: TerritoryMapOption;
  busy: boolean;
  setBusy: (value: boolean) => void;
  setStatus: (value: string) => void;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [boundary, setBoundary] = useState<TerritoryBoundary | null>(territory.boundary);
  return <article className="grid grid-cols-[1fr_auto] items-center gap-3 border-t border-slate-200 py-3">
    <div><strong className="block">{territory.name}</strong><small className="mt-1 block text-slate-500">{territory.boundary ? "Map boundary saved" : "Boundary required before enforcement"}</small></div>
    <button type="button" className={ui.quietButton} onClick={() => setOpen((value) => !value)}>{open ? "Close editor" : territory.boundary ? "Redraw" : "Draw boundary"}</button>
    {open && <div className="col-span-2 grid gap-3 pt-1"><TerritoryBoundaryEditor initialBoundary={territory.boundary} onChange={setBoundary} /><button type="button" className={`${ui.button} justify-self-start`} disabled={busy || !boundary} onClick={async () => { setBusy(true); setStatus(""); try { await requestJson("/api/management/territories", { territoryId: territory.id, boundary }, "PATCH"); onSaved(); setOpen(false); } catch (error) { setStatus(error instanceof Error ? error.message : "Could not update boundary."); } finally { setBusy(false); } }}>{busy ? "Saving…" : "Save boundary"}</button></div>}
  </article>;
}
