import { createHash } from "node:crypto";
import { Query, type TablesDB } from "node-appwrite";

export const ROUTE_SEQUENCE_COUNTER_TABLE = "route_sequence_counters";

export function routeSequenceCounterId(employeeId: string, workDate: string) {
  const digest = createHash("sha256")
    .update([workDate.trim(), employeeId.trim()].join("\u001f"))
    .digest("hex");
  return `rseq_${digest.slice(0, 24)}`;
}

export function nextRouteSequence(counterSequence: unknown, latestRouteSequence: unknown) {
  const counter = finiteNonNegativeInteger(counterSequence);
  const latest = finiteNonNegativeInteger(latestRouteSequence);
  return Math.max(counter, latest) + 1;
}

export async function allocateRouteSequence(
  db: TablesDB,
  databaseId: string,
  employeeId: string,
  workDate: string,
  transactionId: string,
) {
  const counterId = routeSequenceCounterId(employeeId, workDate);
  const [counter, latestRoutes] = await Promise.all([
    getCounterOrNull(db, databaseId, counterId, transactionId),
    db.listRows({
      databaseId,
      tableId: "route_assignments",
      queries: [
        Query.equal("employee_id", employeeId),
        Query.equal("work_date", workDate),
        Query.orderDesc("sequence"),
        Query.limit(1),
      ],
      transactionId,
      total: false,
      ttl: 0,
    }),
  ]);
  const latestSequence = latestRoutes.rows[0]?.sequence;

  if (!counter) {
    const sequence = nextRouteSequence(0, latestSequence);
    await db.createRow({
      databaseId,
      tableId: ROUTE_SEQUENCE_COUNTER_TABLE,
      rowId: counterId,
      transactionId,
      data: { employee_id: employeeId, work_date: workDate, last_sequence: sequence },
      permissions: [],
    });
    return sequence;
  }

  const counterSequence = finiteNonNegativeInteger(counter.last_sequence);
  const routeSequence = finiteNonNegativeInteger(latestSequence);
  const incrementBy = Math.max(1, routeSequence - counterSequence + 1);
  const incremented = await db.incrementRowColumn({
    databaseId,
    tableId: ROUTE_SEQUENCE_COUNTER_TABLE,
    rowId: counterId,
    column: "last_sequence",
    value: incrementBy,
    transactionId,
  });
  return finitePositiveInteger(incremented.last_sequence);
}

async function getCounterOrNull(
  db: TablesDB,
  databaseId: string,
  counterId: string,
  transactionId: string,
) {
  try {
    return await db.getRow({
      databaseId,
      tableId: ROUTE_SEQUENCE_COUNTER_TABLE,
      rowId: counterId,
      transactionId,
    });
  } catch (error) {
    if (appwriteErrorCode(error) === 404) return null;
    throw error;
  }
}

function appwriteErrorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error
    ? Number(error.code)
    : 0;
}

function finiteNonNegativeInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function finitePositiveInteger(value: unknown) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("The route sequence counter returned an invalid value.");
  }
  return parsed;
}
