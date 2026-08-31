"use client";

import {
  type FormEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { ui } from "../ui";

export type ManagedSalesperson = {
  id: string;
  userId: string;
  name: string;
  email: string;
  phone: string;
  status: "active" | "inactive";
  authStatus: "enabled" | "disabled" | "missing";
  updatedAt: string;
  authUpdatedAt?: string;
  joinedAt: string;
  passwordUpdatedAt?: string;
  protected?: boolean;
  identityIssue?: string;
  lastActivityAt?: string;
  effectiveSalesRole?: boolean;
};

type DirectoryFilter = "all" | "active" | "inactive" | "attention";
type Notice = { tone: "success" | "error"; text: string };
type MutationConfig = {
  key: string;
  method: "POST" | "PATCH" | "DELETE";
  url: string;
  body: Record<string, unknown>;
  success: string;
  preferredId?: string | null;
};
type RunMutation = (config: MutationConfig) => Promise<boolean>;

const filterOptions: ReadonlyArray<{ value: DirectoryFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
  { value: "attention", label: "Needs attention" },
];
const rosterPageSize = 100;
const maxRosterPages = 100;
const maxRosterRecords = 10_000;

export function SalespersonManager() {
  const router = useRouter();
  const searchId = useId();
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const loadAbortRef = useRef<AbortController | null>(null);
  const loadSequenceRef = useRef(0);
  const retryOperationsRef = useRef(new Map<string, { fingerprint: string; operationId: string }>());
  const mutationInFlightRef = useRef(false);
  const [salespeople, setSalespeople] = useState<ManagedSalesperson[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<DirectoryFilter>("all");
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const loadRoster = useCallback(async ({ initial = false, preferredId }: { initial?: boolean; preferredId?: string | null } = {}) => {
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    const sequence = ++loadSequenceRef.current;
    if (initial) setInitialLoading(true);
    else setRefreshing(true);
    setLoadError("");

    try {
      const rows: ManagedSalesperson[] = [];
      const employeeIds = new Set<string>();
      const seenCursors = new Set<string>();
      let cursor: string | null = null;
      let pageCount = 0;

      do {
        if (pageCount >= maxRosterPages) throw new Error("The sales roster exceeded the safe pagination limit.");
        if (cursor !== null) {
          if (seenCursors.has(cursor)) throw new Error("The sales roster returned a repeated pagination cursor.");
          seenCursors.add(cursor);
        }
        const url = `/api/management/employees?limit=${rosterPageSize}${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
        const response = await fetch(url, {
          cache: "no-store",
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
        const result: unknown = await response.json().catch(() => null);
        if (!response.ok) throw new Error(apiError(result, "The sales roster could not be loaded."));
        const page = parseDirectoryPage(result);
        for (const person of page.salespeople) {
          if (employeeIds.has(person.id)) throw new Error("The sales roster returned a duplicate personnel record.");
          employeeIds.add(person.id);
          rows.push(person);
          if (rows.length > maxRosterRecords) throw new Error("The sales roster exceeded the safe record limit.");
        }
        cursor = page.nextCursor;
        pageCount += 1;
      } while (cursor !== null);

      if (sequence !== loadSequenceRef.current) return false;
      rows.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
      setSalespeople(rows);
      setSelectedId((current) => {
        if (preferredId && rows.some((row) => row.id === preferredId)) return preferredId;
        if (preferredId === null) return rows[0]?.id ?? "";
        if (rows.some((row) => row.id === current)) return current;
        return rows[0]?.id ?? "";
      });
      return true;
    } catch (error) {
      if (controller.signal.aborted || sequence !== loadSequenceRef.current) return false;
      setLoadError(error instanceof Error ? error.message : "The sales roster could not be loaded.");
      return false;
    } finally {
      if (sequence === loadSequenceRef.current) {
        setInitialLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadRoster({ initial: true });
    return () => {
      loadAbortRef.current?.abort();
      loadSequenceRef.current += 1;
    };
  }, [loadRoster]);

  const visibleSalespeople = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return salespeople.filter((person) => {
      const matchesQuery = !needle || [person.name, person.email, person.phone]
        .some((value) => value.toLocaleLowerCase().includes(needle));
      const matchesFilter = filter === "all"
        || (filter === "active" && person.status === "active")
        || (filter === "inactive" && person.status === "inactive")
        || (filter === "attention" && needsAttention(person));
      return matchesQuery && matchesFilter;
    });
  }, [filter, query, salespeople]);

  useEffect(() => {
    setSelectedId((current) => visibleSalespeople.some((person) => person.id === current)
      ? current
      : visibleSalespeople[0]?.id ?? "");
  }, [visibleSalespeople]);

  const selected = salespeople.find((person) => person.id === selectedId) ?? null;
  const activeCount = salespeople.filter((person) => person.status === "active").length;
  const inactiveCount = salespeople.length - activeCount;
  const attentionCount = salespeople.filter(needsAttention).length;

  const runMutation: RunMutation = useCallback(async (config) => {
    if (mutationInFlightRef.current) return false;
    mutationInFlightRef.current = true;
    setBusy(config.key);
    setNotice(null);

    try {
      const fingerprint = await mutationFingerprint({ method: config.method, url: config.url, body: config.body });
      const previous = retryOperationsRef.current.get(config.key);
      const operationId = previous?.fingerprint === fingerprint
        ? previous.operationId
        : newOperationId(config.key);
      retryOperationsRef.current.set(config.key, { fingerprint, operationId });

      const response = await fetch(config.url, {
        method: config.method,
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ ...config.body, operationId }),
      });
      const result: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const requestError = new Error(apiError(result, "The salesperson change could not be saved."));
        Object.assign(requestError, { status: response.status });
        throw requestError;
      }

      retryOperationsRef.current.delete(config.key);
      router.refresh();
      const returnedId = isRecord(result) && typeof result.employeeId === "string" ? result.employeeId : undefined;
      const preferredId = config.preferredId === null ? null : config.preferredId ?? returnedId;
      await loadRoster(preferredId === undefined ? {} : { preferredId });
      setNotice({ tone: "success", text: config.success });
      return true;
    } catch (error) {
      const status = isRecord(error) && typeof error.status === "number" ? error.status : 0;
      if (status === 409 || status === 412) {
        await loadRoster(config.preferredId === undefined ? {} : { preferredId: config.preferredId });
        setNotice({
          tone: "error",
          text: `${error instanceof Error ? error.message : "This record changed elsewhere."} The latest roster has been loaded; review it and try again.`,
        });
      } else {
        setNotice({
          tone: "error",
          text: error instanceof Error ? error.message : "The salesperson change could not be saved.",
        });
      }
      return false;
    } finally {
      mutationInFlightRef.current = false;
      setBusy("");
    }
  }, [loadRoster, router]);

  function closeCreateAndRestoreFocus() {
    setCreateOpen(false);
    window.requestAnimationFrame(() => addButtonRef.current?.focus());
  }

  return <section
    className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_14px_38px_rgba(20,33,61,0.08)] lg:col-span-2"
    id="salesperson-manager"
    aria-labelledby="salesperson-manager-title"
    aria-busy={initialLoading || refreshing || Boolean(busy)}
  >
    <header className="grid gap-5 bg-[#14213D] px-5 py-5 text-white sm:px-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
      <div>
        <p className="m-0 text-[10px] font-black uppercase tracking-[0.16em] text-blue-200">Field access ledger</p>
        <h2 className="mt-1 text-2xl font-black tracking-[-0.025em]" id="salesperson-manager-title">Sales team roster</h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-300">Create field identities, keep personnel records current, and control who can sign in without losing operational history.</p>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="grid grid-cols-3 overflow-hidden rounded-xl border border-white/15 bg-white/5 text-center" aria-label="Roster summary">
          <RosterStat label="Active" value={activeCount} tone="text-emerald-300" />
          <RosterStat label="Inactive" value={inactiveCount} tone="text-slate-100" />
          <RosterStat label="Attention" value={attentionCount} tone={attentionCount ? "text-amber-300" : "text-slate-100"} />
        </div>
        <button
          ref={addButtonRef}
          type="button"
          className="inline-flex min-h-11 items-center justify-center rounded-xl bg-[#2563EB] px-4 py-2.5 font-extrabold text-white transition hover:bg-blue-500 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-blue-200 disabled:cursor-not-allowed disabled:opacity-45"
          aria-expanded={createOpen}
          aria-controls="new-salesperson-panel"
          disabled={Boolean(busy)}
          onClick={() => setCreateOpen((open) => !open)}
        >{createOpen ? "Close new record" : "Add salesperson"}</button>
      </div>
    </header>

    {createOpen && <CreateSalespersonPanel
      busy={busy === "create-salesperson"}
      locked={Boolean(busy)}
      onCancel={closeCreateAndRestoreFocus}
      onCreate={async (body) => {
        const created = await runMutation({
          key: "create-salesperson",
          method: "POST",
          url: "/api/management/employees",
          body,
          success: `${String(body.name).trim()} was added to the sales roster.`,
        });
        if (created) closeCreateAndRestoreFocus();
        return created;
      }}
    />}

    <div className="border-b border-slate-200 px-5 py-3 sm:px-6" aria-live="polite">
      <div className="flex min-h-11 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1">
          {notice && <div className={`flex items-start justify-between gap-3 ${notice.tone === "success" ? ui.messageSuccess : ui.messageError}`} role={notice.tone === "error" ? "alert" : "status"}>
            <span>{notice.text}</span>
            <button type="button" className="shrink-0 underline underline-offset-2" onClick={() => setNotice(null)} aria-label="Dismiss message">Dismiss</button>
          </div>}
          {!notice && loadError && <div className={`flex items-start justify-between gap-3 ${ui.messageError}`} role="alert">
            <span>{loadError}</span>
            <button type="button" className="shrink-0 underline underline-offset-2" disabled={refreshing} onClick={() => void loadRoster()}>{refreshing ? "Retrying…" : "Retry"}</button>
          </div>}
          {!notice && !loadError && <p className="text-xs font-bold text-slate-500">{refreshing ? "Refreshing roster…" : `${salespeople.length} ${salespeople.length === 1 ? "person" : "people"} on record · destructive removal requires an inactive account and typed identity confirmation`}</p>}
        </div>
        <button type="button" className={`${ui.quietButton} shrink-0`} disabled={refreshing || Boolean(busy)} onClick={() => void loadRoster({ preferredId: selectedId })}>{refreshing ? "Refreshing…" : "Refresh roster"}</button>
      </div>
    </div>

    {initialLoading && salespeople.length === 0
      ? <RosterLoading />
      : salespeople.length === 0 && loadError
        ? <div className="grid min-h-72 place-items-center p-6 text-center"><div><strong className="text-lg text-[#14213D]">Roster unavailable</strong><p className="mt-2 max-w-md text-sm leading-6 text-slate-500">No cached personnel records are shown. Retry the read before making access decisions.</p></div></div>
        : salespeople.length === 0
          ? <EmptyRoster onCreate={() => setCreateOpen(true)} />
          : <div className="grid min-h-[620px] lg:grid-cols-[minmax(290px,370px)_minmax(0,1fr)]">
            <aside className="border-b border-slate-200 bg-slate-50/80 lg:border-b-0 lg:border-r" aria-label="Salespeople roster">
              <div className="border-b border-slate-200 p-4 sm:p-5">
                <label className="grid gap-2 text-xs font-extrabold text-[#14213D]" htmlFor={searchId}>Search roster</label>
                <div className="relative mt-2">
                  <span className="pointer-events-none absolute inset-y-0 left-3 grid place-items-center text-sm text-slate-400" aria-hidden="true">⌕</span>
                  <input
                    id={searchId}
                    type="search"
                    className={`${ui.input} pl-9`}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Name, email, or phone"
                    autoComplete="off"
                  />
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="Filter salespeople">
                  {filterOptions.map((option) => <button
                    key={option.value}
                    type="button"
                    aria-pressed={filter === option.value}
                    className={`min-h-9 rounded-lg border px-2.5 py-1.5 text-[11px] font-black transition focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-blue-400 ${filter === option.value ? "border-[#14213D] bg-[#14213D] text-white" : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"}`}
                    onClick={() => setFilter(option.value)}
                  >{option.label}</button>)}
                </div>
              </div>
              <div className="max-h-[440px] overflow-y-auto p-3 lg:max-h-[690px]" role="listbox" aria-label="Salespeople">
                {visibleSalespeople.map((person) => <RosterRow
                  key={person.id}
                  person={person}
                  selected={person.id === selectedId}
                  disabled={Boolean(busy)}
                  onSelect={() => setSelectedId(person.id)}
                />)}
                {visibleSalespeople.length === 0 && <div className="m-2 rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center">
                  <strong className="text-sm text-[#14213D]">No roster match</strong>
                  <p className="mt-2 text-xs leading-5 text-slate-500">Change the search or status filter to bring personnel records back into view.</p>
                  <button type="button" className="mt-3 text-xs font-black text-blue-700 underline underline-offset-4" onClick={() => { setQuery(""); setFilter("all"); }}>Clear filters</button>
                </div>}
              </div>
            </aside>

            <section className="min-w-0 bg-white" aria-label="Selected salesperson record">
              {selected
                ? <SalespersonRecord key={`${selected.id}:${selected.updatedAt}`} person={selected} busy={busy} runMutation={runMutation} />
                : <div className="grid min-h-[520px] place-items-center p-8 text-center"><div><strong className="text-lg text-[#14213D]">Choose a personnel record</strong><p className="mt-2 text-sm text-slate-500">Select a salesperson from the roster to review access and identity details.</p></div></div>}
            </section>
          </div>}
  </section>;
}

function CreateSalespersonPanel({ busy, locked, onCancel, onCreate }: {
  busy: boolean;
  locked: boolean;
  onCancel: () => void;
  onCreate: (body: Record<string, unknown>) => Promise<boolean>;
}) {
  const nameRef = useRef<HTMLInputElement>(null);
  const [validation, setValidation] = useState("");

  useEffect(() => { nameRef.current?.focus(); }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const password = String(data.get("password") ?? "");
    const confirmation = String(data.get("passwordConfirmation") ?? "");
    if (password !== confirmation) {
      setValidation("The password confirmation does not match.");
      return;
    }
    setValidation("");
    await onCreate({
      name: String(data.get("name") ?? "").trim(),
      email: String(data.get("email") ?? "").trim().toLocaleLowerCase(),
      phone: String(data.get("phone") ?? "").trim(),
      password,
    });
  }

  return <section className="border-b border-blue-200 bg-blue-50/70 px-5 py-5 sm:px-6" id="new-salesperson-panel" aria-labelledby="new-salesperson-title">
    <form className="mx-auto grid max-w-5xl gap-4" onSubmit={submit}>
      <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-start">
        <div><p className={ui.eyebrow}>New field identity</p><h3 className="mt-1 text-xl font-black text-[#14213D]" id="new-salesperson-title">Open a salesperson record</h3><p className="mt-1 text-sm leading-6 text-slate-600">Use a work email and a separate temporary password. The salesperson can sign in as soon as creation succeeds.</p></div>
        <button type="button" className="text-left text-xs font-black text-slate-600 underline underline-offset-4 sm:text-right" disabled={locked} onClick={onCancel}>Cancel</button>
      </div>
      {validation && <p className={ui.messageError} role="alert">{validation}</p>}
      <fieldset className="grid gap-4 disabled:opacity-65 sm:grid-cols-2" disabled={locked}>
        <label className={ui.label}>Full name<input ref={nameRef} className={ui.input} name="name" maxLength={128} placeholder="Ali Raza" autoComplete="name" required /></label>
        <label className={ui.label}>Work email<input className={ui.input} name="email" type="email" maxLength={320} placeholder="ali@example.com" autoComplete="email" required /></label>
        <label className={ui.label}>Phone <span className="font-medium text-slate-500">optional</span><input className={ui.input} name="phone" type="tel" maxLength={32} placeholder="+92 300 1234567" autoComplete="tel" /></label>
        <div className="hidden sm:block" aria-hidden="true" />
        <label className={ui.label}>Temporary password<input className={ui.input} name="password" type="password" minLength={8} maxLength={256} autoComplete="new-password" required /></label>
        <label className={ui.label}>Confirm password<input className={ui.input} name="passwordConfirmation" type="password" minLength={8} maxLength={256} autoComplete="new-password" required /></label>
      </fieldset>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button type="button" className={ui.quietButton} disabled={locked} onClick={onCancel}>Cancel</button>
        <button className={ui.button} disabled={locked}>{busy ? "Creating salesperson…" : "Create salesperson"}</button>
      </div>
    </form>
  </section>;
}

function RosterRow({ person, selected, disabled, onSelect }: { person: ManagedSalesperson; selected: boolean; disabled: boolean; onSelect: () => void }) {
  const attention = needsAttention(person);
  const spine = person.protected ? "border-l-amber-500" : person.status === "active" && person.authStatus === "enabled" ? "border-l-emerald-500" : person.status === "inactive" ? "border-l-slate-400" : "border-l-red-500";
  return <button
    type="button"
    role="option"
    aria-selected={selected}
    disabled={disabled}
    className={`mb-2 w-full rounded-xl border border-l-4 px-3 py-3 text-left transition focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:cursor-wait ${spine} ${selected ? "border-blue-300 bg-blue-50 shadow-[0_4px_14px_rgba(37,99,235,0.10)]" : "border-y-slate-200 border-r-slate-200 bg-white hover:border-y-slate-300 hover:border-r-slate-300"}`}
    onClick={onSelect}
  >
    <span className="flex items-start gap-3">
      <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl text-xs font-black ${selected ? "bg-[#14213D] text-white" : "bg-slate-100 text-slate-600"}`} aria-hidden="true">{initials(person.name)}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-start justify-between gap-2"><strong className="truncate text-sm text-[#14213D]">{person.name}</strong><span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${attention ? "bg-amber-500" : person.status === "active" ? "bg-emerald-500" : "bg-slate-400"}`} aria-hidden="true" /></span>
        <small className="mt-1 block truncate text-xs text-slate-500">{person.email}</small>
        <span className="mt-2 flex flex-wrap gap-1.5">
          <StatusPill label={person.status} tone={person.status === "active" ? "green" : "slate"} />
          {person.protected && <StatusPill label="Protected" tone="amber" />}
          {!person.protected && attention && <StatusPill label="Check identity" tone="amber" />}
        </span>
      </span>
    </span>
  </button>;
}

function SalespersonRecord({ person, busy, runMutation }: { person: ManagedSalesperson; busy: string; runMutation: RunMutation }) {
  const locked = Boolean(busy) || Boolean(person.protected);
  return <div className="p-5 sm:p-6">
    <header className="flex flex-col justify-between gap-4 border-b border-slate-200 pb-5 sm:flex-row sm:items-start">
      <div className="flex min-w-0 items-start gap-4">
        <span className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-[#14213D] text-sm font-black text-white" aria-hidden="true">{initials(person.name)}</span>
        <div className="min-w-0">
          <p className={ui.eyebrow}>Personnel record</p>
          <h3 className="mt-1 truncate text-2xl font-black tracking-[-0.025em] text-[#14213D]">{person.name}</h3>
          <p className="mt-1 break-all text-sm text-slate-500">{person.email}</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 sm:max-w-60 sm:justify-end">
        <StatusPill label={`Record ${person.status}`} tone={person.status === "active" ? "green" : "slate"} />
        <StatusPill label={`Sign-in ${person.authStatus}`} tone={person.authStatus === "enabled" ? "blue" : person.authStatus === "missing" ? "red" : "slate"} />
        {person.effectiveSalesRole === false && <StatusPill label="Role inactive" tone="amber" />}
        {person.protected && <StatusPill label="Protected identity" tone="amber" />}
      </div>
    </header>

    {person.protected && <div className="mt-5 border-l-4 border-amber-500 bg-amber-50 p-4 text-sm text-amber-950" role="note">
      <strong className="block">Protected admin-linked identity</strong>
      <p className="mt-1 leading-6">This record may be linked to a dashboard administrator. Profile, password, access, and removal controls are locked to prevent an admin lockout.</p>
    </div>}
    {person.identityIssue && <div className="mt-5 border-l-4 border-red-600 bg-red-50 p-4 text-sm text-red-900" role="alert">
      <strong className="block">Identity needs attention</strong>
      <p className="mt-1 leading-6">{person.identityIssue}</p>
    </div>}
    {person.effectiveSalesRole === false && <div className="mt-5 border-l-4 border-amber-500 bg-amber-50 p-4 text-sm text-amber-950" role="note">
      <strong className="block">Sales role is not effective</strong>
      <p className="mt-1 leading-6">This personnel record does not currently have an effective salesperson role assignment. Review role scope before assigning new field work.</p>
    </div>}

    <dl className="mt-5 grid overflow-hidden rounded-xl border border-slate-200 bg-slate-50 sm:grid-cols-2 xl:grid-cols-4">
      <RecordDatum label="Joined" value={formatDate(person.joinedAt)} />
      <RecordDatum label="Last activity" value={person.lastActivityAt ? formatDateTime(person.lastActivityAt) : "No recorded activity"} />
      <RecordDatum label="Record updated" value={formatDateTime(person.updatedAt)} />
      <RecordDatum label="Account reference" value={shortReference(person.userId)} title={person.userId} />
    </dl>

    <div className="mt-5 grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(280px,350px)]">
      <div className="grid gap-5">
        <ProfileEditor person={person} busy={busy === `profile:${person.id}`} locked={locked} runMutation={runMutation} />
        <PasswordEditor person={person} busy={busy === `password:${person.id}`} locked={locked} runMutation={runMutation} />
      </div>
      <aside className="grid gap-5">
        <AccessControls person={person} busy={busy === `status:${person.id}`} locked={locked} runMutation={runMutation} />
        <RemovalControls person={person} busy={busy === `delete:${person.id}`} locked={locked} runMutation={runMutation} />
      </aside>
    </div>
  </div>;
}

function ProfileEditor({ person, busy, locked, runMutation }: { person: ManagedSalesperson; busy: boolean; locked: boolean; runMutation: RunMutation }) {
  const [name, setName] = useState(person.name);
  const [email, setEmail] = useState(person.email);
  const [phone, setPhone] = useState(person.phone);
  const authMissing = person.authStatus === "missing";
  const editLocked = locked || authMissing;
  const cleanName = name.trim();
  const cleanEmail = email.trim().toLocaleLowerCase();
  const cleanPhone = phone.trim();
  const changed = cleanName !== person.name || cleanEmail !== person.email.toLocaleLowerCase() || cleanPhone !== person.phone;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await runMutation({
      key: `profile:${person.id}`,
      method: "PATCH",
      url: `/api/management/employees/${encodeURIComponent(person.id)}`,
      body: { action: "profile", name: cleanName, email: cleanEmail, phone: cleanPhone, expectedUpdatedAt: person.updatedAt, expectedAuthUpdatedAt: person.authUpdatedAt ?? "" },
      success: `${cleanName}'s personnel details were updated.`,
      preferredId: person.id,
    });
  }

  return <form className="rounded-2xl border border-slate-200 p-4 sm:p-5" onSubmit={submit}>
    <div><p className={ui.eyebrow}>Identity details</p><h4 className="mt-1 text-lg font-black text-[#14213D]">Profile and contact</h4><p className="mt-1 text-sm leading-6 text-slate-500">Email changes update the salesperson's sign-in identity as well as this personnel record.</p></div>
    {authMissing && <p className="mt-4 border-l-4 border-red-500 bg-red-50 p-3 text-sm font-bold text-red-800">Profile changes are unavailable because they cannot be synchronized to the missing sign-in account.</p>}
    <fieldset className="mt-4 grid gap-4 disabled:opacity-65 sm:grid-cols-2" disabled={editLocked}>
      <label className={ui.label}>Full name<input className={ui.input} value={name} onChange={(event) => setName(event.target.value)} maxLength={128} autoComplete="name" required /></label>
      <label className={ui.label}>Work email<input className={ui.input} value={email} onChange={(event) => setEmail(event.target.value)} type="email" maxLength={320} autoComplete="email" required /></label>
      <label className={`${ui.label} sm:col-span-2`}>Phone <span className="font-medium text-slate-500">optional</span><input className={ui.input} value={phone} onChange={(event) => setPhone(event.target.value)} type="tel" maxLength={32} autoComplete="tel" placeholder="+92 300 1234567" /></label>
    </fieldset>
    <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
      <button type="button" className={ui.quietButton} disabled={editLocked || !changed} onClick={() => { setName(person.name); setEmail(person.email); setPhone(person.phone); }}>Discard edits</button>
      <button className={ui.button} disabled={editLocked || !changed || !cleanName || !cleanEmail}>{busy ? "Saving details…" : "Save details"}</button>
    </div>
  </form>;
}

function PasswordEditor({ person, busy, locked, runMutation }: { person: ManagedSalesperson; busy: boolean; locked: boolean; runMutation: RunMutation }) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [validation, setValidation] = useState("");
  const authMissing = person.authStatus === "missing";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password !== confirmation) {
      setValidation("The password confirmation does not match.");
      return;
    }
    setValidation("");
    const saved = await runMutation({
      key: `password:${person.id}`,
      method: "PATCH",
      url: `/api/management/employees/${encodeURIComponent(person.id)}`,
      body: { action: "password", password, expectedUpdatedAt: person.updatedAt, expectedAuthUpdatedAt: person.authUpdatedAt ?? "" },
      success: `A new password was set for ${person.name}.`,
      preferredId: person.id,
    });
    if (saved) { setPassword(""); setConfirmation(""); }
  }

  return <form className="rounded-2xl border border-slate-200 p-4 sm:p-5" onSubmit={submit}>
    <div><p className={ui.eyebrow}>Credentials</p><h4 className="mt-1 text-lg font-black text-[#14213D]">Set a new password</h4><p className="mt-1 text-sm leading-6 text-slate-500">This takes effect immediately. Share the password through a trusted channel and never reuse an administrator password.</p></div>
    {authMissing && <p className="mt-4 border-l-4 border-red-500 bg-red-50 p-3 text-sm font-bold text-red-800">Password changes are unavailable because the linked sign-in account is missing.</p>}
    {validation && <p className={`mt-4 ${ui.messageError}`} role="alert">{validation}</p>}
    <fieldset className="mt-4 grid gap-4 disabled:opacity-65 sm:grid-cols-2" disabled={locked || authMissing}>
      <label className={ui.label}>New password<input className={ui.input} value={password} onChange={(event) => setPassword(event.target.value)} type="password" minLength={8} maxLength={256} autoComplete="new-password" required /></label>
      <label className={ui.label}>Confirm new password<input className={ui.input} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} type="password" minLength={8} maxLength={256} autoComplete="new-password" required /></label>
    </fieldset>
    <div className="mt-4 flex justify-end"><button className={ui.quietButton} disabled={locked || authMissing || password.length < 8 || confirmation.length < 8}>{busy ? "Setting password…" : "Set new password"}</button></div>
  </form>;
}

