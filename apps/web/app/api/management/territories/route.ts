import { createHash, randomUUID } from "node:crypto";
import { parseTerritoryBoundary } from "@fieldops/domain";
import { ID, Query } from "node-appwrite";
import { NextResponse } from "next/server";
import { createAdminTablesDb } from "@fieldops/appwrite/server";
import { requireDashboardAdmin } from "../../../../lib/auth";
import {
  isAppwriteConflict,
  isAppwriteNotFound,
  managementAuditIdentity,
  managementOperationKey,
  runManagementTransaction,
  salesAreaDeletionAssignmentPlan,
  stableManagementId,
} from "../../../../lib/management-write";
import { text } from "../../../../lib/mobile-auth";
import { listAllRows, listAllRowsChecked } from "../../../../lib/table-data";
import { territoryBoundaryImpact } from "../../../../lib/territory-impact";

const databaseId = process.env.APPWRITE_DATABASE_ID ?? "fieldops";

export async function POST(request: Request) {
  const actor = await requireDashboardAdmin();
  if (!actor) return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
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
    if (!area) return NextResponse.json({ error: "Organization geography must be set up before creating a sales area." }, { status: 409 });
    const areaId = area.$id;
    const code = `TER-${createHash("sha256").update(`${areaId}:${name.trim().toLowerCase()}`).digest("hex").slice(0, 10).toUpperCase()}`;
    const territoryId = stableManagementId("ter", `${areaId}:${code}`);
    const salesRole = (await db.listRows({ databaseId, tableId: "roles", queries: [Query.equal("code", "sales_person"), Query.limit(1)] })).rows[0];
    if (!salesRole) return NextResponse.json({ error: "The salesperson role is not configured." }, { status: 409 });
    const employees = await Promise.all(employeeIds.map((employeeId) => db.getRow({
      databaseId,
      tableId: "employees",
      rowId: employeeId,
    }).catch(() => null)));
    if (employees.some((employee) => !employee || employee.status !== "active")) {
      return NextResponse.json({ error: "Every selected salesperson must still be active. Refresh and try again." }, { status: 409 });
    }

    const existing = await db.getRow({ databaseId, tableId: "territories", rowId: territoryId }).catch((error) => {
      if (isAppwriteNotFound(error)) return null;
      throw error;
    });
    if (existing) {
      const savedBoundary = parseTerritoryBoundary(existing.boundary);
      const sameRequest = existing.active === true
        && String(existing.area_id) === areaId
        && String(existing.code) === code
        && String(existing.name).trim() === name.trim()
        && JSON.stringify(savedBoundary?.coordinates ?? null) === JSON.stringify(boundary.coordinates);
      if (!sameRequest) return NextResponse.json({ error: "A sales area with that name already exists with different details." }, { status: 409 });
      return NextResponse.json({ ok: true, territoryId, created: false, replayed: true });
    }

    const operationKey = managementOperationKey(body.operationId, "territory.create", areaId, code);
    const { auditId, correlationId } = managementAuditIdentity("territory.created", territoryId, operationKey);
    const now = new Date().toISOString();
    await runManagementTransaction(db, async (transactionId) => {
      await db.createRow({ databaseId, tableId: "territories", rowId: territoryId, transactionId, data: {
        area_id: areaId,
        code,
        name,
        boundary: boundary.coordinates,
        active: true,
      }, permissions: [] });
      for (const employeeId of employeeIds) {
        const assignmentId = stableManagementId("assign", "territory-create", employeeId, salesRole.$id, territoryId);
        await db.createRow({ databaseId, tableId: "employee_assignments", rowId: assignmentId, transactionId, data: {
          employee_id: employeeId,
          role_id: salesRole.$id,
          territory_id: territoryId,
          effective_from: now,
          assigned_by: actor.user.$id,
          reason: "Assigned when sales area was created",
        }, permissions: [] });
      }
      await db.createRow({ databaseId, tableId: "audit_logs", rowId: auditId, transactionId, data: {
        actor_user_id: actor.user.$id,
        action: "territory.created",
        entity_type: "territory",
        entity_id: territoryId,
        occurred_at: now,
        after_json: JSON.stringify({ code, areaId, employeeIds }),
        reason: "Management dashboard",
        correlation_id: correlationId,
      }, permissions: [] });
    });
    return NextResponse.json({ ok: true, territoryId, created: true, replayed: false }, { status: 201 });
  } catch (error) {
    if (isAppwriteConflict(error)) {
      const area = (await db.listRows({ databaseId, tableId: "areas", queries: [Query.equal("active", true), Query.orderAsc("$createdAt"), Query.limit(1)] })).rows[0];
      if (area) {
        const code = `TER-${createHash("sha256").update(`${area.$id}:${name.trim().toLowerCase()}`).digest("hex").slice(0, 10).toUpperCase()}`;
        const territoryId = stableManagementId("ter", `${area.$id}:${code}`);
        const stored = await db.getRow({ databaseId, tableId: "territories", rowId: territoryId }).catch(() => null);
        const storedBoundary = stored ? parseTerritoryBoundary(stored.boundary) : null;
        if (stored
          && stored.active === true
          && String(stored.name).trim() === name.trim()
          && JSON.stringify(storedBoundary?.coordinates ?? null) === JSON.stringify(boundary.coordinates)) {
          return NextResponse.json({ ok: true, territoryId, created: false, replayed: true });
        }
      }
    }
    const codeValue = typeof error === "object" && error && "code" in error ? Number(error.code) : 500;
    return NextResponse.json({ error: codeValue === 409 ? "A sales area with that name already exists." : "The sales area could not be created." }, { status: codeValue === 409 ? 409 : 500 });
  }
}

