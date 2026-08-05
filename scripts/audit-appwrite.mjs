import { Client, Storage, TablesDB, Teams, Users } from "../packages/appwrite/node_modules/node-appwrite/dist/index.mjs";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

const client = new Client()
  .setEndpoint(required("APPWRITE_ENDPOINT"))
  .setProject(required("APPWRITE_PROJECT_ID"))
  .setKey(required("APPWRITE_API_KEY"));

const checks = [
  ["databases", new TablesDB(client).list(), "databases"],
  ["buckets", new Storage(client).listBuckets(), "buckets"],
  ["teams", new Teams(client).list(), "teams"],
  ["users", new Users(client).list(), "users"],
];

for (const [name, request, collection] of checks) {
  try {
    const result = await request;
    console.log(JSON.stringify({
      name,
      total: result.total,
      resources: (result[collection] ?? []).map((item) => ({ id: item.$id, name: item.name })),
    }));
  } catch (error) {
    console.log(JSON.stringify({ name, code: error.code, type: error.type, message: error.message }));
  }
}

const databaseId = process.env.APPWRITE_DATABASE_ID;
if (databaseId) {
  try {
    const tables = await new TablesDB(client).listTables({ databaseId });
    console.log(JSON.stringify({
      name: "tables",
      total: tables.total,
      resources: tables.tables.map((table) => ({
        id: table.$id,
        name: table.name,
        enabled: table.enabled,
        rowSecurity: table.rowSecurity,
        permissions: table.$permissions,
        columns: table.columns.length,
        indexes: table.indexes.length,
      })),
    }));
  } catch (error) {
    console.log(JSON.stringify({ name: "tables", code: error.code, type: error.type, message: error.message }));
  }
}
