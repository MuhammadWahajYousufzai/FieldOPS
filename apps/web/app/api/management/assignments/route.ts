import { Query } from "node-appwrite";
import { NextResponse } from "next/server";
import { createAdminTablesDb } from "@fieldops/appwrite/server";
import { requireDashboardAdmin } from "../../../../lib/auth";
import {
  isAppwriteConflict,
  isAppwriteNotFound,
  managementAuditIdentity,
  managementOperationKey,
  runManagementTransactionWithRetry,
  stableManagementId,
} from "../../../../lib/management-write";
import { text, workDate } from "../../../../lib/mobile-auth";
import { allocateRouteSequence } from "../../../../lib/route-sequence";
import { employeeHasTerritory, territoryAccessForEmployee } from "../../../../lib/territory-access";

const databaseId = process.env.APPWRITE_DATABASE_ID ?? "fieldops";

export async function POST(request: Request) {
  const actor = await requireDashboardAdmin();
  if (!actor) return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const outletId = text(body.outletId, 36), employeeId = text(body.employeeId, 36), date = text(body.workDate, 10) || workDate();
  if (!outletId || !employeeId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "Outlet, salesperson, and date are required." }, { status: 400 });
  }

  const db = createAdminTablesDb();
  const [outlet, employee] = await Promise.all([
    db.getRow({ databaseId, tableId: "outlets", rowId: outletId }).catch(() => null),
    db.getRow({ databaseId, tableId: "employees", rowId: employeeId }).catch(() => null),
  ]);
  if (!outlet || outlet.status !== "active") return NextResponse.json({ error: "Select an active outlet." }, { status: 409 });
  if (!employee || employee.status !== "active") return NextResponse.json({ error: "Select an active salesperson." }, { status: 409 });
  const access = await territoryAccessForEmployee(db, employeeId);
  if (access.restricted && !employeeHasTerritory(access, String(outlet.territory_id))) {
    return NextResponse.json({ error: "This outlet is outside the salesperson's assigned sales areas." }, { status: 409 });
  }

  const routeId = stableManagementId("route", `${date}:${employeeId}:${outletId}`);
  const existing = await getRoute(db, routeId);
  if (existing) return NextResponse.json({ ok: true, routeId, created: false, replayed: true });

  const operationKey = managementOperationKey(body.operationId, "outlet.assign", date, employeeId, outletId);
  const { auditId, correlationId } = managementAuditIdentity("outlet.assigned", routeId, operationKey);
  const now = new Date().toISOString();
  try {
    const created = await runManagementTransactionWithRetry(db, async (transactionId) => {
      if (await getRoute(db, routeId, transactionId)) return false;
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
      await db.createRow({ databaseId, tableId: "audit_logs", rowId: auditId, transactionId, data: {
        actor_user_id: actor.user.$id,
        action: "outlet.assigned",
        entity_type: "outlet",
        entity_id: outletId,
        occurred_at: now,
        after_json: JSON.stringify({ employeeId, date, routeId }),
        reason: "Management dashboard",
        correlation_id: correlationId,
      }, permissions: [] });
      return true;
    });
    if (!created) return NextResponse.json({ ok: true, routeId, created: false, replayed: true });
    return NextResponse.json({ ok: true, routeId, created: true, replayed: false }, { status: 201 });
  } catch (error) {
    if (isAppwriteConflict(error) && await getRoute(db, routeId).catch(() => null)) {
      return NextResponse.json({ ok: true, routeId, created: false, replayed: true });
    }
    if (isAppwriteConflict(error)) {
      return NextResponse.json({
        error: "The daily plan changed while this outlet was being assigned. Retry the assignment.",
        code: "route_sequence_conflict",
      }, { status: 409 });
    }
    return NextResponse.json({ error: "The outlet assignment could not be published. No partial assignment was saved; retrying is safe." }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const actor = await requireDashboardAdmin();
  if (!actor) return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const routeId = text(body.routeId, 36);
  if (!routeId) return NextResponse.json({ error: "Route assignment is required." }, { status: 400 });

  const db = createAdminTablesDb();
  const transaction = await db.createTransaction({ ttl: 60 });
  try {
    const route = await getRoute(db, routeId, transaction.$id);
    if (!route) {
      await db.updateTransaction({ transactionId: transaction.$id, rollback: true }).catch(() => undefined);
      return NextResponse.json({ ok: true, routeId, deleted: false, replayed: true });
    }
    if (route.status !== "planned") {
      await db.updateTransaction({ transactionId: transaction.$id, rollback: true }).catch(() => undefined);
      return routeNotPlannedResponse(route.status);
    }

    const outletId = String(route.outlet_id);
    const operationKey = managementOperationKey(body.operationId, "outlet.unassign", routeId, route.$updatedAt);
    const { auditId, correlationId } = managementAuditIdentity("outlet.assignment_unpublished", routeId, operationKey);
    const now = new Date().toISOString();
    const deletion = await db.deleteRows({
      databaseId,
      tableId: "route_assignments",
      queries: [Query.equal("$id", routeId), Query.equal("status", "planned")],
      transactionId: transaction.$id,
    });
    if (deletion.rows.length === 0) {
      const retained = await getRoute(db, routeId, transaction.$id);
      await db.updateTransaction({ transactionId: transaction.$id, rollback: true }).catch(() => undefined);
      return retained
        ? routeNotPlannedResponse(retained.status)
        : NextResponse.json({ ok: true, routeId, deleted: false, replayed: true });
    }
    await db.createRow({ databaseId, tableId: "audit_logs", rowId: auditId, transactionId: transaction.$id, data: {
      actor_user_id: actor.user.$id,
      action: "outlet.assignment_unpublished",
      entity_type: "outlet",
      entity_id: outletId,
      occurred_at: now,
      before_json: JSON.stringify({
        routeId,
        employeeId: route.employee_id,
        workDate: route.work_date,
        sequence: route.sequence,
        status: route.status,
      }),
      reason: text(body.reason, 1000) || "Removed from daily plan by management",
      correlation_id: correlationId,
    }, permissions: [] });
    await db.updateTransaction({ transactionId: transaction.$id, commit: true });
    return NextResponse.json({ ok: true, routeId, deleted: true, replayed: false });
  } catch (error) {
    await db.updateTransaction({ transactionId: transaction.$id, rollback: true }).catch(() => undefined);
    const latest = await getRoute(db, routeId).catch(() => null);
    if ((isAppwriteConflict(error) || isAppwriteNotFound(error)) && !latest) {
      return NextResponse.json({ ok: true, routeId, deleted: false, replayed: true });
    }
    if (isAppwriteConflict(error)) {
      if (latest?.status !== "planned") return routeNotPlannedResponse(latest?.status);
      return NextResponse.json({
        error: "The daily plan changed while this visit was being removed. Refresh and try again.",
        code: "route_assignment_changed",
      }, { status: 409 });
    }
    return NextResponse.json({ error: "The planned visit could not be removed. No partial change was saved; retrying is safe." }, { status: 500 });
  }
}

async function getRoute(db: ReturnType<typeof createAdminTablesDb>, routeId: string, transactionId?: string) {
  try {
    return await db.getRow({ databaseId, tableId: "route_assignments", rowId: routeId, ...(transactionId ? { transactionId } : {}) });
  } catch (error) {
    if (isAppwriteNotFound(error)) return null;
    throw error;
  }
}

function routeNotPlannedResponse(status: unknown) {
  return NextResponse.json({
    error: status === "completed"
      ? "Completed visits cannot be removed from the daily plan."
      : "Only a planned visit can be removed from the daily plan.",
    code: "route_assignment_not_planned",
  }, { status: 409 });
}
