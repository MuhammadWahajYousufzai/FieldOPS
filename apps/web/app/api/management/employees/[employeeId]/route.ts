import { Query, type Models, type TablesDB, type Users } from "node-appwrite";
import { NextResponse } from "next/server";
import { createAdminTablesDb, createAdminUsers } from "@fieldops/appwrite/server";
import { requireDashboardAdmin } from "../../../../../lib/auth";
import {
  EMPLOYEE_OPERATIONAL_DEPENDENCIES,
  employeeAuditReceiptJson,
  employeeAuditReceiptMatches,
  employeeAuditReceiptResult,
  employeeDeletionConfirmationLabel,
  employeeDeletionConfirmationMatches,
  employeeMutationDecision,
  employeeProfileMatches,
  employeeStatusMatches,
  hasEffectiveSalespersonAssignment,
  hasProtectedAdminIdentity,
  summarizeEmployeeDependencies,
  validEmployeeId,
  validateEmployeeDelete,
  validateEmployeeMutation,
  type EmployeeDeleteCommand,
  type EmployeeDependencyCount,
  type EmployeeMutationCommand,
  type EmployeeRow,
} from "../../../../../lib/employee-management";
import {
  appwriteErrorCode,
  isAppwriteConflict,
  isAppwriteNotFound,
  managementAuditIdentity,
  managementOperationKey,
} from "../../../../../lib/management-write";
import { listAllRowsChecked } from "../../../../../lib/table-data";

const databaseId = process.env.APPWRITE_DATABASE_ID ?? "fieldops";
const MAX_ASSIGNMENT_HISTORY = 10_000;
const MAX_UNINDEXED_DEPENDENCY_SCAN = 100_000;

type AuthUser = Models.User<Models.Preferences>;
type Db = ReturnType<typeof createAdminTablesDb>;

type AuthSnapshot = {
  userId: string;
  name: string;
  email: string;
  status: boolean;
};

type AuthChangeTracker = {
  snapshot: AuthSnapshot | null;
  emailChanged: boolean;
  nameChanged: boolean;
  statusChanged: boolean;
  passwordChanged: boolean;
  preserveDisabled: boolean;
};

type ReceiptIdentity = {
  auditId: string;
  correlationId: string;
  auditAction: string;
};

