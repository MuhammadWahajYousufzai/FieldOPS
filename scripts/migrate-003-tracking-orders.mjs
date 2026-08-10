import { Client, TablesDB } from "../packages/appwrite/node_modules/node-appwrite/dist/index.mjs";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

const databaseId = required("APPWRITE_DATABASE_ID");
const client = new Client()
  .setEndpoint(required("APPWRITE_ENDPOINT"))
  .setProject(required("APPWRITE_PROJECT_ID"))
  .setKey(required("APPWRITE_API_KEY"));
const db = new TablesDB(client);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function exists(getter) {
  try { await getter(); return true; } catch (error) {
    if (error?.code === 404) return false;
    throw error;
  }
}

async function waitForColumn(tableId, key) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const column = await db.getColumn({ databaseId, tableId, key });
    if (column.status === "available") return;
    if (column.status === "failed") throw new Error(`Column ${tableId}.${key} failed: ${column.error}`);
    await sleep(500);
  }
  throw new Error(`Timed out creating ${tableId}.${key}`);
}

async function createColumn(tableId, [key, type, sizeOrRequired, required]) {
  if (await exists(() => db.getColumn({ databaseId, tableId, key }))) return;
  const base = { databaseId, tableId, key };
  if (type === "varchar") await db.createVarcharColumn({ ...base, size: sizeOrRequired, required });
  if (type === "text") await db.createTextColumn({ ...base, required: sizeOrRequired });
  if (type === "datetime") await db.createDatetimeColumn({ ...base, required: sizeOrRequired });
  if (type === "float") await db.createFloatColumn({ ...base, required: sizeOrRequired });
  await waitForColumn(tableId, key);
  console.log(`created column ${tableId}.${key}`);
}

async function createIndex(tableId, [key, type, columns]) {
  if (await exists(() => db.getIndex({ databaseId, tableId, key }))) return;
  await db.createIndex({ databaseId, tableId, key, type, columns });
  console.log(`created index ${tableId}.${key}`);
}

const locationColumns = [
  ["idempotency_key", "varchar", 64, false],
  ["work_date", "varchar", 10, false],
  ["altitude", "float", false],
  ["speed", "float", false],
  ["heading", "float", false],
];
for (const column of locationColumns) await createColumn("location_points", column);
for (const index of [
  ["location_idempotency", "unique", ["idempotency_key"]],
  ["location_work_date", "key", ["work_date", "captured_at"]],
  ["location_captured", "key", ["captured_at"]],
]) await createIndex("location_points", index);

if (!(await exists(() => db.getTable({ databaseId, tableId: "orders" })))) {
  await db.createTable({ databaseId, tableId: "orders", name: "Field Orders", permissions: [], rowSecurity: true, enabled: true });
  console.log("created table orders");
}

const orderColumns = [
  ["employee_id", "varchar", 36, true], ["work_date", "varchar", 10, true],
  ["outlet_id", "varchar", 36, false], ["customer_name", "varchar", 160, true],
  ["phone", "varchar", 32, false], ["address", "varchar", 500, false],
  ["product_name", "varchar", 160, true], ["quantity_kg", "float", true],
  ["unit_price", "float", true], ["total_amount", "float", true],
  ["notes", "text", false], ["latitude", "float", true], ["longitude", "float", true],
  ["accuracy", "float", true], ["captured_at", "datetime", true], ["received_at", "datetime", true],
  ["status", "varchar", 24, true], ["idempotency_key", "varchar", 64, true],
];
for (const column of orderColumns) await createColumn("orders", column);
for (const index of [
  ["order_idempotency", "unique", ["idempotency_key"]],
  ["order_employee_date", "key", ["employee_id", "work_date"]],
  ["order_date", "key", ["work_date"]],
]) await createIndex("orders", index);

console.log("migration 003 complete");
