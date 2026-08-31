import { Query } from "node-appwrite";
import { createAdminTablesDb, createSessionAccount } from "@fieldops/appwrite/server";
import { FIELD_SALESPERSON_ROLE, hasEffectiveRoleAssignment } from "./mobile-authorization";
import { listAllRowsChecked } from "./table-data";

const databaseId = process.env.APPWRITE_DATABASE_ID ?? "fieldops";
type AdminTablesDb = ReturnType<typeof createAdminTablesDb>;

export async function mobileActor(request: Request) {
  const header = request.headers.get("authorization") ?? "";
  const session = header.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!session) return null;
  let user;
  try {
    user = await createSessionAccount(session, request.headers.get("user-agent") ?? undefined).get();
  } catch (error) {
    const status = typeof error === "object" && error !== null && "code" in error ? Number(error.code) : 0;
    if (status === 401) return null;
    throw error;
  }
  const db = createAdminTablesDb();
  const employee = await activeSalespersonEmployeeForUser(user.$id, db);
  return employee ? { user, employee, session } : null;
}

export async function activeSalespersonEmployeeForUser(userId: string, db: AdminTablesDb = createAdminTablesDb()) {
  const result = await db.listRows({
    databaseId,
    tableId: "employees",
    queries: [Query.equal("user_id", userId), Query.equal("status", "active"), Query.limit(1)],
  });
  const employee = result.rows[0];
  if (!employee) return null;
  return await employeeHasEffectiveRole(employee.$id, FIELD_SALESPERSON_ROLE, db)
    ? employee
    : null;
}

export async function employeeHasEffectiveRole(
  employeeId: string,
  roleCode: string,
  db: AdminTablesDb = createAdminTablesDb(),
) {
  const role = (await db.listRows({
    databaseId,
    tableId: "roles",
    queries: [Query.equal("code", roleCode), Query.equal("active", true), Query.limit(1)],
  })).rows[0];
  if (!role) return false;
  const assignments = await listAllRowsChecked(
    db,
    databaseId,
    "employee_assignments",
    [Query.equal("employee_id", employeeId)],
    1_000,
  );
  return hasEffectiveRoleAssignment(assignments, role.$id, Date.now());
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
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function text(value: unknown, max = 500) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
