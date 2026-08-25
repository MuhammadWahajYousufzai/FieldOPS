import assert from "node:assert/strict";
import test from "node:test";

import { dashboardAdminForUser, hasDashboardAdminLabel } from "./management-authorization.ts";

test("dashboard access requires the exact server-owned admin label", () => {
  assert.equal(hasDashboardAdminLabel({ labels: ["regional", "admin"] }), true);
  assert.equal(hasDashboardAdminLabel({ labels: ["Admin"] }), false);
  assert.equal(hasDashboardAdminLabel({ labels: ["field_admin"] }), false);
  assert.equal(hasDashboardAdminLabel({ labels: ["admin "] }), false);
  assert.equal(hasDashboardAdminLabel({ labels: [] }), false);
  assert.equal(hasDashboardAdminLabel({}), false);
});

test("dashboard authorization depends only on the exact admin label", () => {
  const admin = { $id: "user_admin", labels: ["admin"], employee: null, roles: [] };
  assert.deepEqual(dashboardAdminForUser(admin), { user: admin });
  assert.equal(dashboardAdminForUser({ $id: "user_manager", labels: [], employee: { status: "active" }, roles: ["manager"] }), null);
});
