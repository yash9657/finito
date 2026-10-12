/**
 * The org's financial data, as the investigator sees it (Plan 5 §5).
 *
 * FinFlow has no "ledger" table. What an org actually has is the set of files it has uploaded
 * across its workflow runs — ERP exports, bank statements, invoices, POs, budgets, actuals — each
 * parsed into typed rows by `lib/csv/parser.ts`. This module is the projection that turns those
 * six differently-shaped row types into ONE queryable shape, so a single `query_ledger` tool can
 * answer a question that spans them.
 *
 * ## Source ids are the load-bearing part
 *
 * Every row carries `sourceId` — `wf:<full workflow UUID>/<dataset>/<rowId>` — and every tool result quotes
 * it. That is what makes D-G1's third clause checkable rather than aspirational: the final answer
 * cites source ids, and post-validation resolves each one back to a real row before the answer is
 * allowed to exist. An id that does not resolve is a fabricated citation, and the answer is
 * rejected and retried.
 *
 * Full workflow UUIDs prevent citation collisions as organizations accumulate runs.
 * Historical short IDs remain readable during compaction for older event records.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { parseFile } from "@/lib/csv/parser";
import type {
  ActualsLine,
  BankTxn,
  BudgetLine,
  ErpTxn,
  FileType,
  Invoice,
  ParsedFile,
  PurchaseOrder,
  WorkflowFile,
} from "@/lib/types";

const STORAGE_BUCKET = "workflow-files";

/**
 * One row of org data, whatever file it came from.
 *
 * Deliberately wider than any single source type: a union would force every tool to switch on
 * the dataset, which is the "one tool per question" shape SWE-agent's findings warn against. The
 * fields a given dataset does not have are null, and `list_datasets` tells the agent which are
 * populated where — so the model learns the shape from a tool result rather than from a prompt.
 */
export interface LedgerRow {
  /** `wf:<8>/<dataset>/<rowId>` — stable, citable, resolvable. */
  sourceId: string;
  workflowId: string;
  workflowName: string;
  dataset: FileType;
  /** ISO `YYYY-MM-DD`. Null for budget/actuals, which are periodic rather than dated. */
  date: string | null;
  /** `YYYY-MM`, derived from `date` or taken from the row's own period column. */
  period: string | null;
  description: string;
  /** Vendor name for AP rows; null where the source has no counterparty concept. */
  counterparty: string | null;
  department: string | null;
  category: string | null;
  amountCents: number;
  /** reference_number / transaction_id / invoice_number / po_number. */
  reference: string | null;
}

export interface DatasetSummary {
  dataset: FileType;
  workflowId: string;
  workflowName: string;
  filename: string;
  rowCount: number;
  /** Rows the parser rejected — surfaced so the agent can distrust a partial dataset. */
  skippedCount: number;
  dateFrom: string | null;
  dateTo: string | null;
  totalCents: number;
  /** Which LedgerRow fields are actually populated for this dataset. */
  populatedFields: string[];
}

export interface OrgDatasets {
  rows: LedgerRow[];
  summaries: DatasetSummary[];
  /** Workflows whose files could not be read, so an empty result is never mistaken for no data. */
  unreadable: { workflowId: string; filename: string; reason: string }[];
  /** Downloaded bytes, including files rejected after parsing, for cumulative activation limits. */
  loadedBytes?: number;
}
export const DATASET_LOAD_LIMITS = { rows: 200_000, bytes: 64 * 1024 * 1024, fileBytes: 10 * 1024 * 1024, historicalWorkflows: 5 } as const;

/* -------------------------------------------------------------------------- */
/* Loading                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Load and normalize every file the org has uploaded, across all of its workflows.
 *
 * Bounded by `maxWorkflows` (newest first), because an org with a year of daily runs would
 * otherwise pull hundreds of files into memory to answer one question. The bound is reported in
 * `list_datasets` rather than applied silently — an agent that cannot see March's data must be
 * told that, or it will conclude March had no transactions.
 *
 * A file that fails to download is recorded in `unreadable` rather than thrown: one corrupt
 * upload should not make the entire investigation impossible, but it must not silently shrink
 * the dataset either.
 */
