"use client";

import { type FormEvent, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ui } from "../ui";

export type TeamDeskEmployee = {
  id: string;
  label: string;
  phone: string;
  updatedAt: string;
};

export type TeamDeskMessage = {
  id: string;
  employeeId: string;
  senderRole: "manager" | "salesperson";
  body: string;
  sentAt: string;
  readAt: string;
};

export type TeamDeskDeal = {
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

export type ManagerTeamContact = {
  name: string;
  phone: string;
  whatsapp: string;
  updatedAt: string;
};

type DeskView = "messages" | "deals" | "contact";
type SubmitStatus = { tone: "success" | "error"; text: string };
const openStages = new Set(["lead", "qualified", "proposal", "negotiation"]);
const stages = ["lead", "qualified", "proposal", "negotiation", "won", "lost"];

export function TeamDesk({ employees, messages, deals, contact }: {
  employees: TeamDeskEmployee[];
  messages: TeamDeskMessage[];
  deals: TeamDeskDeal[];
  contact: ManagerTeamContact;
}) {
  const router = useRouter();
  const [view, setView] = useState<DeskView>("messages");
  const [selectedEmployeeId, setSelectedEmployeeId] = useState(employees[0]?.id ?? "");
  const [dealEmployeeId, setDealEmployeeId] = useState("");
  const [status, setStatus] = useState<SubmitStatus | null>(null);
  const [busy, setBusy] = useState("");
  const retryOperations = useRef(new Map<string, { signature: string; operationId: string }>());
  const selectedEmployee = employees.find((employee) => employee.id === selectedEmployeeId);
  const thread = useMemo(() => messages
    .filter((message) => message.employeeId === selectedEmployeeId)
    .sort((left, right) => left.sentAt.localeCompare(right.sentAt)), [messages, selectedEmployeeId]);
  const visibleDeals = useMemo(() => deals.filter((deal) => !dealEmployeeId || deal.employeeId === dealEmployeeId), [dealEmployeeId, deals]);
  const unread = messages.filter((message) => message.senderRole === "salesperson" && !message.readAt).length;
  const openDeals = deals.filter((deal) => openStages.has(deal.stage)).length;
  const overdue = deals.filter((deal) => isOverdue(deal)).length;

  async function submit(action: string, body: Record<string, unknown>, busyKey: string) {
    setBusy(busyKey);
    setStatus(null);
    const signature = JSON.stringify({ action, ...body });
    const previous = retryOperations.current.get(busyKey);
    const requestOperationId = previous?.signature === signature ? previous.operationId : operationId(action);
    retryOperations.current.set(busyKey, { signature, operationId: requestOperationId });
    try {
      const response = await fetch("/api/management/team-desk", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, operationId: requestOperationId, ...body }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "The Team Desk change could not be saved.");
      if (retryOperations.current.get(busyKey)?.operationId === requestOperationId) retryOperations.current.delete(busyKey);
      setStatus({ tone: "success", text: action === "message" ? "Message sent." : action === "mark_read" ? "Thread marked read." : "Team Desk saved." });
      router.refresh();
      return true;
    } catch (error) {
      setStatus({ tone: "error", text: error instanceof Error ? error.message : "The Team Desk change could not be saved." });
      return false;
    } finally {
      setBusy("");
    }
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedEmployeeId) return;
    const form = event.currentTarget;
    const body = String(new FormData(form).get("body") ?? "").trim();
    if (!body) return;
    if (await submit("message", { employeeId: selectedEmployeeId, body }, "message")) form.reset();
  }

  return <section className="mb-6 scroll-mt-5 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_12px_34px_rgba(20,33,61,0.07)]" id="team-desk" aria-labelledby="team-desk-title">
    <div className="grid gap-5 bg-[#14213D] px-5 py-5 text-white sm:px-6 lg:grid-cols-[1fr_auto] lg:items-end">
      <div><p className="text-[10px] font-black uppercase tracking-[0.14em] text-blue-200">Single-manager workspace</p><h2 className="mt-1 text-2xl font-black" id="team-desk-title">Team Desk</h2><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-300">Call salespeople, keep field decisions in one thread, and make every customer opportunity carry a clear next action.</p></div>
      <div className="grid grid-cols-3 overflow-hidden rounded-xl border border-white/15 bg-white/5 text-center">
        <DeskStat label="Unread" value={unread} alert={unread > 0} />
        <DeskStat label="Open deals" value={openDeals} />
        <DeskStat label="Overdue" value={overdue} alert={overdue > 0} />
      </div>
    </div>
    <div className="border-b border-slate-200 p-2 sm:p-3">
      <div className="grid grid-cols-3 gap-1" role="group" aria-label="Team Desk sections">
        {([[
          "messages", "Messages & calls",
        ], ["deals", "Deal follow-up"], ["contact", "Phone setup"]] as const).map(([key, label]) => <button
          key={key}
          type="button"
          aria-pressed={view === key}
          className={`min-h-11 rounded-xl px-3 text-xs font-black transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-blue-500 sm:text-sm ${view === key ? "bg-[#14213D] text-white" : "text-slate-600 hover:bg-slate-100"}`}
          onClick={() => setView(key)}
        >{label}</button>)}
      </div>
    </div>
    {status && <p className={`mx-5 mt-5 sm:mx-6 ${status.tone === "success" ? ui.messageSuccess : ui.messageError}`} role={status.tone === "error" ? "alert" : "status"} aria-live={status.tone === "error" ? "assertive" : "polite"}>{status.text}</p>}

    {view === "messages" && <div className="grid min-h-[480px] lg:grid-cols-[280px_minmax(0,1fr)]" id="team-desk-messages">
      <aside className="border-b border-slate-200 bg-slate-50 p-4 lg:border-b-0 lg:border-r">
        <p className={ui.eyebrow}>Sales team</p>
        <div className="mt-3 grid gap-2">{employees.map((employee) => {
          const employeeUnread = messages.filter((message) => message.employeeId === employee.id && message.senderRole === "salesperson" && !message.readAt).length;
          return <button type="button" key={employee.id} aria-pressed={employee.id === selectedEmployeeId} aria-label={`${employee.label}. ${employeeUnread} unread ${employeeUnread === 1 ? "message" : "messages"}. ${employee.phone || "Phone not configured"}`} className={`min-h-12 rounded-xl border px-3 py-2 text-left focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-blue-500 ${employee.id === selectedEmployeeId ? "border-blue-300 bg-blue-50 text-blue-950" : "border-slate-200 bg-white text-slate-700"}`} onClick={() => setSelectedEmployeeId(employee.id)}><span className="flex items-center justify-between gap-2"><strong>{employee.label}</strong>{employeeUnread > 0 && <b className="rounded-full bg-amber-300 px-2 py-0.5 text-[10px] text-[#14213D]">{employeeUnread}</b>}</span><small className="mt-1 block text-slate-500">{employee.phone || "Phone not configured"}</small></button>;
        })}</div>
        {employees.length === 0 && <p className="mt-4 text-sm text-slate-500">Create the first salesperson in Team & access.</p>}
      </aside>
      <div className="flex min-w-0 flex-col p-5 sm:p-6">
        {selectedEmployee ? <>
          <div className="flex flex-col justify-between gap-3 border-b border-slate-200 pb-4 sm:flex-row sm:items-center"><div><p className={ui.eyebrow}>Conversation</p><h3 className="text-xl font-black text-[#14213D]">{selectedEmployee.label}</h3></div><div className="flex flex-wrap gap-2">{phoneLinks(selectedEmployee.phone).map(({ label, href }) => <a key={label} className={ui.quietButton} href={href}>{label}</a>)}{thread.some((message) => message.senderRole === "salesperson" && !message.readAt) && <button type="button" className={ui.quietButton} disabled={busy === "read"} onClick={() => submit("mark_read", { employeeId: selectedEmployee.id }, "read")}>{busy === "read" ? "Saving…" : "Mark read"}</button>}</div></div>
          <div className="my-4 flex max-h-[360px] min-h-44 flex-col gap-2 overflow-y-auto rounded-xl bg-slate-50 p-3">{thread.length === 0 ? <p className="m-auto text-center text-sm text-slate-500">No messages yet. Send a clear instruction or ask for a field update.</p> : thread.map((message) => <article key={message.id} className={`max-w-[88%] rounded-2xl px-4 py-3 ${message.senderRole === "manager" ? "self-end bg-blue-700 text-white" : "self-start border border-slate-200 bg-white text-slate-800"}`}><small className={`font-black uppercase tracking-wider ${message.senderRole === "manager" ? "text-blue-100" : "text-slate-500"}`}>{message.senderRole === "manager" ? "You" : selectedEmployee.label}</small><p className="mt-1 whitespace-pre-wrap text-sm leading-6">{message.body}</p><time className={`mt-1 block text-[10px] ${message.senderRole === "manager" ? "text-blue-100" : "text-slate-500"}`}>{dateTime(message.sentAt)} · {message.readAt ? "Read" : message.senderRole === "salesperson" ? "New" : "Sent"}</time></article>)}</div>
          <form className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end" onSubmit={sendMessage}><label className={ui.label}>Message<textarea className={`${ui.input} min-h-24 resize-y`} name="body" maxLength={2000} placeholder="Next action, approval, answer, or field instruction" required /></label><button className={`${ui.button} min-h-11`} disabled={busy === "message"}>{busy === "message" ? "Sending…" : "Send message"}</button></form>
        </> : <p className="m-auto text-slate-500">Select a salesperson to open the thread.</p>}
      </div>
    </div>}

    {view === "deals" && <div className="p-5 sm:p-6" id="team-desk-deals">
      <div className="mb-5 flex flex-col justify-between gap-3 sm:flex-row sm:items-end"><div><p className={ui.eyebrow}>Customer opportunities</p><h3 className="text-xl font-black text-[#14213D]">Next action first</h3><p className="mt-1 text-sm text-slate-500">Values are seller-entered working estimates, not booked revenue.</p></div><label className={ui.label}>Salesperson<select className={ui.input} value={dealEmployeeId} onChange={(event) => setDealEmployeeId(event.target.value)}><option value="">All salespeople</option>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.label}</option>)}</select></label></div>
      <div className="grid gap-4 lg:grid-cols-2">{visibleDeals.map((deal) => <DealCard key={deal.id} deal={deal} busy={busy === `deal:${deal.id}`} onSave={(updates) => submit("deal_update", { dealId: deal.id, expectedUpdatedAt: deal.updatedAt, ...updates }, `deal:${deal.id}`)} />)}</div>
      {visibleDeals.length === 0 && <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center"><strong>No deals in this view</strong><p className="mt-2 text-sm text-slate-500">Salespeople can create opportunities from the mobile Team screen.</p></div>}
    </div>}

    {view === "contact" && <div className="grid gap-5 p-5 sm:p-6 lg:grid-cols-2" id="team-desk-contact">
      <form className={`${ui.card} grid gap-4 shadow-none`} onSubmit={async (event) => { event.preventDefault(); const form = event.currentTarget; const data = Object.fromEntries(new FormData(form)); await submit("contact", { ...data, expectedUpdatedAt: contact.updatedAt }, "contact"); }}><div><p className={ui.eyebrow}>Manager contact</p><h3 className="text-xl font-black text-[#14213D]">What salespeople can call</h3><p className="mt-1 text-sm leading-6 text-slate-500">These buttons open the phone or WhatsApp app. FieldOPS does not record calls.</p></div><label className={ui.label}>Display name<input className={ui.input} name="name" defaultValue={contact.name} maxLength={128} required /></label><label className={ui.label}>Phone<input className={ui.input} name="phone" type="tel" defaultValue={contact.phone} maxLength={32} placeholder="+92 300 1234567" /></label><label className={ui.label}>WhatsApp<input className={ui.input} name="whatsapp" type="tel" defaultValue={contact.whatsapp} maxLength={32} placeholder="+92 300 1234567" /></label><button className={ui.button} disabled={busy === "contact"}>{busy === "contact" ? "Saving…" : "Save manager contact"}</button></form>
      <section className={`${ui.card} shadow-none`}><div><p className={ui.eyebrow}>Salesperson phones</p><h3 className="text-xl font-black text-[#14213D]">Call from this dashboard</h3></div><div className="mt-4 divide-y divide-slate-200">{employees.map((employee) => <form className="grid gap-3 py-4 sm:grid-cols-[1fr_auto] sm:items-end" key={employee.id} onSubmit={async (event) => { event.preventDefault(); const form = event.currentTarget; const phone = String(new FormData(form).get("phone") ?? ""); await submit("employee_phone", { employeeId: employee.id, phone, expectedUpdatedAt: employee.updatedAt }, `phone:${employee.id}`); }}><label className={ui.label}>{employee.label}<input className={ui.input} name="phone" type="tel" defaultValue={employee.phone} maxLength={32} placeholder="+92 300 1234567" required /></label><button className={ui.quietButton} disabled={busy === `phone:${employee.id}`}>{busy === `phone:${employee.id}` ? "Saving…" : "Save phone"}</button></form>)}</div></section>
    </div>}
  </section>;
}

