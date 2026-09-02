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
const tableId = "visit_evidence";
const indexKey = "evidence_retention";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getOrNull(getter) {
  try { return await getter(); } catch (error) {
    if (error?.code === 404) return null;
    throw error;
  }
}

let index = await getOrNull(() => db.getIndex({ databaseId, tableId, key: indexKey }));
if (!index) {
  await db.createIndex({ databaseId, tableId, key: indexKey, type: "key", columns: ["captured_at"] });
  console.log(`created index ${tableId}.${indexKey}`);
}

for (let attempt = 0; attempt < 80; attempt += 1) {
  index = await db.getIndex({ databaseId, tableId, key: indexKey });
  if (index.status === "available") break;
  if (index.status === "failed") throw new Error(`Index ${tableId}.${indexKey} failed: ${index.error}`);
  await sleep(500);
}

if (!index || index.status !== "available") throw new Error(`Timed out creating ${tableId}.${indexKey}`);
if (index.type !== "key" || JSON.stringify(index.columns) !== JSON.stringify(["captured_at"])) {
  throw new Error(`Existing index ${tableId}.${indexKey} does not match the retention query.`);
}

console.log("migration 014 complete");
