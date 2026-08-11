import { Query } from "node-appwrite";
import { NextResponse } from "next/server";
import { createAdminAccount, createAdminTablesDb } from "@fieldops/appwrite/server";
import { text } from "../../../../../lib/mobile-auth";

const databaseId = process.env.APPWRITE_DATABASE_ID ?? "fieldops";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const email = text(body.email, 320).toLowerCase();
    const password = text(body.password, 256);
    if (!email || !password) return NextResponse.json({ error: "Enter email and password." }, { status: 400 });
    const session = await createAdminAccount().createEmailPasswordSession({ email, password });
    const employee = (await createAdminTablesDb().listRows({
      databaseId,
      tableId: "employees",
      queries: [Query.equal("user_id", session.userId), Query.equal("status", "active"), Query.limit(1)],
    })).rows[0];
    if (!employee) return NextResponse.json({ error: "This account is not assigned to FieldOPS." }, { status: 403 });
    return NextResponse.json({
      token: session.secret,
      expiresAt: session.expire,
      employee: { id: employee.$id, name: employee.display_name },
    });
  } catch {
    return NextResponse.json({ error: "The email or password is incorrect." }, { status: 401 });
  }
}