export async function loadOrgDatasets(
  db: SupabaseClient,
  orgId: string,
  opts: { maxWorkflows?: number; workflowIds?: string[]; maxRows?: number; maxBytes?: number } = {},
): Promise<OrgDatasets> {
  const maxWorkflows = Math.max(1, Math.min(25, Math.trunc(opts.maxWorkflows ?? 25)));
  const maxRows = Math.max(0, Math.min(DATASET_LOAD_LIMITS.rows, Math.trunc(opts.maxRows ?? DATASET_LOAD_LIMITS.rows)));
  const maxBytes = Math.max(0, Math.min(DATASET_LOAD_LIMITS.bytes, Math.trunc(opts.maxBytes ?? DATASET_LOAD_LIMITS.bytes)));
  if (![maxWorkflows, maxRows, maxBytes].every(Number.isFinite)) throw new Error("Invalid dataset limits");
  if (opts.workflowIds && (opts.workflowIds.length > DATASET_LOAD_LIMITS.historicalWorkflows || new Set(opts.workflowIds).size !== opts.workflowIds.length || opts.workflowIds.some(id => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)))) throw new Error("Select at most five distinct valid workflow IDs");
  if (opts.workflowIds?.length === 0) return { rows: [], summaries: [], unreadable: [], loadedBytes: 0 };

  let query = db
    .from("workflows")
    .select("id, org_id, name, type, created_at")
    .eq("org_id", orgId)
    .neq("type", "investigation");
  if (opts.workflowIds) query = query.in("id", opts.workflowIds);
  const { data: workflows, error: wfError } = await query
    .order("created_at", { ascending: false })
    .limit(opts.workflowIds?.length ?? maxWorkflows);
  if (wfError) throw new Error(`Failed to list workflows: ${wfError.message}`);
  if ((workflows ?? []).some(workflow => workflow.org_id !== orgId)) throw new Error("Workflow organization scope mismatch");
  if (opts.workflowIds && ((workflows ?? []).length !== opts.workflowIds.length || (workflows ?? []).some(workflow => !opts.workflowIds!.includes(workflow.id)))) throw new Error("A selected historical workflow is unavailable in this organization");

  const byId = new Map((workflows ?? []).map((w) => [w.id as string, w as { id: string; name: string }]));
  if (byId.size === 0) return { rows: [], summaries: [], unreadable: [], loadedBytes: 0 };

  const { data: files, error: fileError } = await db
    .from("workflow_files")
    .select("*")
    .in("workflow_id", [...byId.keys()]);
  if (fileError) throw new Error(`Failed to list workflow files: ${fileError.message}`);

  const rows: LedgerRow[] = [];
  const summaries: DatasetSummary[] = [];
  const unreadable: OrgDatasets["unreadable"] = [];
  let loadedBytes = 0;

  for (const row of (files ?? []) as WorkflowFile[]) {
    const workflow = byId.get(row.workflow_id);
    if (!workflow) continue;

    let parsed: ParsedFile;
    try {
      if (!row.storage_path.startsWith(`${orgId}/${row.workflow_id}/${row.file_type}/`) || row.storage_path.split("/").some(part => {
        const decoded = decodeURIComponent(part);
        return decoded === ".." || decoded === "." || decoded.includes("/") || decoded.includes("\\");
      })) throw new Error("Source storage scope mismatch");
      if (!Number.isSafeInteger(row.size_bytes) || row.size_bytes < 1 || row.size_bytes > DATASET_LOAD_LIMITS.fileBytes) throw new Error("Source size is invalid or exceeds the supported file limit");
      if (loadedBytes + row.size_bytes > maxBytes) throw new Error("Investigation source byte limit reached; narrow the selected workflows");
      const { data: blob, error: dlError } = await db.storage
        .from(STORAGE_BUCKET)
        .download(row.storage_path);
      if (dlError || !blob) throw new Error(dlError?.message ?? "no data");
      if (blob.size !== row.size_bytes) throw new Error("Source size does not match its uploaded record");
      const buffer = Buffer.from(await blob.arrayBuffer());
      loadedBytes += buffer.length;
      parsed = parseFile(buffer, row.file_type, { filename: row.filename });
      if (parsed.meta.sha256 !== row.sha256) throw new Error("Source content hash does not match the uploaded record");
      if (rows.length + parsed.rows.length > maxRows) throw new Error("Investigation dataset limit reached; narrow the data scope");
    } catch (err) {
      unreadable.push({
        workflowId: row.workflow_id,
        filename: row.filename,
        reason: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const normalized = normalizeParsedFile(parsed, row.workflow_id, workflow.name ?? "(unnamed)");
    for (const item of normalized) rows.push(item);
    summaries.push(summarize(normalized, parsed, row));
  }

  return { rows, summaries, unreadable, loadedBytes };
}

/** Seed datasets directly — used by tests and by the proof scripts, which parse from disk. */
export function normalizeParsedFile(
  parsed: ParsedFile,
  workflowId: string,
  workflowName: string,
): LedgerRow[] {
  const dataset = parsed.meta.fileType;
  const shortId = workflowId;

  return parsed.rows.map((raw) => {
    const base = {
      sourceId: `wf:${shortId}/${dataset}/${String(raw.id)}`,
      workflowId,
      workflowName,
      dataset,
    };

    switch (dataset) {
      case "erp_export": {
        const r = raw as unknown as ErpTxn;
        return {
          ...base,
          date: r.date,
          period: monthOf(r.date),
          description: r.description,
          counterparty: null,
          department: null,
          category: null,
          amountCents: r.amountCents,
          reference: r.referenceNumber,
        };
      }
      case "bank_statement": {
        const r = raw as unknown as BankTxn;
        return {
          ...base,
          date: r.date,
          period: monthOf(r.date),
          description: r.description,
          counterparty: null,
          department: null,
          category: null,
          amountCents: r.amountCents,
          reference: r.transactionId,
        };
      }
      case "invoice": {
        const r = raw as unknown as Invoice;
        return {
          ...base,
          date: r.invoiceDate,
          period: monthOf(r.invoiceDate),
          description: r.lineItem,
          counterparty: r.vendorName,
          department: null,
          category: null,
          amountCents: r.amountCents,
          reference: r.invoiceNumber,
        };
      }
      case "po": {
        const r = raw as unknown as PurchaseOrder;
        return {
          ...base,
          date: r.issuedDate,
          period: monthOf(r.issuedDate),
          description: r.lineItem,
          counterparty: r.vendorName,
          department: null,
          category: null,
          amountCents: r.amountCents,
          reference: r.poNumber,
        };
      }
      case "budget": {
        const r = raw as unknown as BudgetLine;
        return {
          ...base,
          date: null,
          period: r.period,
          description: `${r.department} — ${r.category}`,
          counterparty: null,
          department: r.department,
          category: r.category,
          amountCents: r.budgetedAmountCents,
          reference: null,
        };
      }
      case "actuals": {
        const r = raw as unknown as ActualsLine;
        return {
          ...base,
          date: null,
          period: r.period,
          description: `${r.department} — ${r.category}`,
          counterparty: null,
          department: r.department,
          category: r.category,
          amountCents: r.actualAmountCents,
          reference: null,
        };
      }
    }
  });
}

function summarize(rows: LedgerRow[], parsed: ParsedFile, file: WorkflowFile): DatasetSummary {
  const dates = rows.map((r) => r.date).filter((d): d is string => d !== null).sort();
  const populated = new Set<string>();
  for (const row of rows) {
    if (row.date) populated.add("date");
    if (row.period) populated.add("period");
    if (row.counterparty) populated.add("counterparty");
    if (row.department) populated.add("department");
    if (row.category) populated.add("category");
    if (row.reference) populated.add("reference");
  }

  return {
    dataset: parsed.meta.fileType,
    workflowId: file.workflow_id,
    workflowName: rows[0]?.workflowName ?? "(unnamed)",
    filename: parsed.meta.filename || file.filename,
    rowCount: rows.length,
    skippedCount: parsed.meta.skippedCount,
    dateFrom: dates[0] ?? null,
    dateTo: dates[dates.length - 1] ?? null,
    totalCents: rows.reduce((sum, r) => sum + r.amountCents, 0),
    populatedFields: [...populated].sort(),
  };
}

/** `2026-06-14` → `2026-06`. */
function monthOf(date: string | null): string | null {
  if (!date || date.length < 7) return null;
  return date.slice(0, 7);
}

/* -------------------------------------------------------------------------- */
/* Resolution — the other half of the citation contract                        */
/* -------------------------------------------------------------------------- */

/**
 * Resolve cited source ids back to rows, reporting the ones that do not exist.
 *
 * This is what makes a citation a fact rather than a claim. The unresolved list is returned
 * rather than thrown so the caller can put the exact bad ids in the corrective message the model
 * gets — "sourceId X does not exist" is actionable; "invalid citation" is not.
 */
export function resolveSourceIds(
  rows: LedgerRow[],
  sourceIds: readonly string[],
): { resolved: LedgerRow[]; unresolved: string[] } {
  const byId = new Map(rows.map((r) => [r.sourceId, r]));
  const resolved: LedgerRow[] = [];
  const unresolved: string[] = [];
  for (const id of sourceIds) {
    const row = byId.get(id);
    if (row) resolved.push(row);
    else unresolved.push(id);
  }
  return { resolved, unresolved };
}
