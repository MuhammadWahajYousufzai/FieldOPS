import { Client, Query, TablesDB } from "../packages/appwrite/node_modules/node-appwrite/dist/index.mjs";

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
const tableId = "location_points";
const columnKey = "coordinates";
const indexKey = "location_coordinates";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function exists(getter) {
  try { await getter(); return true; } catch (error) {
    if (error?.code === 404) return false;
    throw error;
  }
}

async function waitForColumn() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const column = await db.getColumn({ databaseId, tableId, key: columnKey });
    if (column.status === "available") return column;
    if (column.status === "failed") throw new Error(`Column ${tableId}.${columnKey} failed: ${column.error}`);
    await sleep(500);
  }
  throw new Error(`Timed out preparing ${tableId}.${columnKey}`);
}

async function waitForIndex() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const index = await db.getIndex({ databaseId, tableId, key: indexKey });
    if (index.status === "available") return;
    if (index.status === "failed") throw new Error(`Index ${indexKey} failed: ${index.error}`);
    await sleep(500);
  }
  throw new Error(`Timed out creating ${indexKey}`);
}

async function listLocationRows() {
  const rows = [];
  while (true) {
    const page = await db.listRows({
      databaseId,
      tableId,
      queries: [Query.limit(100), ...(rows.length ? [Query.cursorAfter(rows.at(-1).$id)] : [])],
    });
    rows.push(...page.rows);
    if (page.rows.length < 100) return rows;
  }
}

if (!(await exists(() => db.getColumn({ databaseId, tableId, key: columnKey })))) {
  await db.createPointColumn({ databaseId, tableId, key: columnKey, required: false });
  await waitForColumn();
  console.log(`created point column ${tableId}.${columnKey}`);
}

const rows = await listLocationRows();
for (const row of rows) {
  const longitude = Number(row.longitude), latitude = Number(row.latitude);
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || Math.abs(longitude) > 180 || Math.abs(latitude) > 90) {
    throw new Error(`Cannot backfill invalid location row ${row.$id}`);
  }
  await db.updateRow({ databaseId, tableId, rowId: row.$id, data: { coordinates: [longitude, latitude] } });
}
console.log(`backfilled ${rows.length} location points`);

const column = await waitForColumn();
if (!column.required) {
  await db.updatePointColumn({ databaseId, tableId, key: columnKey, required: true });
  await waitForColumn();
  console.log(`made ${tableId}.${columnKey} required`);
}

if (!(await exists(() => db.getIndex({ databaseId, tableId, key: indexKey })))) {
  await db.createIndex({ databaseId, tableId, key: indexKey, type: "spatial", columns: [columnKey] });
  await waitForIndex();
  console.log(`created spatial index ${indexKey}`);
}

console.log("migration 005 complete");
