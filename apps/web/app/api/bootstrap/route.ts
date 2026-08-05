import { createHash, timingSafeEqual } from "node:crypto";
import { ID, Permission, Query, Role } from "node-appwrite";
import { NextResponse } from "next/server";
import { permissions } from "@fieldops/domain";
import { createAdminTablesDb, createAdminUsers } from "@fieldops/appwrite/server";

const databaseId = process.env.APPWRITE_DATABASE_ID ?? "fieldops";
const stableId = (prefix: string, value: string) => `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
const safeToken = (candidate: unknown) => {
  const expected = process.env.FIELDOPS_BOOTSTRAP_TOKEN;
  if (!expected || typeof candidate !== "string") return false;
  const a = Buffer.from(candidate); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

export async function GET() {
  const users = await createAdminUsers().list({ queries: [Query.limit(1)] });
  return NextResponse.json({ required: users.total === 0 });
}

export async function POST(request: Request) {
  const body = await request.json();
  if (!safeToken(body.bootstrapToken)) return NextResponse.json({ error: "Bootstrap key is invalid." }, { status: 403 });
  if (typeof body.name !== "string" || body.name.trim().length < 2) return NextResponse.json({ error: "Enter your name." }, { status: 400 });
  if (typeof body.email !== "string" || !body.email.includes("@")) return NextResponse.json({ error: "Enter a valid email." }, { status: 400 });
  if (typeof body.password !== "string" || body.password.length < 12) return NextResponse.json({ error: "Use at least 12 characters for the password." }, { status: 400 });

  const users = createAdminUsers();
  if ((await users.list({ queries: [Query.limit(1)] })).total !== 0) {
    return NextResponse.json({ error: "FieldOps has already been initialized." }, { status: 409 });
  }

  const db = createAdminTablesDb();
  const user = await users.create({ userId: ID.unique(), email: body.email.trim().toLowerCase(), password: body.password, name: body.name.trim() });
  const rowPermissions = [Permission.read(Role.user(user.$id))];
  const organizationId = stableId("org", "yousuf-rice");
  const roleId = stableId("role", "super_admin");
  const employeeId = stableId("emp", user.$id);
  const now = new Date().toISOString();

  await db.createRow({ databaseId, tableId: "organizations", rowId: organizationId, data: { name: "Yousuf Rice", legal_name: "Yousuf Rice", timezone: "Asia/Karachi", currency: "PKR", active: true }, permissions: rowPermissions });
  await db.createRow({ databaseId, tableId: "roles", rowId: roleId, data: { code: "super_admin", name: "Super admin", system: true, active: true }, permissions: rowPermissions });
  await db.createRow({ databaseId, tableId: "employees", rowId: employeeId, data: { user_id: user.$id, employee_code: "YR-0001", display_name: user.name, status: "active", joining_date: now }, permissions: rowPermissions });

  for (const code of permissions) {
    const permissionId = stableId("perm", code);
    await db.createRow({ databaseId, tableId: "permissions", rowId: permissionId, data: { code, description: code.replaceAll(":", " "), sensitive: /location|export|audit|approve|payments/.test(code) }, permissions: rowPermissions });
    await db.createRow({ databaseId, tableId: "role_permissions", rowId: stableId("grant", `${roleId}:${permissionId}`), data: { role_id: roleId, permission_id: permissionId, granted_by: user.$id, granted_at: now }, permissions: rowPermissions });
  }
  await db.createRow({ databaseId, tableId: "employee_assignments", rowId: ID.unique(), data: { employee_id: employeeId, role_id: roleId, effective_from: now, assigned_by: user.$id, reason: "Initial secure bootstrap" }, permissions: rowPermissions });
  await db.createRow({ databaseId, tableId: "audit_logs", rowId: ID.unique(), data: { actor_user_id: user.$id, action: "system.bootstrap", entity_type: "organization", entity_id: organizationId, occurred_at: now, after_json: JSON.stringify({ organizationId, employeeId, role: "super_admin" }), reason: "Initial secure bootstrap", correlation_id: crypto.randomUUID() }, permissions: rowPermissions });
  return NextResponse.json({ ok: true }, { status: 201 });
}
