export type NetworkSyncMode = "none" | "normal" | "force";

/**
 * A newly available connection must bypass retry backoff left by an earlier
 * offline attempt. Repeated online notifications keep the normal backoff so a
 * server outage cannot create a request storm.
 */
export function networkSyncMode(previousOnline: boolean | null, online: boolean): NetworkSyncMode {
  if (!online) return "none";
  return previousOnline === true ? "normal" : "force";
}

/** Unknown connectivity is worth one best-effort attempt; known offline work
 * stays safely pending until NetInfo reports a usable connection. */
export function shouldAttemptImmediateUpload(online: boolean | null) {
  return online !== false;
}
