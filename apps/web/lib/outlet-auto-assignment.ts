import { parseTerritoryBoundary, pointInTerritory, type TerritoryBoundary } from "@fieldops/domain";
import { ID, Query, type TablesDB } from "node-appwrite";
import { effectiveSalespeople, salesAreasAtPoint } from "./outlet-location";
import { stableManagementId } from "./management-write";
import { workDate } from "./mobile-auth";
import { allocateRouteSequence } from "./route-sequence";
import { listAllRowsChecked } from "./table-data";

/** Reconcile within the caller's transaction so outlets and published visits stay atomic. */
export async function syncOutletAssignments(
  db: TablesDB,
  databaseId: string,
  actorUserId: string,
  transactionId: string,
  outletIds?: string[],
  changedArea?: { id: string; previousBoundary?: TerritoryBoundary | null },
) {
  const now = new Date();
  const date = workDate(now);
  const read = (tableId: string, queries: string[] = []) => listAllRowsChecked(db, databaseId, tableId, queries, 10_000, transactionId);
  const outletFilter = outletIds ? [Query.equal("$id", outletIds)] : [];
  const routeFilter = outletIds ? [Query.equal("outlet_id", outletIds)] : [];
  const [outlets, territoryRows, assignments, employees, roles, routes] = await Promise.all([
    read("outlets", [Query.equal("status", "active"), ...outletFilter]),
    read("territories", [Query.equal("active", true)]),
    read("employee_assignments"),
    read("employees", [Query.equal("status", "active")]),
    read("roles", [Query.equal("code", "sales_person"), Query.equal("active", true)]),
    read("route_assignments", [Query.greaterThanEqual("work_date", date), ...routeFilter]),
  ]);
  const territories = territoryRows.map((row) => ({ id: row.$id, boundary: parseTerritoryBoundary(row.boundary) }));
  const activeEmployeeIds = new Set(employees.map((row) => row.$id));
  const salesRoleIds = new Set(roles.map((row) => row.$id));
  const results = [];

  for (const outlet of outlets) {
    const point = { latitude: Number(outlet.latitude), longitude: Number(outlet.longitude) };
    const matched = salesAreasAtPoint(point, territories);
    if (changedArea && outlet.territory_id !== changedArea.id
      && !matched.some((territory) => territory.id === changedArea.id)
      && !(changedArea.previousBoundary && pointInTerritory(point, changedArea.previousBoundary))) continue;
    const territoryIds = matched.map((territory) => territory.id);
    const territoryId = territoryIds.includes(String(outlet.territory_id)) ? String(outlet.territory_id) : territoryIds[0] ?? null;
    const employeeIds = effectiveSalespeople(territoryIds, assignments, activeEmployeeIds, salesRoleIds, now);
    const assignedEmployeeId = employeeIds.length === 1 ? employeeIds[0]! : null;
    const outletRoutes = routes.filter((route) => route.outlet_id === outlet.$id);
    const createdRoutes: string[] = [];
    const removedRoutes: string[] = [];
    const changed = (outlet.territory_id || null) !== territoryId || (outlet.assigned_employee_id || null) !== assignedEmployeeId;
    if (changed) {
      await db.updateRow({ databaseId, tableId: "outlets", rowId: outlet.$id, transactionId,
        data: { territory_id: territoryId, assigned_employee_id: assignedEmployeeId } });
    }
    // Only withdraw automatically published visits that have not started.
    for (const route of outletRoutes) {
      if (route.$id.startsWith("autoroute_") && route.status === "planned" && !employeeIds.includes(String(route.employee_id))) {
        await db.deleteRow({ databaseId, tableId: "route_assignments", rowId: route.$id, transactionId });
        removedRoutes.push(route.$id);
      }
    }
    for (const employeeId of employeeIds) {
      if (outletRoutes.some((route) => route.employee_id === employeeId && route.work_date === date)) continue;
      const routeId = stableManagementId("autoroute", `${date}:${employeeId}:${outlet.$id}`);
      const sequence = await allocateRouteSequence(db, databaseId, employeeId, date, transactionId);
      await db.createRow({ databaseId, tableId: "route_assignments", rowId: routeId, transactionId, data: {
        work_date: date, employee_id: employeeId, outlet_id: outlet.$id, sequence, status: "planned",
        assigned_by: actorUserId, published_at: now.toISOString(),
      }, permissions: [] });
      createdRoutes.push(routeId);
    }
    if (changed || createdRoutes.length || removedRoutes.length) {
      await db.createRow({ databaseId, tableId: "audit_logs", rowId: ID.unique(), transactionId, data: {
        actor_user_id: actorUserId, action: "outlet.area_assignment_synced", entity_type: "outlet", entity_id: outlet.$id,
        occurred_at: now.toISOString(), before_json: JSON.stringify({ territoryId: outlet.territory_id, employeeId: outlet.assigned_employee_id }),
        after_json: JSON.stringify({ territoryId, territoryIds, employeeIds, createdRoutes, removedRoutes }),
        reason: "Automatically assigned from the outlet map point and current sales area assignments", correlation_id: ID.unique(),
      }, permissions: [] });
    }
    results.push({ outletId: outlet.$id, territoryId, territoryIds, employeeIds });
  }
  return results;
}