export async function PATCH(
  request: Request,
  context: { params: Promise<{ employeeId: string }> },
) {
  const actor = await requireDashboardAdmin();
  if (!actor) return NextResponse.json({ error: "Admin access is required." }, { status: 403 });

  const { employeeId } = await context.params;
  if (!validEmployeeId(employeeId)) {
    return NextResponse.json({ error: "Choose a valid salesperson." }, { status: 400 });
  }
  const input = await requestJson(request);
  const parsed = validateEmployeeMutation(input);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const command = parsed.value;
  const receiptIdentity = mutationReceiptIdentity(employeeId, command);
  const db = createAdminTablesDb();
  const users = createAdminUsers();

  let existingReceipt: EmployeeRow | null;
  try {
    existingReceipt = await getRowOrNull(db, "audit_logs", receiptIdentity.auditId);
  } catch {
    return receiptUnavailableResponse();
  }
  if (existingReceipt) {
    return mutationReceiptResponse(existingReceipt, actor.user.$id, employeeId, command, receiptIdentity.auditAction);
  }

  let transaction;
  try {
    transaction = await db.createTransaction({ ttl: 60 });
  } catch {
    return NextResponse.json({
      error: "Employee management is temporarily unavailable. No change was applied; retrying is safe.",
      code: "employee_transaction_unavailable",
    }, { status: 503 });
  }

  const tracker = emptyAuthTracker();
  try {
    const concurrentReceipt = await getRowOrNull(db, "audit_logs", receiptIdentity.auditId, transaction.$id);
    if (concurrentReceipt) {
      await rollback(db, transaction.$id);
      return mutationReceiptResponse(concurrentReceipt, actor.user.$id, employeeId, command, receiptIdentity.auditAction);
    }

    const employee = await getRowOrNull(db, "employees", employeeId, transaction.$id);
    if (!employee) throw new EmployeeProblem(404, "The salesperson was not found.", "employee_not_found");
    if (command.action === "status" && String(employee.user_id) === actor.user.$id) {
      throw new EmployeeProblem(409, "You cannot change the lifecycle of your own employee identity.", "employee_self_lifecycle_forbidden");
    }

    const salesperson = await salespersonContext(db, employeeId, transaction.$id);
    if (!salesperson.role || !salesperson.assignments.some((row) => String(row.role_id) === salesperson.role?.$id)) {
      throw new EmployeeProblem(409, "This employee has no salesperson role history.", "employee_not_salesperson");
    }

    let authUser: AuthUser | null;
    try {
      authUser = await authUserOrNull(users, String(employee.user_id));
    } catch {
      throw new EmployeeProblem(503, "The salesperson identity could not be checked. No change was applied; retrying is safe.", "employee_identity_unavailable");
    }
    if (hasProtectedAdminIdentity(authUser)) {
      throw new EmployeeProblem(409, "Admin identities are protected from salesperson management.", "employee_admin_identity_protected");
    }
    if (!authUser && !(command.action === "status" && command.status === "inactive")) {
      throw new EmployeeProblem(
        409,
        "This employee's Auth identity is missing. You may deactivate the profile, but cannot activate it or change its identity or password.",
        "employee_identity_missing",
      );
    }
    if (authUser && !command.expectedAuthUpdatedAt) {
      throw employeeIdentityChanged();
    }
    if (authUser && command.expectedAuthUpdatedAt && authUser.$updatedAt !== command.expectedAuthUpdatedAt) {
      throw employeeIdentityChanged();
    }
    if (authUser) tracker.snapshot = authSnapshot(authUser);

    const now = new Date().toISOString();
    const hasEffectiveRole = salesperson.role
      ? hasEffectiveSalespersonAssignment(salesperson.assignments, salesperson.role.$id, now)
      : false;
    const stateMatches = mutationStateMatches(command, employee, authUser)
      && !(command.action === "status" && command.status === "active" && !hasEffectiveRole);
    const decision = command.action === "password"
      ? employeeMutationDecision(command.expectedUpdatedAt, employee.$updatedAt, false)
      : employeeMutationDecision(command.expectedUpdatedAt, employee.$updatedAt, stateMatches);
    if (decision === "conflict") throw employeeChanged();

    let updatedAt = employee.$updatedAt;
    if (command.action === "status" && command.status === "active" && !hasEffectiveRole) {
      throw new EmployeeProblem(
        409,
        salesperson.role?.active === true
          ? "Restore an effective salesperson role assignment before reactivating this employee."
          : "The salesperson role is inactive. Restore the role before reactivating this employee.",
        salesperson.role?.active === true ? "salesperson_assignment_required" : "salesperson_role_inactive",
      );
    }
    if (decision === "write") {
      const updated = await db.updateRow({
        databaseId,
        tableId: "employees",
        rowId: employeeId,
        transactionId: transaction.$id,
        data: employeeUpdateData(command, employee),
      });
      updatedAt = updated.$updatedAt;
    }

    const result = {
      changed: decision === "write",
      replayed: false,
      updatedAt,
      ...(command.action === "password" ? { sessionsRevoked: true } : {}),
    };
    await db.createRow({
      databaseId,
      tableId: "audit_logs",
      rowId: receiptIdentity.auditId,
      transactionId: transaction.$id,
      data: {
        actor_user_id: actor.user.$id,
        action: receiptIdentity.auditAction,
        entity_type: "employee",
        entity_id: employeeId,
        occurred_at: now,
        before_json: mutationBeforeJson(command, employee, authUser, hasEffectiveRole),
        after_json: employeeAuditReceiptJson(command, result),
        reason: "Management dashboard",
        correlation_id: receiptIdentity.correlationId,
      },
      permissions: [],
    });

    if (decision === "write") {
      await applyAuthMutation(users, command, authUser, tracker);
    }
    await db.updateTransaction({ transactionId: transaction.$id, commit: true });
    const committed = await getRowOrNull(db, "employees", employeeId).catch(() => null);
    return NextResponse.json({
      ok: true,
      employeeId,
      updatedAt: committed?.$updatedAt ?? updatedAt,
      changed: decision === "write",
      replayed: false,
    });
  } catch (error) {
    await rollback(db, transaction.$id);

    const committedReceipt = await getRowOrNull(db, "audit_logs", receiptIdentity.auditId).catch(() => null);
    if (committedReceipt && employeeAuditReceiptMatches(committedReceipt, {
      actorUserId: actor.user.$id,
      action: receiptIdentity.auditAction,
      employeeId,
      command,
    })) {
      return mutationReceiptResponse(committedReceipt, actor.user.$id, employeeId, command, receiptIdentity.auditAction);
    }

    const compensated = await compensateAuthMutation(users, tracker);
    if (!compensated) {
      await disableIdentitySafely(users, tracker.snapshot?.userId);
      return NextResponse.json({
        error: "The database change was cancelled, but the Auth identity could not be fully restored. The identity was disabled where possible and requires administrator reconciliation.",
        code: "employee_identity_reconciliation_required",
      }, { status: 503 });
    }
    return mutationErrorResponse(error, command, tracker);
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ employeeId: string }> },
) {
  const actor = await requireDashboardAdmin();
  if (!actor) return NextResponse.json({ error: "Admin access is required." }, { status: 403 });

  const { employeeId } = await context.params;
  if (!validEmployeeId(employeeId)) {
    return NextResponse.json({ error: "Choose a valid salesperson." }, { status: 400 });
  }
  const input = await requestJson(request);
  const parsed = validateEmployeeDelete(input);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const command = parsed.value;
  const receiptIdentity = deletionReceiptIdentity(employeeId, command);
  const db = createAdminTablesDb();
  const users = createAdminUsers();

  let existingReceipt: EmployeeRow | null;
  try {
    existingReceipt = await getRowOrNull(db, "audit_logs", receiptIdentity.auditId);
  } catch {
    return receiptUnavailableResponse();
  }
  if (existingReceipt) {
    return finishDeletionReceipt(existingReceipt, actor.user.$id, employeeId, command, users);
  }

  let transaction;
  try {
    transaction = await db.createTransaction({ ttl: 60 });
  } catch {
    return NextResponse.json({
      error: "Employee deletion is temporarily unavailable. Nothing was deleted; retrying is safe.",
      code: "employee_transaction_unavailable",
    }, { status: 503 });
  }

  let authUser: AuthUser | null = null;
  let authUserId = "";
  try {
    const concurrentReceipt = await getRowOrNull(db, "audit_logs", receiptIdentity.auditId, transaction.$id);
    if (concurrentReceipt) {
      await rollback(db, transaction.$id);
      return finishDeletionReceipt(concurrentReceipt, actor.user.$id, employeeId, command, users);
    }

    const employee = await getRowOrNull(db, "employees", employeeId, transaction.$id);
    if (!employee) throw new EmployeeProblem(404, "The salesperson was not found.", "employee_not_found");
    authUserId = String(employee.user_id ?? "");
    if (authUserId === actor.user.$id) {
      throw new EmployeeProblem(409, "You cannot permanently delete your own employee identity.", "employee_self_delete_forbidden");
    }

    const salesperson = await salespersonContext(db, employeeId, transaction.$id);
    if (!salesperson.role || !salesperson.assignments.some((row) => String(row.role_id) === salesperson.role?.$id)) {
      throw new EmployeeProblem(409, "This employee has no salesperson role history.", "employee_not_salesperson");
    }

    try {
      authUser = await authUserOrNull(users, authUserId);
    } catch {
      throw new EmployeeProblem(503, "The salesperson identity could not be checked. Nothing was deleted; retrying is safe.", "employee_identity_unavailable");
    }
    if (hasProtectedAdminIdentity(authUser)) {
      throw new EmployeeProblem(409, "Admin identities are protected from permanent deletion.", "employee_admin_identity_protected");
    }
    if (authUser && !command.expectedAuthUpdatedAt) {
      throw employeeIdentityChanged();
    }
    if (authUser && command.expectedAuthUpdatedAt && authUser.$updatedAt !== command.expectedAuthUpdatedAt) {
      throw employeeIdentityChanged();
    }
    if (String(employee.status) !== "inactive") {
      throw new EmployeeProblem(409, "Deactivate this salesperson before permanent deletion.", "employee_must_be_inactive");
    }
    if (authUser?.status === true) {
      throw new EmployeeProblem(409, "The Auth identity is still active. Deactivate the salesperson again before permanent deletion.", "employee_identity_still_active");
    }
    if (authUser?.accessedAt) {
      throw new EmployeeProblem(
        409,
        "This sign-in identity has already been used and cannot be permanently removed. Keep the salesperson inactive to preserve account history.",
        "employee_identity_previously_used",
      );
    }
    if (command.expectedUpdatedAt !== employee.$updatedAt) throw employeeChanged();

    const confirmationMatches = employeeDeletionConfirmationMatches({
      confirmation: command.confirmationEmail,
      ...(authUser ? { authEmail: authUser.email } : {}),
      displayName: String(employee.display_name ?? ""),
    });
    if (!confirmationMatches) {
      const label = employeeDeletionConfirmationLabel(Boolean(authUser));
      throw new EmployeeProblem(
        400,
        `Type ${label} exactly to confirm permanent deletion.`,
        "employee_delete_confirmation_mismatch",
      );
    }

    const dependencySummary = await employeeDependencies(db, employeeId, authUserId, transaction.$id);
    if (dependencySummary.blocked) {
      throw new EmployeeProblem(409, dependencySummary.message, "employee_delete_dependencies", {
        dependencyTotal: dependencySummary.total,
        dependencies: dependencySummary.dependencies,
      });
    }

    const now = new Date().toISOString();
    await db.deleteRows({
      databaseId,
      tableId: "employee_assignments",
      transactionId: transaction.$id,
      queries: [Query.equal("employee_id", employeeId)],
    });
    await db.deleteRow({
      databaseId,
      tableId: "employees",
      rowId: employeeId,
      transactionId: transaction.$id,
    });
    await db.createRow({
      databaseId,
      tableId: "audit_logs",
      rowId: receiptIdentity.auditId,
      transactionId: transaction.$id,
      data: {
        actor_user_id: actor.user.$id,
        action: receiptIdentity.auditAction,
        entity_type: "employee",
        entity_id: employeeId,
        occurred_at: now,
        before_json: JSON.stringify({
          displayName: String(employee.display_name ?? ""),
          email: authUser?.email ?? null,
          phone: employee.phone ? String(employee.phone) : "",
          status: employee.status,
          authUserId,
          assignmentRowsRemoved: salesperson.assignments.length,
        }),
        after_json: employeeAuditReceiptJson(command, {
          authUserId,
          authExisted: Boolean(authUser),
          authCreatedAt: authUser?.$createdAt ?? null,
          deleted: true,
        }),
        reason: "Permanent deletion confirmed in management dashboard; no operational history existed",
        correlation_id: receiptIdentity.correlationId,
      },
      permissions: [],
    });
    await db.updateTransaction({ transactionId: transaction.$id, commit: true });
  } catch (error) {
    await rollback(db, transaction.$id);
    const committedReceipt = await getRowOrNull(db, "audit_logs", receiptIdentity.auditId).catch(() => null);
    if (committedReceipt) {
      return finishDeletionReceipt(committedReceipt, actor.user.$id, employeeId, command, users);
    }
    return deletionErrorResponse(error);
  }

  try {
    if (authUser) await users.delete({ userId: authUserId });
  } catch (error) {
    if (!isAppwriteNotFound(error)) {
      return NextResponse.json({
        error: "The employee records were removed and the inactive Auth identity is pending deletion. Retry this same request to finish safely.",
        code: "employee_auth_deletion_pending",
        employeeId,
      }, { status: 503 });
    }
  }
  return NextResponse.json({ ok: true, employeeId, deleted: true, replayed: false });
}

