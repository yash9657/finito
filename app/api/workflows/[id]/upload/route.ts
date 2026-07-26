import { NextResponse, type NextRequest } from "next/server";
import { requireWorkflowAccess, jsonError } from "@/lib/api/guard";
import { writeAudit, sha256Bytes } from "@/lib/audit";
import {
  FILE_TYPES,
  isPipelineType,
  type FileType,
  type WorkflowType,
  type WorkflowFile,
} from "@/lib/types";

/**
 * POST /api/workflows/[id]/upload — multipart CSV/Excel upload (§10, §4).
 *
 * Validates: workflow is `idle`; `fileType` legal for the workflow type; extension
 * `.csv/.xlsx/.xls`; size ≤ 10 MB. Computes sha256 over the buffer (node:crypto),
 * uploads to the private `workflow-files` bucket (upsert) at the D5 path convention
 * `{org_id}/{workflow_id}/{file_type}/{filename}`, then replaces any prior row of the
 * same `file_type` (delete-then-insert) in `workflow_files`. Audits `file_uploaded`.
 * → 200 `{ fileId, sha256 }`.
 */

const BUCKET = "workflow-files";
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED_EXTENSIONS = [".csv", ".xlsx", ".xls"] as const;

/** Which file_types are legal for each workflow type (§4/§7/§8/§9). */
const LEGAL_FILE_TYPES: Record<WorkflowType, FileType[]> = {
  reconciliation: ["erp_export", "bank_statement"],
  ap_matching: ["po", "invoice"],
  fpa_commentary: ["budget", "actuals"],
};

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot).toLowerCase();
}

function contentTypeFor(ext: string): string {
  switch (ext) {
    case ".csv":
      return "text/csv";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".xls":
      return "application/vnd.ms-excel";
    default:
      return "application/octet-stream";
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  // 1. Auth + org-scope gate.
  const g = await requireWorkflowAccess(id);
  if (!g.ok) return g.response;
  const { admin, profile, workflow } = g;

  // 2. Workflow must be idle to accept uploads.
  if (workflow.status !== "idle") {
    return jsonError("Workflow is not accepting uploads", 409);
  }

  // 3. Parse multipart form.
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return jsonError("Invalid multipart form data", 400);
  }

  const file = form.get("file");
  const fileTypeRaw = form.get("fileType");

  if (!(file instanceof File)) {
    return jsonError("Missing file", 400);
  }
  if (typeof fileTypeRaw !== "string") {
    return jsonError("Missing fileType", 400);
  }

  // 4. Validate fileType is a known value and legal for this workflow type.
  if (!(FILE_TYPES as readonly string[]).includes(fileTypeRaw)) {
    return jsonError("Unknown fileType", 400);
  }
  const fileType = fileTypeRaw as FileType;
  // An investigation reads the org's existing datasets rather than taking uploads of its own
  // (Plan 5, D-G3/D-G19), so there is no legal file type for one.
  if (!isPipelineType(workflow.type)) {
    return jsonError("An investigation does not take file uploads.", 400);
  }
  if (!LEGAL_FILE_TYPES[workflow.type].includes(fileType)) {
    return jsonError(`fileType '${fileType}' is not valid for ${workflow.type}`, 400);
  }

  // 5. Validate extension.
  const filename = file.name;
  const ext = extensionOf(filename);
  if (!(ALLOWED_EXTENSIONS as readonly string[]).includes(ext)) {
    return jsonError("Unsupported file extension (allowed: .csv, .xlsx, .xls)", 400);
  }

  // 6. Read bytes, validate size, hash.
  const buffer = Buffer.from(await file.arrayBuffer());
  if (buffer.byteLength === 0) {
    return jsonError("Empty file", 400);
  }
  if (buffer.byteLength > MAX_BYTES) {
    return jsonError("File exceeds 10 MB limit", 400);
  }
  const sha256 = sha256Bytes(buffer);

  // 7. Upload to Storage (upsert) at the D5 path convention.
  const storagePath = `${workflow.org_id}/${workflow.id}/${fileType}/${filename}`;
  const { error: uploadError } = await admin.storage
    .from(BUCKET)
    .upload(storagePath, buffer, {
      upsert: true,
      contentType: contentTypeFor(ext),
    });
  if (uploadError) {
    return jsonError(`Storage upload failed: ${uploadError.message}`, 500);
  }

  // 8. Replace any prior row of the same file_type (delete-then-insert).
  const { error: deleteError } = await admin
    .from("workflow_files")
    .delete()
    .eq("workflow_id", workflow.id)
    .eq("file_type", fileType);
  if (deleteError) {
    return jsonError(`Failed to replace prior file: ${deleteError.message}`, 500);
  }

  const { data: inserted, error: insertError } = await admin
    .from("workflow_files")
    .insert({
      workflow_id: workflow.id,
      file_type: fileType,
      storage_path: storagePath,
      filename,
      size_bytes: buffer.byteLength,
      sha256,
    })
    .select("*")
    .single<WorkflowFile>();
  if (insertError || !inserted) {
    return jsonError("Failed to record uploaded file", 500);
  }

  // 9. Audit.
  await writeAudit(admin, {
    workflowId: workflow.id,
    actorType: "human",
    actorId: profile.id,
    action: "file_uploaded",
    detail: { filename, size: buffer.byteLength, sha256 },
  });

  return NextResponse.json({ fileId: inserted.id, sha256 }, { status: 200 });
}
