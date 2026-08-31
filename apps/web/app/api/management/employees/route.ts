import { Query, type Models, type Users } from "node-appwrite";
import { NextResponse } from "next/server";
import { createAdminTablesDb, createAdminUsers } from "@fieldops/appwrite/server";
import { requireDashboardAdmin } from "../../../../lib/auth";
import { DASHBOARD_ADMIN_LABEL } from "../../../../lib/management-authorization";
import {
  isAppwriteConflict,
  isAppwriteNotFound,
  managementAuditIdentity,
  managementOperationKey,
  runManagementTransaction,
  stableManagementId,
} from "../../../../lib/management-write";
import { text } from "../../../../lib/mobile-auth";
import { listAllRowsChecked } from "../../../../lib/table-data";

const databaseId = process.env.APPWRITE_DATABASE_ID ?? "fieldops";
const DEFAULT_DIRECTORY_PAGE = 50;
const MAX_DIRECTORY_PAGE = 100;
const MAX_PAGE_ASSIGNMENTS = 5_000;

export async function GET(request: Request) {
  const actor = await requireDashboardAdmin();
  if (!actor) return NextResponse.json({ error: "Admin access is required." }, { status: 403 });

  const db = createAdminTablesDb();
  const users = createAdminUsers();
  try {
    const url = new URL(request.url);
    const limit = directoryLimit(url.searchParams.get("limit"));
    const cursor = text(url.searchParams.get("cursor"), 36);
    if (cursor && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}$/.test(cursor)) {
      return NextResponse.json({ error: "The roster cursor is invalid." }, { status: 400 });
    }
    const [employeePage, salesRoleRows] = await Promise.all([
      db.listRows({
        databaseId,
        tableId: "employees",
        queries: [
          Query.orderAsc("$id"),
          Query.limit(limit),
          ...(cursor ? [Query.cursorAfter(cursor)] : []),
        ],
        total: false,
      }),
      db.listRows({
        databaseId,
        tableId: "roles",
        queries: [Query.equal("code", "sales_person"), Query.limit(2)],
        total: false,
      }),
    ]);
    const salesRole = salesRoleRows.rows[0];
    if (!salesRole) {
      return NextResponse.json({ error: "The salesperson role is not configured." }, { status: 409 });
    }
    const employeeIds = employeePage.rows.map((employee) => employee.$id);
    const assignmentRows = employeeIds.length
      ? await listAllRowsChecked(
        db,
        databaseId,
        "employee_assignments",
        [Query.equal("employee_id", employeeIds)],
        MAX_PAGE_ASSIGNMENTS,
      )
      : [];
    const salespersonIds = new Set(assignmentRows.flatMap((assignment) => (
      String(assignment.role_id) === salesRole.$id ? [String(assignment.employee_id)] : []
    )));
    const effectiveSalespersonIds = new Set(assignmentRows.flatMap((assignment) => (
      salesRole.active === true
        && String(assignment.role_id) === salesRole.$id
        && assignmentIsEffectiveNow(assignment)
        ? [String(assignment.employee_id)]
        : []
    )));
    const salespersonRows = employeePage.rows
      .filter((employee) => salespersonIds.has(employee.$id))
      .sort((left, right) => String(left.display_name).localeCompare(String(right.display_name)));

    const salespeople = await mapWithConcurrency(salespersonRows, 8, async (employee) => {
      const userId = String(employee.user_id ?? "");
      let user: Models.User<Models.Preferences> | null = null;
      if (userId) {
        try {
          user = await users.get({ userId });
        } catch (error) {
          if (!isAppwriteNotFound(error)) throw error;
        }
      }
      const rawEmployeeStatus = String(employee.status ?? "");
      const employeeStatus = rawEmployeeStatus === "active" ? "active" as const : "inactive" as const;
      const authStatus = !user ? "missing" as const : user.status ? "enabled" as const : "disabled" as const;
      const name = String(employee.display_name ?? "").trim();
      const identityIssues = [
        !userId ? "The employee profile has no linked login account." : !user ? "The linked login account is missing." : "",
        user && user.name.trim() !== name ? "Login and field names are out of sync." : "",
        user && ((employeeStatus === "active") !== user.status) ? "Profile and login access are out of sync." : "",
        rawEmployeeStatus !== "active" && rawEmployeeStatus !== "inactive"
          ? `The employee record has an unsupported “${rawEmployeeStatus || "blank"}” status.`
          : "",
      ].filter(Boolean);
      return {
        id: employee.$id,
        userId,
        name,
        email: user?.email ?? "",
        phone: String(employee.phone ?? ""),
        status: employeeStatus,
        rawStatus: rawEmployeeStatus,
        authStatus,
        effectiveSalesRole: effectiveSalespersonIds.has(employee.$id),
        protected: Boolean(user?.labels.includes(DASHBOARD_ADMIN_LABEL)),
        identityIssue: identityIssues.join(" "),
        updatedAt: employee.$updatedAt,
        authUpdatedAt: user?.$updatedAt ?? "",
        joinedAt: String(employee.joining_date ?? employee.$createdAt),
        passwordUpdatedAt: user?.passwordUpdate ?? "",
        lastActivityAt: user?.accessedAt ?? "",
      };
    });

    const nextCursor = employeePage.rows.length === limit ? employeePage.rows.at(-1)?.$id ?? null : null;
    return NextResponse.json({ salespeople, nextCursor }, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    console.error("Could not list salesperson accounts", error);
    return NextResponse.json({ error: "Salesperson accounts could not be loaded." }, { status: 500 });
  }
}