function mutationReceiptIdentity(employeeId: string, command: EmployeeMutationCommand): ReceiptIdentity {
  const auditAction = command.action === "profile"
    ? "employee.profile_updated"
    : command.action === "password"
      ? "employee.password_changed"
      : command.status === "active"
        ? "employee.activated"
        : "employee.deactivated";
  const operationKey = managementOperationKey(command.operationId, auditAction, employeeId);
  return { auditAction, ...managementAuditIdentity(auditAction, employeeId, operationKey) };
}

function deletionReceiptIdentity(employeeId: string, command: EmployeeDeleteCommand): ReceiptIdentity {
  const auditAction = "employee.deleted";
  const operationKey = managementOperationKey(command.operationId, auditAction, employeeId);
  return { auditAction, ...managementAuditIdentity(auditAction, employeeId, operationKey) };
}

function mutationStateMatches(
  command: EmployeeMutationCommand,
  employee: EmployeeRow,
  authUser: AuthUser | null,
) {
  if (command.action === "profile") return Boolean(authUser && employeeProfileMatches(command, employee, authUser));
  if (command.action === "status") return employeeStatusMatches(command.status, employee, authUser);
  return false;
}

function employeeUpdateData(command: EmployeeMutationCommand, employee: EmployeeRow) {
  if (command.action === "profile") {
    return { display_name: command.name, phone: command.phone || null };
  }
  if (command.action === "status") return { status: command.status };
  // Passwords never enter TablesDB. Touching the employee row gives credential
  // resets their own optimistic-concurrency version.
  return { display_name: String(employee.display_name ?? "") };
}

