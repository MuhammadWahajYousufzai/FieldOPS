"use client";

import { useEffect } from "react";
import { ui } from "./ui";
import { BrandMark } from "./brand-mark";

export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error("FieldOPS dashboard error", error); }, [error]);
  return <main className="grid min-h-screen place-items-center bg-slate-50 p-6"><section className={`${ui.card} max-w-2xl`}><span className={`${ui.logo} mb-7`}><BrandMark className="h-full w-full" /></span><p className={ui.eyebrow}>Dashboard needs attention</p><h1 className={ui.h1}>The field record could not be loaded.</h1><p className="leading-7 text-slate-600">Retry the request. If it continues, check that the latest Appwrite migration is complete; no field data is deleted by this screen.</p>{error.digest && <small className="my-4 block text-slate-500">Reference {error.digest}</small>}<div className="mt-5 flex flex-wrap gap-3"><button className={ui.button} onClick={reset}>Retry dashboard</button><a className={ui.quietButton} href="/login">Return to sign in</a></div></section></main>;
}