function AccessControls({ person, busy, locked, runMutation }: { person: ManagedSalesperson; busy: boolean; locked: boolean; runMutation: RunMutation }) {
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);
  const isAligned = (person.status === "active" && person.authStatus === "enabled") || (person.status === "inactive" && person.authStatus === "disabled");
  const canActivate = person.effectiveSalesRole !== false;

  async function changeStatus(status: "active" | "inactive") {
    const changed = await runMutation({
      key: `status:${person.id}`,
      method: "PATCH",
      url: `/api/management/employees/${encodeURIComponent(person.id)}`,
      body: { action: "status", status, expectedUpdatedAt: person.updatedAt, expectedAuthUpdatedAt: person.authUpdatedAt ?? "" },
      success: status === "active" ? `${person.name} can sign in again.` : `${person.name} was deactivated; operational history was retained.`,
      preferredId: person.id,
    });
    if (changed) setConfirmDeactivate(false);
  }

  return <section className="rounded-2xl border border-slate-200 p-4 sm:p-5" aria-labelledby={`access-${person.id}`}>
    <p className={ui.eyebrow}>Lifecycle</p><h4 className="mt-1 text-lg font-black text-[#14213D]" id={`access-${person.id}`}>Field access</h4>
    <div className="mt-4 border-y border-slate-200 py-3">
      <div className="flex items-center justify-between gap-3"><span className="text-sm font-bold text-slate-600">Personnel record</span><strong className={person.status === "active" ? "text-emerald-700" : "text-slate-600"}>{titleCase(person.status)}</strong></div>
      <div className="mt-2 flex items-center justify-between gap-3"><span className="text-sm font-bold text-slate-600">Sign-in account</span><strong className={person.authStatus === "enabled" ? "text-blue-700" : person.authStatus === "missing" ? "text-red-700" : "text-slate-600"}>{titleCase(person.authStatus)}</strong></div>
    </div>
    {!isAligned && !person.identityIssue && <p className="mt-3 text-xs font-bold leading-5 text-amber-800">The personnel and sign-in states do not match. Choose an action below to reconcile access.</p>}
    {!confirmDeactivate && person.status === "active" && person.authStatus === "enabled" && <button type="button" className={`${ui.dangerButton} mt-4 w-full`} disabled={locked} onClick={() => setConfirmDeactivate(true)}>Deactivate salesperson</button>}
    {!confirmDeactivate && person.status === "active" && person.authStatus === "disabled" && <div className="mt-4 grid gap-2">
      {canActivate
        ? <button type="button" className={ui.button} disabled={locked} onClick={() => void changeStatus("active")}>{busy ? "Updating access…" : "Restore sign-in"}</button>
        : <p className="border-l-4 border-amber-500 bg-amber-50 p-3 text-xs font-bold leading-5 text-amber-900">Restore an effective salesperson role assignment before enabling sign-in.</p>}
      <button type="button" className={ui.quietButton} disabled={locked} onClick={() => setConfirmDeactivate(true)}>Keep sign-in blocked and mark inactive</button>
    </div>}
    {!confirmDeactivate && person.status === "active" && person.authStatus === "missing" && <button type="button" className={`${ui.dangerButton} mt-4 w-full`} disabled={locked} onClick={() => setConfirmDeactivate(true)}>Mark record inactive</button>}
    {!confirmDeactivate && person.status === "inactive" && person.authStatus === "disabled" && (canActivate
      ? <button type="button" className={`${ui.button} mt-4 w-full`} disabled={locked} onClick={() => void changeStatus("active")}>{busy ? "Reactivating…" : "Reactivate salesperson"}</button>
      : <p className="mt-4 border-l-4 border-amber-500 bg-amber-50 p-3 text-xs font-bold leading-5 text-amber-900">Restore an effective salesperson role assignment before reactivating this account.</p>)}
    {!confirmDeactivate && person.status === "inactive" && person.authStatus === "enabled" && <div className="mt-4 grid gap-2">
      <button type="button" className={ui.dangerButton} disabled={locked} onClick={() => setConfirmDeactivate(true)}>Disable sign-in and keep inactive</button>
      {canActivate
        ? <button type="button" className={ui.quietButton} disabled={locked} onClick={() => void changeStatus("active")}>{busy ? "Reactivating…" : "Reactivate record instead"}</button>
        : <p className="border-l-4 border-amber-500 bg-amber-50 p-3 text-xs font-bold leading-5 text-amber-900">Restore the sales role before reactivating this record.</p>}
    </div>}
    {!confirmDeactivate && person.status === "inactive" && person.authStatus === "missing" && <p className="mt-4 text-xs font-bold leading-5 text-red-700">The record is inactive and no sign-in account exists. Investigate the identity issue before considering reactivation.</p>}
    {confirmDeactivate && <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-3">
      <strong className="text-sm text-amber-950">Deactivate field access?</strong>
      <p className="mt-1 text-xs leading-5 text-amber-900">The salesperson will be signed out and blocked from new field work. Visits, routes, deals, and audit history stay on record.</p>
      <div className="mt-3 grid grid-cols-2 gap-2"><button type="button" className={ui.quietButton} disabled={Boolean(busy)} onClick={() => setConfirmDeactivate(false)}>Keep active</button><button type="button" className={ui.dangerButton} disabled={locked} onClick={() => void changeStatus("inactive")}>{busy ? "Deactivating…" : "Confirm deactivation"}</button></div>
    </div>}
  </section>;
}

