import type { SupabaseClient } from "@supabase/supabase-js";
import { isDeepStrictEqual } from "node:util";
import { parseDataSource, sha256Source } from "@/lib/data/parser";
import { DATA_LIMITS, DataSourceError, type DataFormat, type DataSource, type DataSourceMetadata, type DataTableManifest, type ParseDataOptions } from "@/lib/data/types";

export const DATA_SOURCE_BUCKET = "analysis-sources";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface StoredDataSource {
  id: string;
  org_id: string;
  created_by: string | null;
  filename: string;
  sha256: string;
  format: DataFormat;
  byte_size: number;
  storage_path: string;
  status: "active" | "deleting";
  manifest: { tables: DataTableManifest[]; warnings: string[]; parserVersion: 1 };
  parse_options: ParseDataOptions;
  created_at: string;
  search_index_status?: "pending" | "indexed" | "failed";
  search_index_error?: string | null;
}

export function dataSourcePath(orgId: string, sourceId: string): string {
  if (!UUID.test(orgId) || !UUID.test(sourceId)) throw new DataSourceError("Invalid organization or source identifier.");
  return `${orgId}/${sourceId}/source`;
}

export function sourceManifest(source: DataSource): StoredDataSource["manifest"] {
  return {
    parserVersion: 1,
    tables: source.tables.map(table => ({ id: table.id, name: table.name, columns: table.columns, rowCount: table.rowCount, truncated: table.truncated, headerRow: table.headerRow, preambleRowCount: table.preamble.length })),
    warnings: source.warnings,
  };
}

export function sourceMetadata(row: StoredDataSource): DataSourceMetadata {
  return { id: row.id, createdBy: row.created_by, filename: row.filename, sha256: row.sha256, format: row.format, byteSize: row.byte_size, createdAt: row.created_at, tables: row.manifest.tables, warnings: row.manifest.warnings, searchIndexStatus: row.search_index_status ?? "pending", searchIndexError: row.search_index_error ?? null };
}

/** Catalog paging is explicit; analysis loading below never silently chooses a subset. */
export async function listDataSources(db: SupabaseClient, orgId: string, options: { limit?: number; offset?: number } = {}): Promise<DataSourceMetadata[]> {
  const limit = Math.min(100, Math.max(1, Math.trunc(options.limit ?? 100)));
  const offset = Math.max(0, Math.trunc(options.offset ?? 0));
  const { data, error } = await db.from("data_sources").select("*").eq("org_id", orgId).eq("status", "active").order("created_at", { ascending: false }).order("id", { ascending: true }).range(offset, offset + limit - 1);
  if (error) throw new DataSourceError("The source catalog is unavailable. Check the data-source migration and retry.", "storage_error");
  const records = (data ?? []) as StoredDataSource[];
  for (const record of records) assertStoredScope(record, orgId);
  return records.map(sourceMetadata);
}

