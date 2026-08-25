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
const tableId = "route_sequence_counters";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function exists(getter) {
  try {
    await getter();
    return true;
  } catch (error) {
    if (error?.code === 404) return false;
    throw error;
  }
}

async function waitForColumn(key) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const column = await db.getColumn({ databaseId, tableId, key });
    if (column.status === "available") return;
    if (column.status === "failed") throw new Error(`Column ${tableId}.${key} failed: ${column.error}`);
    await sleep(500);
  }
  throw new Error(`Timed out creating ${tableId}.${key}`);
}

async function ensureColumn([key, type, size]) {
  if (!(await exists(() => db.getColumn({ databaseId, tableId, key })))) {
    const base = { databaseId, tableId, key, required: true };
    if (type === "varchar") await db.createVarcharColumn({ ...base, size });
    if (type === "integer") await db.createIntegerColumn(base);
    console.log(`created column ${tableId}.${key}`);
  }
  await waitForColumn(key);
}

async function waitForIndex(key) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const index = await db.getIndex({ databaseId, tableId, key });
    if (index.status === "available") return;
    if (index.status === "failed") throw new Error(`Index ${tableId}.${key} failed: ${index.error}`);
    await sleep(500);
  }
  throw new Error(`Timed out creating ${tableId}.${key}`);
}

if (!(await exists(() => db.getTable({ databaseId, tableId })))) {
  await db.createTable({
    databaseId,
    tableId,
    name: "Route Sequence Counters",
    permissions: [],
    rowSecurity: true,
    enabled: true,
  });
  console.log(`created table ${tableId}`);
}

for (const column of [
  ["employee_id", "varchar", 36],
  ["work_date", "varchar", 10],
  ["last_sequence", "integer"],
]) await ensureColumn(column);

const indexKey = "route_counter_employee_date";
if (!(await exists(() => db.getIndex({ databaseId, tableId, key: indexKey })))) {
  await db.createIndex({
    databaseId,
    tableId,
    key: indexKey,
    type: "unique",
    columns: ["employee_id", "work_date"],
  });
  console.log(`created index ${tableId}.${indexKey}`);
}
await waitForIndex(indexKey);

console.log("migration 010 complete");
