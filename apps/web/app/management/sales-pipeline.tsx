"use client";

import { type FormEvent, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ui } from "../ui";

export type SalesPipelineEmployee = {
  id: string;
  label: string;
  status: "active" | "inactive";
};

export type SalesPipelineDeal = {
  id: string;
  employeeId: string;
  employeeLabel: string;
  outletLabel: string;
  customerName: string;
  title: string;
  stage: string;
  amount: number | null;
  nextAction: string;
  followUpAt: string;
  notes: string;
  updatedAt: string;
};

type SubmitStatus = { tone: "success" | "error"; text: string };
const openStages = new Set(["lead", "qualified", "proposal", "negotiation"]);
const stages = ["lead", "qualified", "proposal", "negotiation", "won", "lost"];

export function SalesPipeline({ employees, deals }: {
  employees: SalesPipelineEmployee[];
  deals: SalesPipelineDeal[];
}) {
  const router = useRouter();
  const [employeeId, setEmployeeId] = useState("");
  const [status, setStatus] = useState<SubmitStatus | null>(null);
  const [busy, setBusy] = useState("");
  const busyRef = useRef(new Set<string>());
  const retryOperations = useRef(new Map<string, { signature: string; operationId: string }>());
  const visibleDeals = useMemo(() => deals.filter((deal) => !employeeId || deal.employeeId === employeeId), [deals, employeeId]);
  const openDeals = deals.filter((deal) => openStages.has(deal.stage)).length;
  const overdue = deals.filter((deal) => dealDueState(deal) === "overdue").length;
  const won = deals.filter((deal) => deal.stage === "won").length;

  async function submit(body: Record<string, unknown>, busyKey: string) {
    if (busyRef.current.has(busyKey)) return false;
    busyRef.current.add(busyKey);
    setBusy(busyKey);
    setStatus(null);
    const signature = JSON.stringify({ action: "deal_update", ...body });
    const previous = retryOperations.current.get(busyKey);
    const requestOperationId = previous?.signature === signature ? previous.operationId : operationId("deal_update");
    retryOperations.current.set(busyKey, { signature, operationId: requestOperationId });
    try {
      const response = await fetch("/api/management/deals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "deal_update", operationId: requestOperationId, ...body }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "The deal could not be saved.");
      if (retryOperations.current.get(busyKey)?.operationId === requestOperationId) retryOperations.current.delete(busyKey);
      setStatus({ tone: "success", text: "Deal follow-up saved." });
      router.refresh();
      return true;
    } catch (error) {
      setStatus({ tone: "error", text: error instanceof Error ? error.message : "The deal could not be saved." });
      return false;
    } finally {
      busyRef.current.delete(busyKey);
      setBusy((current) => current === busyKey ? "" : current);
    }
  }

  return <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_12px_34px_rgba(20,33,61,0.07)]" id="sales-pipeline" aria-labelledby="sales-pipeline-title">
    <div className="grid gap-5 bg-[#2D2729] px-5 py-5 text-white sm:px-6 lg:grid-cols-[1fr_auto] lg:items-end">
      <div><p className="text-[10px] font-black uppercase tracking-[0.14em] text-blue-200">Customer follow-up</p><h2 className="mt-1 text-2xl font-black" id="sales-pipeline-title">Sales pipeline</h2><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-300">Keep every customer opportunity attached to a clear next action and follow-up date.</p></div>
      <div className="grid grid-cols-3 overflow-hidden rounded-xl border border-white/15 bg-white/5 text-center">
        <PipelineStat label="Open" value={openDeals} />
        <PipelineStat label="Overdue" value={overdue} alert={overdue > 0} />
        <PipelineStat label="Won" value={won} />
      </div>
    </div>
    {status && <p className={`mx-5 mt-5 sm:mx-6 ${status.tone === "success" ? ui.messageSuccess : ui.messageError}`} role={status.tone === "error" ? "alert" : "status"} aria-live={status.tone === "error" ? "assertive" : "polite"}>{status.text}</p>}
    <div className="p-5 sm:p-6">
      <div className="mb-5 flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
        <div><p className={ui.eyebrow}>Seller-entered opportunities</p><h3 className="text-xl font-black text-[#2D2729]">Next action first</h3><p className="mt-1 text-sm text-slate-500">Working values are estimates, not booked revenue.</p></div>
        <label className={ui.label}>Salesperson<select className={ui.input} value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}><option value="">All salespeople</option>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.label}{employee.status === "inactive" ? " · inactive" : ""}</option>)}</select></label>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">{visibleDeals.map((deal) => <DealCard key={deal.id} deal={deal} busy={busy === `deal:${deal.id}`} onSave={(updates) => submit({ dealId: deal.id, expectedUpdatedAt: deal.updatedAt, ...updates }, `deal:${deal.id}`)} />)}</div>
      {visibleDeals.length === 0 && <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center"><strong>No deals in this view</strong><p className="mt-2 text-sm text-slate-500">Salespeople can create opportunities from the mobile Sales screen.</p></div>}
    </div>
  </section>;
}

