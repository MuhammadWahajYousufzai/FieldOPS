import { cookies, headers } from "next/headers";
import { createSessionAccount } from "@fieldops/appwrite/server";
import { Query } from "node-appwrite";
import { createAdminTablesDb } from "@fieldops/appwrite/server";

export const SESSION_COOKIE = `a_session_${process.env.APPWRITE_PROJECT_ID}`;

export async function currentUser() {
  const cookieStore = await cookies();
  const session = cookieStore.get(SESSION_COOKIE)?.value;
  if (!session) return null;
  try {
    const headerStore = await headers();
    return await createSessionAccount(session, headerStore.get("user-agent") ?? undefined).get();
  } catch {
    return null;
  }
}

export async function requireSuperAdmin() {
  const user = await currentUser();
  if (!user) return null;
  const databaseId = process.env.APPWRITE_DATABASE_ID ?? "fieldops";
  const db = createAdminTablesDb();
  const employeeResult = await db.listRows({ databaseId, tableId: "employees", queries: [Query.equal("user_id", user.$id), Query.limit(1)] });
  const employee = employeeResult.rows[0];
  if (!employee) return null;
  const assignmentResult = await db.listRows({ databaseId, tableId: "employee_assignments", queries: [Query.equal("employee_id", employee.$id), Query.limit(25)] });
  for (const assignment of assignmentResult.rows) {
    const role = await db.getRow({ databaseId, tableId: "roles", rowId: String(assignment.role_id) });
    if (role.code === "super_admin" && !assignment.effective_to) return { user, employee };
  }
  return null;
}
