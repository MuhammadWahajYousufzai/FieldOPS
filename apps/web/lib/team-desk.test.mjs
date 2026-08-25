import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalJson,
  commandReceiptMatches,
  commandReceiptJson,
  dealCreateReplayMatches,
  messageReplayMatches,
  validateDealCommand,
  validateEmployeePhoneCommand,
  validateManagerContactCommand,
  validateMarkReadCommand,
  validateTeamMessageCommand,
} from "./team-desk.ts";

test("team messages require exact bounded content and a reusable-safe command key", () => {
  assert.equal(validateTeamMessageCommand({ idempotencyKey: "msg_1", body: "  Call me after the visit.  " }).ok, true);
  assert.equal(validateTeamMessageCommand({ idempotencyKey: "bad key", body: "Hello" }).ok, false);
  assert.equal(validateTeamMessageCommand({ idempotencyKey: "msg_2", body: "x".repeat(2_001) }).ok, false);
  assert.equal(validateTeamMessageCommand({ idempotencyKey: "msg_3", body: "   " }).ok, false);
  assert.equal(validateMarkReadCommand({ idempotencyKey: "read_1" }).ok, true);
  assert.equal(validateMarkReadCommand({ idempotencyKey: "read id" }).ok, false);
});

test("deal validation accepts the sales stages and rejects unsafe updates", () => {
  const version = "2026-08-25T08:00:00.000Z";
  for (const stage of ["lead", "qualified", "proposal", "negotiation", "won", "lost"]) {
    const result = validateDealCommand({
      action: "create",
      idempotencyKey: `deal_${stage}`,
      customerName: "Clifton Store",
      title: "Rice supply",
      stage,
      amount: 25_000,
    });
    assert.equal(result.ok, true, stage);
  }
  assert.equal(validateDealCommand({ action: "create", idempotencyKey: "deal_bad", customerName: "Shop", title: "Sale", stage: "maybe" }).ok, false);
  assert.equal(validateDealCommand({ action: "stage_update", idempotencyKey: "up_1", dealId: "deal_1", stage: "won", expectedUpdatedAt: version }).ok, true);
  assert.equal(validateDealCommand({ action: "stage_update", idempotencyKey: "up_without_version", dealId: "deal_1", stage: "won" }).ok, false);
  assert.equal(validateDealCommand({ action: "update", idempotencyKey: "up_2", dealId: "deal_1", amount: -1, expectedUpdatedAt: version }).ok, false);
  assert.equal(validateDealCommand({ action: "update", idempotencyKey: "up_3", dealId: "deal_1", expectedUpdatedAt: version }).ok, false);
  const blankAmount = validateDealCommand({ action: "create", idempotencyKey: "deal_blank", customerName: "Shop", title: "Sale", stage: "lead", amount: "   " });
  assert.equal(blankAmount.ok, true);
  if (blankAmount.ok && blankAmount.value.action === "create") assert.equal(blankAmount.value.amount, null);
});

