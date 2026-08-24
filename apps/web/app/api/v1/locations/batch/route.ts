import { NextResponse } from "next/server";
import { createAdminTablesDb } from "@fieldops/appwrite/server";
import { mobileActor, number, text, workDate } from "../../../../../lib/mobile-auth";

const databaseId = process.env.APPWRITE_DATABASE_ID ?? "fieldops";
const MAX_BATCH_SIZE = 100;
const WRITE_CONCURRENCY = 8;

type RejectedPoint = {
  idempotencyKey: string | null;
  reason: "invalid_point" | "idempotency_conflict" | "server_write_failed";
  retryable: boolean;
};

type LocationWrite = {
  idempotencyKey: string;
  data: {
    employee_id: string;
    captured_at: string;
    received_at: string;
    latitude: number;
    longitude: number;
    coordinates: [number, number];
    accuracy: number;
    source: "foreground" | "background";
    idempotency_key: string;
    work_date: string;
    altitude?: number;
    speed?: number;
    heading?: number;
  };
};

function isConflict(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && Number(error.code) === 409;
}

function optionalNumber(value: unknown) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  return number(value);
}

function submittedKey(value: unknown) {
  return typeof value === "string" ? value.slice(0, 64) : null;
}

async function mapWithConcurrency<Input, Output>(
  items: readonly Input[],
  concurrency: number,
  operation: (item: Input) => Promise<Output>,
) {
  const results = new Array<Output>(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await operation(items[index]!);
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    () => worker(),
  ));
  return results;
}

export async function POST(request: Request) {
  const actor = await mobileActor(request);
  if (!actor) return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  const body = await request.json().catch(() => ({})) as { points?: unknown };
  const points = Array.isArray(body.points) ? body.points.slice(0, MAX_BATCH_SIZE) : [];
  if (points.length === 0) return NextResponse.json({ error: "At least one route point is required." }, { status: 400 });
  const db = createAdminTablesDb();
  const receivedAt = new Date().toISOString();
  const rejected: RejectedPoint[] = [];
  const writes: LocationWrite[] = [];

  for (const raw of points) {
    const point = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const rawIdempotencyKey = typeof point.idempotencyKey === "string" ? point.idempotencyKey : "";
    const idempotencyKey = text(rawIdempotencyKey, 36);
    const latitude = optionalNumber(point.latitude);
    const longitude = optionalNumber(point.longitude);
    const accuracy = optionalNumber(point.accuracy);
    const capturedDate = new Date(text(point.capturedAt, 40));
    if (
      rawIdempotencyKey !== idempotencyKey
      || !/^[a-zA-Z0-9._-]{1,36}$/.test(idempotencyKey)
      || latitude === null
      || longitude === null
      || accuracy === null
      || accuracy < 0
      || Number.isNaN(capturedDate.valueOf())
      || Math.abs(latitude) > 90
      || Math.abs(longitude) > 180
    ) {
      rejected.push({ idempotencyKey: submittedKey(point.idempotencyKey), reason: "invalid_point", retryable: false });
      continue;
    }
    const capturedAt = capturedDate.toISOString();
    const altitude = optionalNumber(point.altitude);
    const speed = optionalNumber(point.speed);
    const heading = optionalNumber(point.heading);
    writes.push({
      idempotencyKey,
      data: {
        employee_id: actor.employee.$id,
        captured_at: capturedAt,
        received_at: receivedAt,
        latitude,
        longitude,
        coordinates: [longitude, latitude],
        accuracy,
        source: point.source === "foreground" ? "foreground" : "background",
        idempotency_key: idempotencyKey,
        work_date: workDate(capturedDate),
        ...(altitude === null ? {} : { altitude }),
        ...(speed === null ? {} : { speed }),
        ...(heading === null ? {} : { heading }),
      },
    });
  }

  const outcomes = await mapWithConcurrency(writes, WRITE_CONCURRENCY, async (write) => {
    try {
      await db.createRow({
        databaseId,
        tableId: "location_points",
        rowId: write.idempotencyKey,
        data: write.data,
        permissions: [],
      });
      return { confirmed: write.idempotencyKey } as const;
    } catch (error) {
      if (isConflict(error)) {
        try {
          const stored = await db.getRow({ databaseId, tableId: "location_points", rowId: write.idempotencyKey });
          const storedCapturedAt = new Date(String(stored.captured_at)).valueOf();
          const matches = String(stored.employee_id) === actor.employee.$id
            && String(stored.idempotency_key) === write.idempotencyKey
            && storedCapturedAt === new Date(write.data.captured_at).valueOf()
            && Number(stored.latitude) === write.data.latitude
            && Number(stored.longitude) === write.data.longitude
            && Number(stored.accuracy) === write.data.accuracy
            && String(stored.source) === write.data.source;
          if (matches) return { confirmed: write.idempotencyKey } as const;
          return { rejected: { idempotencyKey: write.idempotencyKey, reason: "idempotency_conflict", retryable: false } satisfies RejectedPoint } as const;
        } catch {
          return { rejected: { idempotencyKey: write.idempotencyKey, reason: "server_write_failed", retryable: true } satisfies RejectedPoint } as const;
        }
      }
      return { rejected: { idempotencyKey: write.idempotencyKey, reason: "server_write_failed", retryable: true } satisfies RejectedPoint } as const;
    }
  });

  const confirmed = [...new Set(outcomes.flatMap((outcome) => "confirmed" in outcome ? [outcome.confirmed] : []))];
  rejected.push(...outcomes.flatMap((outcome) => "rejected" in outcome ? [outcome.rejected] : []));
  return NextResponse.json({ ok: true, confirmed, rejected, rejectedCount: rejected.length });
}
