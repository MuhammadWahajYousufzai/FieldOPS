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
const tableId = "auth_attempt_windows";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getOrNull(getter) {
  try {
    return await getter();
  } catch (error) {
    if (error?.code === 404) return null;
    throw error;
  }
}

async function waitForColumn(key) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const column = await db.getColumn({ databaseId, tableId, key });
    if (column.status === "available") return column;
    if (column.status === "failed") throw new Error(`Column ${tableId}.${key} failed: ${column.error}`);
    await sleep(500);
  }
  throw new Error(`Timed out creating ${tableId}.${key}`);
}

async function ensureColumn({ key, type, size, required: isRequired, min }) {
  const existing = await getOrNull(() => db.getColumn({ databaseId, tableId, key }));
  if (!existing) {
    const base = { databaseId, tableId, key, required: isRequired };
    if (type === "varchar") await db.createVarcharColumn({ ...base, size });
    if (type === "datetime") await db.createDatetimeColumn(base);
    if (type === "integer") await db.createIntegerColumn({ ...base, min });
    console.log(`created column ${tableId}.${key}`);
  }
  const available = await waitForColumn(key);
  if (available.type !== type || available.required !== isRequired) {
    throw new Error(`Existing column ${tableId}.${key} does not match the required ${type} schema.`);
  }
}

async function waitForIndex(key) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const index = await getOrNull(() => db.getIndex({ databaseId, tableId, key }));
    if (!index) {
      await sleep(500);
      continue;
    }
    if (index.status === "available") return index;
    if (index.status === "failed") throw new Error(`Index ${tableId}.${key} failed: ${index.error}`);
    await sleep(500);
  }
  throw new Error(`Timed out creating ${tableId}.${key}`);
}

async function ensureIndex(key, columns) {
  const existing = await getOrNull(() => db.getIndex({ databaseId, tableId, key }));
  if (!existing) {
    await db.createIndex({ databaseId, tableId, key, type: "key", columns });
    console.log(`created index ${tableId}.${key}`);
  }
  const available = await waitForIndex(key);
  if (available.type !== "key" || JSON.stringify(available.columns) !== JSON.stringify(columns)) {
    throw new Error(`Existing index ${tableId}.${key} does not match the required schema.`);
  }
}

let table = await getOrNull(() => db.getTable({ databaseId, tableId }));
if (!table) {
  table = await db.createTable({
    databaseId,
    tableId,
    name: "Credential Attempt Windows",
    permissions: [],
    rowSecurity: true,
    enabled: true,
  });
  console.log(`created table ${tableId}`);
}
if (table.rowSecurity !== true || table.enabled !== true || table.$permissions.length !== 0) {
  throw new Error(`${tableId} must remain enabled, row-secured, and private to the server API key.`);
}

for (const column of [
  { key: "scope", type: "varchar", size: 24, required: true },
  { key: "window_started_at", type: "datetime", required: true },
  { key: "expires_at", type: "datetime", required: true },
  { key: "attempts", type: "integer", min: 0, required: true },
]) await ensureColumn(column);

await ensureIndex("auth_attempt_expiry", ["expires_at"]);
await ensureIndex("auth_attempt_scope_window", ["scope", "window_started_at"]);

console.log("migration 013 complete");
