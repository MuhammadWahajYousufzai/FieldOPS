import { createHash, randomUUID } from "node:crypto";
import { parseTerritoryBoundary } from "@fieldops/domain";
import { ID, Query } from "node-appwrite";
import { NextResponse } from "next/server";
import { createAdminTablesDb } from "@fieldops/appwrite/server";
import { requireManager } from "../../../../lib/auth";
import { text } from "../../../../lib/mobile-auth";

const databaseId = process.env.APPWRITE_DATABASE_ID ?? "fieldops";
const stableId = (prefix: string, value: string) => `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;

export async function POST(request: Request) {
  const actor = await requireManager();
  if (!actor) return NextResponse.json({ error: "Manager access is required." }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const name = text(body.name, 128);
  const boundary = parseTerritoryBoundary(body.boundary);
  const employeeIds = sanitizeIds(body.employeeIds);
  if (!name || !boundary) {
    return NextResponse.json({ error: "A name and closed map boundary with at least three points are required." }, { status: 400 });
  }
  const db = createAdminTablesDb();
  try {
    const area = (await db.listRows({ databaseId, tableId: "areas", queries: [Query.equal("active", true), Query.orderAsc("$createdAt"), Query.limit(1)] })).rows[0];
    if (!area) return NextResponse.json({ error: "Organization geography must be set up before creating a territory." }, { status: 409 });
    const areaId = area.$id;
    const code = `TER-${createHash("sha256").update(`${areaId}:${name.trim().toLowerCase()}`).digest("hex").slice(0, 10).toUpperCase()}`;
    const territoryId = stableId("ter", `${areaId}:${code}`);
    await db.createRow({ databaseId, tableId: "territories", rowId: territoryId, data: {
      area_id: areaId, code, name, boundary: boundary.coordinates, active: true,
    }, permissions: [] });
    const salesRole = (await db.listRows({ databaseId, tableId: "roles", queries: [Query.equal("code", "sales_person"), Query.limit(1)] })).rows[0];
    if (!salesRole) throw new Error("Sales role is not configured");
    for (const employeeId of employeeIds) {
      const employee = await db.getRow({ databaseId, tableId: "employees", rowId: employeeId });
      if (employee.status !== "active") continue;
      await db.createRow({ databaseId, tableId: "employee_assignments", rowId: ID.unique(), data: {
        employee_id: employeeId, role_id: salesRole.$id, territory_id: territoryId,
        effective_from: new Date().toISOString(), assigned_by: actor.user.$id, reason: "Assigned when territory was created",
      }, permissions: [] });
    }
    await audit(db, actor.user.$id, "territory.created", territoryId, { code, areaId, employeeIds });
    return NextResponse.json({ ok: true, territoryId }, { status: 201 });
  } catch (error) {
    const codeValue = typeof error === "object" && error && "code" in error ? Number(error.code) : 500;
    return NextResponse.json({ error: codeValue === 409 ? "A territory with that name already exists." : "The territory could not be created." }, { status: codeValue === 409 ? 409 : 500 });
  }
}

export async function PATCH(request: Request) {
  const actor = await requireManager();
  if (!actor) return NextResponse.json({ error: "Manager access is required." }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const territoryId = text(body.territoryId, 36), boundary = parseTerritoryBoundary(body.boundary);
  if (!territoryId || !boundary) return NextResponse.json({ error: "Territory and a valid closed map boundary are required." }, { status: 400 });
  const db = createAdminTablesDb();
  try {
    const before = await db.getRow({ databaseId, tableId: "territories", rowId: territoryId });
    await db.updateRow({ databaseId, tableId: "territories", rowId: territoryId, data: { boundary: boundary.coordinates } });
    await audit(db, actor.user.$id, "territory.boundary_updated", territoryId, { code: before.code });
    return NextResponse.json({ ok: true, territoryId });
  } catch {
    return NextResponse.json({ error: "The territory boundary could not be updated." }, { status: 500 });
  }
}

function sanitizeIds(value: unknown) {
  return Array.isArray(value) ? [...new Set(value.map((item) => text(item, 36)).filter(Boolean))].slice(0, 100) : [];
}

async function audit(db: ReturnType<typeof createAdminTablesDb>, actorUserId: string, action: string, territoryId: string, after: object) {
  await db.createRow({ databaseId, tableId: "audit_logs", rowId: ID.unique(), data: {
    actor_user_id: actorUserId, action, entity_type: "territory", entity_id: territoryId,
    occurred_at: new Date().toISOString(), after_json: JSON.stringify(after), reason: "Management dashboard", correlation_id: randomUUID(),
  }, permissions: [] });
}