test("message and deal create replays require the same employee and payload", () => {
  const message = {
    idempotency_key: "msg_1",
    employee_id: "emp_1",
    sender_role: "salesperson",
    sender_employee_id: "emp_1",
    body: "Need approval",
  };
  const expectedMessage = {
    idempotencyKey: "msg_1",
    employeeId: "emp_1",
    senderRole: "salesperson",
    senderEmployeeId: "emp_1",
    body: "Need approval",
  };
  assert.equal(messageReplayMatches(message, expectedMessage), true);
  assert.equal(messageReplayMatches(message, { ...expectedMessage, employeeId: "emp_2" }), false);
  assert.equal(messageReplayMatches(message, { ...expectedMessage, body: "Different" }), false);
  const managerExpected = { ...expectedMessage, senderRole: "manager", senderEmployeeId: null };
  assert.equal(messageReplayMatches({ ...message, sender_role: "manager", sender_employee_id: null }, managerExpected), true);
  assert.equal(messageReplayMatches({ ...message, sender_role: "manager", sender_employee_id: undefined }, managerExpected), true);
  assert.equal(messageReplayMatches({ ...message, sender_role: "manager", sender_employee_id: "legacy_manager_employee" }, managerExpected), false);

  const parsed = validateDealCommand({
    action: "create",
    idempotencyKey: "deal_1",
    customerName: "Clifton Store",
    title: "Rice supply",
    stage: "proposal",
    amount: 20_000,
    followUpAt: "2026-08-27T10:00:00+05:00",
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok || parsed.value.action !== "create") return;
  const row = {
    employee_id: "emp_1",
    idempotency_key: "deal_1",
    customer_name: "Clifton Store",
    title: "Rice supply",
    stage: "proposal",
    amount: 20_000,
    follow_up_at: "2026-08-27T05:00:00.000Z",
  };
  assert.equal(dealCreateReplayMatches(row, { ...parsed.value, employeeId: "emp_1" }), true);
  assert.equal(dealCreateReplayMatches(row, { ...parsed.value, employeeId: "emp_2" }), false);
});

test("update receipts replay only the exact actor, entity, and canonical command", () => {
  const command = { dealId: "deal_1", updates: { stage: "won", amount: 100 } };
  const row = {
    actor_user_id: "user_1",
    action: "sales.deal_updated",
    entity_type: "sales_deal",
    entity_id: "deal_1",
    after_json: canonicalJson({ command }),
  };
  assert.equal(commandReceiptMatches(row, {
    actorUserId: "user_1",
    action: "sales.deal_updated",
    entityType: "sales_deal",
    entityId: "deal_1",
    command: { updates: { amount: 100, stage: "won" }, dealId: "deal_1" },
  }), true);
  assert.equal(commandReceiptMatches(row, {
    actorUserId: "user_1",
    action: "sales.deal_updated",
    entityType: "sales_deal",
    entityId: "deal_1",
    command: { dealId: "deal_1", updates: { stage: "lost", amount: 100 } },
  }), false);
});

test("large commands use a bounded digest receipt without weakening replay checks", () => {
  const command = { dealId: "deal_1", updates: { notes: "x".repeat(16_000) } };
  const row = {
    actor_user_id: "user_1",
    action: "sales.deal_updated",
    entity_type: "sales_deal",
    entity_id: "deal_1",
    after_json: commandReceiptJson(command),
  };
  assert.ok(row.after_json.length < 1_000);
  assert.equal(commandReceiptMatches(row, {
    actorUserId: "user_1",
    action: "sales.deal_updated",
    entityType: "sales_deal",
    entityId: "deal_1",
    command,
  }), true);
  assert.equal(commandReceiptMatches(row, {
    actorUserId: "user_1",
    action: "sales.deal_updated",
    entityType: "sales_deal",
    entityId: "deal_1",
    command: { dealId: "deal_1", updates: { notes: `${"x".repeat(15_999)}y` } },
  }), false);
});

test("manager contact is single-organization contact data, not a tenant selector", () => {
  const expectedUpdatedAt = "2026-08-25T08:00:00.000Z";
  assert.equal(validateManagerContactCommand({ operationId: "contact_1", name: "Sales Manager", phone: "+92 300 1234567", expectedUpdatedAt }).ok, true);
  assert.equal(validateManagerContactCommand({ operationId: "contact_2", name: "Sales Manager", expectedUpdatedAt }).ok, false);
  assert.equal(validateManagerContactCommand({ operationId: "contact_3", name: "Sales Manager", phone: "invalid-number", expectedUpdatedAt }).ok, false);
  assert.equal(validateManagerContactCommand({ operationId: "contact_4", name: "Sales Manager", phone: "+92 300 1234567" }).ok, false);
});

test("salesperson call targets require an employee and a valid phone", () => {
  const expectedUpdatedAt = "2026-08-25T08:00:00.000Z";
  assert.equal(validateEmployeePhoneCommand({ operationId: "phone_1", employeeId: "emp_1", phone: "+92 300 7654321", expectedUpdatedAt }).ok, true);
  assert.equal(validateEmployeePhoneCommand({ operationId: "phone_2", employeeId: "emp_1", phone: "call-me", expectedUpdatedAt }).ok, false);
  assert.equal(validateEmployeePhoneCommand({ operationId: "phone_3", employeeId: "", phone: "+92 300 7654321", expectedUpdatedAt }).ok, false);
  assert.equal(validateEmployeePhoneCommand({ operationId: "phone_4", employeeId: "emp_1", phone: "-------", expectedUpdatedAt }).ok, false);
  assert.equal(validateEmployeePhoneCommand({ operationId: "phone_5", employeeId: "emp_1", phone: "+92 300 7654321" }).ok, false);
});