function mutationBeforeJson(
  command: EmployeeMutationCommand,
  employee: EmployeeRow,
  authUser: AuthUser | null,
  effectiveSalespersonAssignment: boolean,
) {
  if (command.action === "profile") {
    return JSON.stringify({
      displayName: String(employee.display_name ?? ""),
      email: authUser?.email ?? null,
      phone: employee.phone ? String(employee.phone) : "",
    });
  }
  if (command.action === "status") {
    return JSON.stringify({
      employeeStatus: String(employee.status ?? ""),
      authStatus: authUser?.status ?? null,
      effectiveSalespersonAssignment,
    });
  }
  return JSON.stringify({ credentialsChanged: false, sessionsRevoked: false });
}

async function applyAuthMutation(
  users: Users,
  command: EmployeeMutationCommand,
  authUser: AuthUser | null,
  tracker: AuthChangeTracker,
) {
  if (!authUser) return;
  const userId = authUser.$id;
  if (command.action === "profile") {
    if (authUser.email.toLowerCase() !== command.email) {
      await users.updateEmail({ userId, email: command.email });
      tracker.emailChanged = true;
    }
    if (authUser.name.trim() !== command.name) {
      await users.updateName({ userId, name: command.name });
      tracker.nameChanged = true;
    }
    return;
  }
  if (command.action === "password") {
    await users.updatePassword({ userId, password: command.password });
    tracker.passwordChanged = true;
    await users.deleteSessions({ userId });
    return;
  }

  const active = command.status === "active";
  if (active) {
    await users.deleteSessions({ userId });
  }
  if (authUser.status !== active) {
    await users.updateStatus({ userId, status: active });
    tracker.statusChanged = true;
  }
  if (!active) {
    try {
      await users.deleteSessions({ userId });
    } catch (error) {
      // Never re-enable an identity when its session revocation could not be
      // confirmed. A retry can safely finish the deactivation.
      tracker.preserveDisabled = true;
      throw error;
    }
  }
}

