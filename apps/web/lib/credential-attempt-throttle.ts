import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { Query, type TablesDB } from "node-appwrite";

export const CREDENTIAL_ATTEMPT_TABLE = "auth_attempt_windows";
export const CREDENTIAL_ATTEMPT_WINDOW_MS = 15 * 60 * 1_000;
export const EMAIL_NETWORK_ATTEMPT_LIMIT = 6;
export const EMAIL_GLOBAL_ATTEMPT_LIMIT = 20;

// At most two rows are created for a new email/network pair. Sampling a
// 12-row cleanup every four attempts drains expired rows faster than they
// can be created under sustained credential-stuffing traffic.
const CLEANUP_SAMPLE_DIVISOR = 4;
const CLEANUP_BATCH_SIZE = 12;
const HMAC_MINIMUM_BYTES = 32;

type CredentialAttemptDb = Pick<
  TablesDB,
  "createRow" | "incrementRowColumn" | "listRows" | "deleteRow"
>;

type HeaderReader = Pick<Headers, "get">;

export type CredentialAttemptScope = "email" | "email_network";

export type CredentialAttemptDecision = {
  allowed: boolean;
  blockedBy: CredentialAttemptScope | null;
  retryAfterSeconds: number;
  windowEndsAt: string;
  emailAttempts: number;
  emailNetworkAttempts: number | null;
};

export type ConsumeCredentialAttemptInput = {
  db: CredentialAttemptDb;
  databaseId: string;
  email: string;
  secret: string;
  headers?: HeaderReader;
  clientAddress?: string;
  now?: Date | number;
  cleanup?: "auto" | "always" | "never";
};

type CredentialAttemptBucket = {
  rowId: string;
  data: {
    scope: CredentialAttemptScope;
    window_started_at: string;
    expires_at: string;
    attempts: number;
  };
};

export class CredentialAttemptThrottleUnavailableError extends Error {
  readonly code = "credential_attempt_throttle_unavailable";

  constructor(cause?: unknown) {
    super("Credential attempt protection is temporarily unavailable.", { cause });
    this.name = "CredentialAttemptThrottleUnavailableError";
  }
}

export function normalizeCredentialEmail(email: string) {
  return email.trim().normalize("NFKC").toLowerCase();
}

