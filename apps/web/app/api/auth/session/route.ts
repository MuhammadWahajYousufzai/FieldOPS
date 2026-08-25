import { NextResponse } from "next/server";
import { requireManager } from "../../../../lib/auth";

export async function GET() {
  const actor = await requireManager();
  return NextResponse.json(
    { user: Boolean(actor) },
    { headers: { "cache-control": "no-store" } },
  );
}
