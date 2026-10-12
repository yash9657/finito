import { NextResponse, type NextRequest } from "next/server";
import { requireOrgAccess } from "@/lib/api/guard";
import { dataSourceErrorResponse, pagingInteger } from "@/lib/data/http";
import { DATA_SOURCE_BUCKET, getStoredDataSource, loadDataSources, sourceMetadata } from "@/lib/data/store";
import { DataSourceError, type DataRow } from "@/lib/data/types";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const access = await requireOrgAccess();
  if (!access.ok) return access.response;
  try {
    const { id } = await params;
    const stored = await getStoredDataSource(access.admin, access.profile.org_id, id);
    if (!stored || stored.status !== "active") throw new DataSourceError("Source not found in this organization.", "not_found");
    const source = sourceMetadata(stored);
    if (!["preview", "tableId", "offset", "limit", "originalRow"].some(key => req.nextUrl.searchParams.has(key))) return NextResponse.json({ source });
    let offset = pagingInteger(req.nextUrl.searchParams.get("offset"), 0, 0, 20_000);
    const limit = pagingInteger(req.nextUrl.searchParams.get("limit"), 25, 1, 100);
    const [loaded] = await loadDataSources(access.admin, access.profile.org_id, [id]);
    const tableId = req.nextUrl.searchParams.get("tableId") ?? loaded.tables[0]?.id;
    const table = loaded.tables.find(table => table.id === tableId);
    if (!table) throw new DataSourceError("Table not found. Select a table ID from the source manifest.", "not_found");
    let preambleOffset = 0;
    if (req.nextUrl.searchParams.has("originalRow")) {
      const originalRow = pagingInteger(req.nextUrl.searchParams.get("originalRow"), 1, 1, 2_147_483_647);
      const rowIndex = table.rows.findIndex(row => row.originalRow === originalRow);
      const preambleIndex = table.preamble.findIndex(row => row.originalRow === originalRow);
      if (rowIndex >= 0) offset = rowIndex;
      else if (preambleIndex >= 0) { preambleOffset = preambleIndex; offset = 0; }
      else if (table.header?.originalRow === originalRow) offset = 0;
      else throw new DataSourceError("The cited original row is not present in this table. Check the immutable source and table reference.", "not_found");
    }
    let previewTruncated = false;
    let remainingChars = 128 * 1024;
    const previewRows = (rows: DataRow[]): DataRow[] => rows.map(row => ({ ...row, values: Object.fromEntries(Object.entries(row.values).map(([key, value]) => {
      if (typeof value !== "string") return [key, value];
      const length = Math.min(2000, Math.max(0, remainingChars));
      remainingChars -= Math.min(value.length, length);
      if (value.length <= length) return [key, value];
      previewTruncated = true;
      return [key, `${value.slice(0, length)}… [preview trimmed]`];
    })) }));
    const rows = previewRows(table.rows.slice(offset, offset + limit));
    const preamble = previewRows(table.preamble.slice(preambleOffset, preambleOffset + 25));
    const header = table.header ? previewRows([table.header])[0] : null;
    return NextResponse.json({ source, table: { id: table.id, name: table.name, columns: table.columns, headerRow: table.headerRow, header, rows, preamble, preambleOffset, preambleRowCount: table.preamble.length, preambleTruncated: preambleOffset > 0 || preambleOffset + preamble.length < table.preamble.length, offset, limit, rowCount: table.rowCount, hasMore: offset + rows.length < table.rowCount, previewTruncated } });
  } catch (error) { return dataSourceErrorResponse(error); }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const access = await requireOrgAccess();
  if (!access.ok) return access.response;
  const { admin, profile } = access;
  if (profile.role !== "admin" && profile.role !== "analyst") return NextResponse.json({ error: "Only administrators and source owners may delete sources." }, { status: 403 });
  try {
    const { id } = await params;
    const source = await getStoredDataSource(admin, profile.org_id, id);
    if (!source) throw new DataSourceError("Source not found in this organization.", "not_found");
    if (profile.role !== "admin" && source.created_by !== profile.id) return NextResponse.json({ error: "Only an administrator or the person who uploaded this source may delete it." }, { status: 403 });
    const { data: marked, error: markError } = await admin.from("data_sources").update({ status: "deleting" }).eq("org_id", profile.org_id).eq("id", id).select("id").maybeSingle();
    if (markError || !marked) throw new DataSourceError("The source could not be marked for deletion. Retry shortly.", "storage_error");
    const { error: storageError } = await admin.storage.from(DATA_SOURCE_BUCKET).remove([source.storage_path]);
    if (storageError) throw new DataSourceError("Source deletion is pending because storage removal failed. Retry this deletion; the source is already unavailable for new analyses.", "storage_error");
    const { data: removed, error: deleteError } = await admin.from("data_sources").delete().eq("org_id", profile.org_id).eq("id", id).eq("status", "deleting").select("id").maybeSingle();
    if (deleteError || !removed) throw new DataSourceError("The stored file was removed, but metadata cleanup is pending. Retry deletion.", "storage_error");
    return NextResponse.json({ deleted: true, id });
  } catch (error) { return dataSourceErrorResponse(error); }
}
