import type { Models } from "node-appwrite";
import { NextResponse } from "next/server";
import { createAdminTablesDb } from "@fieldops/appwrite/server";
import { parseTerritoryBoundary, pointInTerritory } from "@fieldops/domain";
import { requireDashboardAdmin } from "../../../../lib/auth";
import {
  isAppwriteConflict,
  isAppwriteNotFound,
  managementAuditIdentity,
  managementOperationKey,
  runManagementTransactionWithRetry,
  stableManagementId,
} from "../../../../lib/management-write";
import { number, text, workDate } from "../../../../lib/mobile-auth";
import { allocateRouteSequence } from "../../../../lib/route-sequence";
import { employeeHasTerritory, territoryAccessForEmployee } from "../../../../lib/territory-access";

const databaseId = process.env.APPWRITE_DATABASE_ID ?? "fieldops";

export async function POST(request: Request) {
  const actor = await requireDashboardAdmin();
  if (!actor) return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const code = text(body.code, 32).toUpperCase(), name = text(body.name, 160), address = text(body.address, 500);
  const latitude = number(body.latitude), longitude = number(body.longitude);
  const territoryId = text(body.territoryId, 36), employeeId = text(body.employeeId, 36);
  const contactName = text(body.contactName, 128), phone = text(body.phone, 32);
  const visitFrequency = text(body.visitFrequency, 32) || "weekly", notes = text(body.notes, 4000);
  if (!code || !name || !address || latitude === null || longitude === null || Math.abs(latitude) > 90 || Math.abs(longitude) > 180 || !territoryId) {
    return NextResponse.json({ error: "Code, name, address, a map point, and territory are required." }, { status: 400 });
  }

  const db = createAdminTablesDb();
  const outletId = stableManagementId("out", code);
  const date = workDate();
  const routeId = employeeId ? stableManagementId("route", `${date}:${employeeId}:${outletId}`) : "";
  try {
    const territory = await db.getRow({ databaseId, tableId: "territories", rowId: territoryId });
    const boundary = territory.active === true ? parseTerritoryBoundary(territory.boundary) : null;
    if (!boundary) return NextResponse.json({ error: "Draw and save this active territory's map boundary before adding outlets to it." }, { status: 409 });
    if (!pointInTerritory({ latitude, longitude }, boundary)) {
      return NextResponse.json({ error: `The selected point is outside ${territory.name}. Pick a point inside its shaded boundary.` }, { status: 422 });
    }
    if (employeeId) {
      const employee = await db.getRow({ databaseId, tableId: "employees", rowId: employeeId }).catch(() => null);
      if (!employee || employee.status !== "active") return NextResponse.json({ error: "Select an active salesperson." }, { status: 409 });
      const access = await territoryAccessForEmployee(db, employeeId);
      if (access.restricted && !employeeHasTerritory(access, territoryId)) {
        return NextResponse.json({ error: "This salesperson has other territory assignments. Assign this territory to them before assigning its outlets." }, { status: 409 });
      }
    }

    const existingOutlet = await getRowOrNull(db, "outlets", outletId);
    const requestedOutlet = { code, name, address, latitude, longitude, territoryId, employeeId, contactName, phone, visitFrequency, notes };
    if (existingOutlet && !sameOutletRequest(existingOutlet, requestedOutlet)) {
      return NextResponse.json({ error: "That outlet code already exists with different details." }, { status: 409 });
    }
    const existingRoute = routeId ? await getRowOrNull(db, "route_assignments", routeId) : null;
    if (existingOutlet && (!routeId || existingRoute)) {
      return NextResponse.json({ ok: true, outletId, ...(routeId ? { routeId } : {}), created: false, replayed: true });
    }

    const operationKey = managementOperationKey(body.operationId, "outlet.create", code);
    const action = existingOutlet ? "outlet.assignment_reconciled" : "outlet.created";
    const { auditId, correlationId } = managementAuditIdentity(action, outletId, operationKey);
    const now = new Date().toISOString();

    await runManagementTransactionWithRetry(db, async (transactionId) => {
      const routeInTransaction = routeId
        ? await getRowOrNull(db, "route_assignments", routeId, transactionId)
        : null;
      if (!existingOutlet) {
        await db.createRow({ databaseId, tableId: "outlets", rowId: outletId, transactionId, data: {
          code,
          name,
          address,
          latitude,
          longitude,
          coordinates: [longitude, latitude],
          contact_name: contactName,
          phone,
          status: "active",
          territory_id: territoryId,
          ...(employeeId ? { assigned_employee_id: employeeId } : {}),
          visit_frequency: visitFrequency,
          notes,
          created_by: actor.user.$id,
        }, permissions: [] });
      }
      if (routeId && !routeInTransaction) {
        const sequence = await allocateRouteSequence(db, databaseId, employeeId, date, transactionId);
        await db.createRow({ databaseId, tableId: "route_assignments", rowId: routeId, transactionId, data: {
          work_date: date,
          employee_id: employeeId,
          outlet_id: outletId,
          sequence,
          status: "planned",
          assigned_by: actor.user.$id,
          published_at: now,
        }, permissions: [] });
      }
      await db.createRow({ databaseId, tableId: "audit_logs", rowId: auditId, transactionId, data: {
        actor_user_id: actor.user.$id,
        action,
        entity_type: "outlet",
        entity_id: outletId,
        occurred_at: now,
        after_json: JSON.stringify({ code, employeeId, latitude, longitude, routeId: routeId || null }),
        reason: existingOutlet ? "Reconciled an interrupted management outlet assignment" : "Management dashboard",
        correlation_id: correlationId,
      }, permissions: [] });
    });
    return NextResponse.json({
      ok: true,
      outletId,
      ...(routeId ? { routeId } : {}),
      created: !existingOutlet,
      replayed: false,
      reconciled: Boolean(existingOutlet),
    }, { status: existingOutlet ? 200 : 201 });
  } catch (error) {
    if (isAppwriteConflict(error)) {
      const outlet = await getRowOrNull(db, "outlets", outletId).catch(() => null);
      const route = routeId ? await getRowOrNull(db, "route_assignments", routeId).catch(() => null) : true;
      if (outlet && route && sameOutletRequest(outlet, { code, name, address, latitude, longitude, territoryId, employeeId, contactName, phone, visitFrequency, notes })) {
        return NextResponse.json({ ok: true, outletId, ...(routeId ? { routeId } : {}), created: false, replayed: true });
      }
      if (outlet && sameOutletRequest(outlet, { code, name, address, latitude, longitude, territoryId, employeeId, contactName, phone, visitFrequency, notes })) {
        return NextResponse.json({
          error: "The outlet was saved, but today’s plan changed at the same time. Retry to publish its assignment.",
          code: "route_sequence_conflict",
        }, { status: 409 });
      }
      return NextResponse.json({ error: "That outlet code already exists with different details." }, { status: 409 });
    }
    return NextResponse.json({ error: "The outlet could not be created. No partial outlet or assignment was saved; retrying is safe." }, { status: 500 });
  }
}

