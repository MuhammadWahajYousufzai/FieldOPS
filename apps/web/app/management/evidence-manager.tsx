"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { EVIDENCE_RETENTION_DAYS, evidenceRetentionState } from "../../lib/evidence-retention";
import { ui } from "../ui";

export type RetainedEvidenceItem = {
  id: string;
  fileId: string;
  visitId: string;
  type: "photo" | "audio";
  filename: string;
  capturedAt: string;
  employeeName: string;
  outletName: string;
};

export function EvidenceManager({ initialItems }: { initialItems: RetainedEvidenceItem[] }) {
  const router = useRouter();
  const [items, setItems] = useState(initialItems);
  const [query, setQuery] = useState("");
  const [confirming, setConfirming] = useState("");
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const now = useMemo(() => new Date(), []);
  const visible = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return items;
    return items.filter((item) => [item.outletName, item.employeeName, item.filename, item.type]
      .some((value) => value.toLocaleLowerCase().includes(normalized)));
  }, [items, query]);
  const photoCount = items.filter((item) => item.type === "photo").length;
  const audioCount = items.length - photoCount;
  const dueSoon = items.filter((item) => {
    const retention = evidenceRetentionState(item.capturedAt, now);
    return retention && retention.daysRemaining <= 1;
  }).length;

  async function remove(item: RetainedEvidenceItem) {
    setBusy((current) => new Set(current).add(item.id));
    setMessage(null);
    try {
      const response = await fetch(`/api/management/evidence/${encodeURIComponent(item.id)}`, { method: "DELETE" });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error || "The media could not be deleted.");
      setItems((current) => current.filter((candidate) => candidate.id !== item.id));
      setConfirming("");
      setMessage({ tone: "success", text: `${item.type === "photo" ? "Photo" : "Voice note"} deleted. The visit record remains available.` });
      router.refresh();
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "The media could not be deleted." });
    } finally {
      setBusy((current) => {
        const next = new Set(current);
        next.delete(item.id);
        return next;
      });
    }
  }

  return <section className="grid gap-5" aria-labelledby="media-retention-title">
    <div className="overflow-hidden rounded-[24px] border border-[#E9DFDA] bg-white shadow-[0_18px_48px_rgba(16,42,88,0.08)]">
      <div className="grid gap-5 bg-[radial-gradient(circle_at_88%_12%,rgba(31,199,255,0.2),transparent_28%),linear-gradient(125deg,#2D2729,#682238)] p-5 text-white sm:p-7 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-end">
        <div><p className="font-utility text-[10px] font-black uppercase tracking-[0.16em] text-[#F7B8CA]">Seven-day evidence window</p><h2 className="font-display mt-2 text-2xl font-black tracking-[-0.035em] sm:text-3xl" id="media-retention-title">Private media, kept only while it is useful.</h2><p className="mt-2 max-w-3xl leading-7 text-[#ECD7DD]">Photos and voice notes are deleted automatically {EVIDENCE_RETENTION_DAYS} days after capture. Visit outcomes, GPS checks, and audit history stay on record.</p></div>
        <div className="grid grid-cols-3 overflow-hidden rounded-2xl border border-white/15 bg-[#3D1E25]/35 text-center">
          <RetentionMetric label="Photos" value={photoCount} />
          <RetentionMetric label="Voice notes" value={audioCount} />
          <RetentionMetric label="Due in 24h" value={dueSoon} accent={dueSoon > 0} />
        </div>
      </div>
      <div className="flex flex-col gap-3 border-t border-[#E9DFDA] p-4 sm:flex-row sm:items-end sm:justify-between sm:p-5">
        <label className={`${ui.label} w-full sm:max-w-md`}>Find media<input className={ui.input} type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Outlet, salesperson, or file name" /></label>
        <p className="text-sm font-bold text-[#75686B]" aria-live="polite">{visible.length} of {items.length} retained files</p>
      </div>
    </div>

    {message && <p className={message.tone === "success" ? ui.messageSuccess : ui.messageError} role={message.tone === "error" ? "alert" : "status"}>{message.text}</p>}

    <div className="grid gap-4 xl:grid-cols-2">
      {visible.map((item) => {
        const retention = evidenceRetentionState(item.capturedAt, now);
        const isConfirming = confirming === item.id;
        const isBusy = busy.has(item.id);
        return <article className="grid overflow-hidden rounded-[22px] border border-[#E9DFDA] bg-white shadow-[0_10px_30px_rgba(16,42,88,0.055)] sm:grid-cols-[170px_minmax(0,1fr)]" key={item.id}>
          <div className="grid min-h-36 place-items-center bg-[#FFF4F7]">
            {item.type === "photo"
              ? <a className="h-full w-full" href={`/api/evidence/${item.fileId}`} target="_blank" rel="noreferrer"><img className="h-full min-h-36 w-full object-cover transition duration-200 hover:brightness-95" src={`/api/evidence/${item.fileId}`} alt={`Visit evidence for ${item.outletName}`} loading="lazy" /></a>
              : <div className="grid w-full gap-3 p-4"><span className="font-utility text-[10px] font-black uppercase tracking-[0.13em] text-[#CB183D]">Voice report</span><audio className="h-10 w-full" controls preload="none" src={`/api/evidence/${item.fileId}`}>Voice-note playback is unavailable.</audio></div>}
          </div>
          <div className="flex min-w-0 flex-col p-4 sm:p-5">
            <div><span className={`inline-flex rounded-full px-2.5 py-1 font-utility text-[9px] font-black uppercase tracking-[0.1em] ${item.type === "photo" ? "bg-[#E4F9F3] text-[#137458]" : "bg-[#FBE7ED] text-[#B41438]"}`}>{item.type === "photo" ? "Photo" : "Voice note"}</span><h3 className="font-display mt-2 truncate text-lg font-black tracking-[-0.025em] text-[#2D2729]" title={item.outletName}>{item.outletName}</h3><p className="mt-1 text-sm font-bold text-[#75686B]">{item.employeeName}</p></div>
            <dl className="mt-4 grid grid-cols-2 gap-3 border-y border-[#EEE4E0] py-3 text-xs"><div><dt className="font-utility text-[9px] uppercase tracking-[0.1em] text-[#75686B]">Captured</dt><dd className="mt-1 font-bold text-[#2D2729]">{formatDate(item.capturedAt)}</dd></div><div><dt className="font-utility text-[9px] uppercase tracking-[0.1em] text-[#75686B]">Auto-delete</dt><dd className={`mt-1 font-bold ${retention?.expired ? "text-[#B13F36]" : retention?.daysRemaining === 1 ? "text-[#9A6700]" : "text-[#2D2729]"}`}>{retention ? retention.expired ? "Cleanup due" : `${retention.daysRemaining} day${retention.daysRemaining === 1 ? "" : "s"}` : "Needs review"}</dd></div></dl>
            <div className="mt-auto pt-4">
              {!isConfirming
                ? <button type="button" className={ui.dangerButton} disabled={isBusy} onClick={() => { setConfirming(item.id); setMessage(null); }}>Delete now</button>
                : <div className="rounded-xl border border-[#F1B8B0] bg-[#FFF3F1] p-3"><strong className="text-sm text-[#8C302A]">Delete this {item.type === "photo" ? "photo" : "voice note"} permanently?</strong><p className="mt-1 text-xs leading-5 text-[#984B44]">Playback and preview will stop immediately. The visit record stays.</p><div className="mt-3 flex gap-2"><button type="button" className={ui.quietButton} disabled={isBusy} onClick={() => setConfirming("")}>Keep media</button><button type="button" className={ui.dangerButton} disabled={isBusy} onClick={() => void remove(item)}>{isBusy ? "Deleting…" : "Delete permanently"}</button></div></div>}
            </div>
          </div>
        </article>;
      })}
    </div>
    {visible.length === 0 && <div className="rounded-[22px] border border-dashed border-[#D8C6C8] bg-white px-6 py-10 text-center"><strong className="font-display text-xl text-[#2D2729]">{items.length ? "No media matches this search." : "No visit media is currently retained."}</strong><p className="mt-2 text-sm text-[#75686B]">{items.length ? "Try an outlet or salesperson name." : "New confirmed photos and voice notes will appear here during their seven-day window."}</p></div>}
  </section>;
}

function RetentionMetric({ label, value, accent = false }: { label: string; value: number; accent?: boolean }) {
  return <div className="min-w-24 border-r border-white/15 px-3 py-4 last:border-r-0"><b className={`font-display block text-2xl font-black ${accent ? "text-[#F7B8CA]" : "text-white"}`}>{value}</b><small className="mt-1 block whitespace-nowrap font-utility text-[8px] uppercase tracking-[0.08em] text-[#D6BFC4]">{label}</small></div>;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) return "Unknown";
  return date.toLocaleDateString("en-PK", { day: "numeric", month: "short", timeZone: "Asia/Karachi" });
}
