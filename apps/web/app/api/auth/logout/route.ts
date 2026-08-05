import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createSessionAccount } from "@fieldops/appwrite/server";
import { SESSION_COOKIE } from "../../../../lib/auth";

export async function POST() {
  const cookieStore = await cookies();
  const session = cookieStore.get(SESSION_COOKIE)?.value;
  if (session) {
    try { await createSessionAccount(session).deleteSession({ sessionId: "current" }); } catch { /* Expired is already logged out. */ }
  }
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, "", { httpOnly: true, expires: new Date(0), path: "/" });
  return response;
}
