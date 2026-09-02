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
  return <main className="grid min-h-screen bg-[var(--canvas)] text-[var(--ink)] lg:grid-cols-2">
    <section className="flex bg-[linear-gradient(145deg,#B40E30,#C51B40_60%,#C92146)] p-7 text-white sm:p-12 lg:min-h-screen lg:p-16">
      <div className="flex w-full flex-col justify-between gap-12">
        <div className="flex items-center gap-3"><span className={ui.logo}><BrandMark className="h-full w-full" priority /></span><div><strong className="font-display block text-xl font-bold">FieldOPS</strong><small className="text-[#FFE2E9]">Yousuf Rice</small></div></div>
        <div className="max-w-lg"><p className="text-xs font-semibold uppercase tracking-[0.15em] text-[#FFE2E9]">Closer to your field team</p><h1 className="font-display my-5 text-[42px] font-bold leading-[1.05] tracking-[-0.035em] sm:text-6xl">A clearer view.<br />A better day in the field.</h1><p className="max-w-sm text-base leading-7 text-[#FFE8ED]">Visits, routes, and customer orders. One shared picture for your team and the office.</p></div>
        <div className="hidden gap-6 border-t border-white/25 pt-6 text-sm text-[#FFE8ED] sm:flex"><span>Visit reports</span><span>Team routes</span><span>Sales activity</span></div>
      </div>
    </section>
    <section className="grid place-items-center px-5 py-10 sm:p-12">
      <form aria-busy={busy} className="w-full max-w-[430px] rounded-[28px] border border-[var(--line)] bg-white p-6 shadow-[0_14px_60px_#64233208] sm:p-9" onSubmit={submit}>
        <BrandMark className="mb-6 h-16 w-16 rounded-2xl" />
        <p className={ui.eyebrow}>Management dashboard</p><h2 className="font-display mb-2 mt-3 text-[32px] font-bold tracking-tight">Welcome back</h2><p className={ui.lede}>Sign in to see how your team’s day is going.</p>
        <div className="my-7 grid gap-5"><label className={ui.label}>Work email<input className={ui.input} name="email" type="email" inputMode="email" autoComplete="username" autoCapitalize="none" autoCorrect="off" placeholder="you@company.com" required /></label><label className={ui.label}>Password<input className={ui.input} name="password" type="password" autoComplete="current-password" placeholder="Enter your password" required /></label></div>
        {error && <p className={ui.messageError} role="alert">{error}</p>}
        <button className={`${ui.button} my-3 w-full`} disabled={busy}>{busy ? "Signing in…" : "Sign in"}<span aria-hidden="true">→</span></button>
        <p className="mt-4 text-center text-xs leading-5 text-[var(--muted)]">For authorized administrators.<br />Salespeople can sign in through the FieldOPS app.</p>
      </form>
    </section>
  </main>;
}
