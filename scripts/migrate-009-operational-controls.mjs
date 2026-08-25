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

async function waitForColumn(key) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const column = await db.getColumn({ databaseId, tableId: "organizations", key });
    if (column.status === "available") return;
    if (column.status === "failed") throw new Error(`Column organizations.${key} failed: ${column.error}`);
    await sleep(500);
  }
  throw new Error(`Timed out creating organizations.${key}`);
}

async function ensureColumn([key, type, size]) {
  if (!(await exists(() => db.getColumn({ databaseId, tableId: "organizations", key })))) {
    const base = { databaseId, tableId: "organizations", key, required: false };
    if (type === "integer") await db.createIntegerColumn(base);
    if (type === "float") await db.createFloatColumn(base);
    if (type === "datetime") await db.createDatetimeColumn(base);
    if (type === "varchar") await db.createVarcharColumn({ ...base, size });
    console.log(`created column organizations.${key}`);
  }
  await waitForColumn(key);
}

for (const column of [
  ["route_sample_seconds", "integer"],
  ["route_distance_meters", "integer"],
  ["route_max_accuracy_meters", "integer"],
  ["route_stationary_jitter_meters", "integer"],
  ["route_segment_gap_minutes", "integer"],
  ["route_max_speed_mps", "float"],
  ["mobile_sync_interval_seconds", "integer"],
  ["field_policy_updated_at", "datetime"],
  ["field_policy_updated_by", "varchar", 36],
]) await ensureColumn(column);

const organizations = await db.listRows({
  databaseId,
  tableId: "organizations",
  queries: [Query.equal("active", true), Query.limit(100)],
});
for (const organization of organizations.rows) {
  await db.updateRow({
    databaseId,
    tableId: "organizations",
    rowId: organization.$id,
    data: {
      route_sample_seconds: organization.route_sample_seconds ?? 15,
      route_distance_meters: organization.route_distance_meters ?? 10,
      route_max_accuracy_meters: organization.route_max_accuracy_meters ?? 35,
      route_stationary_jitter_meters: organization.route_stationary_jitter_meters ?? 20,
      route_segment_gap_minutes: organization.route_segment_gap_minutes ?? 5,
      route_max_speed_mps: organization.route_max_speed_mps ?? 45,
      mobile_sync_interval_seconds: organization.mobile_sync_interval_seconds ?? 15,
    },
  });
}

console.log(`migration 009 complete; initialized ${organizations.rows.length} active organization policies`);
