import { createHash, randomUUID } from "node:crypto";
import { ID, Query } from "node-appwrite";
import { NextResponse } from "next/server";
import { createAdminTablesDb } from "@fieldops/appwrite/server";
import { requireManager } from "../../../../lib/auth";
import { text, workDate } from "../../../../lib/mobile-auth";

const databaseId = process.env.APPWRITE_DATABASE_ID ?? "fieldops";
const stableId = (prefix: string, value: string) => `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;

export async function POST(request: Request) {
  const actor = await requireManager();
  if (!actor) return NextResponse.json({ error: "Manager access is required." }, { status: 403 });
  const body = await request.json();
  const outletId = text(body.outletId, 36), employeeId = text(body.employeeId, 36), date = text(body.workDate, 10) || workDate();
  if (!outletId || !employeeId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ error: "Outlet, salesperson, and date are required." }, { status: 400 });
  const db = createAdminTablesDb();
  await db.updateRow({ databaseId, tableId: "outlets", rowId: outletId, data: { assigned_employee_id: employeeId } });
  const current = await db.listRows({ databaseId, tableId: "route_assignments", queries: [Query.equal("employee_id", employeeId), Query.equal("work_date", date), Query.limit(100)] });
  const routeId = stableId("route", `${date}:${employeeId}:${outletId}`);
  try {
    await db.createRow({ databaseId, tableId: "route_assignments", rowId: routeId, data: {
      work_date: date, employee_id: employeeId, outlet_id: outletId, sequence: current.total + 1,
      status: "planned", assigned_by: actor.user.$id, published_at: new Date().toISOString(),
    }, permissions: [] });
  } catch (error) {
    if (!(typeof error === "object" && error && "code" in error && Number(error.code) === 409)) throw error;
  }
  await db.createRow({ databaseId, tableId: "audit_logs", rowId: ID.unique(), data: {
    actor_user_id: actor.user.$id, action: "outlet.assigned", entity_type: "outlet", entity_id: outletId,
    occurred_at: new Date().toISOString(), after_json: JSON.stringify({ employeeId, date, routeId }),
    reason: "Management dashboard", correlation_id: randomUUID(),
  }, permissions: [] });
  return NextResponse.json({ ok: true, routeId });
}
