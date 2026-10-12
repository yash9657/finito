/**
 * The six read tools (Plan 5 §5, D-G19). All free, all logged, none consequential.
 *
 * These are the entire investigative surface. The agent calls them in whatever order it decides
 * — that is the open-endedness D-G1 grants — and every arithmetic result they return is computed
 * here in TypeScript, never by the model.
 */

import {
  capRows,
  empty,
  fail,
  formatCents,
  isIsoDate,
  isIsoMonth,
  projectRow,
  type AgentTool,
  type ToolContext,
  type ToolResultEnvelope,
} from "@/lib/harness/agent/tools/types";
import type { LedgerRow } from "@/lib/harness/agent/datasets";
import {
  detectBankDuplicates,
  detectDuplicateInvoices,
  matchAp,
  nearestMiss,
  reconcile,
} from "@/lib/agents/matching";
import { FILE_TYPES } from "@/lib/types";
import type { BankTxn, ErpTxn, Invoice, PurchaseOrder } from "@/lib/types";

/** Rows sent back inline, per call. Tight on purpose — the trail keeps everything (D-G22). */
const ROW_SAMPLE_LIMIT = 25;
const TRANSACTION_PAGE_LIMIT = 50;
const GROUP_LIMIT = 40;

/* -------------------------------------------------------------------------- */
/* 1. list_datasets — the orientation step                                     */
/* -------------------------------------------------------------------------- */

export const listDatasets: AgentTool = {
  name: "list_datasets",
  description:
    "List the financial workflow datasets currently loaded, with row counts, date ranges " +
    "and totals. Initial loading covers at most the latest 25 workflows; older files can be " +
    "discovered through workspace history and activated with load_historical_workflow. " +
    "General uploaded files are listed separately by list_sources.",
  parameters: { type: "object", properties: {}, required: [], additionalProperties: false },

  async run(_args, ctx): Promise<ToolResultEnvelope> {
    const { summaries, unreadable } = ctx.datasets;

    if (summaries.length === 0) {
      return empty(
        "No workflow financial datasets are currently loaded.",
        unreadable.length > 0
          ? `${unreadable.length} file(s) could not be read: ${unreadable
              .map((u) => `${u.filename} (${u.reason})`)
              .join("; ")}. Report this rather than concluding there is no data.`
          : "Before concluding there is nothing to investigate, check list_sources for general files and search_workspace_history for relevant retained workflow uploads.",
      );
    }

    const byDataset = new Map<string, number>();
    for (const s of summaries) {
      byDataset.set(s.dataset, (byDataset.get(s.dataset) ?? 0) + s.rowCount);
    }
    const summary =
      `${summaries.length} dataset file(s) across ${new Set(summaries.map((s) => s.workflowId)).size} ` +
      `workflow(s): ` +
      [...byDataset.entries()].map(([d, n]) => `${d} (${n} rows)`).join(", ") +
      ".";

    return {
      ok: true,
      summary,
      data: {
        datasets: summaries.map((s) => ({
          dataset: s.dataset,
          workflow: s.workflowName,
          workflowId: s.workflowId,
          filename: s.filename,
          rows: s.rowCount,
          skippedRows: s.skippedCount,
          dateFrom: s.dateFrom,
          dateTo: s.dateTo,
          totalCents: s.totalCents,
          populatedFields: s.populatedFields,
        })),
        // Surfaced, never swallowed: an agent that cannot see a file must know it exists.
        unreadableFiles: unreadable,
        scope: "Currently loaded workflows only: initially at most the latest 25, plus explicitly activated historical workflows. This is not the entire retained workspace catalog.",
      },
      hint:
        unreadable.length > 0
          ? `${unreadable.length} file(s) could not be read and are NOT included in any query result.`
          : undefined,
    };
  },
};

/* -------------------------------------------------------------------------- */
/* 2. query_ledger — the compact action                                        */
/* -------------------------------------------------------------------------- */

const GROUP_BY_VALUES = [
  "none",
  "dataset",
  "period",
  "counterparty",
  "department",
  "category",
] as const;
type GroupBy = (typeof GROUP_BY_VALUES)[number];

