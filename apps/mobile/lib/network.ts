export const JSON_REQUEST_TIMEOUT_MS = 12_000;
export const EVIDENCE_UPLOAD_TIMEOUT_MS = 27_000;

export async function fetchWithTimeout(
  input: string,
  init: RequestInit = {},
  timeoutMs = JSON_REQUEST_TIMEOUT_MS,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("The server took too long to respond. Your work is safe on this phone and will retry automatically.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