async function getRowOrNull(
  db: ReturnType<typeof createAdminTablesDb>,
  tableId: string,
  rowId: string,
  transactionId?: string,
) {
  try {
    return await db.getRow({ databaseId, tableId, rowId, ...(transactionId ? { transactionId } : {}) });
  } catch (error) {
    if (isAppwriteNotFound(error)) return null;
    throw error;
  }
}

function sameOutletRequest(outlet: Models.Row & Record<string, unknown>, expected: {
  code: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  territoryId: string;
  employeeId: string;
  contactName: string;
  phone: string;
  visitFrequency: string;
  notes: string;
}) {
  return outlet.status === "active"
    && String(outlet.code) === expected.code
    && String(outlet.name).trim() === expected.name.trim()
    && String(outlet.address).trim() === expected.address.trim()
    && Number(outlet.latitude) === expected.latitude
    && Number(outlet.longitude) === expected.longitude
    && String(outlet.territory_id) === expected.territoryId
    && String(outlet.assigned_employee_id ?? "") === expected.employeeId
    && String(outlet.contact_name ?? "") === expected.contactName
    && String(outlet.phone ?? "") === expected.phone
    && String(outlet.visit_frequency ?? "") === expected.visitFrequency
    && String(outlet.notes ?? "") === expected.notes;
}