/** Admin clients bypass RLS, so every query and result is independently scoped to the org. */
export async function loadDataSources(db: SupabaseClient, orgId: string, ids?: string[]): Promise<DataSource[]> {
  if (ids && (ids.some(id => !UUID.test(id)) || new Set(ids).size !== ids.length)) throw new DataSourceError("Select distinct, valid source IDs.");
  if (ids && ids.length === 0) return [];
  if (ids && ids.length > DATA_LIMITS.maxSourcesPerLoad) throw new DataSourceError("Select at most 10 sources for one analysis.", "limit_exceeded");
  let query = db.from("data_sources").select("*").eq("org_id", orgId).eq("status", "active");
  if (ids) query = query.in("id", ids);
  const { data, error } = await query.order("created_at", { ascending: false }).order("id", { ascending: true }).limit(DATA_LIMITS.maxSourcesPerLoad + 1);
  if (error) throw new DataSourceError("Could not load the selected source metadata. Retry shortly.", "storage_error");
  const records = (data ?? []) as StoredDataSource[];
  if (ids && (records.length !== ids.length || records.some(row => !ids.includes(row.id)))) throw new DataSourceError("One or more selected sources are unavailable in this organization. Refresh the source catalog and select again.", "not_found");
  if (records.length > DATA_LIMITS.maxSourcesPerLoad) throw new DataSourceError("This workspace has more than 10 sources. Select the sources for this analysis explicitly; none were silently omitted.", "limit_exceeded");
  for (const record of records) assertStoredScope(record, orgId);
  if (records.reduce((total, row) => total + row.byte_size, 0) > DATA_LIMITS.maxLoadedBytes) throw new DataSourceError("Selected sources exceed 40 MiB combined. Analyze a smaller set.", "limit_exceeded");

  const sources: DataSource[] = [];
  let totalRows = 0;
  let totalCells = 0;
  for (const record of records) {
    const { data: file, error: downloadError } = await db.storage.from(DATA_SOURCE_BUCKET).download(record.storage_path);
    if (downloadError || !file) throw new DataSourceError(`Source "${record.filename}" could not be read. Restore or re-upload it before continuing.`, "storage_error");
    if (file.size !== record.byte_size || file.size > DATA_LIMITS.maxUploadBytes) throw new DataSourceError(`Source "${record.filename}" failed its size integrity check. Re-upload the original file.`, "integrity_error");
    const buffer = new Uint8Array(await file.arrayBuffer());
    if (sha256Source(buffer) !== record.sha256) throw new DataSourceError(`Source "${record.filename}" failed its SHA-256 integrity check. The stored content does not match its original upload.`, "integrity_error");
    const parsed = await parseDataSource(buffer, record.filename, record.id, record.parse_options ?? {});
    if (parsed.format !== record.format || !isDeepStrictEqual(sourceManifest(parsed), record.manifest)) throw new DataSourceError(`The parsed structure of "${record.filename}" no longer matches its saved manifest. Re-upload to create a new immutable source version.`, "integrity_error");
    totalRows += parsed.tables.reduce((total, table) => total + table.rows.length + table.preamble.length + (table.header ? 1 : 0), 0);
    totalCells += parsed.tables.reduce((total, table) => total + (table.rows.length + table.preamble.length + (table.header ? 1 : 0)) * table.columns.length, 0);
    if (totalRows > DATA_LIMITS.maxRows || totalCells > DATA_LIMITS.maxCells) throw new DataSourceError("Selected sources exceed the combined 20,000-row or 500,000-cell analysis limit. Select a smaller source set; no rows were omitted.", "limit_exceeded");
    sources.push(parsed);
  }
  return sources;
}

/** Shared by DELETE so a tombstoned source can be retried without becoming readable again. */
export async function getStoredDataSource(db: SupabaseClient, orgId: string, id: string): Promise<StoredDataSource | null> {
  if (!UUID.test(id)) throw new DataSourceError("Invalid source ID.");
  const { data, error } = await db.from("data_sources").select("*").eq("org_id", orgId).eq("id", id).maybeSingle<StoredDataSource>();
  if (error) throw new DataSourceError("The source metadata is unavailable. Retry shortly.", "storage_error");
  if (data) assertStoredScope(data, orgId, false);
  return data;
}

function assertStoredScope(record: StoredDataSource, orgId: string, requireActive = true): void {
  if (record.org_id !== orgId || record.storage_path !== dataSourcePath(orgId, record.id)) throw new DataSourceError("Source organization or storage scope mismatch.", "integrity_error");
  if (!Number.isSafeInteger(record.byte_size) || record.byte_size < 1 || record.byte_size > DATA_LIMITS.maxUploadBytes || !/^[a-f0-9]{64}$/.test(record.sha256)) throw new DataSourceError("Stored source metadata failed validation.", "integrity_error");
  if (record.manifest?.parserVersion !== 1 || !Array.isArray(record.manifest.tables) || !Array.isArray(record.manifest.warnings)) throw new DataSourceError("The stored source manifest is unsupported. Re-upload the source.", "integrity_error");
  if (requireActive && record.status !== "active") throw new DataSourceError("The selected source is no longer available.", "not_found");
}
