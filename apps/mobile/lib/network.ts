export const JSON_REQUEST_TIMEOUT_MS = 12_000;
// Appwrite Sites cold starts have been observed above 20 seconds. Authentication
// is not retried automatically because the server may already have created a
// session before the client times out.
export const AUTH_REQUEST_TIMEOUT_MS = 45_000;
// Evidence requests can contain both a field photo and an audio note. Give
// slower mobile connections enough time while still finishing before the
// 60-second Appwrite Sites request limit.
export const EVIDENCE_UPLOAD_TIMEOUT_MS = 55_000;

const DEFAULT_TIMEOUT_MESSAGE = "The server took too long to respond. Your work is safe on this phone and will retry automatically.";

export async function fetchWithTimeout(
  input: string,
  init: RequestInit = {},
  timeoutMs = JSON_REQUEST_TIMEOUT_MS,
  timeoutMessage = DEFAULT_TIMEOUT_MESSAGE,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    // Expo's native fetch rejects an aborted iOS request with a wrapped
    // FetchRequestCanceledException instead of the browser-standard
    // AbortError. The signal is the reliable source of truth because this
    // controller is owned exclusively by the timeout above.
    if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw new Error(timeoutMessage);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