function RemovalControls({ person, busy, locked, runMutation }: { person: ManagedSalesperson; busy: boolean; locked: boolean; runMutation: RunMutation }) {
  const [open, setOpen] = useState(false);
  const [confirmationEmail, setConfirmationEmail] = useState("");
  const inactive = person.status === "inactive";
  const signInBlocked = person.authStatus !== "enabled";
  const unusedIdentity = !person.lastActivityAt;
  const removalEligible = inactive && signInBlocked && unusedIdentity;
  const confirmationTarget = person.email || person.name;
  const confirmed = confirmationEmail.trim().toLocaleLowerCase() === confirmationTarget.trim().toLocaleLowerCase();

  async function remove(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await runMutation({
      key: `delete:${person.id}`,
      method: "DELETE",
      url: `/api/management/employees/${encodeURIComponent(person.id)}`,
      body: { confirmationEmail: confirmationEmail.trim(), expectedUpdatedAt: person.updatedAt, expectedAuthUpdatedAt: person.authUpdatedAt ?? "" },
      success: `${person.name}'s salesperson account and profile were permanently removed.`,
      preferredId: null,
    });
  }

  return <section className="rounded-2xl border border-red-200 bg-red-50/40 p-4 sm:p-5" aria-labelledby={`removal-${person.id}`}>
    <p className="text-[11px] font-black uppercase tracking-[0.13em] text-red-700">Permanent action</p><h4 className="mt-1 text-lg font-black text-red-950" id={`removal-${person.id}`}>Remove salesperson</h4>
    <p className="mt-2 text-sm leading-6 text-red-900">Use only for a wrongly created identity. Deactivation is safer when the person has operational history.</p>
    {!inactive && <p className="mt-3 text-xs font-bold leading-5 text-red-800">Deactivate this salesperson before permanent removal can be considered.</p>}
    {inactive && !signInBlocked && <p className="mt-3 text-xs font-bold leading-5 text-red-800">Disable the sign-in identity before permanent removal can be considered.</p>}
    {inactive && signInBlocked && !unusedIdentity && <p className="mt-3 text-xs font-bold leading-5 text-red-800">This sign-in identity has already been used. Keep the salesperson inactive so account and operational history remain intact.</p>}
    {removalEligible && !open && <button type="button" className={`${ui.dangerButton} mt-4 w-full`} disabled={locked} onClick={() => setOpen(true)}>Open removal check</button>}
    {removalEligible && open && <form className="mt-4 grid gap-3" onSubmit={remove}>
      <div className="rounded-xl border border-red-200 bg-white p-3 text-xs leading-5 text-red-900">Type <strong className="break-all">{confirmationTarget}</strong> to confirm permanent removal.</div>
      <label className="grid gap-2 text-xs font-extrabold text-red-950">{person.email ? "Confirmation email" : "Confirmation name"}<input className={`${ui.input} border-red-300 focus:border-red-600 focus:ring-red-200`} value={confirmationEmail} onChange={(event) => setConfirmationEmail(event.target.value)} type={person.email ? "email" : "text"} autoComplete="off" spellCheck={false} required /></label>
      <div className="grid grid-cols-2 gap-2"><button type="button" className={ui.quietButton} disabled={Boolean(busy)} onClick={() => { setOpen(false); setConfirmationEmail(""); }}>Cancel</button><button className={ui.dangerButton} disabled={locked || !confirmed}>{busy ? "Removing…" : "Remove permanently"}</button></div>
    </form>}
  </section>;
}

