"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ui } from "../ui";

type EvidenceItem = {
  id: string;
  type: "photo" | "audio";
  fileId: string;
  filename: string;
};

export type PlaceReviewItem = {
  id: string;
  employeeName: string;
  submittedName: string;
  submittedAddress: string;
  outcome: string;
  notes: string;
  workDate: string;
  capturedAt: string;
  latitude: number;
  longitude: number;
  accuracy: number;
  candidateTerritoryId: string;
  evidenceComplete: boolean;
  pointAccurate: boolean;
  evidence: EvidenceItem[];
};

export type ApprovedPlace = {
  id: string;
  code: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  territoryName: string;
  submittedName: string;
  salespersonName: string;
  approvedAt: string;
};

type ReviewDraft = {
  name: string;
  address: string;
  territoryId: string;
  reason: string;
};

type Message = { tone: "success" | "error"; text: string } | null;

function reviewDraft(review: PlaceReviewItem): ReviewDraft {
  return {
    name: review.submittedName,
    address: review.submittedAddress,
    territoryId: review.candidateTerritoryId,
    reason: "",
  };
}

async function requestJson(path: string, method: "POST" | "PATCH", body: object) {
  const response = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "The review could not be saved.");
  return result;
}

export function PlaceApprovals({ reviews, territories, approvedPlaces }: {
  reviews: PlaceReviewItem[];
  territories: Array<{ id: string; name: string }>;
  approvedPlaces: ApprovedPlace[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState<Message>(null);
  const [resolved, setResolved] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<Record<string, ReviewDraft>>(() => Object.fromEntries(reviews.map((review) => [review.id, reviewDraft(review)])));
  const openReviews = useMemo(() => reviews.filter((review) => !resolved.includes(review.id)), [resolved, reviews]);

  function updateDraft(visitId: string, update: Partial<ReviewDraft>) {
    const review = reviews.find((item) => item.id === visitId);
    if (!review) return;
    setDrafts((current) => ({ ...current, [visitId]: { ...(current[visitId] ?? reviewDraft(review)), ...update } }));
  }

  async function reviewPlace(review: PlaceReviewItem, action: "approve" | "reject") {
    const draft = drafts[review.id] ?? reviewDraft(review);
    if (action === "approve" && (!draft.name.trim() || !draft.territoryId)) {
      setMessage({ tone: "error", text: "Enter the official name and choose the territory containing the verified point." });
      return;
    }
    if (action === "reject" && !draft.reason.trim()) {
      setMessage({ tone: "error", text: "Add a short reason before rejecting this marked place." });
      return;
    }
    const busyKey = `${action}:${review.id}`;
    setBusy(busyKey);
    setMessage(null);
    try {
      await requestJson("/api/management/place-approvals", "POST", {
        visitId: review.id,
        action,
        name: draft.name.trim(),
        address: draft.address.trim(),
        territoryId: draft.territoryId,
        reason: draft.reason.trim(),
      });
      setResolved((current) => [...current, review.id]);
      setMessage({
        tone: "success",
        text: action === "approve"
          ? `${draft.name.trim()} is now a permanent visit location.`
          : `${review.submittedName} was rejected with the review reason saved.`,
      });
      router.refresh();
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "The review could not be saved." });
    } finally {
      setBusy("");
    }
  }

  return <section className="mb-7 scroll-mt-5" id="place-approvals" aria-labelledby="place-approvals-title">
    <div className="mb-4 flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-end">
      <div>
        <p className={ui.eyebrow}>Verified field marks</p>
        <h2 className={ui.h2} id="place-approvals-title">Approve the place, preserve the report.</h2>
        <p className={ui.lede}>Check the salesperson&apos;s photo, voice report and GPS point. You control the official name and territory before the place joins the permanent outlet list.</p>
      </div>
      <span className={`inline-flex min-h-10 items-center rounded-full px-4 text-xs font-black ${openReviews.length ? "bg-amber-100 text-amber-900" : "bg-emerald-100 text-emerald-900"}`}>
        {openReviews.length ? `${openReviews.length} awaiting review` : "Review queue clear"}
      </span>
    </div>

    {message && <p className={`mb-4 ${message.tone === "success" ? ui.messageSuccess : ui.messageError}`} role="status" aria-live="polite">{message.text}</p>}

    <div className="grid gap-5">
      {openReviews.map((review) => {
        const draft = drafts[review.id] ?? reviewDraft(review);
        const photo = review.evidence.find((item) => item.type === "photo");
        const audio = review.evidence.find((item) => item.type === "audio");
        const approveBusy = busy === `approve:${review.id}`;
        const rejectBusy = busy === `reject:${review.id}`;
        return <article className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_16px_42px_rgba(20,33,61,0.08)]" key={review.id}>
          <header className="flex flex-col justify-between gap-3 border-b border-slate-200 bg-[#14213D] px-5 py-4 text-white sm:flex-row sm:items-center sm:px-6">
            <div className="flex items-center gap-3">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#D8A629] text-[10px] font-black tracking-wider text-[#14213D]">GPS</span>
              <div><p className="text-[10px] font-black uppercase tracking-[0.13em] text-blue-200">Marked by {review.employeeName}</p><h3 className="mt-1 text-xl font-black tracking-tight">{review.submittedName}</h3></div>
            </div>
            <div className="text-left sm:text-right"><span className="block text-xs font-extrabold text-amber-200">Awaiting admin decision</span><small className="mt-1 block text-slate-300">{formatDateTime(review.capturedAt)}</small></div>
          </header>

          <div className="grid xl:grid-cols-[minmax(0,.88fr)_minmax(380px,1.12fr)]">
            <section className="grid content-start gap-4 border-b border-slate-200 bg-slate-50 p-5 sm:p-6 xl:border-r xl:border-b-0" aria-label={`Evidence for ${review.submittedName}`}>
              <div className="grid grid-cols-2 gap-3">
                <Fact label="Sales report" value={review.outcome} />
                <Fact label="GPS accuracy" value={`±${Math.round(review.accuracy)} m`} />
              </div>
              {review.submittedAddress && <Fact label="Submitted address" value={review.submittedAddress} wide />}
              {review.notes && <Fact label="Written note" value={review.notes} wide />}
              <a className="inline-flex min-h-11 items-center justify-between gap-3 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm font-extrabold text-blue-800 transition hover:bg-blue-100 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-blue-300" href={mapUrl(review.latitude, review.longitude)} target="_blank" rel="noreferrer">
                <span>Open verified GPS point</span><span className="font-mono text-[10px]">{review.latitude.toFixed(5)}, {review.longitude.toFixed(5)} ↗</span>
              </a>
              {photo
                ? <a className="group overflow-hidden rounded-xl border border-slate-200 bg-white" href={`/api/evidence/${photo.fileId}`} target="_blank" rel="noreferrer"><img className="h-64 w-full object-cover transition duration-300 group-hover:scale-[1.015]" src={`/api/evidence/${photo.fileId}`} alt={`Photo evidence for ${review.submittedName}`} loading="lazy" /><span className="flex items-center justify-between px-3 py-2 text-xs font-extrabold text-slate-600"><span>Visit photo</span><span>Open full size ↗</span></span></a>
                : <MissingEvidence label="Photo evidence is missing" />}
              {audio
                ? <div className="rounded-xl border border-slate-200 bg-white p-3"><span className="mb-2 block text-[10px] font-black uppercase tracking-wider text-slate-500">Salesperson voice report</span><audio className="h-10 w-full" controls preload="none" src={`/api/evidence/${audio.fileId}`}>Your browser cannot play this voice report.</audio></div>
                : <MissingEvidence label="Voice report is missing" />}
              {!review.evidenceComplete && <p className={ui.messageError}>This legacy record is missing required evidence. Reject it with a reason; it cannot become a permanent place.</p>}
              {!review.pointAccurate && <p className={ui.messageError}>This GPS fix is not accurate enough for a permanent place. Reject it and ask for a new mark near the shop entrance.</p>}
            </section>

            <section className="grid content-start gap-4 p-5 sm:p-6" aria-label={`Permanent place details for ${review.submittedName}`}>
              <div><p className={ui.eyebrow}>Permanent place record</p><h3 className="mt-1 text-xl font-black text-[#14213D]">Confirm what the field team will see</h3><p className="mt-2 text-sm leading-6 text-slate-600">Editing here does not change the original report or verified coordinates.</p></div>
              <label className={ui.label} htmlFor={`official-name-${review.id}`}>Official place name<input id={`official-name-${review.id}`} className={ui.input} value={draft.name} maxLength={160} onChange={(event) => updateDraft(review.id, { name: event.target.value })} /></label>
              {draft.name.trim() !== review.submittedName.trim() && <p className="-mt-2 rounded-lg bg-blue-50 px-3 py-2 text-xs font-bold text-blue-800">Submitted as “{review.submittedName}” — this remains in the visit history.</p>}
              <label className={ui.label} htmlFor={`official-address-${review.id}`}>Official address<input id={`official-address-${review.id}`} className={ui.input} value={draft.address} maxLength={500} placeholder="Address recorded at the verified GPS point" onChange={(event) => updateDraft(review.id, { address: event.target.value })} /></label>
              <label className={ui.label} htmlFor={`official-territory-${review.id}`}>Territory<select id={`official-territory-${review.id}`} className={ui.input} value={draft.territoryId} onChange={(event) => updateDraft(review.id, { territoryId: event.target.value })}><option value="">Choose the territory containing this point</option>{territories.map((territory) => <option key={territory.id} value={territory.id}>{territory.name}</option>)}</select></label>
              <label className={ui.label} htmlFor={`review-reason-${review.id}`}>Review note <span className="font-medium text-slate-500">required only when rejecting</span><textarea id={`review-reason-${review.id}`} className={`${ui.input} min-h-24 resize-y`} value={draft.reason} maxLength={1000} placeholder="Why was it rejected, or what did you verify?" onChange={(event) => updateDraft(review.id, { reason: event.target.value })} /></label>
              <div className="grid gap-3 border-t border-slate-200 pt-4 sm:grid-cols-[1fr_auto]">
                <button type="button" className={ui.button} disabled={Boolean(busy) || !review.evidenceComplete || !review.pointAccurate} onClick={() => reviewPlace(review, "approve")}>{approveBusy ? "Approving place…" : "Approve permanent place"}</button>
                <button type="button" className={ui.dangerButton} disabled={Boolean(busy)} onClick={() => reviewPlace(review, "reject")}>{rejectBusy ? "Rejecting…" : "Reject with reason"}</button>
              </div>
            </section>
          </div>
        </article>;
      })}
      {openReviews.length === 0 && <div className="rounded-2xl border border-dashed border-emerald-300 bg-emerald-50/60 px-5 py-7 sm:px-6"><strong className="block text-lg font-black text-emerald-900">No marked places need a decision.</strong><p className="mt-2 text-sm leading-6 text-emerald-800">New salesperson submissions will appear here after their photo, voice report and GPS point reach the server.</p></div>}
    </div>

    <section className="mt-6 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_10px_30px_rgba(20,33,61,0.055)]" aria-labelledby="approved-places-title">
      <div className="flex flex-col items-start justify-between gap-3 border-b border-slate-200 px-5 py-5 sm:flex-row sm:items-end sm:px-6">
        <div><p className={ui.eyebrow}>Permanent field directory</p><h3 className={ui.h2} id="approved-places-title">Approved salesperson-marked places</h3><p className={ui.lede}>Review history stays here. Use the single Places directory below to edit official details without changing GPS.</p></div>
        <span className="text-sm font-black text-slate-500">{approvedPlaces.length} saved</span>
      </div>
      {approvedPlaces.length > 0 ? <div className="divide-y divide-slate-200">{approvedPlaces.map((place) => <article className="grid gap-4 px-5 py-5 sm:grid-cols-[1fr_auto] sm:items-center sm:px-6" key={place.id}>
          <div><span className="inline-flex rounded-md bg-emerald-50 px-2 py-1 text-[10px] font-black uppercase tracking-wider text-emerald-800">Permanent · {place.code}</span><strong className="mt-2 block text-lg text-[#14213D]">{place.name}</strong><small className="mt-1 block leading-5 text-slate-500">{place.address}<br />{place.territoryName} · marked by {place.salespersonName}<br />Approved {formatDateTime(place.approvedAt)}</small>{place.submittedName && place.submittedName !== place.name && <small className="mt-1 block font-bold text-blue-700">Submitted as “{place.submittedName}”</small>}</div>
          <div className="flex flex-wrap gap-2 sm:justify-end"><a className={ui.quietButton} href={mapUrl(place.latitude, place.longitude)} target="_blank" rel="noreferrer">Open point</a><a className={ui.button} href="#management-controls" onClick={() => window.dispatchEvent(new CustomEvent("fieldops:open-management-control", { detail: "places" }))}>Manage place</a></div>
        </article>)}</div> : <p className="px-5 py-7 text-sm leading-6 text-slate-500 sm:px-6">No salesperson-marked place has been approved yet. The first approved review will become the first permanent entry here.</p>}
    </section>
  </section>;
}

function Fact({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return <div className={`rounded-xl border border-slate-200 bg-white p-3 ${wide ? "col-span-2" : ""}`}><span className="block text-[10px] font-black uppercase tracking-wider text-slate-500">{label}</span><strong className="mt-1 block text-sm leading-5 text-[#14213D]">{value}</strong></div>;
}

function MissingEvidence({ label }: { label: string }) {
  return <div className="rounded-xl border border-dashed border-red-300 bg-red-50 p-4 text-sm font-extrabold text-red-800">{label}</div>;
}

function mapUrl(latitude: number, longitude: number) {
  return `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=18/${latitude}/${longitude}`;
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return date.toLocaleString("en-PK", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Karachi" });
}
