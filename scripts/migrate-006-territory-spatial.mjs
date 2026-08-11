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
    if (column.status === "available") return column;
    if (column.status === "failed") throw new Error(`Column ${tableId}.${key} failed: ${column.error}`);
    await sleep(500);
  }
  throw new Error(`Timed out preparing ${tableId}.${key}`);
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

async function listRows(tableId) {
  const rows = [];
  while (true) {
    const page = await db.listRows({ databaseId, tableId, queries: [Query.limit(100), ...(rows.length ? [Query.cursorAfter(rows.at(-1).$id)] : [])] });
    rows.push(...page.rows);
    if (page.rows.length < 100) return rows;
  }
}

async function ensureSpatialIndex(tableId, key, column) {
  if (await exists(() => db.getIndex({ databaseId, tableId, key }))) return;
  await db.createIndex({ databaseId, tableId, key, type: "spatial", columns: [column] });
  await waitForIndex(tableId, key);
  console.log(`created spatial index ${tableId}.${key}`);
}

if (!(await exists(() => db.getColumn({ databaseId, tableId: "territories", key: "boundary" })))) {
  await db.createPolygonColumn({ databaseId, tableId: "territories", key: "boundary", required: false });
  await waitForColumn("territories", "boundary");
  console.log("created territories.boundary polygon");
}
const territoriesAfterBackfill = await listRows("territories");
if (territoriesAfterBackfill.every((row) => Boolean(row.boundary))) {
  const boundaryColumn = await waitForColumn("territories", "boundary");
  if (!boundaryColumn.required) {
    await db.updatePolygonColumn({ databaseId, tableId: "territories", key: "boundary", required: true });
    await waitForColumn("territories", "boundary");
  }
  await ensureSpatialIndex("territories", "territory_boundary", "boundary");
} else {
  console.log("skipped territory boundary spatial index until every active territory has a saved polygon");
}

for (const tableId of ["outlets", "visits"]) {
  if (!(await exists(() => db.getColumn({ databaseId, tableId, key: "coordinates" })))) {
    await db.createPointColumn({ databaseId, tableId, key: "coordinates", required: false });
    await waitForColumn(tableId, "coordinates");
    console.log(`created ${tableId}.coordinates point`);
  }
  const rows = await listRows(tableId);
  for (const row of rows) {
    if (row.coordinates) continue;
    const longitude = Number(row.longitude), latitude = Number(row.latitude);
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || Math.abs(longitude) > 180 || Math.abs(latitude) > 90) throw new Error(`Invalid ${tableId} coordinates on ${row.$id}`);
    await db.updateRow({ databaseId, tableId, rowId: row.$id, data: { coordinates: [longitude, latitude] } });
  }
  const column = await waitForColumn(tableId, "coordinates");
  if (!column.required) {
    await db.updatePointColumn({ databaseId, tableId, key: "coordinates", required: true });
    await waitForColumn(tableId, "coordinates");
    console.log(`made ${tableId}.coordinates required`);
  }
  await ensureSpatialIndex(tableId, `${tableId}_coordinates`, "coordinates");
}

console.log("migration 006 complete");