export async function PATCH(request: Request) {
  const actor = await requireDashboardAdmin();
  if (!actor) return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const territoryId = text(body.territoryId, 36), boundary = parseTerritoryBoundary(body.boundary);
  if (!territoryId || !boundary) return NextResponse.json({ error: "A sales area and a valid closed map boundary are required." }, { status: 400 });
  const db = createAdminTablesDb();
  try {
    const before = await db.getRow({ databaseId, tableId: "territories", rowId: territoryId });
    const outletRows = await listAllRows(db, databaseId, "outlets", [
      Query.equal("territory_id", territoryId),
      Query.equal("status", "active"),
    ]);
    const impact = territoryBoundaryImpact(boundary, outletRows.map((outlet) => ({
      id: outlet.$id,
      name: String(outlet.name || outlet.code || "Unnamed outlet"),
      latitude: Number(outlet.latitude),
      longitude: Number(outlet.longitude),
    })));
    const affected = [...impact.outside, ...impact.invalid];
    if (affected.length > 0) {
      return NextResponse.json({
        error: `This boundary would leave ${affected.length} active ${affected.length === 1 ? "outlet" : "outlets"} outside the sales area. Include them in the boundary or move them to the correct sales area first.`,
        code: "territory_boundary_strands_outlets",
        affectedOutlets: affected.map((outlet) => ({ id: outlet.id, name: outlet.name })),
      }, { status: 409 });
    }

    const transaction = await db.createTransaction({ ttl: 60 });
    try {
      await db.updateRow({ databaseId, tableId: "territories", rowId: territoryId, transactionId: transaction.$id, data: { boundary: boundary.coordinates } });
      await db.createRow({ databaseId, tableId: "audit_logs", rowId: ID.unique(), transactionId: transaction.$id, data: {
        actor_user_id: actor.user.$id,
        action: "territory.boundary_updated",
        entity_type: "territory",
        entity_id: territoryId,
        occurred_at: new Date().toISOString(),
        before_json: JSON.stringify({ boundary: before.boundary ?? null }),
        after_json: JSON.stringify({ boundary: boundary.coordinates, outletsChecked: impact.checked }),
        reason: "Management dashboard boundary validation",
        correlation_id: randomUUID(),
      }, permissions: [] });
      await db.updateTransaction({ transactionId: transaction.$id, commit: true });
    } catch (error) {
      await db.updateTransaction({ transactionId: transaction.$id, rollback: true }).catch(() => undefined);
      throw error;
    }
    return NextResponse.json({ ok: true, territoryId });
  } catch {
    return NextResponse.json({ error: "The sales area boundary could not be updated." }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const actor = await requireDashboardAdmin();
  if (!actor) return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const territoryId = text(body.territoryId, 36);
  if (!territoryId) return NextResponse.json({ error: "Choose a sales area to delete." }, { status: 400 });

  const db = createAdminTablesDb();
  const now = new Date().toISOString();
  try {
    const result = await runManagementTransaction(db, async (transactionId) => {
      const territory = await db.getRow({
        databaseId,
        tableId: "territories",
        rowId: territoryId,
        transactionId,
      }).catch((error) => {
        if (isAppwriteNotFound(error)) return null;
        throw error;
      });
      if (!territory) throw new SalesAreaDeletionProblem(404, "This sales area no longer exists.");
      if (territory.active !== true) return { changed: false, name: String(territory.name), endedAssignments: 0 };

      const assignments = await listAllRowsChecked(db, databaseId, "employee_assignments", [], 5_000, transactionId);
      const { targetAssignments: activeTargetAssignments, rolesToRetain } = salesAreaDeletionAssignmentPlan(assignments, territoryId, now);

      const operationKey = managementOperationKey(body.operationId, "territory.delete", territoryId, territory.$updatedAt);
      const retainedRoleAssignments: string[] = [];
      for (const { employeeId, roleId } of rolesToRetain) {
        const assignmentId = stableManagementId("assign", "role-retained-after-area-delete", employeeId, roleId, territoryId);
        await db.createRow({
          databaseId,
          tableId: "employee_assignments",
          rowId: assignmentId,
          transactionId,
          data: {
            employee_id: employeeId,
            role_id: roleId,
            effective_from: now,
            assigned_by: actor.user.$id,
            reason: "Role retained after sales area deletion",
          },
          permissions: [],
        });
        retainedRoleAssignments.push(assignmentId);
      }

      for (const assignment of activeTargetAssignments) {
        await db.updateRow({
          databaseId,
          tableId: "employee_assignments",
          rowId: assignment.$id,
          transactionId,
          data: { effective_to: now },
        });
      }
      await db.updateRow({
        databaseId,
        tableId: "territories",
        rowId: territoryId,
        transactionId,
        data: { active: false },
      });

      const { auditId, correlationId } = managementAuditIdentity("territory.deleted", territoryId, operationKey);
      await db.createRow({ databaseId, tableId: "audit_logs", rowId: auditId, transactionId, data: {
        actor_user_id: actor.user.$id,
        action: "territory.deleted",
        entity_type: "territory",
        entity_id: territoryId,
        occurred_at: now,
        before_json: JSON.stringify({
          name: String(territory.name),
          code: String(territory.code),
          active: true,
          activeAssignmentIds: activeTargetAssignments.map((assignment) => assignment.$id),
        }),
        after_json: JSON.stringify({
          active: false,
          endedAssignments: activeTargetAssignments.map((assignment) => assignment.$id),
          retainedRoleAssignments,
          outletsPreserved: true,
        }),
        reason: "Temporary sales area restriction ended; outlets and historical records retained",
        correlation_id: correlationId,
      }, permissions: [] });

      return {
        changed: true,
        name: String(territory.name),
        endedAssignments: activeTargetAssignments.length,
      };
    });
    return NextResponse.json({ ok: true, deleted: true, replayed: !result.changed, ...result });
  } catch (error) {
    if (error instanceof SalesAreaDeletionProblem) {
      return NextResponse.json({
        error: error.message,
        code: "sales_area_not_found",
      }, { status: error.status });
    }
    if (isAppwriteConflict(error)) {
      const current = await db.getRow({ databaseId, tableId: "territories", rowId: territoryId }).catch(() => null);
      if (current?.active === false) {
        return NextResponse.json({ ok: true, deleted: true, changed: false, replayed: true, name: String(current.name), endedAssignments: 0 });
      }
    }
    return NextResponse.json({ error: "The sales area could not be deleted. No partial change was saved; retrying is safe." }, { status: 500 });
  }
}

class SalesAreaDeletionProblem extends Error {
  constructor(readonly status: 404, message: string) {
    super(message);
  }
}

function sanitizeIds(value: unknown) {
  return Array.isArray(value) ? [...new Set(value.map((item) => text(item, 36)).filter(Boolean))].slice(0, 100) : [];
}
