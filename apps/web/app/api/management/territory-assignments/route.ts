import { randomUUID } from "node:crypto";
import { ID, Query } from "node-appwrite";
import { NextResponse } from "next/server";
import { createAdminTablesDb } from "@fieldops/appwrite/server";
import { requireManager } from "../../../../lib/auth";
import { text } from "../../../../lib/mobile-auth";

const databaseId = process.env.APPWRITE_DATABASE_ID ?? "fieldops";

export async function POST(request: Request) {
  const actor = await requireManager();
  if (!actor) return NextResponse.json({ error: "Manager access is required." }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const employeeId = text(body.employeeId, 36), territoryId = text(body.territoryId, 36);
  if (!employeeId || !territoryId) return NextResponse.json({ error: "Salesperson and territory are required." }, { status: 400 });
  const db = createAdminTablesDb();
  const [employee, territory, role] = await Promise.all([
    db.getRow({ databaseId, tableId: "employees", rowId: employeeId }).catch(() => null),
    db.getRow({ databaseId, tableId: "territories", rowId: territoryId }).catch(() => null),
    db.listRows({ databaseId, tableId: "roles", queries: [Query.equal("code", "sales_person"), Query.limit(1)] }).then((result) => result.rows[0]),
  ]);
  if (!employee || employee.status !== "active" || !territory || territory.active !== true || !role) return NextResponse.json({ error: "Select an active salesperson and territory." }, { status: 409 });
  const current = await activeAssignments(db, employeeId, territoryId);
  if (current.length > 0) return NextResponse.json({ ok: true, assignmentId: current[0]!.$id });
  const row = await db.createRow({ databaseId, tableId: "employee_assignments", rowId: ID.unique(), data: {
    employee_id: employeeId, role_id: role.$id, territory_id: territoryId,
    effective_from: new Date().toISOString(), assigned_by: actor.user.$id, reason: "Assigned from management dashboard",
  }, permissions: [] });
  await audit(db, actor.user.$id, "territory.assigned", territoryId, { employeeId, assignmentId: row.$id });
  return NextResponse.json({ ok: true, assignmentId: row.$id }, { status: 201 });
}

export async function DELETE(request: Request) {
  const actor = await requireManager();
  if (!actor) return NextResponse.json({ error: "Manager access is required." }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const employeeId = text(body.employeeId, 36), territoryId = text(body.territoryId, 36);
  if (!employeeId || !territoryId) return NextResponse.json({ error: "Salesperson and territory are required." }, { status: 400 });
  const db = createAdminTablesDb();
  const rows = await activeAssignments(db, employeeId, territoryId);
  const now = new Date().toISOString();
  for (const row of rows) await db.updateRow({ databaseId, tableId: "employee_assignments", rowId: row.$id, data: { effective_to: now } });
  const role = (await db.listRows({ databaseId, tableId: "roles", queries: [Query.equal("code", "sales_person"), Query.limit(1)] })).rows[0];
  if (role) {
    const employeeAssignments = await db.listRows({ databaseId, tableId: "employee_assignments", queries: [Query.equal("employee_id", employeeId), Query.equal("role_id", role.$id), Query.limit(100)] });
    const hasRoleOnly = employeeAssignments.rows.some((row) => !row.territory_id && !row.effective_to);
    if (!hasRoleOnly) await db.createRow({ databaseId, tableId: "employee_assignments", rowId: ID.unique(), data: {
      employee_id: employeeId, role_id: role.$id, effective_from: now, assigned_by: actor.user.$id, reason: "Role retained after territory removal",
    }, permissions: [] });
  }
  await audit(db, actor.user.$id, "territory.unassigned", territoryId, { employeeId, endedAssignments: rows.map((row) => row.$id) });
  return NextResponse.json({ ok: true, ended: rows.length });
}

async function activeAssignments(db: ReturnType<typeof createAdminTablesDb>, employeeId: string, territoryId: string) {
  const result = await db.listRows({ databaseId, tableId: "employee_assignments", queries: [
    Query.equal("employee_id", employeeId), Query.equal("territory_id", territoryId), Query.limit(100),
  ] });
  const now = Date.now();
  return result.rows.filter((row) => new Date(String(row.effective_from)).valueOf() <= now && (!row.effective_to || new Date(String(row.effective_to)).valueOf() > now));
}

async function audit(db: ReturnType<typeof createAdminTablesDb>, actorUserId: string, action: string, territoryId: string, after: object) {
  await db.createRow({ databaseId, tableId: "audit_logs", rowId: ID.unique(), data: {
    actor_user_id: actorUserId, action, entity_type: "territory", entity_id: territoryId,
    occurred_at: new Date().toISOString(), after_json: JSON.stringify(after), reason: "Management dashboard", correlation_id: randomUUID(),
  }, permissions: [] });
}
