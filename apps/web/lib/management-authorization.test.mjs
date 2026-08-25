import assert from "node:assert/strict";
import test from "node:test";

import {
  assignmentIsEffective,
  hasDashboardAdminLabel,
  isManagementRoleCode,
} from "./management-authorization.ts";

test("dashboard access requires the exact server-owned admin label", () => {
  assert.equal(hasDashboardAdminLabel({ labels: ["regional", "admin"] }), true);
  assert.equal(hasDashboardAdminLabel({ labels: ["Admin"] }), false);
  assert.equal(hasDashboardAdminLabel({ labels: ["field_admin"] }), false);
  assert.equal(hasDashboardAdminLabel({ labels: ["admin "] }), false);
  assert.equal(hasDashboardAdminLabel({ labels: [] }), false);
  assert.equal(hasDashboardAdminLabel({}), false);
});

test("only management role codes can authorize dashboard access", () => {
  assert.equal(isManagementRoleCode("manager"), true);
  assert.equal(isManagementRoleCode("executive"), true);
  assert.equal(isManagementRoleCode("super_admin"), true);
  assert.equal(isManagementRoleCode("sales_person"), false);
  assert.equal(isManagementRoleCode("admin"), false);
});

test("management assignments must be active at the authorization instant", () => {
  const now = Date.parse("2026-08-25T12:00:00.000Z");
  assert.equal(assignmentIsEffective({ effective_from: "2026-01-01T00:00:00.000Z" }, now), true);
  assert.equal(assignmentIsEffective({
    effective_from: "2026-01-01T00:00:00.000Z",
    effective_to: "2026-08-25T12:00:01.000Z",
  }, now), true);
  assert.equal(assignmentIsEffective({
    effective_from: "2026-01-01T00:00:00.000Z",
    effective_to: "2026-08-25T12:00:00.000Z",
  }, now), false);
  assert.equal(assignmentIsEffective({ effective_from: "2026-08-26T00:00:00.000Z" }, now), false);
  assert.equal(assignmentIsEffective({ effective_from: "not-a-date" }, now), false);
});
