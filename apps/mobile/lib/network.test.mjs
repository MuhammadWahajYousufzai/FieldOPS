import assert from "node:assert/strict";
import test from "node:test";

import { fetchWithTimeout, retryAfterDelayMs } from "./network.ts";

test("fetchWithTimeout translates Expo's native cancellation into the supplied timeout message", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = (_input, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => {
      reject(new Error("fetch failed: FetchRequestCanceledException: Fetch request has been canceled (at Expo/NativeResponse.swift:63)"));
    }, { once: true });
  });

  await assert.rejects(
    fetchWithTimeout("https://example.invalid", {}, { timeoutMs: 1, timeoutMessage: "Friendly timeout message." }),
    (error) => error instanceof Error && error.message === "Friendly timeout message.",
  );
});

test("fetchWithTimeout preserves non-timeout network errors", async (t) => {
  const originalFetch = globalThis.fetch;
  const networkError = new TypeError("Network request failed");
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => {
    throw networkError;
  };

  await assert.rejects(
    fetchWithTimeout("https://example.invalid", {}, { timeoutMs: 1_000 }),
    (error) => error === networkError,
  );
});

test("fetchWithTimeout still recognizes the standard AbortError shape", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => {
    throw new DOMException("The operation was aborted.", "AbortError");
  };

  await assert.rejects(
    fetchWithTimeout("https://example.invalid", {}, { timeoutMs: 1_000, timeoutMessage: "Friendly timeout message." }),
    (error) => error instanceof Error && error.message === "Friendly timeout message.",
  );
});

test("fetchWithTimeout clears its timer after a successful response", async (t) => {
  const originalFetch = globalThis.fetch;
  let requestSignal;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (_input, init) => {
    requestSignal = init.signal;
    return new Response(null, { status: 204 });
  };

  const response = await fetchWithTimeout("https://example.invalid", {}, { timeoutMs: 1 });
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(response.status, 204);
  assert.equal(requestSignal.aborted, false);
});

test("fetchWithTimeout preserves an explicit caller cancellation", async (t) => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  const cancellation = new Error("screen closed");
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = (_input, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new Error("native cancellation")), { once: true });
  });

  const request = fetchWithTimeout("https://example.invalid", { signal: controller.signal }, {
    timeoutMs: 1_000,
    timeoutMessage: "This was not a timeout.",
  });
  controller.abort(cancellation);
  await assert.rejects(request, (error) => error === cancellation);
});

test("retryAfterDelayMs supports delta seconds and HTTP dates with a safety cap", () => {
  const now = new Date("2026-08-25T10:00:00.000Z").valueOf();
  assert.equal(retryAfterDelayMs("12", now), 12_000);
  assert.equal(retryAfterDelayMs("Tue, 25 Aug 2026 10:00:30 GMT", now), 30_000);
  assert.equal(retryAfterDelayMs("not-a-date", now), undefined);
  assert.equal(retryAfterDelayMs("3600", now, 60_000), 60_000);
});
