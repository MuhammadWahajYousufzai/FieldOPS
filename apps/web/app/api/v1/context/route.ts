import { Query } from "node-appwrite";
import { NextResponse } from "next/server";
import { createAdminTablesDb } from "@fieldops/appwrite/server";
import { mobileActor, workDate } from "../../../../lib/mobile-auth";
import { territoryAccessForEmployee } from "../../../../lib/territory-access";

const databaseId = process.env.APPWRITE_DATABASE_ID ?? "fieldops";

export async function GET(request: Request) {
  const actor = await mobileActor(request);
  if (!actor) return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  const db = createAdminTablesDb();
  const date = new URL(request.url).searchParams.get("date") || workDate();
  const [routes, territoryAccess] = await Promise.all([
    db.listRows({
      databaseId,
      tableId: "route_assignments",
      queries: [Query.equal("employee_id", actor.employee.$id), Query.equal("work_date", date), Query.orderAsc("sequence"), Query.limit(100)],
    }),
    territoryAccessForEmployee(db, actor.employee.$id),
  ]);
  const rows = [];
  for (const route of routes.rows) {
    try {
      const outlet = await db.getRow({ databaseId, tableId: "outlets", rowId: String(route.outlet_id) });
      if (outlet.status !== "active") continue;
      rows.push({
        routeId: route.$id,
        id: outlet.$id,
        code: outlet.code,
        name: outlet.name,
        address: outlet.address,
        latitude: outlet.latitude,
        longitude: outlet.longitude,
        sequence: route.sequence,
        status: route.status,
        notes: outlet.notes ?? "",
        territoryId: outlet.territory_id,
        kind: "assigned",
        workDate: date,
      });
    } catch { /* A removed outlet is omitted from the downloaded plan. */ }
  }
  const attendanceRows = (await db.listRows({
    databaseId,
    tableId: "attendance_records",
    queries: [Query.equal("employee_id", actor.employee.$id), Query.equal("work_date", date), Query.limit(100)],
  })).rows;
  attendanceRows.sort((a, b) => String(b.check_in_at).localeCompare(String(a.check_in_at)));
  const activeAttendance = attendanceRows.find((row) => row.status === "checked_in" && !row.check_out_at);
  const workState = activeAttendance ? "active" : attendanceRows.length > 0 ? "finished" : "not_started";
  return NextResponse.json({
    date,
    employee: { id: actor.employee.$id, name: actor.employee.display_name },
    shiftActive: Boolean(activeAttendance),
    workState,
    route: rows,
    territoryPolicy: {
      mode: territoryAccess.restricted ? "restricted" : "unrestricted",
      assignedCount: territoryAccess.assignedCount,
      territories: territoryAccess.territories.map((territory) => ({
        id: territory.id, code: territory.code, name: territory.name, boundary: territory.boundary,
      })),
    },
    map: { styleUrl: "https://tiles.openfreemap.org/styles/liberty", attribution: "© OpenStreetMap contributors" },
  });
}
