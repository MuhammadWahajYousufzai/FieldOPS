import { Models, Query, TablesDB } from "node-appwrite";

export async function listAllRows(db: TablesDB, databaseId: string, tableId: string, queries: string[] = [], maximum = 10_000) {
  const rows: Models.DefaultRow[] = [];
  while (rows.length < maximum) {
    const page = await db.listRows({
      databaseId,
      tableId,
      queries: [...queries, Query.limit(Math.min(100, maximum - rows.length)), ...(rows.length ? [Query.cursorAfter(rows.at(-1)!.$id)] : [])],
    });
    rows.push(...page.rows);
    if (page.rows.length < 100) break;
  }
  return rows;
}

export async function listAllRowsOrEmpty(db: TablesDB, databaseId: string, tableId: string, queries: string[] = [], maximum = 10_000) {
  try {
    return await listAllRows(db, databaseId, tableId, queries, maximum);
  } catch (error) {
    console.error(`Could not list optional FieldOPS table ${tableId}`, error);
    return [];
  }
}

export function localDateRange(date: string) {
  const start = new Date(`${date}T00:00:00+05:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}
