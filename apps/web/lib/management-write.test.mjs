import assert from "node:assert/strict";
import test from "node:test";
import {
  managementAuditIdentity,
  managementOperationKey,
  optimisticWriteDecision,
  removalLeavesUnrestricted,
  runManagementTransaction,
  runManagementTransactionWithRetry,
  stableManagementId,
} from "./management-write.ts";

test("stableManagementId is deterministic, distinct, and Appwrite-safe", () => {
  const first = stableManagementId("employee", "Ali@example.com");
  assert.equal(first, stableManagementId("employee", "Ali@example.com"));
  assert.notEqual(first, stableManagementId("employee", "other@example.com"));
  assert.match(first, /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}$/);
  assert.ok(first.length <= 36);
});

test("managementOperationKey keeps a valid client key and safely derives invalid keys", () => {
  assert.equal(managementOperationKey("manage_123", "fallback"), "manage_123");
  assert.equal(
    managementOperationKey("contains spaces", "fallback"),
    managementOperationKey(undefined, "fallback"),
  );
});

test("managementAuditIdentity gives a stable audit row and correlation", () => {
  const first = managementAuditIdentity("outlet.assigned", "out_1", "op_1");
  assert.deepEqual(first, managementAuditIdentity("outlet.assigned", "out_1", "op_1"));
  assert.notDeepEqual(first, managementAuditIdentity("outlet.assigned", "out_1", "op_2"));
  assert.ok(first.auditId.length <= 36);
  assert.ok(first.correlationId.length <= 36);
});

test("removalLeavesUnrestricted detects only the last active territory", () => {
  assert.equal(removalLeavesUnrestricted(["clifton"], "clifton"), true);
  assert.equal(removalLeavesUnrestricted(["clifton", "dha"], "clifton"), false);
  assert.equal(removalLeavesUnrestricted(["clifton", "clifton"], "clifton"), true);
});

test("optimisticWriteDecision accepts identical retries before rejecting stale versions", () => {
  assert.equal(optimisticWriteDecision("old", "new", true), "replay");
  assert.equal(optimisticWriteDecision("old", "new", false), "conflict");
  assert.equal(optimisticWriteDecision("same", "same", false), "write");
  assert.equal(optimisticWriteDecision("", "current", false), "write");
});

test("runManagementTransaction commits after successful work", async () => {
  const calls = [];
  const db = {
    createTransaction: async () => ({ $id: "tx_ok" }),
    updateTransaction: async (input) => { calls.push(input); },
  };
  const value = await runManagementTransaction(db, async (transactionId) => {
    assert.equal(transactionId, "tx_ok");
    return 42;
  });
  assert.equal(value, 42);
  assert.deepEqual(calls, [{ transactionId: "tx_ok", commit: true }]);
});

test("runManagementTransaction rolls back and preserves the original failure", async () => {
  const calls = [];
  const failure = new Error("write failed");
  const db = {
    createTransaction: async () => ({ $id: "tx_fail" }),
    updateTransaction: async (input) => { calls.push(input); },
  };
  await assert.rejects(
    runManagementTransaction(db, async () => { throw failure; }),
    (error) => error === failure,
  );
  assert.deepEqual(calls, [{ transactionId: "tx_fail", rollback: true }]);
});

test("runManagementTransactionWithRetry retries only Appwrite conflicts", async () => {
  const finalizations = [];
  let transactionNumber = 0;
  const db = {
    createTransaction: async () => ({ $id: `tx_${++transactionNumber}` }),
    updateTransaction: async (input) => {
      finalizations.push(input);
      if (input.commit && input.transactionId === "tx_1") throw { code: 409 };
    },
  };
  const attempts = [];
  const result = await runManagementTransactionWithRetry(db, async (transactionId, attempt) => {
    attempts.push({ transactionId, attempt });
    return "saved";
  });
  assert.equal(result, "saved");
  assert.deepEqual(attempts, [
    { transactionId: "tx_1", attempt: 1 },
    { transactionId: "tx_2", attempt: 2 },
  ]);
  assert.deepEqual(finalizations, [
    { transactionId: "tx_1", commit: true },
    { transactionId: "tx_1", rollback: true },
    { transactionId: "tx_2", commit: true },
  ]);
});
