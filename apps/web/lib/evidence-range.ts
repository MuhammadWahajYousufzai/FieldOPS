export type EvidenceByteRange = { start: number; end: number };

export function parseEvidenceByteRange(value: string | null, size: number): EvidenceByteRange | "invalid" | null {
  if (!value) return null;
  const match = value.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || size <= 0) return "invalid";
  const startText = match[1] ?? "", endText = match[2] ?? "";
  if (!startText && !endText) return "invalid";
  if (!startText) {
    const suffix = Number(endText);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "invalid";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(startText);
  const requestedEnd = endText ? Number(endText) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || requestedEnd < start || start >= size) return "invalid";
  return { start, end: Math.min(requestedEnd, size - 1) };
}