export function fixedCredentialAttemptWindow(now: Date | number = Date.now()) {
  const timestamp = now instanceof Date ? now.valueOf() : now;
  if (!Number.isFinite(timestamp)) throw new TypeError("A valid throttle timestamp is required.");
  const startedAtMs = Math.floor(timestamp / CREDENTIAL_ATTEMPT_WINDOW_MS) * CREDENTIAL_ATTEMPT_WINDOW_MS;
  const expiresAtMs = startedAtMs + CREDENTIAL_ATTEMPT_WINDOW_MS;
  return {
    startedAtMs,
    expiresAtMs,
    startedAt: new Date(startedAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

export function clientNetworkForAddress(value: string | null | undefined) {
  const address = parseIpAddress(value);
  if (!address) return "unknown";

  if (isIP(address) === 4) {
    const octets = address.split(".").map(Number);
    return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
  }

  const embeddedIpv4 = address.includes(".") ? address.slice(address.lastIndexOf(":") + 1) : "";
  if (isIP(embeddedIpv4) === 4) return clientNetworkForAddress(embeddedIpv4);

  const groups = expandIpv6(address);
  if (!groups) return "unknown";
  return `${groups.slice(0, 4).map((group) => group.toString(16)).join(":")}::/64`;
}

export function clientNetworkFromHeaders(headers: HeaderReader) {
  for (const name of ["x-appwrite-user-ip", "cf-connecting-ip"]) {
    const address = parseIpAddress(headers.get(name));
    if (address) return clientNetworkForAddress(address);
  }

  const forwardedFor = headers.get("x-forwarded-for")
    ?.split(",")
    .map((part) => part.trim())
    .reverse() ?? [];
  for (const candidate of forwardedFor) {
    const address = parseIpAddress(candidate);
    if (address) return clientNetworkForAddress(address);
  }

  for (const name of ["x-real-ip", "true-client-ip"]) {
    const address = parseIpAddress(headers.get(name));
    if (address) return clientNetworkForAddress(address);
  }

  const forwarded = headers.get("forwarded")?.split(",").reverse() ?? [];
  for (const entry of forwarded) {
    const pair = entry.split(";").find((part) => part.trim().toLowerCase().startsWith("for="));
    const address = parseIpAddress(pair?.slice((pair.indexOf("=") + 1)));
    if (address) return clientNetworkForAddress(address);
  }

  return "unknown";
}

export function credentialAttemptBucket(input: {
  email: string;
  clientNetwork: string;
  scope: CredentialAttemptScope;
  secret: string;
  now?: Date | number;
}): CredentialAttemptBucket {
  const email = normalizeCredentialEmail(input.email);
  assertThrottleInputs(email, input.secret);
  const window = fixedCredentialAttemptWindow(input.now);
  const networkPart = input.scope === "email_network" ? input.clientNetwork : "all-networks";
  const digest = hmac(
    input.secret,
    ["fieldops-credential-attempt", "v1", input.scope, email, networkPart, window.startedAt].join("\u001f"),
  );
  const prefix = input.scope === "email" ? "ate" : "atn";

  return {
    rowId: `${prefix}_${digest.slice(0, 32)}`,
    data: {
      scope: input.scope,
      window_started_at: window.startedAt,
      expires_at: window.expiresAt,
      attempts: 1,
    },
  };
}

export async function consumeCredentialAttempt(
  input: ConsumeCredentialAttemptInput,
): Promise<CredentialAttemptDecision> {
  const email = normalizeCredentialEmail(input.email);
  assertThrottleInputs(email, input.secret);
  const nowMs = input.now instanceof Date ? input.now.valueOf() : (input.now ?? Date.now());
  const window = fixedCredentialAttemptWindow(nowMs);
  const clientNetwork = input.clientAddress
    ? clientNetworkForAddress(input.clientAddress)
    : input.headers
      ? clientNetworkFromHeaders(input.headers)
      : "unknown";
  const emailBucket = credentialAttemptBucket({
    email,
    clientNetwork,
    scope: "email",
    secret: input.secret,
    now: nowMs,
  });

  let emailAttempts: number;
  try {
    emailAttempts = await incrementCredentialAttemptBucket(
      input.db,
      input.databaseId,
      emailBucket,
    );
  } catch (error) {
    throw unavailable(error);
  }

  if (emailAttempts > EMAIL_GLOBAL_ATTEMPT_LIMIT) {
    await bestEffortCleanup(input, email, nowMs);
    return decision(false, "email", window.expiresAtMs, nowMs, emailAttempts, null);
  }

  const networkBucket = credentialAttemptBucket({
    email,
    clientNetwork,
    scope: "email_network",
    secret: input.secret,
    now: nowMs,
  });
  let emailNetworkAttempts: number;
  try {
    emailNetworkAttempts = await incrementCredentialAttemptBucket(
      input.db,
      input.databaseId,
      networkBucket,
    );
  } catch (error) {
    throw unavailable(error);
  }

  await bestEffortCleanup(input, email, nowMs);
  return decision(
    emailNetworkAttempts <= EMAIL_NETWORK_ATTEMPT_LIMIT,
    emailNetworkAttempts > EMAIL_NETWORK_ATTEMPT_LIMIT ? "email_network" : null,
    window.expiresAtMs,
    nowMs,
    emailAttempts,
    emailNetworkAttempts,
  );
}

export async function cleanupExpiredCredentialAttemptWindows(
  db: CredentialAttemptDb,
  databaseId: string,
  now: Date | number = Date.now(),
) {
  const nowMs = now instanceof Date ? now.valueOf() : now;
  const cutoff = new Date(nowMs - CREDENTIAL_ATTEMPT_WINDOW_MS).toISOString();
  const expired = await db.listRows({
    databaseId,
    tableId: CREDENTIAL_ATTEMPT_TABLE,
    queries: [
      Query.lessThanEqual("expires_at", cutoff),
      Query.orderAsc("expires_at"),
      Query.limit(CLEANUP_BATCH_SIZE),
    ],
    total: false,
  });

  const deleted = await Promise.all(expired.rows.map(async (row) => {
    try {
      await db.deleteRow({ databaseId, tableId: CREDENTIAL_ATTEMPT_TABLE, rowId: row.$id });
      return 1;
    } catch (error) {
      if (appwriteErrorCode(error) === 404) return 0;
      throw error;
    }
  }));
  return deleted.reduce<number>((total, value) => total + value, 0);
}

async function incrementCredentialAttemptBucket(
  db: CredentialAttemptDb,
  databaseId: string,
  bucket: CredentialAttemptBucket,
) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const created = await db.createRow({
        databaseId,
        tableId: CREDENTIAL_ATTEMPT_TABLE,
        rowId: bucket.rowId,
        data: bucket.data,
        permissions: [],
      });
      return positiveAttemptCount(created.attempts);
    } catch (error) {
      if (appwriteErrorCode(error) !== 409) throw error;
    }

    try {
      const incremented = await db.incrementRowColumn({
        databaseId,
        tableId: CREDENTIAL_ATTEMPT_TABLE,
        rowId: bucket.rowId,
        column: "attempts",
        value: 1,
      });
      return positiveAttemptCount(incremented.attempts);
    } catch (error) {
      if (appwriteErrorCode(error) !== 404) throw error;
    }
  }
  throw new Error("Credential attempt counter could not be allocated atomically.");
}

