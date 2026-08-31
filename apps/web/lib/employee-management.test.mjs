import assert from "node:assert/strict";
import test from "node:test";

import {
  EMPLOYEE_OPERATIONAL_DEPENDENCIES,
  assignmentIsEffective,
  employeeAuditReceiptJson,
  employeeAuditReceiptMatches,
  employeeAuditReceiptResult,
  employeeCommandForAudit,
  employeeDeletionConfirmationLabel,
  employeeDeletionConfirmationMatches,
  employeeMutationDecision,
  employeeProfileMatches,
  employeeStatusMatches,
  hasEffectiveSalespersonAssignment,
  hasProtectedAdminIdentity,
  summarizeEmployeeDependencies,
  validEmployeeId,
  validateEmployeeDelete,
  validateEmployeeMutation,
} from "./employee-management.ts";

const version = "2026-08-26T09:30:00.000Z";

test("profile validation normalizes identity fields and permits clearing an optional phone", () => {
  const valid = validateEmployeeMutation({
    action: "profile",
    operationId: "profile_01",
    expectedUpdatedAt: version,
    name: "  Ayesha Khan  ",
    email: "  AYESHA@Example.COM ",
    phone: "+92 (300) 123-4567",
  });
  assert.deepEqual(valid, {
    ok: true,
    value: {
      action: "profile",
      operationId: "profile_01",
      expectedUpdatedAt: version,
      expectedAuthUpdatedAt: "",
      name: "Ayesha Khan",
      email: "ayesha@example.com",
      phone: "+92 (300) 123-4567",
    },
  });

  const cleared = validateEmployeeMutation({
    action: "profile",
    operationId: "profile_02",
    expectedUpdatedAt: version,
    name: "Ayesha Khan",
    email: "ayesha@example.com",
    phone: "   ",
  });
  assert.equal(cleared.ok, true);
  if (cleared.ok && cleared.value.action === "profile") assert.equal(cleared.value.phone, "");
});

test("profile validation rejects malformed or over-broad identity input", () => {
  for (const input of [
    { name: "", email: "ayesha@example.com", phone: "+923001234567" },
    { name: "Ayesha", email: "not-an-email", phone: "+923001234567" },
    { name: "Ayesha", email: "ayesha@example.com", phone: "call-me" },
    { name: "Ayesha", email: "ayesha@example.com", phone: "+1234567890123456" },
  ]) {
    assert.equal(validateEmployeeMutation({
      action: "profile",
      operationId: "profile_bad",
      expectedUpdatedAt: version,
      ...input,
    }).ok, false);
  }
});

test("password validation preserves the exact secret but enforces Appwrite bounds", () => {
  const password = "  p@ss word  ";
  const valid = validateEmployeeMutation({ action: "password", operationId: "password_01", expectedUpdatedAt: version, password });
  assert.equal(valid.ok, true);
  if (valid.ok && valid.value.action === "password") assert.equal(valid.value.password, password);

  assert.equal(validateEmployeeMutation({ action: "password", operationId: "short", expectedUpdatedAt: version, password: "1234567" }).ok, false);
  assert.equal(validateEmployeeMutation({ action: "password", operationId: "blank", expectedUpdatedAt: version, password: "        " }).ok, false);
  assert.equal(validateEmployeeMutation({ action: "password", operationId: "long", expectedUpdatedAt: version, password: "x".repeat(257) }).ok, false);
});

test("status mutations accept only explicit lifecycle states", () => {
  for (const status of ["active", "inactive"]) {
    const result = validateEmployeeMutation({ action: "status", operationId: `status_${status}`, expectedUpdatedAt: version, status });
    assert.equal(result.ok, true, status);
  }
  assert.equal(validateEmployeeMutation({ action: "status", operationId: "status_bad", expectedUpdatedAt: version, status: "deleted" }).ok, false);
  assert.equal(validateEmployeeMutation({ action: "unknown", operationId: "unknown", expectedUpdatedAt: version }).ok, false);
});

