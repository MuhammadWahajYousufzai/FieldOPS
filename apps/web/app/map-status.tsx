"use client";

export function MapStatus({ ready, error, retry }: { ready: boolean; error: string; retry: () => void }) {
  if (ready && !error) return null;
  return <div className={`${ready ? "absolute bottom-12 left-3 right-3 rounded-lg" : "absolute inset-0 grid place-content-center"} z-10 bg-white/95 p-5 text-center text-sm text-[#53647F]`} role="status">
    <p className="font-bold">{error || "Loading vector map…"}</p>
    {error && <button type="button" className="mt-3 rounded-lg bg-[#5269FF] px-4 py-2 font-bold text-white" onClick={retry}>Retry map</button>}
  </div>;
}
