import { Client, Query, TablesDB, Users } from "../packages/appwrite/node_modules/node-appwrite/dist/index.mjs";

const MANAGER_ROLE_CODES = new Set(["super_admin", "executive", "manager"]);
const ADMIN_LABEL = "admin";
const PAGE_SIZE = 100;

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

const databaseId = required("APPWRITE_DATABASE_ID");
const client = new Client()
  .setEndpoint(required("APPWRITE_ENDPOINT"))
  .setProject(required("APPWRITE_PROJECT_ID"))
  .setKey(required("APPWRITE_API_KEY"));
const db = new TablesDB(client);
const users = new Users(client);

function assignmentIsEffective(assignment, now) {
  const startsAt = new Date(String(assignment.effective_from ?? "")).valueOf();
  if (!Number.isFinite(startsAt) || startsAt > now) return false;
  if (!assignment.effective_to) return true;
  const endsAt = new Date(String(assignment.effective_to)).valueOf();
  return Number.isFinite(endsAt) && endsAt > now;
}

async function listAllRows(tableId, queries = []) {
  const rows = [];
  let cursor;

  for (;;) {
    const page = await db.listRows({
      databaseId,
      tableId,
      queries: [
        ...queries,
        Query.orderAsc("$id"),
        Query.limit(PAGE_SIZE),
        ...(cursor ? [Query.cursorAfter(cursor)] : []),
      ],
      total: false,
    });

    rows.push(...page.rows);
    if (page.rows.length < PAGE_SIZE) return rows;

    const nextCursor = page.rows.at(-1)?.$id;
    if (!nextCursor || nextCursor === cursor) {
      throw new Error(`Could not safely paginate ${tableId}`);
    }
    cursor = nextCursor;
  }
}

const activeOrganizations = await listAllRows("organizations", [Query.equal("active", true)]);
if (activeOrganizations.length !== 1) {
  throw new Error(
    `Migration 012 is restricted to one active organization; found ${activeOrganizations.length}. No labels were changed.`,
  );
}

const activeManagerRoles = (await listAllRows("roles", [Query.equal("active", true)]))
  .filter((role) => MANAGER_ROLE_CODES.has(String(role.code)));
const managerRoleIds = new Set(activeManagerRoles.map((role) => role.$id));

const effectiveAssignments = (await listAllRows("employee_assignments"))
  .filter((assignment) => managerRoleIds.has(String(assignment.role_id)))
  .filter((assignment) => assignmentIsEffective(assignment, Date.now()));

const candidateEmployees = new Map();
for (const assignment of effectiveAssignments) {
  const employeeId = String(assignment.employee_id ?? "").trim();
  if (!employeeId) {
    throw new Error(`Effective manager assignment ${assignment.$id} has no employee ID. No labels were changed.`);
  }
  if (candidateEmployees.has(employeeId)) continue;

  let employee;
  try {
    employee = await db.getRow({ databaseId, tableId: "employees", rowId: employeeId });
  } catch (error) {
    if (error?.code === 404) {
      throw new Error(`Effective manager assignment ${assignment.$id} references missing employee ${employeeId}. No labels were changed.`);
    }
    throw error;
  }

  if (employee.status !== "active") continue;
  const userId = String(employee.user_id ?? "").trim();
  if (!userId) {
    throw new Error(`Active manager employee ${employeeId} has no user ID. No labels were changed.`);
  }
  candidateEmployees.set(employeeId, userId);
}

const managerUserIds = [...new Set(candidateEmployees.values())];
if (managerUserIds.length !== 1) {
  throw new Error(
    `Expected exactly one distinct active manager user; found ${managerUserIds.length}. No labels were changed.`,
  );
}

const managerUserId = managerUserIds[0];
const managerUser = await users.get({ userId: managerUserId });
if (managerUser.status !== true) {
  throw new Error(`Manager user ${managerUserId} is disabled. No labels were changed.`);
}
if (!Array.isArray(managerUser.labels) || managerUser.labels.some((label) => typeof label !== "string")) {
  throw new Error(`Manager user ${managerUserId} returned invalid labels. No labels were changed.`);
}

if (managerUser.labels.includes(ADMIN_LABEL)) {
  console.log(`migration 012 complete; manager user ${managerUserId} already has label ${ADMIN_LABEL}`);
} else {
  await users.updateLabels({
    userId: managerUserId,
    labels: [...managerUser.labels, ADMIN_LABEL],
  });
  console.log(`migration 012 complete; added label ${ADMIN_LABEL} to manager user ${managerUserId}`);
}