async function compensateAuthMutation(users: Users, tracker: AuthChangeTracker) {
  const snapshot = tracker.snapshot;
  if (!snapshot) return true;
  let restored = true;
  if (tracker.nameChanged) {
    try {
      await users.updateName({ userId: snapshot.userId, name: snapshot.name });
    } catch {
      restored = false;
    }
  }
  if (tracker.emailChanged) {
    try {
      await users.updateEmail({ userId: snapshot.userId, email: snapshot.email });
    } catch {
      restored = false;
    }
  }
  if (tracker.statusChanged && !tracker.preserveDisabled) {
    try {
      await users.updateStatus({ userId: snapshot.userId, status: snapshot.status });
    } catch {
      restored = false;
    }
  }
  // The former credential is unknowable by design. Re-applying the submitted
  // password on a retry is idempotent and no secret is logged.
  return restored;
}

async function disableIdentitySafely(users: Users, userId: string | undefined) {
  if (!userId) return;
  await users.updateStatus({ userId, status: false }).catch(() => undefined);
  await users.deleteSessions({ userId }).catch(() => undefined);
}

function emptyAuthTracker(): AuthChangeTracker {
  return {
    snapshot: null,
    emailChanged: false,
    nameChanged: false,
    statusChanged: false,
    passwordChanged: false,
    preserveDisabled: false,
  };
}