export const queryLedger: AgentTool = {
  name: "query_ledger",
  description:
    "Filter, group and aggregate financial rows in ONE call. Combine any filters you need — " +
    "this should answer most questions on its own, without a follow-up. Amounts are integer " +
    "cents. Select exactly one dataset; select workflowId if more than one uploaded source matches. Returns group totals plus a small sample of matching rows with their source ids.",
  parameters: {
    type: "object",
    properties: {
      datasets: {
        type: "array",
        items: { type: "string", enum: [...FILE_TYPES] },
        minItems: 1,
        maxItems: 1,
        description: "Exactly one dataset. Bank, ERP, budget and actuals are different financial bases and must never be summed together.",
      },
      workflowId: { type: "string", description: "Workflow source ID from list_datasets. Required when several uploads match the selected dataset." },
      dateFrom: { type: "string", description: "Inclusive ISO date, YYYY-MM-DD." },
      dateTo: { type: "string", description: "Inclusive ISO date, YYYY-MM-DD." },
      period: { type: "string", description: "A single period, YYYY-MM." },
      counterparty: { type: "string", description: "Case-insensitive substring of the vendor." },
      department: { type: "string", description: "Case-insensitive substring." },
      category: { type: "string", description: "Case-insensitive substring." },
      textContains: {
        type: "string",
        description: "Case-insensitive substring of the description or reference.",
      },
      minAmountCents: { type: "integer", description: "Inclusive lower bound, in cents." },
      maxAmountCents: { type: "integer", description: "Inclusive upper bound, in cents." },
      groupBy: {
        type: "string",
        enum: [...GROUP_BY_VALUES],
        description: "How to aggregate. 'none' returns one overall total.",
      },
    },
    required: ["datasets"],
    additionalProperties: false,
  },

  async run(args, ctx): Promise<ToolResultEnvelope> {
    const filtered = applyFilters(ctx.rows, args);
    if ("error" in filtered) return filtered.error;

    const rows = filtered.rows;
    if (rows.length === 0) {
      return empty(
        "No rows matched those filters.",
        emptyHint(ctx, args),
      );
    }

    const basisError = validateAggregationBasis(args, rows);
    if (basisError) return basisError;

    const groupBy = (args.groupBy as GroupBy | undefined) ?? "none";
    const groups = groupRows(rows, groupBy);
    const capped = capRows(groups, GROUP_LIMIT);
    const sample = capRows(rows, ROW_SAMPLE_LIMIT);
    const totalCents = rows.reduce((sum, r) => sum + r.amountCents, 0);

    return {
      ok: true,
      summary:
        `${rows.length} row(s) totalling ${formatCents(totalCents)}` +
        (groupBy === "none" ? "." : ` across ${groups.length} ${groupBy} group(s).`),
      data: {
        dataset: rows[0].dataset,
        workflowId: rows[0].workflowId,
        totalCents,
        rowCount: rows.length,
        groupBy,
        groups: capped.rows,
        sampleRows: sample.rows.map(projectRow),
      },
      truncated: capped.truncated || sample.truncated,
      total: rows.length,
      showing: sample.showing,
      hint:
        sample.truncated || capped.truncated
          ? `Showing ${sample.showing} of ${rows.length} rows${
              capped.truncated ? ` and ${capped.showing} of ${groups.length} groups` : ""
            }. The totals above are computed over ALL matching rows, not just the sample. Use ` +
            `get_transactions to page through the rest.`
          : undefined,
    };
  },
};

/* -------------------------------------------------------------------------- */
/* 3. get_transactions — drill into a number you just computed                 */
/* -------------------------------------------------------------------------- */

