import { NextResponse } from "next/server";
import { mobileActor } from "../../../../../lib/mobile-auth";

export async function POST(request: Request) {
  const actor = await mobileActor(request);
  if (!actor) return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  return NextResponse.json({
    error: "Incomplete visit check-ins are no longer uploaded. Finish the visit with its photo and audio note, then submit the complete record.",
  }, { status: 409 });
}
