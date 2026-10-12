/**
 * Loading a run's source files (Plan 4 §4).
 *
 * Every harness step needs the parsed source files — for its verification context and for the
 * input hash it stamps on events — but the files are NOT carried in the Mastra snapshot.
 * That is deliberate: a reconciliation's parsed rows can be megabytes, and putting them in the
 * checkpoint would bloat every snapshot write for data that is already durably stored and
 * immutable once uploaded.
 *
 * So steps reload instead. A process-local cache keyed by workflow id makes that cheap after
 * the first step, and it is safe precisely because `workflow_files` rows are append-only in
 * practice — a run's files do not change once it starts. The cache evicts least-recently-used runs at 24 entries or
 * 64 MiB of estimated serialized source data. Oversized runs bypass the cache.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { parseFile } from "@/lib/csv/parser";
import type { ParsedFile, WorkflowFile } from "@/lib/types";

const STORAGE_BUCKET = "workflow-files";

/** workflowId → parsed files, keyed by file_type. */
const cache = new Map<string, { files: Record<string, ParsedFile>; bytes: number }>();
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_CACHE_RUNS = 24;
let cacheBytes = 0;

function cacheFiles(workflowId: string, files: Record<string, ParsedFile>): void {
  clearWorkflowFiles(workflowId);
  const bytes = Buffer.byteLength(JSON.stringify(files), "utf8");
  if (bytes > MAX_CACHE_BYTES) return;
  while (cache.size >= MAX_CACHE_RUNS || cacheBytes + bytes > MAX_CACHE_BYTES) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    clearWorkflowFiles(oldest);
  }
  cache.set(workflowId, { files, bytes });
  cacheBytes += bytes;
}

/**
 * Download and parse every file attached to a workflow, memoized per process.
 *
 * Throws on a missing or unreadable object rather than returning a partial set: a step that
 * silently ran against half its inputs would produce a confident, wrong reconciliation, which
 * is worse than a failed run.
 */
export async function loadWorkflowFiles(
  db: SupabaseClient,
  workflowId: string,
): Promise<Record<string, ParsedFile>> {
  const cached = cache.get(workflowId);
  if (cached) {
    cache.delete(workflowId);
    cache.set(workflowId, cached);
    return cached.files;
  }

  const { data, error } = await db
    .from("workflow_files")
    .select("*")
    .eq("workflow_id", workflowId);
  if (error) throw new Error(`Failed to load workflow files: ${error.message}`);

  const files: Record<string, ParsedFile> = {};
  for (const row of (data ?? []) as WorkflowFile[]) {
    const { data: blob, error: dlError } = await db.storage
      .from(STORAGE_BUCKET)
      .download(row.storage_path);
    if (dlError || !blob) {
      throw new Error(
        `Failed to download "${row.storage_path}": ${dlError?.message ?? "no data"}`,
      );
    }
    const buffer = Buffer.from(await blob.arrayBuffer());
    const parsed = parseFile(buffer, row.file_type, { filename: row.filename });
    if (parsed.meta.sha256 !== row.sha256) throw new Error(`Source integrity check failed for ${row.filename}`);
    if (!parsed.rows.length || parsed.errors.length) throw new Error(`${row.filename}: ${parsed.errors.length} invalid rows. Correct the source file before running analysis.`);
    files[row.file_type] = parsed;
  }

  cacheFiles(workflowId, files);
  return files;
}

/** Seed the cache directly — used by tests and by the H3 proof script, which parse from disk. */
export function primeWorkflowFiles(
  workflowId: string,
  files: Record<string, ParsedFile>,
): void {
  cacheFiles(workflowId, files);
}

/** Drop a run's cached files. Called when a run finishes, and by tests between cases. */
export function clearWorkflowFiles(workflowId?: string): void {
  if (workflowId) {
    cacheBytes -= cache.get(workflowId)?.bytes ?? 0;
    cache.delete(workflowId);
  } else {
    cache.clear();
    cacheBytes = 0;
  }
}
