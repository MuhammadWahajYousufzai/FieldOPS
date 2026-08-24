import assert from "node:assert/strict";
import test from "node:test";

import { fetchWithTimeout } from "./network.ts";

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
    fetchWithTimeout("https://example.invalid", {}, 1, "Friendly timeout message."),
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
    fetchWithTimeout("https://example.invalid", {}, 1_000),
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
    fetchWithTimeout("https://example.invalid", {}, 1_000, "Friendly timeout message."),
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

  const response = await fetchWithTimeout("https://example.invalid", {}, 1);
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(response.status, 204);
  assert.equal(requestSignal.aborted, false);
});