export const getTransactions: AgentTool = {
  name: "get_transactions",
  description:
    "The individual rows behind an aggregate, paginated and sorted by amount (largest first) or " +
    "by date. Use this after query_ledger when you need to see the specific transactions that " +
    "make up a total, each with a source id you can cite.",
  parameters: {
    type: "object",
    properties: {
      datasets: { type: "array", items: { type: "string", enum: [...FILE_TYPES] } },
      workflowId: { type: "string", description: "Workflow source ID from list_datasets." },
      dateFrom: { type: "string" },
      dateTo: { type: "string" },
      period: { type: "string" },
      counterparty: { type: "string" },
      department: { type: "string" },
      category: { type: "string" },
      textContains: { type: "string" },
      minAmountCents: { type: "integer" },
      maxAmountCents: { type: "integer" },
      sortBy: {
        type: "string",
        enum: ["amount_desc", "amount_asc", "date_asc", "date_desc"],
        description: "Defaults to amount_desc — the largest items first.",
      },
      offset: { type: "integer", description: "Rows to skip, for paging." },
      limit: { type: "integer", description: `Max rows to return (cap ${TRANSACTION_PAGE_LIMIT}).` },
    },
    required: [],
    additionalProperties: false,
  },

  async run(args, ctx): Promise<ToolResultEnvelope> {
    const filtered = applyFilters(ctx.rows, args);
    if ("error" in filtered) return filtered.error;

    const sortBy = (args.sortBy as string | undefined) ?? "amount_desc";
    const sorted = [...filtered.rows].sort(comparator(sortBy));

    const offset = Math.max(0, toInt(args.offset) ?? 0);
    const limit = Math.min(toInt(args.limit) ?? TRANSACTION_PAGE_LIMIT, TRANSACTION_PAGE_LIMIT);
    const page = sorted.slice(offset, offset + limit);

    if (sorted.length === 0) {
      return empty("No rows matched those filters.", emptyHint(ctx, args));
    }
    if (page.length === 0) {
      return {
        ok: true,
        summary: `Offset ${offset} is past the end of ${sorted.length} matching row(s).`,
        data: { rows: [] },
        total: sorted.length,
        showing: 0,
        hint: `There are ${sorted.length} rows in total; use an offset below that.`,
      };
    }

    const pageTotal = page.reduce((sum, r) => sum + r.amountCents, 0);
    return {
      ok: true,
      summary:
        `Rows ${offset + 1}–${offset + page.length} of ${sorted.length}, ` +
        `totalling ${formatCents(pageTotal)} on this page.`,
      data: { rows: page.map(projectRow), pageTotalCents: pageTotal },
      truncated: offset + page.length < sorted.length,
      total: sorted.length,
      showing: page.length,
      hint:
        offset + page.length < sorted.length
          ? `${sorted.length - offset - page.length} more row(s). Call again with offset=${
              offset + page.length
            }.`
          : undefined,
    };
  },
};

/* -------------------------------------------------------------------------- */
/* 4. compare_periods — variances computed in code                             */
/* -------------------------------------------------------------------------- */

export const comparePeriods: AgentTool = {
  name: "compare_periods",
  description:
    "Compare two periods (YYYY-MM) and return the variance per group, computed in code. Use this " +
    "for any 'what changed' question — do not compute differences yourself from two separate " +
    "query_ledger calls.",
  parameters: {
    type: "object",
    properties: {
      periodA: { type: "string", description: "The earlier period, YYYY-MM." },
      periodB: { type: "string", description: "The later period, YYYY-MM." },
      datasets: { type: "array", items: { type: "string", enum: [...FILE_TYPES] }, minItems: 1, maxItems: 1, description: "Select exactly one financial dataset; never combine actuals, budget, bank and ERP." },
      workflowId: { type: "string", description: "Workflow source ID from list_datasets; select one source when several uploads match." },
      groupBy: {
        type: "string",
        enum: ["dataset", "counterparty", "department", "category"],
        description: "Defaults to category.",
      },
    },
    required: ["periodA", "periodB", "datasets"],
    additionalProperties: false,
  },

  async run(args, ctx): Promise<ToolResultEnvelope> {
    const { periodA, periodB } = args;
    if (!isIsoMonth(periodA) || !isIsoMonth(periodB)) {
      return fail(
        "periodA and periodB must be months in YYYY-MM form.",
        `You passed periodA=${JSON.stringify(periodA)}, periodB=${JSON.stringify(periodB)}. ` +
          `Call list_datasets to see which periods exist.`,
      );
    }
    if (periodA === periodB) {
      return fail("periodA and periodB are the same period.", "Pass two different months.");
    }

    const groupBy = (args.groupBy as GroupBy | undefined) ?? "category";
    const filtered = applyFilters(ctx.rows, args);
    if ("error" in filtered) return filtered.error;
    const aRows = filtered.rows.filter(r => r.period === periodA);
    const bRows = filtered.rows.filter(r => r.period === periodB);

    if (aRows.length === 0 && bRows.length === 0) {
      const periods = [...new Set(ctx.rows.map((r) => r.period).filter(Boolean))].sort();
      return empty(
        `Neither ${periodA} nor ${periodB} has any rows.`,
        `Periods present in the data: ${periods.join(", ") || "none"}.`,
      );
    }
    const basisError = validateAggregationBasis(args, [...aRows, ...bRows]);
    if (basisError) return basisError;
    if (aRows.length === 0 || bRows.length === 0) {
      return fail("One comparison period has no source rows; its value is unknown, not zero.", `Load both ${periodA} and ${periodB} for the selected source before comparing their monetary totals.`);
    }

    const keys = new Set([...aRows, ...bRows].map((r) => groupKey(r, groupBy)));
    const variances = [...keys]
      .map((key) => {
        const a = sumOf(aRows, groupBy, key);
        const b = sumOf(bRows, groupBy, key);
        const varianceCents = b - a;
        return {
          key,
          periodACents: a,
          periodBCents: b,
          varianceCents,
          // Null rather than Infinity when the base is zero — a percentage of nothing is not a
          // number, and emitting Infinity would let it reach the answer as a figure.
          variancePct: a === 0 ? null : Math.round((varianceCents / Math.abs(a)) * 10000) / 100,
          direction: varianceCents > 0 ? "increase" : varianceCents < 0 ? "decrease" : "flat",
        };
      })
      .sort((x, y) => Math.abs(y.varianceCents) - Math.abs(x.varianceCents));

    const totalA = aRows.reduce((s, r) => s + r.amountCents, 0);
    const totalB = bRows.reduce((s, r) => s + r.amountCents, 0);
    const capped = capRows(variances, GROUP_LIMIT);

    return {
      ok: true,
      summary:
        `${periodA} ${formatCents(totalA)} → ${periodB} ${formatCents(totalB)} ` +
        `(${formatCents(totalB - totalA)}), across ${variances.length} ${groupBy} group(s).`,
      data: {
        dataset: aRows[0].dataset,
        workflowId: aRows[0].workflowId,
        periodA,
        periodB,
        totalACents: totalA,
        totalBCents: totalB,
        totalVarianceCents: totalB - totalA,
        groupBy,
        variances: capped.rows,
      },
      truncated: capped.truncated,
      total: variances.length,
      showing: capped.showing,
      hint: capped.truncated
        ? `Showing the ${capped.showing} largest variances of ${variances.length}.`
        : undefined,
    };
  },
};