function authSnapshot(user: AuthUser): AuthSnapshot {
  return { userId: user.$id, name: user.name, email: user.email, status: user.status };
}

async function salespersonContext(db: Db, employeeId: string, transactionId: string) {
  const roles = await db.listRows({
    databaseId,
    tableId: "roles",
    transactionId,
    queries: [Query.equal("code", "sales_person"), Query.limit(2)],
    ttl: 0,
  });
  const role = roles.rows[0] ?? null;
  const assignments = await assignmentHistory(db, employeeId, transactionId);
  return { role, assignments };
}

async function assignmentHistory(db: Db, employeeId: string, transactionId: string) {
  try {
    return await listAllRowsChecked(
      db,
      databaseId,
      "employee_assignments",
      [Query.equal("employee_id", employeeId)],
      MAX_ASSIGNMENT_HISTORY,
      transactionId,
    ) as EmployeeRow[];
  } catch {
    throw new EmployeeProblem(
      503,
      "This employee has too much assignment history to verify safely in one request. Archive or review the history before retrying.",
      "employee_assignment_history_limit",
    );
  }
}

async function employeeDependencies(db: Db, employeeId: string, authUserId: string, transactionId: string) {
  let counts: EmployeeDependencyCount[];
  try {
    counts = await Promise.all(EMPLOYEE_OPERATIONAL_DEPENDENCIES.map(async (dependency) => {
      const identifier = dependency.identifier === "user" ? authUserId : employeeId;
      return {
        key: dependency.key,
        label: dependency.label,
        count: !identifier
          ? 0
          : "scan" in dependency && dependency.scan
          ? await scanDependencyCount(db, dependency.tableId, dependency.field, identifier, transactionId)
          : await indexedDependencyCount(db, dependency.tableId, dependency.field, identifier, transactionId),
      };
    }));
  } catch (error) {
    if (error instanceof EmployeeProblem) throw error;
    throw new EmployeeProblem(
      503,
      "Operational history could not be verified safely. Nothing was deleted; retrying is safe.",
      "employee_dependency_check_unavailable",
    );
  }
  return summarizeEmployeeDependencies(counts);
}

async function indexedDependencyCount(
  db: Db,
  tableId: string,
  field: string,
  employeeId: string,
  transactionId: string,
) {
  const result = await db.listRows({
    databaseId,
    tableId,
    transactionId,
    total: true,
    ttl: 0,
    queries: [Query.equal(field, employeeId), Query.limit(1)],
  });
  return result.total;
}

