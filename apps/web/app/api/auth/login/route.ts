import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { createAdminUsers, createSessionAccount } from "@fieldops/appwrite/server";
import { dashboardManagerUserId, managerForUser, SESSION_COOKIE } from "../../../../lib/auth";

function matchesDashboardPassword(password: string): boolean {
  const configured = process.env.FIELDOPS_INITIAL_PASSWORD;
  if (!configured) throw new Error("FIELDOPS_INITIAL_PASSWORD is not configured.");
  const submittedDigest = createHash("sha256").update(password).digest();
  const configuredDigest = createHash("sha256").update(configured).digest();
  return timingSafeEqual(submittedDigest, configuredDigest);
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (typeof body.password !== "string" || !body.password) {
      return NextResponse.json({ error: "Enter your password." }, { status: 400 });
    }
    if (!matchesDashboardPassword(body.password)) {
      return NextResponse.json({ error: "The password is incorrect." }, { status: 401 });
    }
    const userId = await dashboardManagerUserId();
    const session = await createAdminUsers().createSession({ userId });
    const account = createSessionAccount(session.secret);
    const user = await account.get();
    const actor = await managerForUser(user);
    if (!actor) {
      await account.deleteSession({ sessionId: "current" });
      return NextResponse.json({ error: "Management access is required." }, { status: 403 });
    }
    const response = NextResponse.json({ ok: true });
    response.cookies.set(SESSION_COOKIE, session.secret, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      expires: new Date(session.expire),
      path: "/",
    });
    return response;
  } catch (error) {
    console.error("Dashboard sign-in failed", error);
    return NextResponse.json({ error: "Dashboard sign-in is not configured correctly." }, { status: 503 });
  }
}
