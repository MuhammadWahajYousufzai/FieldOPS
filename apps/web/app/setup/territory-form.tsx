"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { ui } from "../ui";

export function TerritoryForm() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError(""); setSaved(false);
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    const response = await fetch("/api/setup/territory", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
    const body = await response.json();
    setBusy(false);
    if (!response.ok) { setError(body.error); return; }
    form.reset(); setSaved(true); router.refresh();
  }

  return <form className={`${ui.card} grid gap-5`} onSubmit={submit}>
    <div><p className={ui.eyebrow}>Sales hierarchy</p><h2 className={ui.h2}>Add a sales area path</h2></div>
    <fieldset className="grid gap-3 border-0 border-t border-slate-200 pt-5 sm:grid-cols-[2fr_1fr]"><legend className="pr-3 text-lg font-black">Region</legend><label className={ui.label}>Name<input className={ui.input} name="regionName" placeholder="Karachi" required /></label><label className={ui.label}>Internal region key<input className={ui.input} name="regionCode" placeholder="KHI" maxLength={32} required /></label></fieldset>
    <fieldset className="grid gap-3 border-0 border-t border-slate-200 pt-5 sm:grid-cols-[2fr_1fr]"><legend className="pr-3 text-lg font-black">Area</legend><label className={ui.label}>Name<input className={ui.input} name="areaName" placeholder="South Karachi" required /></label><label className={ui.label}>Internal area key<input className={ui.input} name="areaCode" placeholder="KHI-S" maxLength={32} required /></label></fieldset>
    <fieldset className="grid gap-3 border-0 border-t border-slate-200 pt-5"><legend className="pr-3 text-lg font-black">Sales area</legend><label className={ui.label}>Name<input className={ui.input} name="territoryName" placeholder="Clifton & DHA" required /></label></fieldset>
    {error && <p className={ui.messageError} role="alert">{error}</p>}
    {saved && <p className={ui.messageSuccess}>Sales area saved and audited.</p>}
    <button className={ui.button} disabled={busy}>{busy ? "Saving…" : "Save sales area path"}</button>
  </form>;
}
