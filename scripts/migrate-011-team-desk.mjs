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

async function waitForColumn(tableId, key) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const column = await db.getColumn({ databaseId, tableId, key });
    if (column.status === "available") return;
    if (column.status === "failed") throw new Error(`Column ${tableId}.${key} failed: ${column.error}`);
    await sleep(500);
  }
  throw new Error(`Timed out creating ${tableId}.${key}`);
}

async function ensureColumn(tableId, [key, type, size, requiredValue]) {
  if (!(await exists(() => db.getColumn({ databaseId, tableId, key })))) {
    const base = { databaseId, tableId, key, required: requiredValue };
    if (type === "varchar") await db.createVarcharColumn({ ...base, size });
    if (type === "text") await db.createTextColumn(base);
    if (type === "datetime") await db.createDatetimeColumn(base);
    if (type === "float") await db.createFloatColumn(base);
    console.log(`created column ${tableId}.${key}`);
  }
  await waitForColumn(tableId, key);
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

async function ensureIndex(tableId, key, type, columns) {
  if (!(await exists(() => db.getIndex({ databaseId, tableId, key })))) {
    await db.createIndex({ databaseId, tableId, key, type, columns });
    console.log(`created index ${tableId}.${key}`);
  }
  await waitForIndex(tableId, key);
}

async function ensureTable(tableId, name) {
  if (await exists(() => db.getTable({ databaseId, tableId }))) return;
  await db.createTable({
    databaseId,
    tableId,
    name,
    permissions: [],
    rowSecurity: true,
    enabled: true,
  });
  console.log(`created table ${tableId}`);
}

for (const column of [
  ["manager_contact_name", "varchar", 128, false],
  ["manager_contact_phone", "varchar", 32, false],
  ["manager_contact_whatsapp", "varchar", 32, false],
]) await ensureColumn("organizations", column);
await ensureColumn("employees", ["phone", "varchar", 32, false]);

await ensureTable("team_messages", "Team Messages");
for (const column of [
  ["employee_id", "varchar", 36, true],
  ["sender_role", "varchar", 24, true],
  ["sender_employee_id", "varchar", 36, false],
  ["body", "text", undefined, true],
  ["sent_at", "datetime", undefined, true],
  ["read_at", "datetime", undefined, false],
  ["idempotency_key", "varchar", 64, true],
]) await ensureColumn("team_messages", column);
await ensureIndex("team_messages", "team_message_operation", "unique", ["idempotency_key"]);
await ensureIndex("team_messages", "team_message_time", "key", ["sent_at"]);
await ensureIndex("team_messages", "team_message_employee_time", "key", ["employee_id", "sent_at"]);
await ensureIndex("team_messages", "team_message_employee_unread", "key", ["employee_id", "sender_role", "read_at"]);

await ensureTable("sales_deals", "Sales Deals");
for (const column of [
  ["employee_id", "varchar", 36, true],
  ["outlet_id", "varchar", 36, false],
  ["customer_name", "varchar", 160, true],
  ["title", "varchar", 160, true],
  ["stage", "varchar", 24, true],
  ["amount", "float", undefined, false],
  ["next_action", "varchar", 500, false],
  ["follow_up_at", "datetime", undefined, false],
  ["notes", "text", undefined, false],
  ["idempotency_key", "varchar", 64, true],
  ["updated_by", "varchar", 36, true],
]) await ensureColumn("sales_deals", column);
await ensureIndex("sales_deals", "deal_operation", "unique", ["idempotency_key"]);
await ensureIndex("sales_deals", "deal_employee_stage", "key", ["employee_id", "stage"]);
await ensureIndex("sales_deals", "deal_stage_follow_up", "key", ["stage", "follow_up_at"]);
await ensureIndex("sales_deals", "deal_outlet", "key", ["outlet_id"]);

console.log("migration 011 complete");
