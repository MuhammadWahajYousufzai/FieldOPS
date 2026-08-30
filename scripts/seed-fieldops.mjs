import { createHash } from "node:crypto";
import { Client, ID, Query, TablesDB, Users } from "../packages/appwrite/node_modules/node-appwrite/dist/index.mjs";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
const stableId = (prefix, value) => `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
const endpoint = required("APPWRITE_ENDPOINT");
const projectId = required("APPWRITE_PROJECT_ID");
const databaseId = required("APPWRITE_DATABASE_ID");
const initialPassword = required("FIELDOPS_INITIAL_PASSWORD");
const salespersonPassword = required("FIELDOPS_SEED_SALESPERSON_PASSWORD");
const client = new Client().setEndpoint(endpoint).setProject(projectId).setKey(required("APPWRITE_API_KEY"));
const db = new TablesDB(client);
const users = new Users(client);
const now = new Date().toISOString();

async function first(tableId, queries) {
  return (await db.listRows({ databaseId, tableId, queries: [...queries, Query.limit(1)] })).rows[0];
}

async function ensureRow(tableId, rowId, data) {
  try { return await db.getRow({ databaseId, tableId, rowId }); } catch (error) {
    if (error?.code !== 404) throw error;
    return db.createRow({ databaseId, tableId, rowId, data, permissions: [] });
  }
}

async function ensureUser(email, name, password) {
  const existing = (await users.list({ queries: [Query.equal("email", email), Query.limit(1)] })).users[0];
  if (existing) return existing;
  return users.create({ userId: ID.unique(), email, password, name });
}

async function ensureUserLabel(user, label) {
  const labels = Array.isArray(user.labels) ? user.labels : [];
  if (labels.includes(label)) return user;
  return users.updateLabels({ userId: user.$id, labels: [...labels, label] });
}

const organizationId = stableId("org", "yousuf-rice");
const regionId = stableId("reg", `${organizationId}:KHI`);
const areaId = stableId("area", `${regionId}:KHI-S`);
const territoryId = stableId("ter", `${areaId}:CLF-DHA`);
await ensureRow("organizations", organizationId, { name: "Yousuf Rice", legal_name: "Yousuf Rice", timezone: "Asia/Karachi", currency: "PKR", active: true });
await ensureRow("regions", regionId, { organization_id: organizationId, code: "KHI", name: "Karachi", active: true });
await ensureRow("areas", areaId, { region_id: regionId, code: "KHI-S", name: "South Karachi", active: true });
await ensureRow("territories", territoryId, { area_id: areaId, code: "CLF-DHA", name: "Clifton & DHA", active: true });

const managerRoleId = stableId("role", "super_admin");
const salesRoleId = stableId("role", "sales_person");
await ensureRow("roles", managerRoleId, { code: "super_admin", name: "Executive manager", system: true, active: true });
await ensureRow("roles", salesRoleId, { code: "sales_person", name: "Sales person", system: true, active: true });

const manager = await ensureUserLabel(
  await ensureUser("management@sherazwaqar.tech", "FieldOPS Management", initialPassword),
  "admin",
);
const salesperson = await ensureUser("ali.raza@sherazwaqar.tech", "Ali Raza", salespersonPassword);
const managerEmployeeId = stableId("emp", manager.$id);
const salesEmployeeId = stableId("emp", salesperson.$id);
await ensureRow("employees", managerEmployeeId, { user_id: manager.$id, display_name: manager.name, status: "active", joining_date: now });
await ensureRow("employees", salesEmployeeId, { user_id: salesperson.$id, display_name: salesperson.name, manager_employee_id: managerEmployeeId, status: "active", joining_date: now });
await ensureRow("employee_assignments", stableId("assign", `${managerEmployeeId}:manager`), { employee_id: managerEmployeeId, role_id: managerRoleId, territory_id: territoryId, effective_from: now, assigned_by: manager.$id, reason: "Initial FieldOPS deployment" });
await ensureRow("employee_assignments", stableId("assign", `${salesEmployeeId}:sales`), { employee_id: salesEmployeeId, role_id: salesRoleId, territory_id: territoryId, effective_from: now, assigned_by: manager.$id, reason: "Pilot route assignment" });

if (!(await first("audit_logs", [Query.equal("action", "system.seeded")]))) {
  await db.createRow({ databaseId, tableId: "audit_logs", rowId: ID.unique(), data: {
    actor_user_id: manager.$id, action: "system.seeded", entity_type: "organization", entity_id: organizationId,
    occurred_at: now, after_json: JSON.stringify({ managerEmployeeId, salesEmployeeId }),
    reason: "Production launch seed", correlation_id: crypto.randomUUID(),
  }, permissions: [] });
}

console.log(JSON.stringify({
  managerEmail: manager.email,
  salespersonEmail: salesperson.email,
  salespersonEmployeeId: salesEmployeeId,
}));