async function scanDependencyCount(
  db: Db,
  tableId: string,
  field: string,
  employeeId: string,
  transactionId: string,
) {
  let count = 0;
  let scanned = 0;
  let cursor = "";
  while (scanned < MAX_UNINDEXED_DEPENDENCY_SCAN) {
    const result = await db.listRows({
      databaseId,
      tableId,
      transactionId,
      total: false,
      ttl: 0,
      queries: [
        Query.select(["$id", field]),
        Query.limit(100),
        ...(cursor ? [Query.cursorAfter(cursor)] : []),
      ],
    });
    for (const row of result.rows) {
      if (String(row[field] ?? "") === employeeId) count += 1;
    }
    scanned += result.rows.length;
    if (result.rows.length < 100) return count;
    const nextCursor = result.rows.at(-1)?.$id ?? "";
    if (!nextCursor || nextCursor === cursor) break;
    cursor = nextCursor;
  }
  throw new EmployeeProblem(
    503,
    `The ${tableId} dependency scan exceeded its safe limit. Nothing was deleted.`,
    "employee_dependency_scan_limit",
  );
}

async function finishDeletionReceipt(
  receipt: EmployeeRow,
  actorUserId: string,
  employeeId: string,
  command: EmployeeDeleteCommand,
  users: Users,
) {
  if (!employeeAuditReceiptMatches(receipt, {
    actorUserId,
    action: "employee.deleted",
    employeeId,
    command,
  })) return operationReuseResponse();
  const result = employeeAuditReceiptResult(receipt);
  const authUserId = String(result?.authUserId ?? "");
  if (result?.authExisted === false) {
    return NextResponse.json({ ok: true, employeeId, deleted: false, replayed: true });
  }
  if (!validEmployeeId(authUserId)) {
    return NextResponse.json({
      error: "The deletion receipt is incomplete and requires administrator reconciliation.",
      code: "employee_delete_receipt_invalid",
    }, { status: 503 });
  }
  let user: AuthUser | null;
  try {
    user = await authUserOrNull(users, authUserId);
  } catch {
    return authDeletionPending(employeeId);
  }
  if (!user) return NextResponse.json({ ok: true, employeeId, deleted: false, replayed: true });
  const originalCreatedAt = String(result?.authCreatedAt ?? "");
  if (originalCreatedAt && user.$createdAt !== originalCreatedAt) {
    // Appwrite releases IDs after deletion. Never delete a later identity that
    // happens to reuse the historical ID from this tombstone receipt.
    return NextResponse.json({ ok: true, employeeId, deleted: false, replayed: true, identityIdReused: true });
  }
  if (authUserId === actorUserId || hasProtectedAdminIdentity(user)) {
    return NextResponse.json({
      error: "The remaining Auth identity is protected and was not deleted.",
      code: "employee_admin_identity_protected",
    }, { status: 409 });
  }
  if (user.status) {
    return NextResponse.json({
      error: "The remaining Auth identity was reactivated and was not deleted. Disable it before retrying cleanup.",
      code: "employee_identity_still_active",
    }, { status: 409 });
  }
  try {
    await users.delete({ userId: authUserId });
  } catch (error) {
    if (!isAppwriteNotFound(error)) return authDeletionPending(employeeId);
  }
  return NextResponse.json({ ok: true, employeeId, deleted: false, replayed: true });
}

function mutationReceiptResponse(
  receipt: EmployeeRow,
  actorUserId: string,
  employeeId: string,
  command: EmployeeMutationCommand,
  auditAction: string,
) {
  if (!employeeAuditReceiptMatches(receipt, { actorUserId, action: auditAction, employeeId, command })) {
    return operationReuseResponse();
  }
  const result = employeeAuditReceiptResult(receipt);
  return NextResponse.json({
    ok: true,
    employeeId,
    updatedAt: String(result?.updatedAt ?? ""),
    changed: false,
    replayed: true,
    ...(result?.restoredAssignmentId ? { restoredAssignmentId: String(result.restoredAssignmentId) } : {}),
  });
}

