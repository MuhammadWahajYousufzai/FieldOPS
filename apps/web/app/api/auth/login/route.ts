import { NextResponse } from "next/server";
import { createAdminAccount } from "@fieldops/appwrite/server";
import { SESSION_COOKIE } from "../../../../lib/auth";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (typeof body.email !== "string" || typeof body.password !== "string") {
      return NextResponse.json({ error: "Enter your email and password." }, { status: 400 });
    }
    const session = await createAdminAccount().createEmailPasswordSession({ email: body.email.trim(), password: body.password });
    const response = NextResponse.json({ ok: true });
    response.cookies.set(SESSION_COOKIE, session.secret, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      expires: new Date(session.expire),
      path: "/",
    });
    return response;
  } catch {
    return NextResponse.json({ error: "The email or password is incorrect." }, { status: 401 });
  }
}
