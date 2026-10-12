import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { requireOrgAccess } from "@/lib/api/guard";
import { boundedSourceFormData, dataSourceErrorResponse, pagingInteger } from "@/lib/data/http";
import { parseDataSource } from "@/lib/data/parser";
import { DATA_SOURCE_BUCKET, dataSourcePath, listDataSources, sourceManifest, sourceMetadata, type StoredDataSource } from "@/lib/data/store";
import { DATA_LIMITS, DataSourceError, type ParseDataOptions } from "@/lib/data/types";
import { indexDataSource } from "@/lib/memory/index";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const access = await requireOrgAccess();
  if (!access.ok) return access.response;
  try {
    const limit = pagingInteger(req.nextUrl.searchParams.get("limit"), 100, 1, 100);
    const offset = pagingInteger(req.nextUrl.searchParams.get("offset"), 0, 0, 1_000_000);
    const sources = await listDataSources(access.admin, access.profile.org_id, { limit, offset });
    return NextResponse.json({ sources, limit, offset, hasMore: sources.length === limit, viewer: { id: access.profile.id, canUpload: access.profile.role === "admin" || access.profile.role === "analyst", isAdmin: access.profile.role === "admin" } });
  } catch (error) { return dataSourceErrorResponse(error); }
}

export async function POST(req: NextRequest) {
  const access = await requireOrgAccess();
  if (!access.ok) return access.response;
  const { admin, profile } = access;
  if (profile.role !== "admin" && profile.role !== "analyst") return NextResponse.json({ error: "Only administrators and analysts may upload sources." }, { status: 403 });
  try {
    const form = await boundedSourceFormData(req);
    const file = form.get("file");
    if (!(file instanceof File) || form.getAll("file").length !== 1) throw new DataSourceError("Select exactly one file for this upload.");
    if (file.size > DATA_LIMITS.maxUploadBytes) throw new DataSourceError("The source exceeds 20 MiB. Split it into smaller files.", "limit_exceeded");
    const options: ParseDataOptions = {};
    const headerRows = form.get("headerRows");
    if (headerRows !== null) {
      if (typeof headerRows !== "string" || headerRows.length > 4096) throw new DataSourceError("Header overrides must be a JSON object no larger than 4 KiB.");
      try { options.headerRows = JSON.parse(headerRows); }
      catch { throw new DataSourceError("Header overrides must be valid JSON, such as {\"t0\": 5, \"t1\": null}."); }
    }
    const id = randomUUID();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const source = await parseDataSource(bytes, file.name, id, options);
    const storagePath = dataSourcePath(profile.org_id, id);
    const { error: uploadError } = await admin.storage.from(DATA_SOURCE_BUCKET).upload(storagePath, bytes, { upsert: false, contentType: "application/octet-stream" });
    if (uploadError) throw new DataSourceError("The source could not be stored. Confirm the private analysis-sources bucket is configured and retry.", "storage_error");
    const { data, error } = await admin.from("data_sources").insert({ id, org_id: profile.org_id, created_by: profile.id, filename: source.filename, sha256: source.sha256, format: source.format, byte_size: bytes.byteLength, storage_path: storagePath, manifest: sourceManifest(source), parse_options: options, status: "active" }).select("*").single<StoredDataSource>();
    if (error || !data) {
      const { error: cleanupError } = await admin.storage.from(DATA_SOURCE_BUCKET).remove([storagePath]);
      throw new DataSourceError(cleanupError ? "The upload was not registered and temporary storage cleanup failed. Ask an administrator to inspect storage before retrying." : "The source metadata could not be saved; the uploaded object was removed. Check the data-source migration and retry.", "storage_error");
    }
    const indexing = await indexDataSource(admin, profile.org_id, source);
    return NextResponse.json({ source: { ...sourceMetadata(data), searchIndexStatus: indexing.status, searchIndexError: indexing.error ?? null }, indexing }, { status: 201 });
  } catch (error) { return dataSourceErrorResponse(error); }
}
