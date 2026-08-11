import { createHash, randomUUID } from "node:crypto";
import { ID, Query } from "node-appwrite";
import { NextResponse } from "next/server";
import { createAdminTablesDb } from "@fieldops/appwrite/server";
import { parseTerritoryBoundary, pointInTerritory } from "@fieldops/domain";
import { requireManager } from "../../../../lib/auth";
import { number, text, workDate } from "../../../../lib/mobile-auth";
import { employeeHasTerritory, territoryAccessForEmployee } from "../../../../lib/territory-access";

const databaseId = process.env.APPWRITE_DATABASE_ID ?? "fieldops";
const stableId = (prefix: string, value: string) => `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;

export async function POST(request: Request) {
  const actor = await requireManager();
  if (!actor) return NextResponse.json({ error: "Manager access is required." }, { status: 403 });
  const body = await request.json();
  const code = text(body.code, 32).toUpperCase(), name = text(body.name, 160), address = text(body.address, 500);
  const latitude = number(body.latitude), longitude = number(body.longitude);
  const territoryId = text(body.territoryId, 36), employeeId = text(body.employeeId, 36);
  if (!code || !name || !address || latitude === null || longitude === null || Math.abs(latitude) > 90 || Math.abs(longitude) > 180 || !territoryId) {
    return NextResponse.json({ error: "Code, name, address, a map point, and territory are required." }, { status: 400 });
  }
  const db = createAdminTablesDb(), outletId = stableId("out", code);
  try {
    const territory = await db.getRow({ databaseId, tableId: "territories", rowId: territoryId });
    const boundary = parseTerritoryBoundary(territory.boundary);
    if (!boundary) return NextResponse.json({ error: "Draw and save this territory's map boundary before adding outlets to it." }, { status: 409 });
    if (!pointInTerritory({ latitude, longitude }, boundary)) return NextResponse.json({ error: `The selected point is outside ${territory.name}. Pick a point inside its shaded boundary.` }, { status: 422 });
    if (employeeId) {
      const access = await territoryAccessForEmployee(db, employeeId);
      if (access.restricted && !employeeHasTerritory(access, territoryId)) {
        return NextResponse.json({ error: "This salesperson has other territory assignments. Assign this territory to them before assigning its outlets." }, { status: 409 });
      }
    }
    await db.createRow({ databaseId, tableId: "outlets", rowId: outletId, data: {
      code, name, address, latitude, longitude, coordinates: [longitude, latitude], contact_name: text(body.contactName, 128), phone: text(body.phone, 32),
      status: "active", territory_id: territoryId, ...(employeeId ? { assigned_employee_id: employeeId } : {}),
      visit_frequency: text(body.visitFrequency, 32) || "weekly", notes: text(body.notes, 4000), created_by: actor.user.$id,
    }, permissions: [] });
    if (employeeId) {
      const routeId = stableId("route", `${workDate()}:${employeeId}:${outletId}`);
      const existing = await db.listRows({ databaseId, tableId: "route_assignments", queries: [
        Query.equal("work_date", [workDate()]), Query.equal("employee_id", [employeeId]), Query.limit(1), Query.orderDesc("sequence"),
      ] });
      await db.createRow({ databaseId, tableId: "route_assignments", rowId: routeId, data: {
        work_date: workDate(), employee_id: employeeId, outlet_id: outletId, sequence: Number(existing.rows[0]?.sequence ?? 0) + 1,
        status: "planned", assigned_by: actor.user.$id, published_at: new Date().toISOString(),
      }, permissions: [] });
    }
    await db.createRow({ databaseId, tableId: "audit_logs", rowId: ID.unique(), data: {
      actor_user_id: actor.user.$id, action: "outlet.created", entity_type: "outlet", entity_id: outletId,
      occurred_at: new Date().toISOString(), after_json: JSON.stringify({ code, employeeId, latitude, longitude }),
      reason: "Management dashboard", correlation_id: randomUUID(),
    }, permissions: [] });
    return NextResponse.json({ ok: true, outletId }, { status: 201 });
  } catch (error) {
    const codeValue = typeof error === "object" && error && "code" in error ? Number(error.code) : 500;
    return NextResponse.json({ error: codeValue === 409 ? "That outlet code already exists." : "The outlet could not be created." }, { status: codeValue === 409 ? 409 : 500 });
  }
}