/* -------------------------------------------------------------------------- */
/* 5. find_anomalies — the EXISTING deterministic detectors                    */
/* -------------------------------------------------------------------------- */

export const findAnomalies: AgentTool = {
  name: "find_anomalies",
  description:
    "Run FinFlow's deterministic anomaly detectors over the data and return what they find: " +
    "unmatched ERP/bank transactions, duplicate bank entries, duplicate invoices, and " +
    "invoice-to-PO amount variances. These are the same tested detectors the reconciliation and " +
    "AP workflows use — prefer them over eyeballing rows yourself.",
  parameters: {
    type: "object",
    properties: {
      workflowId: { type: "string", description: "One workflow source ID from list_datasets. Required if the organization has multiple uploaded workflows; never match transactions across unrelated uploads." },
      detectors: {
        type: "array",
        items: {
          type: "string",
          enum: ["reconciliation", "bank_duplicates", "invoice_duplicates", "ap_variance"],
        },
        description: "Which detectors to run. Omit to run all of them.",
      },
    },
    required: [],
    additionalProperties: false,
  },

  async run(args, ctx): Promise<ToolResultEnvelope> {
    if (args.workflowId !== undefined && (typeof args.workflowId !== "string" || !args.workflowId.trim())) {
      return fail("workflowId must be a source ID.", "Select the exact workflowId from list_datasets.");
    }
    const scopedRows = args.workflowId ? ctx.rows.filter(row => row.workflowId === args.workflowId) : ctx.rows;
    if (new Set(scopedRows.map(row => row.workflowId)).size > 1) {
      return fail("Anomaly detectors require one selected workflow source.", "Call list_datasets, then pass workflowId. Matching across overlapping or unrelated uploads can create false reconciliations and duplicate citations.");
    }
    ctx = { ...ctx, rows: scopedRows };
    const requested = (args.detectors as string[] | undefined) ?? [
      "reconciliation",
      "bank_duplicates",
      "invoice_duplicates",
      "ap_variance",
    ];

    const erp = rowsAs<ErpTxn>(ctx, "erp_export", (r) => ({
      id: sourceRowId(r.sourceId),
      date: r.date ?? "",
      description: r.description,
      amountCents: r.amountCents,
      referenceNumber: r.reference ?? "",
    }));
    const bank = rowsAs<BankTxn>(ctx, "bank_statement", (r) => ({
      id: sourceRowId(r.sourceId),
      date: r.date ?? "",
      description: r.description,
      amountCents: r.amountCents,
      transactionId: r.reference ?? "",
    }));
    const invoices = rowsAs<Invoice>(ctx, "invoice", (r) => ({
      id: sourceRowId(r.sourceId),
      invoiceNumber: r.reference ?? "",
      vendorName: r.counterparty ?? "",
      lineItem: r.description,
      amountCents: r.amountCents,
      invoiceDate: r.date ?? "",
      dueDate: r.date ?? "",
    }));
    const pos = rowsAs<PurchaseOrder>(ctx, "po", (r) => ({
      id: sourceRowId(r.sourceId),
      poNumber: r.reference ?? "",
      vendorName: r.counterparty ?? "",
      lineItem: r.description,
      amountCents: r.amountCents,
      issuedDate: r.date ?? "",
      approvedBy: "",
    }));

    // Row ids inside the detectors are per-file (`erp-001`), so results are mapped back to full
    // source ids before they leave — a citation the agent cannot resolve is worse than none.
    const idFor = new Map(ctx.rows.map((r) => [`${r.dataset}:${sourceRowId(r.sourceId)}`, r.sourceId]));
    const cite = (dataset: string, rowId: string) => idFor.get(`${dataset}:${rowId}`) ?? rowId;

    const findings: Record<string, unknown> = {};
    const counts: string[] = [];
    const ran: string[] = [];
    const skipped: string[] = [];

    if (requested.includes("reconciliation")) {
      if (erp.length === 0 || bank.length === 0) {
        skipped.push("reconciliation (needs both erp_export and bank_statement)");
      } else {
        const pass = reconcile(erp, bank);
        // `nearestMiss` answers for ONE target at a time; the agent wants the whole set, capped.
        // This is the "what nearly matched" question, which is usually the actual answer to
        // "why doesn't this tie out" — a fee, a settlement delay, a transposed digit.
        const misses = pass.unmatchedErp.slice(0, 20).flatMap((target) => {
          const best = nearestMiss(target, pass.unmatchedBank);
          return best ? [{ erpId: target.id, ...best }] : [];
        });
        findings.reconciliation = {
          exactMatches: pass.matchedPairs.length,
          unmatchedErp: pass.unmatchedErp.map((t) => ({
            sourceId: cite("erp_export", t.id),
            date: t.date,
            description: t.description,
            amountCents: t.amountCents,
          })),
          unmatchedBank: pass.unmatchedBank.map((t) => ({
            sourceId: cite("bank_statement", t.id),
            date: t.date,
            description: t.description,
            amountCents: t.amountCents,
          })),
          nearestMisses: misses.map((m) => ({
            erpSourceId: cite("erp_export", m.erpId),
            bankSourceId: cite("bank_statement", m.id),
            amountDiffCents: m.amountDiffCents,
            daysDiff: m.daysDiff,
            descriptionJaccard: m.descriptionJaccard,
          })),
        };
        ran.push("reconciliation");
        counts.push(
          `${pass.unmatchedErp.length} unmatched ERP, ${pass.unmatchedBank.length} unmatched bank`,
        );
      }
    }

    if (requested.includes("bank_duplicates")) {
      if (bank.length === 0) {
        skipped.push("bank_duplicates (needs bank_statement)");
      } else {
        const { duplicates } = detectBankDuplicates(bank);
        findings.bankDuplicates = duplicates.map((d) => ({
          sourceId: cite("bank_statement", d.id),
          duplicateOfSourceId: cite("bank_statement", d.duplicateOf),
          date: d.date,
          description: d.description,
          amountCents: d.amountCents,
        }));
        ran.push("bank_duplicates");
        counts.push(`${duplicates.length} duplicate bank row(s)`);
      }
    }

    if (requested.includes("invoice_duplicates")) {
      if (invoices.length === 0) {
        skipped.push("invoice_duplicates (needs invoice)");
      } else {
        const byId = new Map(invoices.map((i) => [i.id, i]));
        const duplicates = detectDuplicateInvoices(invoices);
        findings.invoiceDuplicates = duplicates.map((d) => ({
          sourceId: cite("invoice", d.id),
          duplicateOfSourceId: cite("invoice", d.duplicateOf),
          vendor: byId.get(d.id)?.vendorName ?? null,
          amountCents: byId.get(d.id)?.amountCents ?? null,
        }));
        ran.push("invoice_duplicates");
        counts.push(`${duplicates.length} duplicate invoice(s)`);
      }
    }

    if (requested.includes("ap_variance")) {
      if (invoices.length === 0 || pos.length === 0) {
        skipped.push("ap_variance (needs both invoice and po)");
      } else {
        const pass = matchAp(invoices, pos);
        findings.apVariance = {
          matched: pass.matchedPairs.length,
          unmatchedInvoices: pass.unmatchedInvoices.map((i) => ({
            sourceId: cite("invoice", i.id),
            vendor: i.vendorName,
            amountCents: i.amountCents,
          })),
          candidates: pass.candidatePairs.slice(0, 20).map((c) => ({
            invoiceSourceId: cite("invoice", c.invoiceId),
            poSourceId: cite("po", c.poId),
            amountDiffCents: c.amountDiffCents,
          })),
        };
        ran.push("ap_variance");
        counts.push(`${pass.unmatchedInvoices.length} unmatched invoice(s)`);
      }
    }

    if (ran.length === 0) {
      return empty(
        "No detector could run — the required datasets are not present.",
        `Skipped: ${skipped.join("; ")}. Call list_datasets to see what data exists.`,
      );
    }

    return {
      ok: true,
      summary: `Ran ${ran.join(", ")}: ${counts.join("; ")}.`,
      data: findings,
      hint:
        skipped.length > 0
          ? `Not run for want of data: ${skipped.join("; ")}.`
          : undefined,
    };
  },
};

