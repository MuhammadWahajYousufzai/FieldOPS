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
  try {
    await getter();
    return true;
  } catch (error) {
    if (error?.code === 404) return false;
    throw error;
  }
}

async function waitForIndex(tableId, key) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const index = await db.getIndex({ databaseId, tableId, key });
    if (index.status === "available") return;
    if (index.status === "failed") throw new Error(`Index ${tableId}.${key} failed: ${index.error}`);
    await sleep(500);
  }
  throw new Error(`Timed out creating ${tableId}.${key}`);
}

async function ensureIndex(tableId, key, columns) {
  if (!(await exists(() => db.getIndex({ databaseId, tableId, key })))) {
    await db.createIndex({ databaseId, tableId, key, type: "key", columns });
    console.log(`created index ${tableId}.${key}`);
  }
  await waitForIndex(tableId, key);
}

// Activity includes recent admin decisions even when the marked visit happened
// on an earlier workday. These indexes keep that mobile refresh scoped to the
// signed-in employee instead of scanning every visit.
await ensureIndex("visits", "visit_employee_reviewed", ["employee_id", "reviewed_at"]);
await ensureIndex("visits", "visit_employee_place_date", ["employee_id", "place_approval_status", "work_date"]);

console.log("migration 008 complete");
