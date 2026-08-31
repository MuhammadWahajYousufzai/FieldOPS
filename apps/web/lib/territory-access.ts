import { parseTerritoryBoundary, pointInAnyTerritory, type Coordinate, type TerritoryBoundary } from "@fieldops/domain";
import { Query, type Models, type TablesDB } from "node-appwrite";
import { listAllRowsChecked } from "./table-data";

const databaseId = process.env.APPWRITE_DATABASE_ID ?? "fieldops";

export type AssignedTerritory = {
  id: string;
  code: string;
  name: string;
  boundary: TerritoryBoundary | null;
};

export type TerritoryAccess = {
  restricted: boolean;
  assignedCount: number;
  territories: AssignedTerritory[];
};

export async function territoryAccessForEmployee(db: TablesDB, employeeId: string, at = new Date()): Promise<TerritoryAccess> {
  const assignments = await listAllRowsChecked(
    db,
    databaseId,
    "employee_assignments",
    [Query.equal("employee_id", employeeId)],
    1_000,
  );
  const assignedIds = [...new Set(assignments
    .filter((row) => isEffective(row, at) && row.territory_id)
    .map((row) => String(row.territory_id)))];
  const territoryRows = await Promise.all(assignedIds.map((territoryId) => db.getRow({
    databaseId,
    tableId: "territories",
    rowId: territoryId,
  }).catch(() => null)));
  const territories = territoryRows.flatMap((row) => {
    if (!row || row.active !== true) return [];
    return [{
      id: row.$id,
      code: String(row.code),
      name: String(row.name),
      boundary: parseTerritoryBoundary(row.boundary),
    }];
  });
  return { restricted: assignedIds.length > 0, assignedCount: assignedIds.length, territories };
}

export function evaluateTerritoryAccess(access: TerritoryAccess, point: Coordinate) {
  if (!access.restricted) return { allowed: true, reason: "No territory is assigned, so field activity is unrestricted." };
  const boundaries = access.territories.flatMap((territory) => territory.boundary ? [territory.boundary] : []);
  if (boundaries.length === 0) return { allowed: false, reason: "Your assigned territory does not have a saved map boundary yet. Ask a manager to draw it." };
  const allowed = pointInAnyTerritory(point, boundaries);
  return {
    allowed,
    reason: allowed
      ? "You are inside an assigned territory."
      : `You are outside ${access.territories.map((territory) => territory.name).join(" or ")}. Visits and orders are disabled here.`,
  };
}

export function employeeHasTerritory(access: TerritoryAccess, territoryId: string) {
  return access.territories.some((territory) => territory.id === territoryId);
}

function isEffective(row: Models.DefaultRow, at: Date) {
  const start = new Date(String(row.effective_from));
  const end = row.effective_to ? new Date(String(row.effective_to)) : null;
  return start <= at && (!end || end > at);
}