function RosterStat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return <div className="border-r border-white/15 px-3 py-2.5 last:border-r-0"><b className={`block text-xl font-black ${tone}`}>{value}</b><small className="mt-0.5 block text-[10px] font-bold text-slate-300">{label}</small></div>;
}

function RecordDatum({ label, value, title }: { label: string; value: string; title?: string }) {
  return <div className="border-b border-slate-200 px-4 py-3 last:border-b-0 sm:border-r sm:[&:nth-child(even)]:border-r-0 sm:[&:nth-last-child(-n+2)]:border-b-0 xl:border-b-0 xl:border-r xl:last:border-r-0"><dt className="text-[10px] font-black uppercase tracking-[0.1em] text-slate-500">{label}</dt><dd className="mt-1 truncate text-xs font-bold text-[#14213D]" title={title}>{value}</dd></div>;
}

function StatusPill({ label, tone }: { label: string; tone: "green" | "blue" | "slate" | "amber" | "red" }) {
  const colors = {
    green: "bg-emerald-50 text-emerald-800 ring-emerald-200",
    blue: "bg-blue-50 text-blue-800 ring-blue-200",
    slate: "bg-slate-100 text-slate-700 ring-slate-200",
    amber: "bg-amber-50 text-amber-900 ring-amber-200",
    red: "bg-red-50 text-red-800 ring-red-200",
  } as const;
  return <span className={`inline-flex rounded-full px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.08em] ring-1 ring-inset ${colors[tone]}`}>{label}</span>;
}