test("every mutation and deletion requires a bounded operation ID and fresh version", () => {
  assert.equal(validateEmployeeMutation({ action: "status", operationId: "bad key", expectedUpdatedAt: version, status: "active" }).ok, false);
  assert.equal(validateEmployeeMutation({ action: "status", operationId: "status_01", expectedUpdatedAt: "not-a-date", status: "active" }).ok, false);
  assert.equal(validateEmployeeDelete({ operationId: "delete_01", expectedUpdatedAt: version, confirmationEmail: " user@example.com " }).ok, true);
  assert.equal(validateEmployeeDelete({ operationId: "delete_01", expectedUpdatedAt: version, expectedAuthUpdatedAt: "invalid", confirmationEmail: "user@example.com" }).ok, false);
  assert.equal(validateEmployeeDelete({ operationId: "delete_01", expectedUpdatedAt: version, confirmationEmail: " " }).ok, false);
  assert.equal(validateEmployeeDelete({ operationId: "delete key", expectedUpdatedAt: version, confirmationEmail: "user@example.com" }).ok, false);
});

test("employee IDs use Appwrite's safe identifier shape", () => {
  assert.equal(validEmployeeId("emp_123.test-ok"), true);
  assert.equal(validEmployeeId("_starts-special"), false);
  assert.equal(validEmployeeId("x".repeat(37)), false);
  assert.equal(validEmployeeId("contains space"), false);
});

test("protected identity detection requires the exact admin label", () => {
  assert.equal(hasProtectedAdminIdentity({ labels: ["admin"] }), true);
  assert.equal(hasProtectedAdminIdentity({ labels: ["sales_person", "admin"] }), true);
  assert.equal(hasProtectedAdminIdentity({ labels: ["Admin", "administrator"] }), false);
  assert.equal(hasProtectedAdminIdentity({ labels: "admin" }), false);
  assert.equal(hasProtectedAdminIdentity(null), false);
});

test("deletion confirmation uses Auth email, or exact employee name when Auth is missing", () => {
  assert.equal(employeeDeletionConfirmationMatches({
    confirmation: "  AYESHA@example.com ",
    authEmail: "ayesha@example.com",
    displayName: "Ayesha Khan",
  }), true);
  assert.equal(employeeDeletionConfirmationMatches({
    confirmation: "Ayesha Khan",
    authEmail: "ayesha@example.com",
    displayName: "Ayesha Khan",
  }), false);
  assert.equal(employeeDeletionConfirmationMatches({ confirmation: " ayesha KHAN ", displayName: "Ayesha Khan" }), true);
  assert.equal(employeeDeletionConfirmationLabel(true), "the salesperson email");
  assert.equal(employeeDeletionConfirmationLabel(false), "the employee name");
});

test("effective assignments honor inclusive starts and exclusive ends", () => {
  const at = "2026-08-26T10:00:00.000Z";
  assert.equal(assignmentIsEffective({ effective_from: at }, at), true);
  assert.equal(assignmentIsEffective({ effective_from: "2026-08-26T09:00:00.000Z", effective_to: "2026-08-26T11:00:00.000Z" }, at), true);
  assert.equal(assignmentIsEffective({ effective_from: "2026-08-26T09:00:00.000Z", effective_to: at }, at), false);
  assert.equal(assignmentIsEffective({ effective_from: "invalid" }, at), false);

  const assignments = [
    { role_id: "other", effective_from: "2026-08-20T00:00:00.000Z" },
    { role_id: "sales", effective_from: "2026-08-20T00:00:00.000Z", effective_to: "2026-08-25T00:00:00.000Z" },
  ];
  assert.equal(hasEffectiveSalespersonAssignment(assignments, "sales", at), false);
  assert.equal(hasEffectiveSalespersonAssignment([...assignments, { role_id: "sales", effective_from: at }], "sales", at), true);
});

test("optimistic decisions allow exact no-ops but reject stale writes", () => {
  assert.equal(employeeMutationDecision("old", "new", true), "noop");
  assert.equal(employeeMutationDecision("same", "same", false), "write");
  assert.equal(employeeMutationDecision("old", "new", false), "conflict");
});

