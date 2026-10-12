import type { SupabaseClient } from "@supabase/supabase-js";
import type { DataSource } from "@/lib/data/types";
import { MEMORY_LIMITS, MemoryError } from "./types";

export interface SourceMemoryChunk { chunk_no: number; table_id: string; original_row: number | null; row_kind: "metadata" | "header" | "preamble" | "data"; content: string }

/** Every chunk belongs to one original row; long rows keep the same immutable citation. */
export function buildSourceMemoryChunks(source: DataSource): SourceMemoryChunk[] {
  const chunks: SourceMemoryChunk[] = [];
  let chars = 0;
  const append = (text: string, tableId: string, originalRow: number | null, kind: SourceMemoryChunk["row_kind"]) => {
    // Preserve complete values. Cutting into chunks never cuts source text from the index.
    for (let offset = 0; offset < text.length;) {
      let end = Math.min(text.length, offset + MEMORY_LIMITS.chunkChars);
      // Do not split UTF-16 surrogate pairs before JSON serialization to PostgreSQL.
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
      const content = text.slice(offset, end);
      chars += content.length;
      if (chars > MEMORY_LIMITS.indexChars || chunks.length >= MEMORY_LIMITS.indexChunks) throw new MemoryError("Full-content indexing exceeds 32 MiB of text or 60,000 chunks. Split the source; its metadata remains searchable.");
      chunks.push({ chunk_no: chunks.length, table_id: tableId, original_row: originalRow, row_kind: kind, content });
      offset = end;
    }
  };
  for (const table of source.tables) {
    append(`${source.filename}\n${table.name}\nColumns: ${JSON.stringify(table.columns)}`, table.id, null, "metadata");
    if (table.header) append(JSON.stringify(table.columns.map(column => table.header!.values[column] ?? null)), table.id, table.header.originalRow, "header");
    for (const row of table.preamble) append(JSON.stringify(table.columns.map(column => row.values[column] ?? null)), table.id, row.originalRow, "preamble");
    for (const row of table.rows) append(JSON.stringify(table.columns.map(column => row.values[column] ?? null)), table.id, row.originalRow, "data");
  }
  return chunks;
}

/** Replaces a source's complete index atomically; failed attempts are visibly marked for retry. */
export async function indexDataSource(db: SupabaseClient, orgId: string, source: DataSource): Promise<{ status: "indexed" | "failed"; chunks?: number; error?: string }> {
  try {
    const chunks = buildSourceMemoryChunks(source);
    const { data, error } = await db.rpc("replace_source_memory_chunks", { p_org: orgId, p_source: source.id, p_chunks: chunks });
    if (error || data !== chunks.length) throw new MemoryError("Full-content search indexing failed. The source remains available for analysis; retry indexing in Memory settings.", "unavailable");
    return { status: "indexed", chunks: chunks.length };
  } catch (error) {
    const message = error instanceof MemoryError ? error.message : "Full-content indexing failed. Retry from Memory settings.";
    // A missing migration can also reject this update; preserve the explicit failure response.
    try {
      const { error: markError } = await db.from("data_sources").update({ search_index_status: "failed", search_index_error: message }).eq("org_id", orgId).eq("id", source.id).eq("status", "active");
      return { status: "failed", error: markError ? `${message} The indexing status could not be saved.` : message };
    } catch { return { status: "failed", error: `${message} The indexing status could not be saved.` }; }
  }
}