/* -------------------------------------------------------------------------- */
/* 6. get_workflow_history — where the agent learns this org's normal          */
/* -------------------------------------------------------------------------- */

export const getWorkflowHistory: AgentTool = {
  name: "get_workflow_history",
  description:
    "Prior workflow runs for this organization: what ran, when, whether it completed, and how " +
    "each consequential action was resolved (auto-approved, approved, rejected, denied). Use " +
    "this to learn what is normal here before calling something unusual.",
  parameters: {
    type: "object",
    properties: {
      limit: { type: "integer", description: "Max runs to return (cap 20)." },
    },
    required: [],
    additionalProperties: false,
  },

  async run(args, ctx): Promise<ToolResultEnvelope> {
    const limit = Math.min(toInt(args.limit) ?? 10, 20);

    const { data: workflows, error } = await ctx.db
      .from("workflows")
      .select("id, name, type, status, created_at, completed_at, error_message")
      .eq("org_id", ctx.orgId)
      .neq("type", "investigation")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) {
      return fail(
        `Could not read workflow history: ${error.message}`,
        "Continue the investigation using the data tools instead.",
      );
    }
    const runs = workflows ?? [];
    if (runs.length === 0) {
      return empty(
        "This organization has no prior workflow runs.",
        "There is no history to learn the org's normal from; rely on the data itself.",
      );
    }

    const { data: actions } = await ctx.db
      .from("action_requests")
      .select("workflow_id, action_type, summary, status, decision_source, decision_reason, amount_cents, counterparty")
      .in("workflow_id", runs.map((w) => w.id as string));

    const byWorkflow = new Map<string, Record<string, unknown>[]>();
    for (const a of actions ?? []) {
      const list = byWorkflow.get(a.workflow_id as string) ?? [];
      list.push({
        actionType: a.action_type,
        summary: a.summary,
        status: a.status,
        decidedBy: a.decision_source,
        reason: a.decision_reason,
        amountCents: a.amount_cents,
        counterparty: a.counterparty,
      });
      byWorkflow.set(a.workflow_id as string, list);
    }

    const totalActions = (actions ?? []).length;
    const rejected = (actions ?? []).filter(
      (a) => a.status === "rejected" || a.status === "denied",
    ).length;

    return {
      ok: true,
      summary:
        `${runs.length} prior run(s); ${totalActions} consequential action(s), ` +
        `${rejected} rejected or denied.`,
      data: {
        runs: runs.map((w) => ({
          workflowId: w.id,
          name: w.name,
          type: w.type,
          status: w.status,
          createdAt: w.created_at,
          completedAt: w.completed_at,
          error: w.error_message,
          actions: byWorkflow.get(w.id as string) ?? [],
        })),
      },
    };
  },
};