async function bestEffortCleanup(
  input: ConsumeCredentialAttemptInput,
  email: string,
  nowMs: number,
) {
  const mode = input.cleanup ?? "auto";
  if (mode === "never") return;
  const sampled = Number.parseInt(hmac(input.secret, `cleanup\u001f${email}\u001f${fixedCredentialAttemptWindow(nowMs).startedAt}`).slice(0, 8), 16)
    % CLEANUP_SAMPLE_DIVISOR === 0;
  if (mode !== "always" && !sampled) return;
  try {
    await cleanupExpiredCredentialAttemptWindows(input.db, input.databaseId, nowMs);
  } catch {
    // Counter writes already succeeded. Cleanup is deliberately best-effort and bounded.
  }
}

function decision(
  allowed: boolean,
  blockedBy: CredentialAttemptScope | null,
  expiresAtMs: number,
  nowMs: number,
  emailAttempts: number,
  emailNetworkAttempts: number | null,
): CredentialAttemptDecision {
  return {
    allowed,
    blockedBy,
    retryAfterSeconds: Math.max(1, Math.ceil((expiresAtMs - nowMs) / 1_000)),
    windowEndsAt: new Date(expiresAtMs).toISOString(),
    emailAttempts,
    emailNetworkAttempts,
  };
}

function assertThrottleInputs(email: string, secret: string) {
  if (!email || email.length > 320) throw new TypeError("A normalized credential email is required.");
  if (Buffer.byteLength(secret, "utf8") < HMAC_MINIMUM_BYTES) {
    throw new CredentialAttemptThrottleUnavailableError(
      new Error("AUTH_RATE_LIMIT_HMAC_SECRET or APPWRITE_API_KEY must contain at least 32 bytes."),
    );
  }
}

function unavailable(error: unknown) {
  return error instanceof CredentialAttemptThrottleUnavailableError
    ? error
    : new CredentialAttemptThrottleUnavailableError(error);
}

function positiveAttemptCount(value: unknown) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error("Credential attempt counter returned an invalid value.");
  }
  return count;
}

function appwriteErrorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error
    ? Number(error.code)
    : 0;
}

function hmac(secret: string, value: string) {
  return createHmac("sha256", secret).update(value).digest("hex");
}

function parseIpAddress(value: string | null | undefined) {
  if (!value) return null;
  let candidate = value.trim().replace(/^for=/i, "").replace(/^"|"$/g, "");
  if (!candidate || candidate.toLowerCase() === "unknown" || candidate.startsWith("_")) return null;

  if (candidate.startsWith("[")) {
    const closing = candidate.indexOf("]");
    if (closing > 0) candidate = candidate.slice(1, closing);
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(candidate)) {
    candidate = candidate.slice(0, candidate.lastIndexOf(":"));
  }

  candidate = candidate.split("%")[0] ?? candidate;
  return isIP(candidate) ? candidate.toLowerCase() : null;
}

function expandIpv6(value: string) {
  let address = value.toLowerCase();
  if (address.includes(".")) {
    const lastColon = address.lastIndexOf(":");
    const ipv4 = address.slice(lastColon + 1).split(".").map(Number);
    if (ipv4.length !== 4 || ipv4.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    address = `${address.slice(0, lastColon)}:${((ipv4[0] ?? 0) * 256 + (ipv4[1] ?? 0)).toString(16)}:${((ipv4[2] ?? 0) * 256 + (ipv4[3] ?? 0)).toString(16)}`;
  }

  const halves = address.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const values = [...left, ...Array.from({ length: missing }, () => "0"), ...right]
    .map((group) => Number.parseInt(group, 16));
  return values.length === 8 && values.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff)
    ? values
    : null;
}
