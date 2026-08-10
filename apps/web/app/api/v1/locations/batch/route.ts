import { NextResponse } from "next/server";
import { createAdminTablesDb } from "@fieldops/appwrite/server";
import { mobileActor, number, text, workDate } from "../../../../../lib/mobile-auth";

const databaseId = process.env.APPWRITE_DATABASE_ID ?? "fieldops";

export async function POST(request: Request) {
  const actor = await mobileActor(request);
  if (!actor) return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const points = Array.isArray(body.points) ? body.points.slice(0, 100) : [];
  if (points.length === 0) return NextResponse.json({ error: "At least one route point is required." }, { status: 400 });
  const db = createAdminTablesDb();
  const confirmed: string[] = [];
  for (const raw of points) {
    const idempotencyKey = text(raw.idempotencyKey, 36);
    const latitude = number(raw.latitude), longitude = number(raw.longitude), accuracy = number(raw.accuracy);
    const capturedDate = new Date(text(raw.capturedAt, 40));
    if (!/^[a-zA-Z0-9._-]{1,36}$/.test(idempotencyKey) || latitude === null || longitude === null || accuracy === null || Number.isNaN(capturedDate.valueOf()) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) continue;
    const capturedAt = capturedDate.toISOString();
    const now = new Date().toISOString();
    const altitude = number(raw.altitude), speed = number(raw.speed), heading = number(raw.heading);
    try {
      await db.createRow({ databaseId, tableId: "location_points", rowId: idempotencyKey, data: {
        employee_id: actor.employee.$id,
        captured_at: capturedAt,
        received_at: now,
        latitude,
        longitude,
        accuracy: Math.max(0, accuracy),
        source: raw.source === "foreground" ? "foreground" : "background",
        idempotency_key: idempotencyKey,
        work_date: workDate(capturedDate),
        ...(altitude === null ? {} : { altitude }),
        ...(speed === null ? {} : { speed }),
        ...(heading === null ? {} : { heading }),
      }, permissions: [] });
      confirmed.push(idempotencyKey);
    } catch (error) {
      if (typeof error === "object" && error && "code" in error && Number(error.code) === 409) confirmed.push(idempotencyKey);
      else throw error;
    }
  }
  return NextResponse.json({ ok: true, confirmed, rejected: points.length - confirmed.length });
}
