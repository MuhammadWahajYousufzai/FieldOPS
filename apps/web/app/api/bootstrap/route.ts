import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({ error: "FieldOPS is already initialized." }, { status: 410 });
}

export async function POST() {
  return NextResponse.json({ error: "FieldOPS is already initialized." }, { status: 410 });
}
