import { Client, TablesDB } from "../packages/appwrite/node_modules/node-appwrite/dist/index.mjs";

const value = (name) => {
  const result = process.env[name];
  if (!result) throw new Error(`Missing ${name}`);
  return result;
};

const databaseId = value("APPWRITE_DATABASE_ID");
const client = new Client()
  .setEndpoint(value("APPWRITE_ENDPOINT"))
  .setProject(value("APPWRITE_PROJECT_ID"))
  .setKey(value("APPWRITE_API_KEY"));
const db = new TablesDB(client);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const tables = [
  { id: "organizations", name: "Organizations", columns: [
    ["name", "string", 128, true], ["legal_name", "string", 255, false], ["timezone", "string", 64, true],
    ["currency", "string", 3, true], ["active", "boolean", true],
  ], indexes: [["organization_name", "key", ["name"]]] },
  { id: "regions", name: "Regions", columns: [
    ["organization_id", "string", 36, true], ["code", "string", 32, true], ["name", "string", 128, true], ["active", "boolean", true],
  ], indexes: [["region_code", "unique", ["organization_id", "code"]], ["region_active", "key", ["organization_id", "active"]]] },
  { id: "areas", name: "Areas", columns: [
    ["region_id", "string", 36, true], ["code", "string", 32, true], ["name", "string", 128, true], ["active", "boolean", true],
  ], indexes: [["area_code", "unique", ["region_id", "code"]], ["area_active", "key", ["region_id", "active"]]] },
  { id: "territories", name: "Territories", columns: [
    ["area_id", "string", 36, true], ["code", "string", 32, true], ["name", "string", 128, true],
    ["boundary", "polygon", false], ["active", "boolean", true],
  ], indexes: [["territory_code", "unique", ["area_id", "code"]], ["territory_active", "key", ["area_id", "active"]]] },
  { id: "roles", name: "Roles", columns: [
    ["code", "string", 64, true], ["name", "string", 128, true], ["system", "boolean", true], ["active", "boolean", true],
  ], indexes: [["role_code", "unique", ["code"]], ["role_active", "key", ["active"]]] },
  { id: "employees", name: "Employees", columns: [
    ["user_id", "string", 36, true], ["employee_code", "string", 32, true], ["display_name", "string", 128, true],
    ["manager_employee_id", "string", 36, false], ["status", "string", 24, true], ["joining_date", "datetime", true],
  ], indexes: [["employee_user", "unique", ["user_id"]], ["employee_code", "unique", ["employee_code"]], ["manager_status", "key", ["manager_employee_id", "status"]]] },
  { id: "employee_assignments", name: "Employee Assignments", columns: [
    ["employee_id", "string", 36, true], ["role_id", "string", 36, true], ["territory_id", "string", 36, false],
    ["effective_from", "datetime", true], ["effective_to", "datetime", false], ["assigned_by", "string", 36, true], ["reason", "string", 500, false],
  ], indexes: [["employee_dates", "key", ["employee_id", "effective_from"]], ["territory_dates", "key", ["territory_id", "effective_from"]]] },
  { id: "audit_logs", name: "Immutable Audit Logs", columns: [
    ["actor_user_id", "string", 36, true], ["action", "string", 96, true], ["entity_type", "string", 64, true],
    ["entity_id", "string", 36, true], ["occurred_at", "datetime", true], ["before_json", "string", 16383, false],
    ["after_json", "string", 16383, false], ["reason", "string", 1000, false], ["session_id", "string", 64, false],
    ["correlation_id", "string", 64, true],
  ], indexes: [["audit_entity_time", "key", ["entity_type", "entity_id", "occurred_at"]], ["audit_actor_time", "key", ["actor_user_id", "occurred_at"]], ["audit_action_time", "key", ["action", "occurred_at"]]] },
];

async function exists(getter) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { await getter(); return true; } catch (error) {
      if (error.code === 404) return false;
      if (attempt === 4 || error.code) throw error;
      await sleep(500 * 2 ** attempt);
    }
  }
}

async function waitForColumn(tableId, key) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const column = await db.getColumn({ databaseId, tableId, key });
    if (column.status === "available") return;
    if (column.status === "failed") throw new Error(`Column ${tableId}.${key} failed: ${column.error}`);
    await sleep(500);
  }
  throw new Error(`Timed out creating ${tableId}.${key}`);
}

if (!(await exists(() => db.get({ databaseId })))) {
  await db.create({ databaseId, name: "Yousuf Rice FieldOps", enabled: true });
  console.log(`created database ${databaseId}`);
}

for (const table of tables) {
  if (!(await exists(() => db.getTable({ databaseId, tableId: table.id })))) {
    await db.createTable({ databaseId, tableId: table.id, name: table.name, permissions: [], rowSecurity: true, enabled: true });
    console.log(`created table ${table.id}`);
  }
  for (const [key, type, sizeOrRequired, required] of table.columns) {
    if (await exists(() => db.getColumn({ databaseId, tableId: table.id, key }))) continue;
    const base = { databaseId, tableId: table.id, key };
    if (type === "string") await db.createStringColumn({ ...base, size: sizeOrRequired, required });
    if (type === "boolean") await db.createBooleanColumn({ ...base, required: sizeOrRequired });
    if (type === "datetime") await db.createDatetimeColumn({ ...base, required: sizeOrRequired });
    if (type === "integer") await db.createIntegerColumn({ ...base, required: sizeOrRequired });
    if (type === "polygon") await db.createPolygonColumn({ ...base, required: sizeOrRequired });
    await waitForColumn(table.id, key);
    console.log(`created column ${table.id}.${key}`);
  }
  for (const [key, type, columns] of table.indexes) {
    if (await exists(() => db.getIndex({ databaseId, tableId: table.id, key }))) continue;
    await db.createIndex({ databaseId, tableId: table.id, key, type: type === "unique" ? "unique" : "key", columns });
    console.log(`created index ${table.id}.${key}`);
  }
}

console.log("migration 001 complete");
