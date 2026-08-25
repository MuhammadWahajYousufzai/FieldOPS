import { NextResponse } from "next/server";
import type { Models } from "node-appwrite";
import { createAdminAccount, createAdminTablesDb, createAdminUsers } from "@fieldops/appwrite/server";
import { dashboardAdminForUser, SESSION_COOKIE } from "../../../../lib/auth";
import { authorizeCreatedSession } from "../../../../lib/created-session-authorization";
import { consumeCredentialAttempt } from "../../../../lib/credential-attempt-throttle";

const databaseId = process.env.APPWRITE_DATABASE_ID ?? "fieldops";

function appwriteStatus(error: unknown): number {
  return typeof error === "object" && error !== null && "code" in error
    ? Number(error.code)
    : 0;
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    const input = await request.json() as unknown;
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid body");
    body = input as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Enter your email and password." }, { status: 400 });
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!email || email.length > 320 || !password || password.length > 256) {
    return NextResponse.json({ error: "Enter your email and password." }, { status: 400 });
  }

  try {
    const throttle = await consumeCredentialAttempt({
      db: createAdminTablesDb(),
      databaseId,
      email,
      headers: request.headers,
      secret: process.env.AUTH_RATE_LIMIT_HMAC_SECRET ?? process.env.APPWRITE_API_KEY ?? "",
    });
    if (!throttle.allowed) {
      return NextResponse.json(
        { error: "Too many sign-in attempts. Wait a few minutes and try again." },
        { status: 429, headers: { "cache-control": "no-store", "retry-after": String(throttle.retryAfterSeconds) } },
      );
    }
  } catch (error) {
    console.error("Dashboard credential-attempt protection is unavailable", error);
    return NextResponse.json(
      { error: "Sign in is temporarily unavailable. Try again shortly." },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  let session: Models.Session;
  try {
    session = await createAdminAccount().createEmailPasswordSession({ email, password });
  } catch (error) {
    const status = appwriteStatus(error);
    return NextResponse.json(
      { error: status === 401 ? "The email or password is incorrect." : "Sign in is temporarily unavailable." },
      { status: status === 401 ? 401 : 503 },
    );
  }

  const users = createAdminUsers();
  try {
    const actor = await authorizeCreatedSession(
      async () => {
        const user = await users.get({ userId: session.userId });
        return dashboardAdminForUser(user);
      },
      () => users.deleteSession({ userId: session.userId, sessionId: session.$id }),
    );
    if (!actor) {
      return NextResponse.json({ error: "This Appwrite account does not have the admin label." }, { status: 403 });
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
    console.error("Dashboard authorization failed after session creation", error);
    return NextResponse.json({ error: "Sign in could not be completed safely. Try again." }, { status: 503 });
  }
}
