import { Client, Storage, TablesDB } from "../packages/appwrite/node_modules/node-appwrite/dist/index.mjs";

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
const storage = new Storage(client);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const tables = [
  {
    id: "outlets",
    name: "Outlets",
    columns: [
      ["code", "varchar", 32, true], ["name", "varchar", 160, true],
      ["address", "varchar", 500, true], ["latitude", "float", true], ["longitude", "float", true], ["coordinates", "point", true],
      ["contact_name", "varchar", 128, false], ["phone", "varchar", 32, false],
      ["status", "varchar", 24, true], ["territory_id", "varchar", 36, true],
      ["assigned_employee_id", "varchar", 36, false], ["visit_frequency", "varchar", 32, true],
      ["notes", "text", false], ["created_by", "varchar", 36, true],
    ],
    indexes: [
      ["outlet_code", "unique", ["code"]], ["outlet_status", "key", ["status"]],
      ["outlet_employee", "key", ["assigned_employee_id", "status"]],
      ["outlet_territory", "key", ["territory_id", "status"]],
    ],
  },
  {
    id: "route_assignments",
    name: "Route Assignments",
    columns: [
      ["work_date", "varchar", 10, true], ["employee_id", "varchar", 36, true],
      ["outlet_id", "varchar", 36, true], ["sequence", "integer", true],
      ["status", "varchar", 24, true], ["assigned_by", "varchar", 36, true],
      ["published_at", "datetime", true], ["completed_at", "datetime", false],
    ],
    indexes: [
      ["route_unique", "unique", ["work_date", "employee_id", "outlet_id"]],
      ["route_employee_date", "key", ["employee_id", "work_date", "sequence"]],
      ["route_date_status", "key", ["work_date", "status"]],
    ],
  },
  {
    id: "attendance_records",
    name: "Attendance Records",
    columns: [
      ["employee_id", "varchar", 36, true], ["work_date", "varchar", 10, true],
      ["check_in_at", "datetime", true], ["check_out_at", "datetime", false],
      ["check_in_latitude", "float", true], ["check_in_longitude", "float", true],
      ["check_in_accuracy", "float", true], ["check_out_latitude", "float", false],
      ["check_out_longitude", "float", false], ["check_out_accuracy", "float", false],
      ["status", "varchar", 24, true], ["idempotency_key", "varchar", 64, true],
    ],
    indexes: [
      ["attendance_idempotency", "unique", ["idempotency_key"]],
      ["attendance_employee_date", "unique", ["employee_id", "work_date"]],
      ["attendance_date_status", "key", ["work_date", "status"]],
    ],
  },
  {
    id: "visits",
    name: "Outlet Visits",
    columns: [
      ["employee_id", "varchar", 36, true], ["outlet_id", "varchar", 36, true],
      ["route_assignment_id", "varchar", 36, false], ["work_date", "varchar", 10, true],
      ["visit_type", "varchar", 24, false], ["customer_name", "varchar", 160, false],
      ["customer_address", "varchar", 500, false],
      ["check_in_at", "datetime", true], ["check_out_at", "datetime", false],
      ["latitude", "float", true], ["longitude", "float", true], ["coordinates", "point", true], ["accuracy", "float", true],
      ["geofence_distance_m", "integer", true], ["geofence_accepted", "boolean", true],
      ["completion_distance_m", "integer", false],
      ["outcome", "varchar", 48, false], ["notes", "text", false],
      ["order_amount", "float", false], ["status", "varchar", 24, true],
      ["idempotency_key", "varchar", 64, true], ["device_captured_at", "datetime", true],
    ],
    indexes: [
      ["visit_idempotency", "unique", ["idempotency_key"]],
      ["visit_employee_date", "key", ["employee_id", "work_date"]],
      ["visit_outlet_date", "key", ["outlet_id", "work_date"]],
      ["visit_date_status", "key", ["work_date", "status"]],
    ],
  },
  {
    id: "visit_evidence",
    name: "Visit Evidence",
    columns: [
      ["visit_id", "varchar", 36, true], ["employee_id", "varchar", 36, true],
      ["outlet_id", "varchar", 36, true], ["type", "varchar", 16, true],
      ["file_id", "varchar", 36, true], ["filename", "varchar", 255, true],
      ["mime_type", "varchar", 96, true], ["captured_at", "datetime", true],
      ["latitude", "float", true], ["longitude", "float", true], ["accuracy", "float", true],
    ],
    indexes: [
      ["evidence_visit", "key", ["visit_id", "captured_at"]],
      ["evidence_employee", "key", ["employee_id", "captured_at"]],
    ],
  },
  {
    id: "location_points",
    name: "Location Points",
    columns: [
      ["employee_id", "varchar", 36, true], ["visit_id", "varchar", 36, false],
      ["captured_at", "datetime", true], ["received_at", "datetime", true],
      ["latitude", "float", true], ["longitude", "float", true], ["accuracy", "float", true],
      ["source", "varchar", 24, true],
    ],
    indexes: [
      ["location_employee_time", "key", ["employee_id", "captured_at"]],
      ["location_visit_time", "key", ["visit_id", "captured_at"]],
    ],
  },
];

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

async function createColumn(tableId, column) {
  const [key, type, sizeOrRequired, required] = column;
  const base = { databaseId, tableId, key };
  if (type === "varchar") await db.createVarcharColumn({ ...base, size: sizeOrRequired, required });
  if (type === "text") await db.createTextColumn({ ...base, required: sizeOrRequired });
  if (type === "boolean") await db.createBooleanColumn({ ...base, required: sizeOrRequired });
  if (type === "datetime") await db.createDatetimeColumn({ ...base, required: sizeOrRequired });
  if (type === "integer") await db.createIntegerColumn({ ...base, required: sizeOrRequired });
  if (type === "float") await db.createFloatColumn({ ...base, required: sizeOrRequired });
  if (type === "point") await db.createPointColumn({ ...base, required: sizeOrRequired });
  await waitForColumn(tableId, key);
}

for (const table of tables) {
  if (!(await exists(() => db.getTable({ databaseId, tableId: table.id })))) {
    await db.createTable({ databaseId, tableId: table.id, name: table.name, permissions: [], rowSecurity: true, enabled: true });
    console.log(`created table ${table.id}`);
  }
  for (const column of table.columns) {
    if (await exists(() => db.getColumn({ databaseId, tableId: table.id, key: column[0] }))) continue;
    await createColumn(table.id, column);
    console.log(`created column ${table.id}.${column[0]}`);
  }
  for (const [key, type, columns] of table.indexes) {
    if (await exists(() => db.getIndex({ databaseId, tableId: table.id, key }))) continue;
    await db.createIndex({ databaseId, tableId: table.id, key, type: type === "unique" ? "unique" : "key", columns });
    console.log(`created index ${table.id}.${key}`);
  }
}

if (!(await exists(() => storage.getBucket({ bucketId: "visit-evidence" })))) {
  await storage.createBucket({
    bucketId: "visit-evidence",
    name: "Visit Evidence",
    permissions: [],
    fileSecurity: true,
    enabled: true,
    maximumFileSize: 20 * 1024 * 1024,
    allowedFileExtensions: ["jpg", "jpeg", "png", "heic", "m4a", "aac", "wav", "mp3", "webm"],
    compression: "gzip",
    encryption: true,
    antivirus: true,
  });
  console.log("created bucket visit-evidence");
}

console.log("migration 002 complete");
