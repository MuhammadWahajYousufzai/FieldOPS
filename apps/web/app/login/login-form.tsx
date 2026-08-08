"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

export function LoginForm() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const data = new FormData(event.currentTarget);
    const response = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: data.get("email"), password: data.get("password") }) });
    const body = await response.json(); setBusy(false);
    if (!response.ok) { setError(body.error); return; }
    router.replace("/"); router.refresh();
  }
  return <main className="auth-page">
    <section className="auth-story"><div className="brand"><span className="grain">YR</span><div><strong>Yousuf Rice FieldOps</strong><small>Karachi operations</small></div></div><div><p className="eyebrow">One operating picture</p><h1>From market visit to delivered bag.</h1><p>Coordinate representatives, outlets, evidence and sales results without losing work when the signal drops.</p></div><small>Authorized executives and managers only</small></section>
    <section className="auth-form"><form onSubmit={submit}><p className="eyebrow">Management access</p><h2>Sign in to FieldOps</h2><label>Email<input name="email" type="email" autoComplete="email" required /></label><label>Password<input name="password" type="password" autoComplete="current-password" required /></label>{error && <p className="form-error" role="alert">{error}</p>}<button disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button><small className="security-note">Accounts are created by management. Activity is recorded against the signed-in account.</small></form></section>
  </main>;
}
