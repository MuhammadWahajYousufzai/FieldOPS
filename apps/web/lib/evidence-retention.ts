export const EVIDENCE_RETENTION_DAYS = 7;
export const EVIDENCE_RETENTION_MS = EVIDENCE_RETENTION_DAYS * 24 * 60 * 60 * 1_000;

export type EvidenceRetentionState = {
  capturedAt: string;
  expiresAt: string;
  expired: boolean;
  daysRemaining: number;
};

export function evidenceRetentionState(capturedAt: string, now = new Date()): EvidenceRetentionState | null {
  const capturedMs = Date.parse(capturedAt);
  if (!Number.isFinite(capturedMs)) return null;
  const expiresMs = capturedMs + EVIDENCE_RETENTION_MS;
  return {
    capturedAt: new Date(capturedMs).toISOString(),
    expiresAt: new Date(expiresMs).toISOString(),
    expired: expiresMs <= now.valueOf(),
    daysRemaining: Math.max(0, Math.ceil((expiresMs - now.valueOf()) / (24 * 60 * 60 * 1_000))),
  };
}

export function evidenceRetentionCutoff(now = new Date()) {
  return new Date(now.valueOf() - EVIDENCE_RETENTION_MS).toISOString();
}

export function isAppwriteNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && Number((error as { code?: unknown }).code) === 404);
}
