"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
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
  return <main className="grid min-h-screen bg-slate-50 text-[#14213D] lg:grid-cols-[minmax(320px,.9fr)_minmax(430px,1.1fr)]">
    <section className="flex min-h-[340px] flex-col justify-between bg-[#14213D] p-8 text-white sm:p-12 lg:p-[clamp(48px,5vw,76px)]"><div className="flex items-center gap-3"><span className={ui.logo}>YR</span><div><strong className="block text-sm">Yousuf Rice FieldOps</strong><small className="mt-1 block text-slate-400">Karachi operations</small></div></div><div><p className="text-[11px] font-black uppercase tracking-[0.13em] text-slate-400">One operating picture</p><h1 className="my-3 max-w-2xl text-4xl font-black leading-none tracking-[-0.045em] sm:text-6xl">From market visit to delivered bag.</h1><p className="max-w-xl leading-7 text-slate-300">Coordinate representatives, outlets, evidence and sales results without losing work when the signal drops.</p></div><small className="text-slate-400">Appwrite admin accounts only</small></section>
    <section className="grid place-items-center bg-white p-6 sm:p-10"><form aria-busy={busy} className="w-full max-w-md" onSubmit={submit}><p className={ui.eyebrow}>Admin access</p><h2 className="my-3 text-3xl font-black tracking-tight">Sign in to FieldOps</h2><div className="my-5 grid gap-4"><label className={ui.label}>Appwrite email<input className={ui.input} name="email" type="email" inputMode="email" autoComplete="username" autoCapitalize="none" autoCorrect="off" placeholder="management@sherazwaqar.tech" autoFocus required /></label><label className={ui.label}>Password<input className={ui.input} name="password" type="password" autoComplete="current-password" required /></label></div>{error && <p className={ui.messageError} role="alert">{error}</p>}<button className={`${ui.button} my-4 w-full`} disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button><small className="block text-center leading-5 text-slate-500">Appwrite verifies your login. The dashboard then checks only for the exact server-side <code>admin</code> label on that account.</small></form></section>
  </main>;
}