function mutationErrorResponse(error: unknown, command: EmployeeMutationCommand, tracker: AuthChangeTracker) {
  if (error instanceof EmployeeProblem) return error.response();
  const code = appwriteErrorCode(error);
  if (isAppwriteConflict(error)) {
    return NextResponse.json({
      error: command.action === "profile"
        ? "That email is already in use, or this employee changed in another request. Refresh and try again."
        : "This employee changed in another request. Refresh and try again.",
      code: "employee_changed",
    }, { status: 409 });
  }
  if (isAppwriteNotFound(error)) {
    return NextResponse.json({
      error: "The salesperson Auth identity disappeared during the update. Refresh before retrying.",
      code: "employee_identity_missing",
    }, { status: 409 });
  }
  if (code === 400) {
    return NextResponse.json({
      error: command.action === "password"
        ? "The password does not meet the configured Auth policy."
        : "The Auth service rejected the supplied profile details.",
      code: "employee_identity_input_rejected",
    }, { status: 400 });
  }
  return NextResponse.json({
    error: tracker.passwordChanged
      ? "The credential may already be changed, but session revocation or the audit commit could not be confirmed. Retry the same request safely."
      : tracker.preserveDisabled
        ? "The Auth identity is disabled, but session revocation could not be confirmed. Retry the same deactivation safely."
        : "The employee could not be updated. No database change was committed; retrying is safe.",
    code: tracker.passwordChanged ? "employee_password_reconciliation_pending" : "employee_update_failed",
  }, { status: 503 });
}

function deletionErrorResponse(error: unknown) {
  if (error instanceof EmployeeProblem) return error.response();
  if (isAppwriteConflict(error)) return employeeChanged().response();
  if (isAppwriteNotFound(error)) {
    return NextResponse.json({ error: "The salesperson was not found.", code: "employee_not_found" }, { status: 404 });
  }
  return NextResponse.json({
    error: "The salesperson could not be deleted. No employee records were removed; retrying is safe.",
    code: "employee_delete_failed",
  }, { status: 500 });
}

function authDeletionPending(employeeId: string) {
  return NextResponse.json({
    error: "The employee records are deleted and the inactive Auth identity is pending deletion. Retry this same request to finish safely.",
    code: "employee_auth_deletion_pending",
    employeeId,
  }, { status: 503 });
}

function operationReuseResponse() {
  return NextResponse.json({
    error: "This request ID was already used for a different employee command. Start a new request.",
    code: "employee_operation_reused",
  }, { status: 409 });
}

function employeeChanged() {
  return new EmployeeProblem(
    409,
    "This salesperson changed in another tab or request. Refresh before saving again.",
    "employee_changed",
  );
}

function employeeIdentityChanged() {
  return new EmployeeProblem(
    409,
    "This salesperson's Auth identity changed outside this page. Refresh before saving again.",
    "employee_identity_changed",
  );
}

function receiptUnavailableResponse() {
  return NextResponse.json({
    error: "Employee request history could not be checked safely. No change was applied; retrying is safe.",
    code: "employee_receipt_unavailable",
  }, { status: 503 });
}

async function authUserOrNull(users: Users, userId: string) {
  try {
    return await users.get({ userId });
  } catch (error) {
    if (isAppwriteNotFound(error)) return null;
    throw error;
  }
}

async function getRowOrNull(
  db: TablesDB,
  tableId: string,
  rowId: string,
  transactionId?: string,
) {
  try {
    return await db.getRow({
      databaseId,
      tableId,
      rowId,
      ...(transactionId ? { transactionId } : {}),
    }) as EmployeeRow;
  } catch (error) {
    if (isAppwriteNotFound(error)) return null;
    throw error;
  }
}

async function rollback(db: Db, transactionId: string) {
  await db.updateTransaction({ transactionId, rollback: true }).catch(() => undefined);
}

async function requestJson(request: Request): Promise<Record<string, unknown>> {
  const value = await request.json().catch(() => null);
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

class EmployeeProblem extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(status: number, message: string, code: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "EmployeeProblem";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  response() {
    return NextResponse.json({ error: this.message, code: this.code, ...this.details }, { status: this.status });
  }
}