function directoryLimit(value: string | null) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0
    ? Math.min(parsed, MAX_DIRECTORY_PAGE)
    : DEFAULT_DIRECTORY_PAGE;
}

function assignmentIsEffectiveNow(assignment: Record<string, unknown>) {
  const now = Date.now();
  const start = new Date(String(assignment.effective_from ?? "")).valueOf();
  if (!Number.isFinite(start) || start > now) return false;
  if (!assignment.effective_to) return true;
  const end = new Date(String(assignment.effective_to)).valueOf();
  return Number.isFinite(end) && end > now;
}

function validEmail(value: string) {
  return value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validOptionalPhone(value: string) {
  if (!value) return true;
  const digits = value.replace(/\D/g, "");
  const plusCount = [...value].filter((character) => character === "+").length;
  return /^[+0-9() .-]+$/.test(value)
    && plusCount <= 1
    && (plusCount === 0 || value.startsWith("+"))
    && digits.length >= 7
    && digits.length <= 15;
}

export async function POST(request: Request) {
  const actor = await requireDashboardAdmin();
  if (!actor) return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const name = text(body.name, 128), email = text(body.email, 320).toLowerCase();
  const phone = text(body.phone, 32);
  const password = typeof body.password === "string" && body.password.length <= 256 ? body.password : "";
  if (!name || !validEmail(email) || !validOptionalPhone(phone) || password.length < 8 || !/\S/.test(password)) {
    return NextResponse.json({ error: "Enter a valid name, work email, optional phone, and separate 8–256 character salesperson password." }, { status: 400 });
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

  const deterministicUserIds = salespersonUserIdCandidates(email);
  if (!createdAuthUser && !deterministicUserIds.includes(user.$id)) {
    return NextResponse.json({
      error: "That email already belongs to another login account and cannot be adopted as a salesperson.",
    }, { status: 409 });
  }
  if (!createdAuthUser && user.labels.includes(DASHBOARD_ADMIN_LABEL)) {
    return NextResponse.json({
      error: "Dashboard administrator accounts cannot be converted into salesperson accounts.",
    }, { status: 409 });
  }
  if (!createdAuthUser && user.accessedAt) {
    return NextResponse.json({
      error: "That reserved login has already been used and cannot be converted into a salesperson account.",
    }, { status: 409 });
  }
  if (!createdAuthUser) {
    try {
      if (user.name !== name) user = await users.updateName({ userId: user.$id, name });
      user = await users.updatePassword({ userId: user.$id, password });
      if (!user.status) user = await users.updateStatus({ userId: user.$id, status: true });
      await users.deleteSessions({ userId: user.$id });
    } catch {
      console.error("Could not reconcile reserved salesperson login");
      return NextResponse.json({
        error: "The reserved salesperson login could not be reconciled. No employee profile was created.",
      }, { status: 503 });
    }
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
  const matches = await users.list({ queries: [Query.equal("email", email), Query.limit(2)] });
  const exact = matches.users.find((candidate) => candidate.email.toLowerCase() === email);
  if (exact) return { user: exact, created: false };

  for (const deterministicUserId of salespersonUserIdCandidates(email)) {
    try {
      const occupied = await users.get({ userId: deterministicUserId });
      if (occupied.email.toLowerCase() === email) return { user: occupied, created: false };
      continue;
    } catch (error) {
      if (!isAppwriteNotFound(error)) throw error;
    }

    try {
      return {
        user: await users.create({ userId: deterministicUserId, email, password, name }),
        created: true,
      };
    } catch (error) {
      if (!isAppwriteConflict(error)) throw error;
      const replay = await users.list({ queries: [Query.equal("email", email), Query.limit(2)] });
      const user = replay.users.find((candidate) => candidate.email.toLowerCase() === email);
      if (user) return { user, created: false };
    }
  }
  throw conflictError();
}

function salespersonUserIdCandidates(email: string) {
  return Array.from({ length: 8 }, (_, index) => index === 0
    ? stableManagementId("usr", email)
    : stableManagementId("usr", email, "identity-slot", index));
}

async function mapWithConcurrency<Input, Output>(
  values: Input[],
  concurrency: number,
  mapper: (value: Input, index: number) => Promise<Output>,
) {
  const results = new Array<Output>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(values[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

function conflictError() {
  return { code: 409 };
}