function RosterLoading() {
  return <div className="grid min-h-[620px] lg:grid-cols-[minmax(290px,370px)_minmax(0,1fr)]" role="status" aria-label="Loading sales roster">
    <div className="border-b border-slate-200 bg-slate-50 p-5 lg:border-b-0 lg:border-r"><div className="h-11 animate-pulse rounded-xl bg-slate-200 motion-reduce:animate-none" />{[1, 2, 3, 4].map((item) => <div key={item} className="mt-3 h-20 animate-pulse rounded-xl bg-slate-200 motion-reduce:animate-none" />)}</div>
    <div className="p-6"><div className="h-20 animate-pulse rounded-xl bg-slate-100 motion-reduce:animate-none" /><div className="mt-5 h-64 animate-pulse rounded-2xl bg-slate-100 motion-reduce:animate-none" /></div>
    <span className="sr-only">Loading sales roster…</span>
  </div>;
}

function EmptyRoster({ onCreate }: { onCreate: () => void }) {
  return <div className="grid min-h-[430px] place-items-center bg-[linear-gradient(135deg,rgba(37,99,235,0.04),transparent_55%)] p-6 text-center">
    <div className="max-w-md"><span className="mx-auto grid h-16 w-16 place-items-center rounded-2xl border border-blue-200 bg-blue-50 text-xl font-black text-blue-700" aria-hidden="true">+</span><p className={`${ui.eyebrow} mt-5`}>Roster ready</p><h3 className="mt-1 text-2xl font-black text-[#14213D]">Add the first salesperson</h3><p className="mt-2 text-sm leading-6 text-slate-500">Create a field-only identity here, then assign sales areas and daily work from the rest of the management workspace.</p><button type="button" className={`${ui.button} mt-5`} onClick={onCreate}>Create first salesperson</button></div>
  </div>;
}