/* -------------------------------------------------------------------------- */
/* Filtering, grouping, and the shared helpers                                 */
/* -------------------------------------------------------------------------- */

function applyFilters(
  rows: LedgerRow[],
  args: Record<string, unknown>,
): { rows: LedgerRow[] } | { error: ToolResultEnvelope } {
  const { dateFrom, dateTo, period } = args;

  // Argument validation returns a CORRECTABLE message rather than throwing (D-G19 rule 4).
  if (dateFrom !== undefined && !isIsoDate(dateFrom)) {
    return {
      error: fail(
        "dateFrom must be an ISO date in YYYY-MM-DD form.",
        `You passed ${JSON.stringify(dateFrom)}. Example: "2026-06-01".`,
      ),
    };
  }
  if (dateTo !== undefined && !isIsoDate(dateTo)) {
    return {
      error: fail(
        "dateTo must be an ISO date in YYYY-MM-DD form.",
        `You passed ${JSON.stringify(dateTo)}. Example: "2026-06-30".`,
      ),
    };
  }
  if (period !== undefined && !isIsoMonth(period)) {
    return {
      error: fail(
        "period must be a month in YYYY-MM form.",
        `You passed ${JSON.stringify(period)}. Example: "2026-06".`,
      ),
    };
  }
  if (isIsoDate(dateFrom) && isIsoDate(dateTo) && dateFrom > dateTo) {
    return {
      error: fail(
        "dateFrom is after dateTo, so nothing could ever match.",
        `Swap them: dateFrom=${dateTo}, dateTo=${dateFrom}.`,
      ),
    };
  }

  if (args.datasets !== undefined && (!Array.isArray(args.datasets) || !args.datasets.every(value => typeof value === "string"))) {
    return { error: fail("datasets must be an array of dataset names.", `Valid datasets: ${FILE_TYPES.join(", ")}.`) };
  }
  if (args.workflowId !== undefined && (typeof args.workflowId !== "string" || !args.workflowId.trim())) {
    return { error: fail("workflowId must be a non-empty source ID.", "Use the exact workflowId from list_datasets.") };
  }
  const datasets = args.datasets as string[] | undefined;
  const unknownDataset = (datasets ?? []).find(
    (d) => !(FILE_TYPES as readonly string[]).includes(d),
  );
  if (unknownDataset) {
    return {
      error: fail(
        `"${unknownDataset}" is not a dataset.`,
        `Valid datasets: ${FILE_TYPES.join(", ")}. Call list_datasets to see which exist here.`,
      ),
    };
  }

  const min = toInt(args.minAmountCents);
  const max = toInt(args.maxAmountCents);
  if (min !== undefined && max !== undefined && min > max) {
    return {
      error: fail(
        "minAmountCents is greater than maxAmountCents.",
        "Amounts are in integer CENTS — $1,000 is 100000.",
      ),
    };
  }

  const text = lower(args.textContains);
  const counterparty = lower(args.counterparty);
  const department = lower(args.department);
  const category = lower(args.category);

  const out = rows.filter((row) => {
    if (args.workflowId && row.workflowId !== args.workflowId) return false;
    if (datasets && datasets.length > 0 && !datasets.includes(row.dataset)) return false;
    if (isIsoDate(dateFrom) && (row.date === null || row.date < dateFrom)) return false;
    if (isIsoDate(dateTo) && (row.date === null || row.date > dateTo)) return false;
    if (isIsoMonth(period) && row.period !== period) return false;
    if (counterparty && !(row.counterparty ?? "").toLowerCase().includes(counterparty)) return false;
    if (department && !(row.department ?? "").toLowerCase().includes(department)) return false;
    if (category && !(row.category ?? "").toLowerCase().includes(category)) return false;
    if (min !== undefined && row.amountCents < min) return false;
    if (max !== undefined && row.amountCents > max) return false;
    if (text) {
      const haystack = `${row.description} ${row.reference ?? ""}`.toLowerCase();
      if (!haystack.includes(text)) return false;
    }
    return true;
  });

  return { rows: out };
}