function DealCard({ deal, busy, onSave }: { deal: TeamDeskDeal; busy: boolean; onSave: (updates: Record<string, unknown>) => Promise<boolean> }) {
  const due = dueCopy(deal);
  return <article className="rounded-2xl border border-slate-200 p-4 sm:p-5">
    <div className="flex items-start justify-between gap-3"><div><small className="font-black uppercase tracking-wider text-slate-500">{deal.employeeLabel}</small><h4 className="mt-1 text-lg font-black text-[#14213D]">{deal.title}</h4><p className="mt-1 text-sm font-bold text-slate-600">{deal.customerName}{deal.outletLabel ? ` · ${deal.outletLabel}` : ""}</p></div><span className={`rounded-full px-3 py-1.5 text-[10px] font-black uppercase tracking-wider ${deal.stage === "won" ? "bg-emerald-50 text-emerald-800" : deal.stage === "lost" ? "bg-red-50 text-red-800" : "bg-blue-50 text-blue-800"}`}>{deal.stage}</span></div>
    <div className="my-4 grid grid-cols-2 border-y border-slate-200 py-3"><div><small className="font-black uppercase tracking-wider text-slate-500">Working value</small><b className="mt-1 block text-[#14213D]">{deal.amount === null ? "Not entered" : `PKR ${deal.amount.toLocaleString("en-PK")}`}</b></div><div className="text-right"><small className="font-black uppercase tracking-wider text-slate-500">Follow-up</small><b className={`mt-1 block ${due.tone}`}>{due.label}</b></div></div>
    <form className="grid gap-3" onSubmit={async (event) => { event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); await onSave({ stage: data.get("stage"), nextAction: data.get("nextAction"), followUpAt: localDateTime(String(data.get("followUpAt") ?? "")) }); }}><label className={ui.label}>Stage<select className={ui.input} name="stage" defaultValue={deal.stage}>{stages.map((stage) => <option key={stage} value={stage}>{stage[0]?.toUpperCase()}{stage.slice(1)}</option>)}</select></label><label className={ui.label}>Next action<input className={ui.input} name="nextAction" defaultValue={deal.nextAction} placeholder="What must happen next?" maxLength={500} /></label><label className={ui.label}>Follow-up<input className={ui.input} name="followUpAt" type="datetime-local" defaultValue={toLocalInput(deal.followUpAt)} /></label><button className={ui.quietButton} disabled={busy}>{busy ? "Saving…" : "Save deal follow-up"}</button></form>
  </article>;
}