function parseDirectoryPage(payload: unknown): { salespeople: ManagedSalesperson[]; nextCursor: string | null } {
  if (!isRecord(payload) || !Array.isArray(payload.salespeople)) throw new Error("The server returned an invalid sales roster.");
  if (payload.nextCursor !== null && payload.nextCursor !== undefined && typeof payload.nextCursor !== "string") {
    throw new Error("The server returned an invalid sales roster cursor.");
  }
  return {
    salespeople: payload.salespeople.map((value, index) => parseSalesperson(value, index)),
    nextCursor: typeof payload.nextCursor === "string" && payload.nextCursor ? payload.nextCursor : null,
  };
}

function parseSalesperson(value: unknown, index: number): ManagedSalesperson {
  if (!isRecord(value)
    || typeof value.id !== "string"
    || typeof value.userId !== "string"
    || typeof value.name !== "string"
    || typeof value.email !== "string"
    || typeof value.phone !== "string"
    || (value.status !== "active" && value.status !== "inactive")
    || (value.authStatus !== "enabled" && value.authStatus !== "disabled" && value.authStatus !== "missing")
    || typeof value.updatedAt !== "string"
    || typeof value.joinedAt !== "string") {
    throw new Error(`Sales roster entry ${index + 1} is invalid.`);
  }
  return {
    id: value.id,
    userId: value.userId,
    name: value.name,
    email: value.email,
    phone: value.phone,
    status: value.status,
    authStatus: value.authStatus,
    updatedAt: value.updatedAt,
    ...(typeof value.authUpdatedAt === "string" ? { authUpdatedAt: value.authUpdatedAt } : {}),
    joinedAt: value.joinedAt,
    ...(typeof value.passwordUpdatedAt === "string" && value.passwordUpdatedAt ? { passwordUpdatedAt: value.passwordUpdatedAt } : {}),
    ...(typeof value.protected === "boolean" ? { protected: value.protected } : {}),
    ...(typeof value.identityIssue === "string" && value.identityIssue ? { identityIssue: value.identityIssue } : {}),
    ...(typeof value.lastActivityAt === "string" && value.lastActivityAt ? { lastActivityAt: value.lastActivityAt } : {}),
    ...(typeof value.effectiveSalesRole === "boolean" ? { effectiveSalesRole: value.effectiveSalesRole } : {}),
  };
}

