import { createHash, randomUUID } from "node:crypto";
import { ID, Query } from "node-appwrite";
import { NextResponse } from "next/server";
import { createAdminTablesDb, createAdminUsers } from "@fieldops/appwrite/server";
import { requireManager } from "../../../../lib/auth";
import { text } from "../../../../lib/mobile-auth";

const databaseId = process.env.APPWRITE_DATABASE_ID ?? "fieldops";
const stableId = (prefix: string, value: string) => `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;

export async function POST(request: Request) {
  const actor = await requireManager();
  if (!actor) return NextResponse.json({ error: "Manager access is required." }, { status: 403 });
  const body = await request.json();
  const name = text(body.name, 128), email = text(body.email, 320).toLowerCase(), employeeCode = text(body.employeeCode, 32).toUpperCase();
  const password = text(body.password, 256);
  if (!name || !email.includes("@") || !employeeCode || password.length < 8) {
    return NextResponse.json({ error: "Name, email, employee code, and a separate 8+ character salesperson password are required." }, { status: 400 });
  }
  const db = createAdminTablesDb();
  try {
    const user = await createAdminUsers().create({ userId: ID.unique(), email, password, name });
    const employeeId = stableId("emp", user.$id);
    const role = (await db.listRows({ databaseId, tableId: "roles", queries: [Query.equal("code", "sales_person"), Query.limit(1)] })).rows[0];
    if (!role) throw new Error("Sales role is not configured");
    await db.createRow({ databaseId, tableId: "employees", rowId: employeeId, data: {
      user_id: user.$id, employee_code: employeeCode, display_name: name, manager_employee_id: actor.employee.$id,
      status: "active", joining_date: new Date().toISOString(),
    }, permissions: [] });
    await db.createRow({ databaseId, tableId: "employee_assignments", rowId: ID.unique(), data: {
      employee_id: employeeId, role_id: role.$id,
      effective_from: new Date().toISOString(), assigned_by: actor.user.$id, reason: "Created from management dashboard",
    }, permissions: [] });
    await db.createRow({ databaseId, tableId: "audit_logs", rowId: ID.unique(), data: {
      actor_user_id: actor.user.$id, action: "employee.created", entity_type: "employee", entity_id: employeeId,
      occurred_at: new Date().toISOString(), after_json: JSON.stringify({ email, employeeCode }),
      reason: "Management dashboard", correlation_id: randomUUID(),
    }, permissions: [] });
    return NextResponse.json({ ok: true, employeeId }, { status: 201 });
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? Number(error.code) : 500;
    return NextResponse.json({ error: code === 409 ? "That email or employee code already exists." : "The salesperson could not be created." }, { status: code === 409 ? 409 : 500 });
  }
}
