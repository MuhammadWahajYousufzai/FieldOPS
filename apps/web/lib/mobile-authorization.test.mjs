import assert from "node:assert/strict";
import test from "node:test";

import {
  FIELD_SALESPERSON_ROLE,
  hasEffectiveRoleAssignment,
} from "./mobile-authorization.ts";

const now = Date.parse("2026-08-25T12:00:00.000Z");

test("field access is reserved for the salesperson role", () => {
  assert.equal(FIELD_SALESPERSON_ROLE, "sales_person");
  assert.equal(hasEffectiveRoleAssignment([{
    role_id: "sales-role",
    effective_from: "2026-01-01T00:00:00.000Z",
  }], "sales-role", now), true);
  assert.equal(hasEffectiveRoleAssignment([{
    role_id: "manager-role",
    effective_from: "2026-01-01T00:00:00.000Z",
  }], "sales-role", now), false);
});

test("future, expired, and invalid salesperson assignments cannot authorize field access", () => {
  assert.equal(hasEffectiveRoleAssignment([{
    role_id: "sales-role",
    effective_from: "2026-08-25T12:00:01.000Z",
  }], "sales-role", now), false);
  assert.equal(hasEffectiveRoleAssignment([{
    role_id: "sales-role",
    effective_from: "2026-01-01T00:00:00.000Z",
    effective_to: "2026-08-25T12:00:00.000Z",
  }], "sales-role", now), false);
  assert.equal(hasEffectiveRoleAssignment([{
    role_id: "sales-role",
    effective_from: "invalid",
  }], "sales-role", now), false);
});

test("an assignment stays effective until, but not including, its end instant", () => {
  const assignment = {
    role_id: "sales-role",
    effective_from: "2026-01-01T00:00:00.000Z",
    effective_to: "2026-08-25T12:00:01.000Z",
  };
  assert.equal(hasEffectiveRoleAssignment([assignment], "sales-role", now), true);
  assert.equal(hasEffectiveRoleAssignment([assignment], "sales-role", now + 1_000), false);
});
