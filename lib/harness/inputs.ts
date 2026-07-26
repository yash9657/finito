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
 * practice — a run's files do not change once it starts. The cache is a plain Map with no
 * eviction, which is correct for a serverless process whose lifetime is one or a few runs; if
 * a long-lived worker ever hosts thousands of runs, this is where a bounded LRU goes.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { parseFile } from "@/lib/csv/parser";
import type { ParsedFile, WorkflowFile } from "@/lib/types";

const STORAGE_BUCKET = "workflow-files";

/** workflowId → parsed files, keyed by file_type. */
const cache = new Map<string, Record<string, ParsedFile>>();

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
  if (cached) return cached;

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
    files[row.file_type] = parseFile(buffer, row.file_type, { filename: row.filename });
  }

  cache.set(workflowId, files);
  return files;
}

/** Seed the cache directly — used by tests and by the H3 proof script, which parse from disk. */
export function primeWorkflowFiles(
  workflowId: string,
  files: Record<string, ParsedFile>,
): void {
  cache.set(workflowId, files);
}

/** Drop a run's cached files. Called when a run finishes, and by tests between cases. */
export function clearWorkflowFiles(workflowId?: string): void {
  if (workflowId) cache.delete(workflowId);
  else cache.clear();
}