function DeskStat({ label, value, alert = false }: { label: string; value: number; alert?: boolean }) {
  return <div className="border-r border-white/15 px-3 py-3 last:border-r-0"><b className={`block text-xl font-black ${alert ? "text-amber-300" : "text-white"}`}>{value}</b><small className="mt-0.5 block text-[10px] font-bold text-slate-300">{label}</small></div>;
}

function isOverdue(deal: TeamDeskDeal) {
  return dealDueState(deal) === "overdue";
}

function dueCopy(deal: TeamDeskDeal) {
  if (!deal.followUpAt) return { label: "Not scheduled", tone: "text-slate-600" };
  const date = new Date(deal.followUpAt);
  if (!Number.isFinite(date.valueOf())) return { label: "Check date", tone: "text-red-700" };
  const state = dealDueState(deal);
  if (state === "overdue") return { label: `Overdue · ${dateOnly(deal.followUpAt)}`, tone: "text-red-700" };
  if (state === "today") return { label: `Due today · ${dateOnly(deal.followUpAt)}`, tone: "text-amber-700" };
  return { label: dateOnly(deal.followUpAt), tone: "text-[#14213D]" };
}

function dealDueState(deal: TeamDeskDeal): "overdue" | "today" | "future" | "none" {
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

function phoneLinks(phone: string) {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return [];
  const telephone = `${phone.trim().startsWith("+") ? "+" : ""}${digits}`;
  return [{ label: "Call", href: `tel:${telephone}` }, { label: "WhatsApp", href: `https://wa.me/${digits}` }];
}

function operationId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`.slice(0, 64);
}

function dateTime(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? date.toLocaleString("en-PK", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Karachi" }) : "";
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
