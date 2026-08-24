// Keep every mobile request below the Appwrite Sites 60-second ceiling while
// allowing enough time for observed cold starts on the self-hosted server.
export const SERVER_REQUEST_TIMEOUT_MS = 50_000;

const DEFAULT_TIMEOUT_MESSAGE = "The server took too long to respond. Your work is safe on this phone and will retry automatically.";

type FetchTimeoutOptions = {
  timeoutMs?: number;
  timeoutMessage?: string;
};

export async function fetchWithTimeout(
  input: string,
  init: RequestInit = {},
  options: FetchTimeoutOptions = {},
) {
  const {
    timeoutMs = SERVER_REQUEST_TIMEOUT_MS,
    timeoutMessage = DEFAULT_TIMEOUT_MESSAGE,
  } = options;
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
