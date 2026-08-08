import { Query } from "node-appwrite";
import { NextResponse } from "next/server";
import { createAdminTablesDb } from "@fieldops/appwrite/server";
import { mobileActor, workDate } from "../../../../lib/mobile-auth";

const databaseId = process.env.APPWRITE_DATABASE_ID ?? "fieldops";

export async function GET(request: Request) {
  const actor = await mobileActor(request);
  if (!actor) return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  const db = createAdminTablesDb();
  const date = new URL(request.url).searchParams.get("date") || workDate();
  const routes = await db.listRows({
    databaseId,
    tableId: "route_assignments",
    queries: [Query.equal("employee_id", actor.employee.$id), Query.equal("work_date", date), Query.orderAsc("sequence"), Query.limit(100)],
  });
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
      });
    } catch { /* A removed outlet is omitted from the downloaded plan. */ }
  }
  const attendance = (await db.listRows({
    databaseId,
    tableId: "attendance_records",
    queries: [Query.equal("employee_id", actor.employee.$id), Query.equal("work_date", date), Query.limit(1)],
  })).rows[0];
  return NextResponse.json({
    date,
    employee: { id: actor.employee.$id, name: actor.employee.display_name, code: actor.employee.employee_code },
    shiftActive: attendance?.status === "checked_in",
    route: rows,
    map: { styleUrl: "https://tiles.openfreemap.org/styles/liberty", attribution: "© OpenStreetMap contributors" },
  });
}
