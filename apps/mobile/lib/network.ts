// Keep every mobile request below the Appwrite Sites 60-second ceiling while
// allowing enough time for observed cold starts on the self-hosted server.
export const SERVER_REQUEST_TIMEOUT_MS = 50_000;

const DEFAULT_TIMEOUT_MESSAGE = "The server took too long to respond. Your work is safe on this phone and will retry automatically.";

type FetchTimeoutOptions = {
  timeoutMs?: number;
  timeoutMessage?: string;
};

export function retryAfterDelayMs(
  value: string | null | undefined,
  nowMs = Date.now(),
  maximumMs = 15 * 60_000,
) {
  if (!value) return undefined;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds)
    ? Math.max(0, seconds * 1_000)
    : Math.max(0, new Date(value).valueOf() - nowMs);
  if (!Number.isFinite(delay)) return undefined;
  return Math.min(Math.max(0, maximumMs), Math.round(delay));
}

export async function fetchWithTimeout(
  input: string,
  init: RequestInit = {},
  options: FetchTimeoutOptions = {},
) {
  const {
    timeoutMs = SERVER_REQUEST_TIMEOUT_MS,
    timeoutMessage = DEFAULT_TIMEOUT_MESSAGE,
  } = options;
  const upstreamSignal = init.signal;
  const controller = new AbortController();
  let timedOut = false;
  const relayAbort = () => controller.abort(upstreamSignal?.reason);
  if (upstreamSignal?.aborted) relayAbort();
  else upstreamSignal?.addEventListener("abort", relayAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(0, timeoutMs));
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    // Expo's native fetch rejects an aborted iOS request with a wrapped
    // FetchRequestCanceledException instead of the browser-standard
    // AbortError. The signal is the reliable source of truth because this
    // controller is owned exclusively by the timeout above.
    if (timedOut || (!upstreamSignal && error instanceof Error && error.name === "AbortError")) {
      throw new Error(timeoutMessage);
    }
    if (upstreamSignal?.aborted && upstreamSignal.reason instanceof Error) throw upstreamSignal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    upstreamSignal?.removeEventListener("abort", relayAbort);
  }
}
