import { NextResponse } from "next/server";
import { createSessionAccount } from "@fieldops/appwrite/server";

export async function POST(request: Request) {
  const header = request.headers.get("authorization") ?? "";
  const session = header.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!session) return NextResponse.json({ ok: true });

  try {
    await createSessionAccount(session, request.headers.get("user-agent") ?? undefined)
      .deleteSession({ sessionId: "current" });
  } catch (error) {
    const status = typeof error === "object" && error !== null && "code" in error ? Number(error.code) : 0;
    if (status !== 401 && status !== 404) {
      return NextResponse.json({ error: "The server session could not be closed." }, { status: 503 });
    }
  }
  return NextResponse.json({ ok: true });
}
