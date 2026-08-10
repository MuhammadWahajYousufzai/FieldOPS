"use client";

import { useEffect } from "react";

export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error("FieldOPS dashboard error", error); }, [error]);
  return <main className="error-page"><section><span className="grain">YR</span><p className="eyebrow">Dashboard needs attention</p><h1>The field record could not be loaded.</h1><p>Retry the request. If it continues, check that the latest Appwrite migration is complete; no field data is deleted by this screen.</p>{error.digest && <small>Reference {error.digest}</small>}<div className="actions"><button onClick={reset}>Retry dashboard</button><a className="button-link quiet-button" href="/login">Return to sign in</a></div></section></main>;
}
