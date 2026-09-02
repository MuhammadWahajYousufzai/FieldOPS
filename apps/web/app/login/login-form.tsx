"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { BrandMark } from "../brand-mark";
import { ui } from "../ui";

export function LoginForm() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/session", { cache: "no-store" })
      .then((r) => r.json())
      .then((b) => { if (!cancelled && b.user) router.replace("/"); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [router]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const data = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: data.get("email"), password: data.get("password") }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) {
        setError(body.error || "Sign in could not be completed.");
        return;
      }
      router.replace("/"); router.refresh();
    } catch {
      setError("Could not reach FieldOPS. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }
  return <main className="grid min-h-screen bg-[#F5F7FF] text-[#102A58] lg:grid-cols-[minmax(360px,.95fr)_minmax(430px,1.05fr)]">
    <section className="relative flex min-h-[390px] overflow-hidden bg-[radial-gradient(circle_at_78%_16%,rgba(31,199,255,0.35),transparent_24%),linear-gradient(145deg,#102A58_0%,#1B3167_62%,#213B7D_100%)] p-8 text-white sm:p-12 lg:min-h-screen lg:p-[clamp(48px,5vw,78px)]">
      <div className="relative z-10 flex w-full flex-col justify-between gap-14">
        <div className="flex items-center gap-3"><span className={ui.logo}><BrandMark className="h-full w-full" priority /></span><div><strong className="font-display block text-base tracking-[-0.02em]">Yousuf Rice FieldOPS</strong><small className="mt-1 flex items-center gap-1.5 text-[#C5D2EA]"><span className="h-1.5 w-1.5 rounded-full bg-[#55E6C1]" />Karachi operations</small></div></div>
        <div><p className="font-utility text-[10px] font-black uppercase tracking-[0.18em] text-[#88EEFF]">The route from promise to proof</p><h1 className="font-display my-4 max-w-2xl text-4xl font-black leading-[0.96] tracking-[-0.055em] sm:text-6xl">See the field clearly.<br /><span className="text-[#FFE36B]">Act while it matters.</span></h1><p className="max-w-xl leading-7 text-[#C9D5EA]">Coordinate visits, verified evidence, outlets, and sales results—even when the signal is unreliable.</p></div>
        <small className="font-utility text-[10px] uppercase tracking-[0.12em] text-[#92A4C4]">Private administrator access</small>
      </div>
      <div className="absolute -bottom-28 -right-24 h-72 w-72 rounded-full border-[42px] border-[#55E6C1]/15" aria-hidden="true" />
    </section>
    <section className="grid place-items-center p-6 sm:p-10"><form aria-busy={busy} className="w-full max-w-md rounded-[28px] border border-[#DCE4F2] bg-white p-6 shadow-[0_22px_70px_rgba(16,42,88,0.10)] sm:p-9" onSubmit={submit}><p className={ui.eyebrow}>Management control room</p><h2 className="font-display my-3 text-3xl font-black tracking-[-0.035em]">Welcome back</h2><p className="text-sm leading-6 text-[#60708C]">Use your administrator account to open today’s operating picture.</p><div className="my-6 grid gap-4"><label className={ui.label}>Work email<input className={ui.input} name="email" type="email" inputMode="email" autoComplete="username" autoCapitalize="none" autoCorrect="off" placeholder="you@company.com" autoFocus required /></label><label className={ui.label}>Password<input className={ui.input} name="password" type="password" autoComplete="current-password" required /></label></div>{error && <p className={ui.messageError} role="alert">{error}</p>}<button className={`${ui.button} my-4 w-full`} disabled={busy}>{busy ? "Opening control room…" : "Open control room"}</button><small className="block text-center leading-5 text-[#71809A]">Access is limited to accounts carrying the protected server-side admin label.</small></form></section>
  </main>;
}