function needsAttention(person: ManagedSalesperson) {
  return Boolean(person.protected)
    || Boolean(person.identityIssue)
    || person.effectiveSalesRole === false
    || person.authStatus === "missing"
    || (person.status === "active" && person.authStatus !== "enabled")
    || (person.status === "inactive" && person.authStatus !== "disabled");
}

function apiError(payload: unknown, fallback: string) {
  return isRecord(payload) && typeof payload.error === "string" && payload.error.trim() ? payload.error : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function mutationFingerprint(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  let hash = 2166136261;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
  return (hash >>> 0).toString(16);
}

function newOperationId(key: string) {
  const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 20) || "employee";
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${safeKey}_${random}`.slice(0, 64);
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0]?.[0] ?? ""}${parts.at(-1)?.[0] ?? ""}` : parts[0]?.slice(0, 2) ?? "SP").toLocaleUpperCase();
}

function titleCase(value: string) {
  return value ? `${value[0]?.toLocaleUpperCase()}${value.slice(1)}` : "Unknown";
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? date.toLocaleDateString("en-PK", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Karachi" }) : "Not recorded";
}

function formatDateTime(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? date.toLocaleString("en-PK", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Karachi" }) : "Not recorded";
}

function shortReference(value: string) {
  if (!value) return "Missing";
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}
