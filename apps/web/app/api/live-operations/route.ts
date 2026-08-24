import { NextResponse } from "next/server";
import { Query, type Models } from "node-appwrite";
import { createAdminTablesDb } from "@fieldops/appwrite/server";
import { requireManager } from "../../../lib/auth";
import { listAllRows, withTimeout } from "../../../lib/table-data";
import type { LiveOperationsPayload } from "../../../lib/live-types";

export const dynamic = "force-dynamic";
const databaseId = process.env.APPWRITE_DATABASE_ID ?? "fieldops";

export async function GET(request: Request) {
  try {
    const actor = await withTimeout(requireManager(), 8_000, "Manager verification timed out");
    if (!actor) return NextResponse.json({ error: "Manager access is required." }, { status: 401 });

    const url = new URL(request.url);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("date") ?? "") ? String(url.searchParams.get("date")) : "";
    const selectedEmployee = url.searchParams.get("employee") ?? "all";
    if (!date || (selectedEmployee !== "all" && !/^[a-zA-Z0-9._-]{1,36}$/.test(selectedEmployee))) {
      return NextResponse.json({ error: "A valid date and salesperson filter are required." }, { status: 400 });
    }

    const sinceValue = url.searchParams.get("since");
    const sinceDate = sinceValue ? new Date(sinceValue) : null;
    const since = sinceDate && !Number.isNaN(sinceDate.valueOf()) ? new Date(sinceDate.valueOf() - 2_000).toISOString() : null;
    const near = parseNear(url.searchParams.get("near"));
    const rawCursor = url.searchParams.get("cursor") ?? "";
    const cursor = /^[a-zA-Z0-9._-]{1,36}$/.test(rawCursor) ? rawCursor : "";
    const radius = Math.min(100_000, Math.max(50, Number(url.searchParams.get("radius") ?? 5_000)));
    const employeeFilter = selectedEmployee === "all" ? [] : [Query.equal("employee_id", selectedEmployee)];
    // Receipt time is the incremental cursor. A salesperson can upload points
    // captured much earlier after reconnecting; captured_at would skip them.
    const locationQueries = [Query.equal("work_date", date), ...employeeFilter, ...(since ? [Query.greaterThanEqual("received_at", since)] : []), ...(near ? [Query.distanceLessThan("coordinates", near, radius)] : []), Query.orderAsc("received_at")];
    const db = createAdminTablesDb();
    const [employeeRows, attendanceRows, locationRows] = await withTimeout(Promise.all([
      listAllRows(db, databaseId, "employees", [Query.equal("status", "active")], 500),
      listAllRows(db, databaseId, "attendance_records", [Query.equal("work_date", date), ...employeeFilter], 500),
      listLocationRows(db, locationQueries, cursor, 2_000),
    ]), 8_000, "Live location query timed out");

    const payload: LiveOperationsPayload = {
      serverTime: new Date().toISOString(),
      ...(locationRows.length === 2_000 ? { nextCursor: locationRows.at(-1)!.$id } : {}),
      employees: employeeRows.map((row) => ({ id: row.$id, name: String(row.display_name ?? "Salesperson") })),
      attendance: latestAttendanceByEmployee(attendanceRows).map((row) => ({
        id: row.$id,
        employeeId: String(row.employee_id),
        status: String(row.status),
        checkInAt: String(row.check_in_at),
        checkOutAt: row.check_out_at ? String(row.check_out_at) : null,
      })),
      points: locationRows.map((row) => {
        const coordinates = validPoint(row.coordinates) ? row.coordinates : [Number(row.longitude), Number(row.latitude)];
        return {
          id: row.$id,
          employeeId: String(row.employee_id),
          capturedAt: String(row.captured_at),
          receivedAt: String(row.received_at),
          latitude: Number(coordinates[1]),
          longitude: Number(coordinates[0]),
          accuracy: Number(row.accuracy),
          source: String(row.source),
        };
      }),
    };
    return NextResponse.json(payload, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
  } catch (error) {
    console.error("Could not refresh live FieldOPS locations", error);
    return NextResponse.json({ error: "Live locations are temporarily delayed. The last confirmed positions remain visible." }, { status: 503, headers: { "Cache-Control": "private, no-store, max-age=0" } });
  }
}

async function listLocationRows(
  db: ReturnType<typeof createAdminTablesDb>,
  queries: string[],
  initialCursor: string,
  maximum: number,
) {
  const rows: Models.DefaultRow[] = [];
  let cursor = initialCursor;
  while (rows.length < maximum) {
    const page = await db.listRows({
      databaseId,
      tableId: "location_points",
      queries: [
        ...queries,
        Query.limit(Math.min(100, maximum - rows.length)),
        ...(cursor ? [Query.cursorAfter(cursor)] : []),
      ],
    });
    rows.push(...page.rows);
    if (page.rows.length < 100) break;
    cursor = page.rows.at(-1)!.$id;
  }
  return rows;
}

function parseNear(value: string | null): [number, number] | null {
  if (!value) return null;
  const [longitude, latitude] = value.split(",").map(Number);
  return Number.isFinite(longitude) && Number.isFinite(latitude) && Math.abs(longitude!) <= 180 && Math.abs(latitude!) <= 90 ? [longitude!, latitude!] : null;
}

function validPoint(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && value.every((coordinate) => Number.isFinite(Number(coordinate)));
}

function latestAttendanceByEmployee<T extends object>(rows: T[]) {
  const latest = new Map<string, T>();
  for (const row of [...rows].sort((a, b) => String((b as Record<string, unknown>).check_in_at).localeCompare(String((a as Record<string, unknown>).check_in_at)))) {
    const employeeId = String((row as Record<string, unknown>).employee_id);
    if (!latest.has(employeeId)) latest.set(employeeId, row);
  }
  return [...latest.values()];
}
