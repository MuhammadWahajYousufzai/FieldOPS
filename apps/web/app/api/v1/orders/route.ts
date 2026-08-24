import { Query } from "node-appwrite";
import { NextResponse } from "next/server";
import { createAdminTablesDb } from "@fieldops/appwrite/server";
import {
  IdempotencyConflictError,
  ensureLocationSideEffect,
  orderReplayMatches,
  stableOperationId,
  type DataRow,
  type OrderReplay,
} from "../../../../lib/mobile-write-idempotency";
import { mobileActor, number, text, workDate } from "../../../../lib/mobile-auth";
import { evaluateTerritoryAccess, territoryAccessForEmployee } from "../../../../lib/territory-access";

const databaseId = process.env.APPWRITE_DATABASE_ID ?? "fieldops";

export async function POST(request: Request) {
  const actor = await mobileActor(request);
  if (!actor) return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const rawIdempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
  const idempotencyKey = text(rawIdempotencyKey, 64);
  const customerName = text(body.customerName, 160), outletId = text(body.outletId, 36);
  const productName = text(body.productName, 160), quantityKg = strictNumber(body.quantityKg), unitPrice = strictNumber(body.unitPrice);
  const latitude = strictNumber(body.latitude), longitude = strictNumber(body.longitude), accuracy = strictNumber(body.accuracy);
  const capturedDate = new Date(text(body.capturedAt, 40));
  if (
    rawIdempotencyKey !== idempotencyKey
    || !/^[a-zA-Z0-9._-]{1,64}$/.test(idempotencyKey)
    || !customerName
    || !productName
    || quantityKg === null
    || quantityKg <= 0
    || unitPrice === null
    || unitPrice < 0
    || latitude === null
    || longitude === null
    || accuracy === null
    || Math.abs(latitude) > 90
    || Math.abs(longitude) > 180
    || accuracy < 0
    || Number.isNaN(capturedDate.valueOf())
  ) {
    return NextResponse.json({ error: "Customer, product, quantity, price, location, and operation ID are required." }, { status: 400 });
  }
  const capturedAt = capturedDate.toISOString();
  const date = workDate(capturedDate);
  const totalAmount = Math.round(quantityKg * unitPrice * 100) / 100;
  const expected: OrderReplay = {
    employeeId: actor.employee.$id,
    idempotencyKey,
    workDate: date,
    outletId,
    customerName,
    phone: text(body.phone, 32),
    address: text(body.address, 500),
    productName,
    quantityKg,
    unitPrice,
    totalAmount,
    notes: text(body.notes, 4000),
    latitude,
    longitude,
    accuracy,
    capturedAt,
  };
  const db = createAdminTablesDb();

  try {
    const duplicate = await orderByOperation(db, idempotencyKey);
    if (duplicate) {
      if (!orderReplayMatches(duplicate, expected)) throw new IdempotencyConflictError();
      await ensureOrderLocation(db, expected);
      return NextResponse.json({ ok: true, orderId: duplicate.$id, totalAmount: duplicate.total_amount });
    }

    const territoryDecision = evaluateTerritoryAccess(
      await territoryAccessForEmployee(db, actor.employee.$id, capturedDate),
      { latitude, longitude },
    );
    if (!territoryDecision.allowed) return NextResponse.json({ error: territoryDecision.reason }, { status: 403 });
    if (outletId) {
      try {
        await db.getRow({ databaseId, tableId: "outlets", rowId: outletId });
      } catch (error) {
        const status = typeof error === "object" && error !== null && "code" in error ? Number(error.code) : 0;
        if (status === 404) return NextResponse.json({ error: "The selected outlet no longer exists." }, { status: 409 });
        throw error;
      }
    }

    let row: DataRow;
    let created = true;
    try {
      row = await db.createRow({ databaseId, tableId: "orders", rowId: stableOperationId("order", idempotencyKey), data: {
        employee_id: actor.employee.$id,
        work_date: date,
        ...(outletId ? { outlet_id: outletId } : {}),
        customer_name: customerName,
        phone: expected.phone,
        address: expected.address,
        product_name: productName,
        quantity_kg: quantityKg,
        unit_price: unitPrice,
        total_amount: totalAmount,
        notes: expected.notes,
        latitude,
        longitude,
        coordinates: [longitude, latitude],
        accuracy,
        captured_at: capturedAt,
        received_at: new Date().toISOString(),
        status: "confirmed",
        idempotency_key: idempotencyKey,
      }, permissions: [] }) as DataRow;
    } catch (createError) {
      const committed = await orderByOperation(db, idempotencyKey).catch(() => null);
      if (!committed) throw createError;
      if (!orderReplayMatches(committed, expected)) throw new IdempotencyConflictError();
      row = committed;
      created = false;
    }
    await ensureOrderLocation(db, expected);
    return NextResponse.json(
      { ok: true, orderId: row.$id, totalAmount: row.total_amount },
      { status: created ? 201 : 200 },
    );
  } catch (error) {
    if (error instanceof IdempotencyConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}

async function orderByOperation(
  db: ReturnType<typeof createAdminTablesDb>,
  idempotencyKey: string,
): Promise<DataRow | null> {
  return ((await db.listRows({
    databaseId,
    tableId: "orders",
    queries: [Query.equal("idempotency_key", idempotencyKey), Query.limit(1)],
  })).rows[0] as DataRow | undefined) ?? null;
}

function ensureOrderLocation(
  db: ReturnType<typeof createAdminTablesDb>,
  expected: OrderReplay,
) {
  return ensureLocationSideEffect(db, databaseId, {
    operationKey: `order:${expected.idempotencyKey}`,
    employeeId: expected.employeeId,
    capturedAt: expected.capturedAt,
    receivedAt: new Date().toISOString(),
    latitude: expected.latitude,
    longitude: expected.longitude,
    accuracy: expected.accuracy,
    source: "order",
    workDate: expected.workDate,
  });
}

function strictNumber(value: unknown) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  return number(value);
}
