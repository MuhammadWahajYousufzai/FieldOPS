import type { Models } from "node-appwrite";
import { NextResponse } from "next/server";
import { createAdminAccount, createAdminTablesDb, createAdminUsers } from "@fieldops/appwrite/server";
import { authorizeCreatedSession } from "../../../../../lib/created-session-authorization";
import { consumeCredentialAttempt } from "../../../../../lib/credential-attempt-throttle";
import { activeSalespersonEmployeeForUser, text } from "../../../../../lib/mobile-auth";

const databaseId = process.env.APPWRITE_DATABASE_ID ?? "fieldops";

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    const input = await request.json() as unknown;
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid body");
    body = input as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Enter email and password." }, { status: 400 });
  }
  const email = text(body.email, 320).toLowerCase();
  const password = typeof body.password === "string" ? body.password : "";
  if (!email || !password || password.length > 256) {
    return NextResponse.json({ error: "Enter email and password." }, { status: 400 });
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
    console.error("Mobile credential-attempt protection is unavailable", error);
    return NextResponse.json(
      { error: "Sign in is temporarily unavailable. Try again shortly." },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  let session: Models.Session;
  try {
    session = await createAdminAccount().createEmailPasswordSession({ email, password });
  } catch (error) {
    const status = typeof error === "object" && error !== null && "code" in error ? Number(error.code) : 0;
    return NextResponse.json(
      { error: status === 401 ? "The email or password is incorrect." : "Sign in is temporarily unavailable." },
      { status: status === 401 ? 401 : 503 },
    );
  }

  try {
    const employee = await authorizeCreatedSession(
      () => activeSalespersonEmployeeForUser(session.userId),
      () => createAdminUsers().deleteSession({ userId: session.userId, sessionId: session.$id }),
    );
    if (!employee) return NextResponse.json({ error: "This account is not assigned to active FieldOPS sales work." }, { status: 403 });
    return NextResponse.json({
      token: session.secret,
      expiresAt: session.expire,
      employee: { id: employee.$id, name: employee.display_name },
    });
  } catch (error) {
    console.error("Mobile employee authorization failed after session creation", error);
    return NextResponse.json({ error: "Sign in could not be completed safely. Try again." }, { status: 503 });
  }
}