function DealCard({ deal, busy, onSave }: { deal: SalesPipelineDeal; busy: boolean; onSave: (updates: Record<string, unknown>) => Promise<boolean> }) {
  const due = dueCopy(deal);
  const submitRef = useRef(false);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitRef.current) return;
    submitRef.current = true;
    const data = new FormData(event.currentTarget);
    try {
      await onSave({ stage: data.get("stage"), nextAction: data.get("nextAction"), followUpAt: localDateTime(String(data.get("followUpAt") ?? "")) });
    } finally {
      submitRef.current = false;
    }
  }

  return <article className="rounded-2xl border border-slate-200 p-4 sm:p-5">
    <div className="flex items-start justify-between gap-3"><div><small className="font-black uppercase tracking-wider text-slate-500">{deal.employeeLabel}</small><h4 className="mt-1 text-lg font-black text-[#2D2729]">{deal.title}</h4><p className="mt-1 text-sm font-bold text-slate-600">{deal.customerName}{deal.outletLabel ? ` · ${deal.outletLabel}` : ""}</p></div><span className={`rounded-full px-3 py-1.5 text-[10px] font-black uppercase tracking-wider ${deal.stage === "won" ? "bg-emerald-50 text-emerald-800" : deal.stage === "lost" ? "bg-red-50 text-red-800" : "bg-blue-50 text-blue-800"}`}>{deal.stage}</span></div>
    <div className="my-4 grid grid-cols-2 border-y border-slate-200 py-3"><div><small className="font-black uppercase tracking-wider text-slate-500">Working value</small><b className="mt-1 block text-[#2D2729]">{deal.amount === null ? "Not entered" : `PKR ${deal.amount.toLocaleString("en-PK")}`}</b></div><div className="text-right"><small className="font-black uppercase tracking-wider text-slate-500">Follow-up</small><b className={`mt-1 block ${due.tone}`}>{due.label}</b></div></div>
    <form className="grid gap-3" onSubmit={save}><label className={ui.label}>Stage<select className={ui.input} name="stage" defaultValue={deal.stage}>{stages.map((stage) => <option key={stage} value={stage}>{stage[0]?.toUpperCase()}{stage.slice(1)}</option>)}</select></label><label className={ui.label}>Next action<input className={ui.input} name="nextAction" defaultValue={deal.nextAction} placeholder="What must happen next?" maxLength={500} /></label><label className={ui.label}>Follow-up<input className={ui.input} name="followUpAt" type="datetime-local" defaultValue={toLocalInput(deal.followUpAt)} /></label><button className={ui.quietButton} disabled={busy}>{busy ? "Saving…" : "Save deal follow-up"}</button></form>
  </article>;
}

function PipelineStat({ label, value, alert = false }: { label: string; value: number; alert?: boolean }) {
  return <div className="border-r border-white/15 px-3 py-3 last:border-r-0"><b className={`block text-xl font-black ${alert ? "text-amber-300" : "text-white"}`}>{value}</b><small className="mt-0.5 block text-[10px] font-bold text-slate-300">{label}</small></div>;
}

function dueCopy(deal: SalesPipelineDeal) {
  if (!deal.followUpAt) return { label: "Not scheduled", tone: "text-slate-600" };
  const date = new Date(deal.followUpAt);
  if (!Number.isFinite(date.valueOf())) return { label: "Check date", tone: "text-red-700" };
  const state = dealDueState(deal);
  if (state === "overdue") return { label: `Overdue · ${dateOnly(deal.followUpAt)}`, tone: "text-red-700" };
  if (state === "today") return { label: `Due today · ${dateOnly(deal.followUpAt)}`, tone: "text-amber-700" };
  return { label: dateOnly(deal.followUpAt), tone: "text-[#2D2729]" };
}

function dealDueState(deal: SalesPipelineDeal): "overdue" | "today" | "future" | "none" {
  if (!openStages.has(deal.stage) || !deal.followUpAt) return "none";
  const followUp = new Date(deal.followUpAt).valueOf();
  if (!Number.isFinite(followUp)) return "none";
  const pakistanOffset = 5 * 60 * 60 * 1_000;
  const dueDay = Math.floor((followUp + pakistanOffset) / 86_400_000);
  const today = Math.floor((Date.now() + pakistanOffset) / 86_400_000);
  if (dueDay < today) return "overdue";
  if (dueDay === today) return "today";
  return "future";
}

function operationId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`.slice(0, 64);
}

function dateOnly(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? date.toLocaleDateString("en-PK", { day: "numeric", month: "short", timeZone: "Asia/Karachi" }) : "";
}

function toLocalInput(value: string) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) return "";
  const inKarachi = new Date(date.valueOf() + 5 * 60 * 60 * 1_000);
  return inKarachi.toISOString().slice(0, 16);
}

function localDateTime(value: string) {
  if (!value) return null;
  const parsed = new Date(`${value}:00+05:00`);
  return Number.isFinite(parsed.valueOf()) ? parsed.toISOString() : null;
}