test("dependency summaries are stable, positive-only, and actionable", () => {
  assert.deepEqual(EMPLOYEE_OPERATIONAL_DEPENDENCIES.map((item) => item.key), [
    "directReports",
    "assignedOutlets",
    "routeAssignments",
    "attendanceRecords",
    "visits",
    "visitEvidence",
    "locationPoints",
    "orders",
    "teamMessages",
    "sentTeamMessages",
    "salesDeals",
    "routeSequenceCounters",
    "actorAuditLogs",
  ]);
  const summary = summarizeEmployeeDependencies([
    { key: "visits", label: "visits", count: 2 },
    { key: "orders", label: "orders", count: 1.9 },
    { key: "teamMessages", label: "legacy records", count: Number.NaN },
  ]);
  assert.equal(summary.blocked, true);
  assert.equal(summary.total, 3);
  assert.deepEqual(summary.dependencies.map((item) => [item.key, item.count]), [["visits", 2], ["orders", 1]]);
  assert.match(summary.message, /2 visits/);
  assert.match(summary.message, /Deactivate/);
  assert.equal(summarizeEmployeeDependencies([]).blocked, false);
});

test("profile and status equality includes both the employee row and Auth identity", () => {
  const profile = {
    action: "profile",
    operationId: "profile_01",
    expectedUpdatedAt: version,
    expectedAuthUpdatedAt: "",
    name: "Ayesha Khan",
    email: "ayesha@example.com",
    phone: "+923001234567",
  };
  const employee = { display_name: "Ayesha Khan", phone: "+923001234567", status: "active" };
  const user = { name: "Ayesha Khan", email: "Ayesha@Example.com", status: true };
  assert.equal(employeeProfileMatches(profile, employee, user), true);
  assert.equal(employeeProfileMatches(profile, { ...employee, phone: "" }, user), false);
  assert.equal(employeeProfileMatches(profile, employee, { ...user, email: "other@example.com" }), false);
  assert.equal(employeeStatusMatches("active", employee, user), true);
  assert.equal(employeeStatusMatches("inactive", { ...employee, status: "inactive" }, null), true);
  assert.equal(employeeStatusMatches("active", employee, null), false);
});

test("password audit receipts contain neither the password nor a password hash", () => {
  const command = {
    action: "password",
    operationId: "password_01",
    expectedUpdatedAt: version,
    expectedAuthUpdatedAt: "",
    password: "Correct Horse Battery Staple",
  };
  const audited = employeeCommandForAudit(command);
  assert.deepEqual(audited, { action: "password", operationId: "password_01", expectedUpdatedAt: version, expectedAuthUpdatedAt: "" });
  const receipt = employeeAuditReceiptJson(command, { sessionsRevoked: true });
  assert.equal(receipt.includes(command.password), false);
  assert.equal(receipt.toLowerCase().includes("passwordhash"), false);
  assert.equal(receipt.toLowerCase().includes("password_hash"), false);
});

test("audit receipts bind actor, action, employee, and normalized command", () => {
  const command = {
    action: "delete",
    operationId: "delete_01",
    expectedUpdatedAt: version,
    expectedAuthUpdatedAt: "",
    confirmationEmail: "Ayesha@Example.com",
  };
  const row = {
    actor_user_id: "admin_1",
    action: "employee.deleted",
    entity_type: "employee",
    entity_id: "emp_1",
    after_json: employeeAuditReceiptJson(command, { authUserId: "user_1", deleted: true }),
  };
  assert.equal(row.after_json.includes(command.confirmationEmail), false);
  assert.equal(row.after_json.toLowerCase().includes("confirmationemail"), false);
  assert.equal(employeeAuditReceiptMatches(row, {
    actorUserId: "admin_1",
    action: "employee.deleted",
    employeeId: "emp_1",
    command: { ...command, confirmationEmail: "a different retry confirmation" },
  }), true);
  assert.equal(employeeAuditReceiptMatches(row, { actorUserId: "admin_2", action: "employee.deleted", employeeId: "emp_1", command }), false);
  assert.equal(employeeAuditReceiptMatches(row, { actorUserId: "admin_1", action: "employee.deleted", employeeId: "emp_2", command }), false);
  assert.deepEqual(employeeAuditReceiptResult(row), { authUserId: "user_1", deleted: true });
  assert.equal(employeeAuditReceiptResult({ after_json: "not-json" }), null);
});
