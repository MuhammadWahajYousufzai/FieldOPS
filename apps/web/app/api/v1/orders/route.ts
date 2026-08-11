import { ID, Query } from "node-appwrite";
import { NextResponse } from "next/server";
import { createAdminTablesDb } from "@fieldops/appwrite/server";
import { mobileActor, number, text, workDate } from "../../../../lib/mobile-auth";
import { evaluateTerritoryAccess, territoryAccessForEmployee } from "../../../../lib/territory-access";

const databaseId = process.env.APPWRITE_DATABASE_ID ?? "fieldops";

export async function POST(request: Request) {
  const actor = await mobileActor(request);
  if (!actor) return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const idempotencyKey = text(body.idempotencyKey, 64);
  const customerName = text(body.customerName, 160), outletId = text(body.outletId, 36);
  const productName = text(body.productName, 160), quantityKg = number(body.quantityKg), unitPrice = number(body.unitPrice);
  const latitude = number(body.latitude), longitude = number(body.longitude), accuracy = number(body.accuracy);
  const capturedDate = new Date(text(body.capturedAt, 40));
  if (!idempotencyKey || !customerName || !productName || quantityKg === null || quantityKg <= 0 || unitPrice === null || unitPrice < 0 || latitude === null || longitude === null || accuracy === null || Number.isNaN(capturedDate.valueOf())) {
    return NextResponse.json({ error: "Customer, product, quantity, price, location, and operation ID are required." }, { status: 400 });
  }
  const db = createAdminTablesDb();
  const duplicate = (await db.listRows({ databaseId, tableId: "orders", queries: [Query.equal("idempotency_key", idempotencyKey), Query.limit(1)] })).rows[0];
  if (duplicate) return NextResponse.json({ ok: true, orderId: duplicate.$id, totalAmount: duplicate.total_amount });
  const territoryDecision = evaluateTerritoryAccess(
    await territoryAccessForEmployee(db, actor.employee.$id, capturedDate),
    { latitude, longitude },
  );
  if (!territoryDecision.allowed) return NextResponse.json({ error: territoryDecision.reason }, { status: 403 });
  if (outletId) {
    try { await db.getRow({ databaseId, tableId: "outlets", rowId: outletId }); } catch { return NextResponse.json({ error: "The selected outlet no longer exists." }, { status: 409 }); }
  }
  const capturedAt = capturedDate.toISOString(), now = new Date().toISOString();
  const totalAmount = Math.round(quantityKg * unitPrice * 100) / 100;
  const row = await db.createRow({ databaseId, tableId: "orders", rowId: ID.unique(), data: {
    employee_id: actor.employee.$id,
    work_date: workDate(capturedDate),
    ...(outletId ? { outlet_id: outletId } : {}),
    customer_name: customerName,
    phone: text(body.phone, 32),
    address: text(body.address, 500),
    product_name: productName,
    quantity_kg: quantityKg,
    unit_price: unitPrice,
    total_amount: totalAmount,
    notes: text(body.notes, 4000),
    latitude,
    longitude,
    coordinates: [longitude, latitude],
    accuracy: Math.max(0, accuracy),
    captured_at: capturedAt,
    received_at: now,
    status: "confirmed",
    idempotency_key: idempotencyKey,
  }, permissions: [] });
  await db.createRow({ databaseId, tableId: "location_points", rowId: ID.unique(), data: {
    employee_id: actor.employee.$id,
    captured_at: capturedAt,
    received_at: now,
    latitude,
    longitude,
    coordinates: [longitude, latitude],
    accuracy: Math.max(0, accuracy),
    source: "order",
    work_date: workDate(capturedDate),
  }, permissions: [] });
  return NextResponse.json({ ok: true, orderId: row.$id, totalAmount }, { status: 201 });
}
