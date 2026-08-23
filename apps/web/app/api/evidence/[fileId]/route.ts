import { NextResponse } from "next/server";
import { createAdminStorage } from "@fieldops/appwrite/server";
import { requireManager } from "../../../../lib/auth";

const bucketId = process.env.APPWRITE_EVIDENCE_BUCKET_ID?.trim() || "visit-evidence";

export async function GET(_request: Request, context: { params: Promise<{ fileId: string }> }) {
  if (!await requireManager()) return NextResponse.json({ error: "Manager access is required." }, { status: 403 });
  const { fileId } = await context.params;
  try {
    const storage = createAdminStorage();
    const [file, bytes] = await Promise.all([
      storage.getFile({ bucketId, fileId }),
      storage.getFileDownload({ bucketId, fileId }),
    ]);
    return new NextResponse(bytes, { headers: {
      "content-type": file.mimeType || "application/octet-stream",
      "content-disposition": `inline; filename="${file.name.replaceAll('"', '')}"`,
      "cache-control": "private, max-age=300",
    } });
  } catch {
    return NextResponse.json({ error: "Evidence file not found." }, { status: 404 });
  }
}
