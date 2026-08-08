import { Query } from "node-appwrite";
import { createAdminTablesDb, createSessionAccount } from "@fieldops/appwrite/server";

const databaseId = process.env.APPWRITE_DATABASE_ID ?? "fieldops";

export async function mobileActor(request: Request) {
  const header = request.headers.get("authorization") ?? "";
  const session = header.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!session) return null;
  try {
    const user = await createSessionAccount(session, request.headers.get("user-agent") ?? undefined).get();
    const result = await createAdminTablesDb().listRows({
      databaseId,
      tableId: "employees",
      queries: [Query.equal("user_id", user.$id), Query.equal("status", "active"), Query.limit(1)],
    });
    const employee = result.rows[0];
    return employee ? { user, employee, session } : null;
  } catch {
    return null;
  }
}

export function workDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Karachi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function number(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function text(value: unknown, max = 500) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
