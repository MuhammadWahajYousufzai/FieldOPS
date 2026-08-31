import { Query, type Models } from "node-appwrite";
import { NextResponse } from "next/server";
import { createAdminTablesDb } from "@fieldops/appwrite/server";
import { requireDashboardAdmin } from "../../../../lib/auth";
import {
  isAppwriteConflict,
  managementAuditIdentity,
  managementOperationKey,
  removalLeavesUnrestricted,
  runManagementTransaction,
  stableManagementId,
} from "../../../../lib/management-write";
import { text } from "../../../../lib/mobile-auth";
import { listAllRowsChecked } from "../../../../lib/table-data";

const databaseId = process.env.APPWRITE_DATABASE_ID ?? "fieldops";

export async function POST(request: Request) {
  const actor = await requireDashboardAdmin();
  if (!actor) return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const employeeId = text(body.employeeId, 36), territoryId = text(body.territoryId, 36);
  if (!employeeId || !territoryId) return NextResponse.json({ error: "Salesperson and sales area are required." }, { status: 400 });
  const db = createAdminTablesDb();
  const [employee, territory, role] = await Promise.all([
    db.getRow({ databaseId, tableId: "employees", rowId: employeeId }).catch(() => null),
    db.getRow({ databaseId, tableId: "territories", rowId: territoryId }).catch(() => null),
    salesRole(db),
  ]);
  if (!employee || employee.status !== "active" || !territory || territory.active !== true || !role) {
    return NextResponse.json({ error: "Select an active salesperson and sales area." }, { status: 409 });
  }

  const history = await assignmentRows(db, employeeId, territoryId);
  const roleHistory = history.filter((row) => String(row.role_id) === role.$id);
  const current = activeRows(roleHistory);
  if (current.length > 0) {
    return NextResponse.json({ ok: true, assignmentId: current[0]!.$id, created: false, replayed: true });
  }

  const previousEnd = latestEnd(roleHistory);
  const operationKey = managementOperationKey(body.operationId, "territory.assign", employeeId, territoryId, previousEnd || "initial");
  const assignmentId = stableManagementId("assign", operationKey, role.$id);
  const { auditId, correlationId } = managementAuditIdentity("territory.assigned", assignmentId, operationKey);
  const now = new Date().toISOString();
  try {
    await runManagementTransaction(db, async (transactionId) => {
      await db.createRow({ databaseId, tableId: "employee_assignments", rowId: assignmentId, transactionId, data: {
        employee_id: employeeId,
        role_id: role.$id,
        territory_id: territoryId,
        effective_from: now,
        assigned_by: actor.user.$id,
        reason: "Assigned from management dashboard",
      }, permissions: [] });
      await db.createRow({ databaseId, tableId: "audit_logs", rowId: auditId, transactionId, data: {
        actor_user_id: actor.user.$id,
        action: "territory.assigned",
        entity_type: "territory",
        entity_id: territoryId,
        occurred_at: now,
        after_json: JSON.stringify({ employeeId, assignmentId }),
        reason: "Management dashboard",
        correlation_id: correlationId,
      }, permissions: [] });
    });
    return NextResponse.json({ ok: true, assignmentId, created: true, replayed: false }, { status: 201 });
  } catch (error) {
    if (isAppwriteConflict(error)) {
      const replay = activeRows(await assignmentRows(db, employeeId, territoryId))
        .filter((row) => String(row.role_id) === role.$id);
      if (replay[0]) return NextResponse.json({ ok: true, assignmentId: replay[0].$id, created: false, replayed: true });
    }
    return NextResponse.json({ error: "Sales area access could not be assigned. No partial assignment was saved; retrying is safe." }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const actor = await requireDashboardAdmin();
  if (!actor) return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const employeeId = text(body.employeeId, 36), territoryId = text(body.territoryId, 36);
  if (!employeeId || !territoryId) return NextResponse.json({ error: "Salesperson and sales area are required." }, { status: 400 });
  const db = createAdminTablesDb();
  const [targetHistory, employeeHistory, role] = await Promise.all([
    assignmentRows(db, employeeId, territoryId),
    listAllRowsChecked(db, databaseId, "employee_assignments", [Query.equal("employee_id", employeeId)], 1_000),
    salesRole(db),
  ]);
  if (!role) return NextResponse.json({ error: "The salesperson role is not configured." }, { status: 409 });
  const rows = activeRows(targetHistory).filter((row) => String(row.role_id) === role.$id);
  if (rows.length === 0) return NextResponse.json({ ok: true, ended: 0, changed: false, replayed: true });

  const activeTerritoryIds = new Set(activeRows(employeeHistory)
    .filter((row) => String(row.role_id) === role.$id)
    .map((row) => String(row.territory_id ?? ""))
    .filter(Boolean));
  const unrestricted = removalLeavesUnrestricted(activeTerritoryIds, territoryId);
  if (unrestricted && body.confirmUnrestricted !== true) {
    return NextResponse.json({
      error: "Removing this last sales area will allow field work in every area. Confirm unrestricted access before continuing.",
      code: "confirm_unrestricted_required",
      employeeId,
      territoryId,
    }, { status: 409 });
  }

  const roleOnlyHistory = employeeHistory.filter((row) => String(row.role_id) === role.$id && !row.territory_id);
  const activeRoleOnly = activeRows(roleOnlyHistory)[0] ?? null;
  const now = new Date().toISOString();
  const operationKey = managementOperationKey(body.operationId, "territory.unassign", employeeId, territoryId, rows.map((row) => row.$id).sort());
  const { auditId, correlationId } = managementAuditIdentity("territory.unassigned", territoryId, operationKey);
  const roleAssignmentId = activeRoleOnly
    ? ""
    : stableManagementId("assign", "role-retained", employeeId, role.$id, latestEnd(roleOnlyHistory) || "initial");

  try {
    await runManagementTransaction(db, async (transactionId) => {
      for (const row of rows) {
        await db.updateRow({
          databaseId,
          tableId: "employee_assignments",
          rowId: row.$id,
          transactionId,
          data: { effective_to: now },
        });
      }
      if (roleAssignmentId) {
        await db.createRow({ databaseId, tableId: "employee_assignments", rowId: roleAssignmentId, transactionId, data: {
          employee_id: employeeId,
          role_id: role.$id,
          effective_from: now,
          assigned_by: actor.user.$id,
          reason: "Role retained after sales area removal",
        }, permissions: [] });
      }
      await db.createRow({ databaseId, tableId: "audit_logs", rowId: auditId, transactionId, data: {
        actor_user_id: actor.user.$id,
        action: "territory.unassigned",
        entity_type: "territory",
        entity_id: territoryId,
        occurred_at: now,
        before_json: JSON.stringify({ employeeId, activeAssignmentIds: rows.map((row) => row.$id) }),
        after_json: JSON.stringify({
          employeeId,
          endedAssignments: rows.map((row) => row.$id),
          unrestricted,
          roleAssignmentId: roleAssignmentId || activeRoleOnly?.$id,
        }),
        reason: "Management dashboard",
        correlation_id: correlationId,
      }, permissions: [] });
    });
    return NextResponse.json({ ok: true, ended: rows.length, changed: true, replayed: false, unrestricted });
  } catch (error) {
    const remaining = isAppwriteConflict(error)
      ? activeRows(await assignmentRows(db, employeeId, territoryId)).filter((row) => String(row.role_id) === role.$id)
      : null;
    if (remaining && remaining.length === 0) {
      return NextResponse.json({ ok: true, ended: 0, changed: false, replayed: true });
    }
    return NextResponse.json({ error: "Sales area access could not be removed. No partial change was saved; retrying is safe." }, { status: 500 });
  }
}

async function salesRole(db: ReturnType<typeof createAdminTablesDb>) {
  const result = await db.listRows({
    databaseId,
    tableId: "roles",
    queries: [Query.equal("code", "sales_person"), Query.equal("active", true), Query.limit(1)],
  });
  return result.rows[0] ?? null;
}

async function assignmentRows(db: ReturnType<typeof createAdminTablesDb>, employeeId: string, territoryId: string) {
  return listAllRowsChecked(db, databaseId, "employee_assignments", [
    Query.equal("employee_id", employeeId),
    Query.equal("territory_id", territoryId),
  ], 1_000);
}

function activeRows<T extends Models.Row & Record<string, unknown>>(rows: T[], at = Date.now()) {
  return rows.filter((row) => {
    const start = new Date(String(row.effective_from)).valueOf();
    const end = row.effective_to ? new Date(String(row.effective_to)).valueOf() : null;
    return Number.isFinite(start) && start <= at && (end === null || (Number.isFinite(end) && end > at));
  });
}

function latestEnd(rows: Array<Models.Row & Record<string, unknown>>) {
  return rows.reduce((latest, row) => {
    if (!row.effective_to) return latest;
    const value = String(row.effective_to);
    return value > latest ? value : latest;
  }, "");
}
