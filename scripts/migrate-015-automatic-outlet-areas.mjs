import { Client, TablesDB } from "../packages/appwrite/node_modules/node-appwrite/dist/index.mjs";

const required = (name) => {
  if (!process.env[name]) throw new Error(`Missing ${name}`);
  return process.env[name];
};
const databaseId = required("APPWRITE_DATABASE_ID");
const db = new TablesDB(new Client()
  .setEndpoint(required("APPWRITE_ENDPOINT"))
  .setProject(required("APPWRITE_PROJECT_ID"))
  .setKey(required("APPWRITE_API_KEY")));
const target = { databaseId, tableId: "outlets", key: "territory_id" };
const before = await db.getColumn(target);
if (before.required) await db.updateVarcharColumn({ ...target, required: false, xdefault: null });
for (let attempt = 0; attempt < 80; attempt += 1) {
  const column = await db.getColumn(target);
  if (column.status === "available" && column.required === false) {
    console.log("migration 015 complete: outlets can be saved before a sales area covers their location");
    process.exit(0);
  }
  if (column.status === "failed") throw new Error(`Updating outlets.territory_id failed: ${column.error}`);
  await new Promise((resolve) => setTimeout(resolve, 500));
}
throw new Error("Timed out updating outlets.territory_id");
