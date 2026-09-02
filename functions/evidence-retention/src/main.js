import { Client, ID, Query, Storage, TablesDB } from "node-appwrite";

const RETENTION_DAYS = 7;
const PAGE_SIZE = 100;
const MAX_DELETIONS_PER_RUN = 1_000;

function requiredAny(env, names) {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  throw new Error(`Missing function configuration: ${names.join(" or ")}`);
}

function isNotFound(error) {
  return Number(error?.code) === 404;
}

export default async ({ res, log, error }) => {
  const endpoint = requiredAny(process.env, ["APPWRITE_FUNCTION_API_ENDPOINT", "APPWRITE_ENDPOINT"]);
  const projectId = requiredAny(process.env, ["APPWRITE_FUNCTION_PROJECT_ID", "APPWRITE_PROJECT_ID"]);
  const apiKey = requiredAny(process.env, ["APPWRITE_FUNCTION_API_KEY", "APPWRITE_API_KEY"]);
  const databaseId = process.env.APPWRITE_DATABASE_ID?.trim() || "fieldops";
  const bucketId = process.env.APPWRITE_EVIDENCE_BUCKET_ID?.trim() || "visit-evidence";
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1_000).toISOString();
  const client = new Client().setEndpoint(endpoint).setProject(projectId).setKey(apiKey);
  const db = new TablesDB(client);
  const storage = new Storage(client);
  let deleted = 0;
  let failed = 0;

  while (deleted + failed < MAX_DELETIONS_PER_RUN) {
    const page = await db.listRows({
      databaseId,
      tableId: "visit_evidence",
      queries: [Query.lessThanEqual("captured_at", cutoff), Query.orderAsc("captured_at"), Query.limit(PAGE_SIZE)],
      total: false,
    });
    if (page.rows.length === 0) break;

    for (const evidence of page.rows) {
      if (deleted + failed >= MAX_DELETIONS_PER_RUN) break;
      const evidenceId = evidence.$id;
      const fileId = String(evidence.file_id ?? "");
      try {
        try {
          await storage.deleteFile({ bucketId, fileId });
        } catch (storageError) {
          if (!isNotFound(storageError)) throw storageError;
        }

        const transaction = await db.createTransaction({ ttl: 60 });
        try {
          await db.deleteRow({ databaseId, tableId: "visit_evidence", rowId: evidenceId, transactionId: transaction.$id });
          await db.createRow({
            databaseId,
            tableId: "audit_logs",
            rowId: ID.unique(),
            transactionId: transaction.$id,
            data: {
              actor_user_id: "system.retention",
              action: "evidence.retention_expired",
              entity_type: "visit_evidence",
              entity_id: evidenceId,
              occurred_at: new Date().toISOString(),
              before_json: JSON.stringify({ visitId: evidence.visit_id, type: evidence.type, fileId, capturedAt: evidence.captured_at }),
              after_json: JSON.stringify({ deleted: true, retentionDays: RETENTION_DAYS }),
              reason: "Automatic seven-day visit-media retention policy",
              correlation_id: ID.unique(),
            },
            permissions: [],
          });
          await db.updateTransaction({ transactionId: transaction.$id, commit: true });
          deleted += 1;
        } catch (transactionError) {
          await db.updateTransaction({ transactionId: transaction.$id, rollback: true }).catch(() => undefined);
          throw transactionError;
        }
      } catch (recordError) {
        failed += 1;
        error(`Evidence ${evidenceId} could not be purged: ${recordError instanceof Error ? recordError.message : String(recordError)}`);
      }
    }

    if (page.rows.length < PAGE_SIZE || failed >= PAGE_SIZE) break;
  }

  log(`Evidence retention finished: ${deleted} deleted, ${failed} failed, cutoff ${cutoff}.`);
  return res.json({ ok: failed === 0, retentionDays: RETENTION_DAYS, cutoff, deleted, failed });
};
