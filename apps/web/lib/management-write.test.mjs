import assert from "node:assert/strict";
import test from "node:test";
import {
  managementAuditIdentity,
  managementOperationKey,
  optimisticWriteDecision,
  removalLeavesUnrestricted,
  runManagementTransaction,
  runManagementTransactionWithRetry,
  salesAreaDeletionAssignmentPlan,
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

test("sales area deletion ends only active target assignments and preserves otherwise-lost roles", () => {
  const at = "2026-08-31T12:00:00.000Z";
  const result = salesAreaDeletionAssignmentPlan([
    { $id: "sales_target", employee_id: "sales_1", role_id: "sales", territory_id: "area_old", effective_from: "2026-01-01T00:00:00.000Z" },
    { $id: "manager_target", employee_id: "manager_1", role_id: "manager", territory_id: "area_old", effective_from: "2026-01-01T00:00:00.000Z" },
    { $id: "multi_target", employee_id: "sales_2", role_id: "sales", territory_id: "area_old", effective_from: "2026-01-01T00:00:00.000Z" },
    { $id: "multi_other", employee_id: "sales_2", role_id: "sales", territory_id: "area_other", effective_from: "2026-01-01T00:00:00.000Z" },
    { $id: "role_only_target", employee_id: "sales_3", role_id: "sales", territory_id: "area_old", effective_from: "2026-01-01T00:00:00.000Z" },
    { $id: "role_only", employee_id: "sales_3", role_id: "sales", effective_from: "2026-01-01T00:00:00.000Z" },
    { $id: "expired", employee_id: "sales_4", role_id: "sales", territory_id: "area_old", effective_from: "2026-01-01T00:00:00.000Z", effective_to: "2026-08-01T00:00:00.000Z" },
  ], "area_old", at);

  assert.deepEqual(result.targetAssignments.map((assignment) => assignment.$id), [
    "sales_target", "manager_target", "multi_target", "role_only_target",
  ]);
  assert.deepEqual(result.rolesToRetain, [
    { employeeId: "sales_1", roleId: "sales" },
    { employeeId: "manager_1", roleId: "manager" },
  ]);
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
