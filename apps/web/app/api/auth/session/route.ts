import { NextResponse } from "next/server";
import { requireDashboardAdmin } from "../../../../lib/auth";

export async function GET() {
  const actor = await requireDashboardAdmin();
  return NextResponse.json(
    { user: Boolean(actor) },
    { headers: { "cache-control": "no-store" } },
  );
}
