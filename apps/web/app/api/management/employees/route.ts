import { Query, type Models, type Users } from "node-appwrite";
import { NextResponse } from "next/server";
import { createAdminTablesDb, createAdminUsers } from "@fieldops/appwrite/server";
import { requireDashboardAdmin } from "../../../../lib/auth";
import {
  isAppwriteConflict,
  isAppwriteNotFound,
  managementAuditIdentity,
  managementOperationKey,
  runManagementTransaction,
  stableManagementId,
} from "../../../../lib/management-write";
import { text } from "../../../../lib/mobile-auth";

const databaseId = process.env.APPWRITE_DATABASE_ID ?? "fieldops";

export async function POST(request: Request) {
  const actor = await requireDashboardAdmin();
  if (!actor) return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const name = text(body.name, 128), email = text(body.email, 320).toLowerCase();
  const phone = text(body.phone, 32);
  const password = text(body.password, 256);
  if (!name || !email.includes("@") || password.length < 8) {
    return NextResponse.json({ error: "Name, email, and a separate 8+ character salesperson password are required." }, { status: 400 });
  }

  const db = createAdminTablesDb();
  const users = createAdminUsers();
  const role = (await db.listRows({
    databaseId,
    tableId: "roles",
    queries: [Query.equal("code", "sales_person"), Query.equal("active", true), Query.limit(1)],
  })).rows[0];
  if (!role) return NextResponse.json({ error: "The salesperson role is not configured." }, { status: 409 });

  let createdAuthUser = false;
  let user: Models.User<Models.Preferences>;
  try {
    const resolved = await resolveOrCreateUser(users, email, password, name);
    user = resolved.user;
    createdAuthUser = resolved.created;
  } catch (error) {
    if (isAppwriteConflict(error)) {
      return NextResponse.json({ error: "A salesperson with that email already exists." }, { status: 409 });
    }
    return NextResponse.json({ error: "The salesperson account could not be created." }, { status: 500 });
  }

  let existingEmployee;
  try {
    existingEmployee = await employeeForUser(db, user.$id);
  } catch {
    // The deterministic Auth account is intentionally retained when employee
    // reconciliation cannot be verified. A retry can safely finish the profile.
    return NextResponse.json({ error: "The salesperson profile could not be checked. The account is reserved and retrying is safe." }, { status: 503 });
  }
  if (existingEmployee) {
    if (existingEmployee.status !== "active"
      || String(existingEmployee.display_name).trim() !== name.trim()
      || String(existingEmployee.phone ?? "") !== phone) {
      return NextResponse.json({
        error: "That email already belongs to an existing salesperson with different profile details.",
      }, { status: 409 });
    }
    return NextResponse.json({
      ok: true,
      employeeId: existingEmployee.$id,
      created: false,
      replayed: true,
    });
  }

  const employeeId = stableManagementId("emp", user.$id);
  const assignmentId = stableManagementId("assign", "employee-role", employeeId, role.$id);
  const operationKey = managementOperationKey(body.operationId, "employee.create", email);
  const { auditId, correlationId } = managementAuditIdentity("employee.created", employeeId, operationKey);
  const now = new Date().toISOString();

  try {
    await runManagementTransaction(db, async (transactionId) => {
      await db.createRow({ databaseId, tableId: "employees", rowId: employeeId, transactionId, data: {
        user_id: user.$id,
        display_name: name,
        ...(phone ? { phone } : {}),
        status: "active",
        joining_date: now,
      }, permissions: [] });
      await db.createRow({ databaseId, tableId: "employee_assignments", rowId: assignmentId, transactionId, data: {
        employee_id: employeeId,
        role_id: role.$id,
        effective_from: now,
        assigned_by: actor.user.$id,
        reason: "Created from management dashboard",
      }, permissions: [] });
      await db.createRow({ databaseId, tableId: "audit_logs", rowId: auditId, transactionId, data: {
        actor_user_id: actor.user.$id,
        action: "employee.created",
        entity_type: "employee",
        entity_id: employeeId,
        occurred_at: now,
        after_json: JSON.stringify({ email, phone, assignmentId, reconciledAuthUser: !createdAuthUser }),
        reason: "Management dashboard",
        correlation_id: correlationId,
      }, permissions: [] });
    });
    return NextResponse.json({
      ok: true,
      employeeId,
      created: true,
      replayed: false,
      reconciledAuthUser: !createdAuthUser,
    }, { status: 201 });
  } catch (error) {
    let concurrentEmployee;
    try {
      concurrentEmployee = await employeeForUser(db, user.$id);
    } catch {
      return NextResponse.json({
        error: "The final employee status could not be confirmed. The account was retained so retrying cannot lose it.",
      }, { status: 503 });
    }
    if (concurrentEmployee) {
      return NextResponse.json({ ok: true, employeeId: concurrentEmployee.$id, created: false, replayed: true });
    }
    if (createdAuthUser) await users.delete({ userId: user.$id }).catch(() => undefined);
    const code = isAppwriteConflict(error) ? 409 : 500;
    return NextResponse.json({
      error: code === 409
        ? "A salesperson with that email already exists."
        : "The salesperson could not be created. No employee profile was saved; retrying is safe.",
    }, { status: code });
  }
}

async function employeeForUser(db: ReturnType<typeof createAdminTablesDb>, userId: string) {
  const rows = await db.listRows({
    databaseId,
    tableId: "employees",
    queries: [Query.equal("user_id", userId), Query.limit(1)],
  });
  return rows.rows[0] ?? null;
}

async function resolveOrCreateUser(users: Users, email: string, password: string, name: string) {
  const deterministicUserId = stableManagementId("usr", email);
  try {
    const user = await users.get({ userId: deterministicUserId });
    if (user.email.toLowerCase() !== email) throw conflictError();
    return { user, created: false };
  } catch (error) {
    if (!isAppwriteNotFound(error)) throw error;
  }

  const matches = await users.list({ queries: [Query.equal("email", email), Query.limit(2)] });
  const exact = matches.users.find((candidate) => candidate.email.toLowerCase() === email);
  if (exact) return { user: exact, created: false };

  try {
    return {
      user: await users.create({ userId: deterministicUserId, email, password, name }),
      created: true,
    };
  } catch (error) {
    if (!isAppwriteConflict(error)) throw error;
    const replay = await users.list({ queries: [Query.equal("email", email), Query.limit(2)] });
    const user = replay.users.find((candidate) => candidate.email.toLowerCase() === email);
    if (!user) throw error;
    return { user, created: false };
  }
}

function conflictError() {
  return { code: 409 };
}