/** Mathematical addition is only meaningful after the financial basis is unambiguous. */
function validateAggregationBasis(args: Record<string, unknown>, rows: LedgerRow[]): ToolResultEnvelope | null {
  if (!Array.isArray(args.datasets) || args.datasets.length !== 1 || new Set(rows.map(row => row.dataset)).size !== 1) {
    return fail("Monetary totals require exactly one selected dataset.", "Call list_datasets, then pass datasets with one name, such as [\"erp_export\"]. Query bank, ERP, budget and actuals separately; adding them double-counts or mixes financial bases.");
  }
  const sources = [...new Set(rows.map(row => row.workflowId))];
  if (sources.length > 1) {
    return fail("Several uploaded sources match; their monetary totals cannot be safely combined.", `Pass workflowId from list_datasets to select one source. Matching workflow IDs: ${sources.slice(0, 10).join(", ")}. The data has no entity or currency metadata proving these uploads may be consolidated.`);
  }
  if (rows.some(row => !Number.isSafeInteger(row.amountCents)) || rows.reduce((sum, row) => sum + BigInt(Math.abs(row.amountCents)), BigInt(0)) > BigInt(Number.MAX_SAFE_INTEGER)) {
    return fail("These monetary totals exceed exact integer-cent arithmetic limits.", "Narrow the selected source or period. Do not estimate or use rounded floating-point totals.");
  }
  return null;
}

