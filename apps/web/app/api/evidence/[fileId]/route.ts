import { NextResponse } from "next/server";
import { createAdminStorage, createAdminTablesDb } from "@fieldops/appwrite/server";
import { requireDashboardAdmin } from "../../../../lib/auth";
import { parseEvidenceByteRange } from "../../../../lib/evidence-range";
import { evidenceRetentionState } from "../../../../lib/evidence-retention";

const databaseId = process.env.APPWRITE_DATABASE_ID ?? "fieldops";
const bucketId = process.env.APPWRITE_EVIDENCE_BUCKET_ID?.trim() || "visit-evidence";

export async function GET(request: Request, context: { params: Promise<{ fileId: string }> }) {
  if (!await requireDashboardAdmin()) return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  const { fileId } = await context.params;
  try {
    const evidence = await createAdminTablesDb().getRow({ databaseId, tableId: "visit_evidence", rowId: fileId });
    const retention = evidenceRetentionState(String(evidence.captured_at || evidence.$createdAt));
    if (!retention || retention.expired) {
      return NextResponse.json({ error: "This evidence has reached the end of its seven-day retention window." }, {
        status: 410,
        headers: { "cache-control": "private, no-store" },
      });
    }
    const storage = createAdminStorage();
    const [file, bytes] = await Promise.all([
      storage.getFile({ bucketId, fileId }),
      storage.getFileDownload({ bucketId, fileId }),
    ]);
    const data = Buffer.from(bytes);
    const headers: Record<string, string> = {
      "content-type": file.mimeType || "application/octet-stream",
      "content-disposition": `inline; filename="${file.name.replaceAll('"', '')}"`,
      "cache-control": "private, max-age=300",
      "accept-ranges": "bytes",
    };
    const range = parseEvidenceByteRange(request.headers.get("range"), data.length);
    if (range === "invalid") {
      return new NextResponse(null, { status: 416, headers: { ...headers, "content-range": `bytes */${data.length}` } });
    }
    if (range) {
      const body = data.subarray(range.start, range.end + 1);
      return new NextResponse(body, { status: 206, headers: {
        ...headers,
        "content-length": String(body.length),
        "content-range": `bytes ${range.start}-${range.end}/${data.length}`,
      } });
    }
    return new NextResponse(data, { headers: { ...headers, "content-length": String(data.length) } });
  } catch {
    return NextResponse.json({ error: "Evidence file not found." }, { status: 404 });
  }
}
