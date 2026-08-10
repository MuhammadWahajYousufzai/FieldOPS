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

async function waitForColumn(key) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const column = await db.getColumn({ databaseId, tableId: "visits", key });
    if (column.status === "available") return;
    if (column.status === "failed") throw new Error(`Column visits.${key} failed: ${column.error}`);
    await sleep(500);
  }
  throw new Error(`Timed out creating visits.${key}`);
}

async function createColumn([key, type, size]) {
  if (await exists(() => db.getColumn({ databaseId, tableId: "visits", key }))) return;
  const base = { databaseId, tableId: "visits", key, required: false };
  if (type === "varchar") await db.createVarcharColumn({ ...base, size });
  if (type === "integer") await db.createIntegerColumn(base);
  await waitForColumn(key);
  console.log(`created column visits.${key}`);
}

for (const column of [
  ["visit_type", "varchar", 24],
  ["customer_name", "varchar", 160],
  ["customer_address", "varchar", 500],
  ["completion_distance_m", "integer"],
]) await createColumn(column);

console.log("migration 004 complete");