/**
 * What to suggest when a filter matched nothing.
 *
 * The single most useful thing an empty result can carry is the range that DOES exist — an agent
 * told "no rows in 2025-03" and nothing else will try 2025-04, then 2025-05, burning turns. Told
 * the data covers 2026-06 only, it stops.
 */
function emptyHint(ctx: ToolContext, args: Record<string, unknown>): string {
  const dates = ctx.rows.map((r) => r.date).filter((d): d is string => d !== null).sort();
  const periods = [...new Set(ctx.rows.map((r) => r.period).filter(Boolean))].sort();
  const datasets = [...new Set(ctx.rows.map((r) => r.dataset))];

  const parts: string[] = [];
  if (dates.length > 0) parts.push(`the data covers ${dates[0]}..${dates[dates.length - 1]}`);
  if (periods.length > 0) parts.push(`periods present: ${periods.join(", ")}`);
  parts.push(`datasets: ${datasets.join(", ") || "none"}`);
  if (args.counterparty) {
    const known = [...new Set(ctx.rows.map((r) => r.counterparty).filter(Boolean))].slice(0, 8);
    if (known.length > 0) parts.push(`counterparties include: ${known.join(", ")}`);
  }
  return `Widen or drop a filter — ${parts.join("; ")}.`;
}

function groupKey(row: LedgerRow, groupBy: GroupBy): string {
  switch (groupBy) {
    case "dataset":
      return row.dataset;
    case "period":
      return row.period ?? "(no period)";
    case "counterparty":
      return row.counterparty ?? "(none)";
    case "department":
      return row.department ?? "(none)";
    case "category":
      return row.category ?? "(none)";
    case "none":
      return "all";
  }
}

function groupRows(rows: LedgerRow[], groupBy: GroupBy) {
  const buckets = new Map<string, LedgerRow[]>();
  for (const row of rows) {
    const key = groupKey(row, groupBy);
    const list = buckets.get(key) ?? [];
    list.push(row);
    buckets.set(key, list);
  }
  return [...buckets.entries()]
    .map(([key, group]) => {
      const amounts = group.map((r) => r.amountCents);
      const totalCents = amounts.reduce((a, b) => a + b, 0);
      return {
        key,
        count: group.length,
        totalCents,
        minCents: Math.min(...amounts),
        maxCents: Math.max(...amounts),
        // Integer cents throughout: a mean in floating point would reintroduce exactly the
        // rounding the money-as-cents rule (D7) exists to prevent.
        meanCents: roundedCentsMean(totalCents, group.length),
      };
    })
    .sort((a, b) => Math.abs(b.totalCents) - Math.abs(a.totalCents));
}

function roundedCentsMean(total: number, count: number): number {
  const numerator = BigInt(total);
  const denominator = BigInt(count);
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return Number(remainder * BigInt(2) >= denominator ? quotient + BigInt(1)
    : -remainder * BigInt(2) > denominator ? quotient - BigInt(1) : quotient);
}

function sumOf(rows: LedgerRow[], groupBy: GroupBy, key: string): number {
  return rows
    .filter((r) => groupKey(r, groupBy) === key)
    .reduce((sum, r) => sum + r.amountCents, 0);
}

function comparator(sortBy: string): (a: LedgerRow, b: LedgerRow) => number {
  switch (sortBy) {
    case "amount_asc":
      return (a, b) => a.amountCents - b.amountCents;
    case "date_asc":
      return (a, b) => (a.date ?? "").localeCompare(b.date ?? "");
    case "date_desc":
      return (a, b) => (b.date ?? "").localeCompare(a.date ?? "");
    default:
      // Largest absolute first: a big credit is as interesting as a big debit.
      return (a, b) => Math.abs(b.amountCents) - Math.abs(a.amountCents);
  }
}

/** Rebuild the typed row shape the existing detectors expect, from the normalized view. */
function rowsAs<T>(ctx: ToolContext, dataset: string, map: (row: LedgerRow) => T): T[] {
  return ctx.rows.filter((r) => r.dataset === dataset).map(map);
}

/** `wf:abc12345/erp_export/erp-001` → `erp-001`. */
function sourceRowId(sourceId: string): string {
  const slash = sourceId.lastIndexOf("/");
  return slash >= 0 ? sourceId.slice(slash + 1) : sourceId;
}

function lower(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value.toLowerCase() : null;
}

function toInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Math.trunc(Number(value));
  }
  return undefined;
}

export const READ_TOOLS: AgentTool[] = [
  listDatasets,
  queryLedger,
  getTransactions,
  comparePeriods,
  findAnomalies,
  getWorkflowHistory,
];
