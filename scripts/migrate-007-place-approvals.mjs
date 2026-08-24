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
    if (column.status === "available") return;
    if (column.status === "failed") throw new Error(`Column ${tableId}.${key} failed: ${column.error}`);
    await sleep(500);
  }
  throw new Error(`Timed out creating ${tableId}.${key}`);
}

async function waitForIndex(tableId, key) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    let index;
    try {
      index = await db.getIndex({ databaseId, tableId, key });
    } catch (error) {
      if (error?.code === 404) {
        await sleep(500);
        continue;
      }
      throw error;
    }
    if (index.status === "available") return;
    if (index.status === "failed") throw new Error(`Index ${tableId}.${key} failed: ${index.error}`);
    await sleep(500);
  }
  throw new Error(`Timed out creating ${tableId}.${key}`);
}

async function createColumn(tableId, [key, type, size]) {
  if (await exists(() => db.getColumn({ databaseId, tableId, key }))) {
    await waitForColumn(tableId, key);
    return;
  }
  const base = { databaseId, tableId, key, required: false };
  if (type === "varchar") await db.createVarcharColumn({ ...base, size });
  if (type === "datetime") await db.createDatetimeColumn(base);
  if (type === "text") await db.createTextColumn(base);
  await waitForColumn(tableId, key);
  console.log(`created column ${tableId}.${key}`);
}

async function createIndex(tableId, key, type, columns) {
  if (!(await exists(() => db.getIndex({ databaseId, tableId, key })))) {
    await db.createIndex({ databaseId, tableId, key, type, columns });
  }
  await waitForIndex(tableId, key);
  console.log(`created index ${tableId}.${key}`);
}

for (const column of [
  ["place_approval_status", "varchar", 24],
  ["candidate_territory_id", "varchar", 36],
  ["approved_outlet_id", "varchar", 36],
  ["reviewed_by", "varchar", 36],
  ["reviewed_at", "datetime"],
  ["review_note", "text"],
]) await createColumn("visits", column);

await createColumn("outlets", ["origin_visit_id", "varchar", 36]);
await createColumn("outlets", ["source", "varchar", 24]);
await createIndex("visits", "visit_place_review", "key", ["place_approval_status", "work_date"]);
await createIndex("outlets", "outlet_origin_visit", "unique", ["origin_visit_id"]);
await createIndex("location_points", "location_date_received", "key", ["work_date", "received_at"]);
await createIndex("location_points", "location_employee_received", "key", ["employee_id", "work_date", "received_at"]);

let cursor;
let updated = 0;
do {
  const page = await db.listRows({
    databaseId,
    tableId: "visits",
    queries: [Query.limit(100), ...(cursor ? [Query.cursorAfter(cursor)] : [])],
  });
  for (const visit of page.rows) {
    if (visit.place_approval_status) continue;
    const selfInitiated = visit.visit_type === "self_initiated" || !visit.route_assignment_id;
    await db.updateRow({
      databaseId,
      tableId: "visits",
      rowId: visit.$id,
      data: { place_approval_status: selfInitiated ? "pending_review" : "not_applicable" },
    });
    updated += 1;
  }
  cursor = page.rows.at(-1)?.$id;
  if (page.rows.length < 100) break;
} while (cursor);

console.log(`migration 007 complete; initialized ${updated} visit approval states`);
