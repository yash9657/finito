/**
 * Excel report + audit certificate workbook builder (PLAN §12).
 *
 * `buildWorkbook` assembles a SheetJS workbook from a completed, reviewed workflow:
 * a Summary sheet, type-specific detail sheets, and an Audit Certificate sheet.
 * `buildWorkbookBuffer` yields the xlsx bytes the report API route streams back.
 *
 * Money is integer cents everywhere past the parser (D7); Excel cells hold real
 * NUMBERS in dollars (cents / 100, 2dp) with the `#,##0.00` number format — never
 * pre-formatted strings. Dates are written as ISO strings. Column widths are set on
 * every sheet so nothing renders truncated.
 */

import * as XLSX from "xlsx";
import { centsToDollars } from "@/lib/format";
import {
  authorizationFooterClause,
  authorizationSummary,
  decisionNarrative,
} from "@/lib/approvals/report";
import { RISK_CLASS_SPECS } from "@/lib/approvals/risk";
import { actionTypeLabel } from "@/lib/approvals/action-types";
import type {
  ActionRequest,
  Workflow,
  WorkflowStep,
  WorkflowFile,
  ReviewDecision,
  Profile,
  ReconReportSummary,
  ApApprovalQueue,
  FpaOutput,
} from "@/lib/types";

/** Distinct `provider:model` pairs actually used across the run (Plan 2, D-P14). */
function modelsUsed(steps: WorkflowStep[]): string[] {
  const seen = new Set<string>();
  for (const s of steps) {
    if (s.provider_used && s.model) seen.add(`${s.provider_used}:${s.model}`);
  }
  return [...seen].sort();
}

/** Excel number format for dollar amounts (2dp, thousands separators). */
const MONEY_FMT = "#,##0.00";

/**
 * A cell in a sheet matrix. `{ money }` marks integer cents that must be written as a
 * dollar NUMBER with the money format; everything else is written verbatim.
 */
type Cell = string | number | boolean | null | undefined | { money: number };

/* -------------------------------------------------------------------------- */
/* Sheet construction helpers.                                                 */
/* -------------------------------------------------------------------------- */

/** Display length of a raw (already money-converted) cell value, for column sizing. */
function displayLen(v: string | number | null): number {
  if (v === null) return 0;
  if (typeof v === "number") {
    return v.toLocaleString("en-US", { maximumFractionDigits: 2 }).length;
  }
  return String(v).length;
}

/**
 * Build a worksheet from a matrix of cells. Money cells are converted to dollar
 * numbers and tagged with the money number format; column widths are sized to the
 * widest cell in each column.
 */
function buildSheet(matrix: Cell[][]): XLSX.WorkSheet {
  const aoa: (string | number | null)[][] = [];
  const moneyCoords: Array<[number, number]> = [];

  matrix.forEach((row, r) => {
    const outRow: (string | number | null)[] = [];
    row.forEach((cell, c) => {
      if (cell !== null && typeof cell === "object" && "money" in cell) {
        outRow.push(centsToDollars(cell.money));
        moneyCoords.push([r, c]);
      } else if (cell === undefined || cell === null) {
        outRow.push(null);
      } else if (typeof cell === "boolean") {
        outRow.push(cell ? "Yes" : "No");
      } else {
        outRow.push(cell);
      }
    });
    aoa.push(outRow);
  });

  const ws = XLSX.utils.aoa_to_sheet(aoa);

  for (const [r, c] of moneyCoords) {
    const addr = XLSX.utils.encode_cell({ r, c });
    const cell = ws[addr] as XLSX.CellObject | undefined;
    if (cell) {
      cell.t = "n";
      cell.z = MONEY_FMT;
    }
  }

  // Column widths: widest display cell per column, with light padding and a cap.
  let colCount = 0;
  for (const row of aoa) colCount = Math.max(colCount, row.length);
  const widths: number[] = new Array(colCount).fill(0);
  for (const row of aoa) {
    for (let c = 0; c < row.length; c++) {
      widths[c] = Math.max(widths[c], displayLen(row[c]));
    }
  }
  ws["!cols"] = widths.map((w) => ({ wch: Math.min(Math.max(w + 2, 8), 80) }));

  return ws;
}

/** Milliseconds between two ISO timestamps → `12.3s`; empty when either is missing. */
function formatDuration(start: string | null, end: string | null): string {
  if (!start || !end) return "";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (Number.isNaN(ms)) return "";
  return `${(ms / 1000).toFixed(1)}s`;
}

/** The final deliverable output — the highest-numbered complete step with output. */
function finalStepOutput<T>(steps: WorkflowStep[]): T | null {
  const complete = steps.filter((s) => s.status === "complete" && s.output != null);
  if (complete.length === 0) return null;
  const last = complete.reduce((a, b) => (b.step_number > a.step_number ? b : a));
  return (last.output as T) ?? null;
}

/* -------------------------------------------------------------------------- */
/* Summary sheet.                                                              */
/* -------------------------------------------------------------------------- */

function summaryMatrix(
  workflow: Workflow,
  steps: WorkflowStep[],
): Cell[][] {
  const runDate = workflow.started_at ?? workflow.created_at;
  const rows: Cell[][] = [
    ["FinFlow Report"],
    ["Workflow", workflow.name],
    ["Type", workflow.type],
    ["Run date", runDate],
    ["Status", workflow.status],
    [],
  ];

  if (workflow.type === "reconciliation") {
    const r = finalStepOutput<ReconReportSummary>(steps);
    rows.push(["Reconciliation Summary"]);
    if (r) {
      rows.push(["ERP transactions", r.totals.erpCount, { money: r.totals.erpAmountCents }]);
      rows.push(["Bank transactions", r.totals.bankCount, { money: r.totals.bankAmountCents }]);
      rows.push(["Matched", r.matched.count, { money: r.matched.amountCents }]);
      rows.push(["Net difference", "", { money: r.netDifferenceCents }]);
      rows.push(["Result", r.status]);
      rows.push([]);
      rows.push(["Narrative", r.narrative]);
    }
  } else if (workflow.type === "ap_matching") {
    const q = finalStepOutput<ApApprovalQueue>(steps);
    rows.push(["AP Approval Queue"]);
    if (q) {
      rows.push([
        "Auto-approve",
        q.stats.autoApproveCount,
        { money: q.stats.autoApproveAmountCents },
      ]);
      rows.push(["Hold for review", q.stats.holdCount, { money: q.stats.holdAmountCents }]);
      rows.push([]);
      rows.push(["Narrative", q.narrative]);
    }
  } else {
    const f = finalStepOutput<FpaOutput>(steps);
    rows.push(["FP&A Commentary"]);
    if (f) {
      rows.push(["Overall status", f.overallStatus]);
      rows.push([]);
      rows.push(["Executive summary", f.executiveSummary]);
    }
  }

  return rows;
}

/* -------------------------------------------------------------------------- */
/* Reconciliation detail sheets.                                               */
/* -------------------------------------------------------------------------- */

function appendReconSheets(wb: XLSX.WorkBook, steps: WorkflowStep[]): void {
  const r = finalStepOutput<ReconReportSummary>(steps);

  const matched: Cell[][] = [
    ["ERP ID", "Bank ID", "Amount", "Confidence", "Match reason"],
  ];
  for (const p of r?.matchedPairs ?? []) {
    matched.push([p.erpId, p.bankId, { money: p.amountCents }, p.confidence, p.matchReason]);
  }
  XLSX.utils.book_append_sheet(wb, buildSheet(matched), "Matched");

  const unmatchedErp: Cell[][] = [
    ["ID", "Date", "Description", "Amount", "Reference", "Category", "Explanation", "Recommendation"],
  ];
  for (const t of r?.unmatchedErp ?? []) {
    unmatchedErp.push([
      t.id,
      t.date,
      t.description,
      { money: t.amountCents },
      t.referenceNumber,
      t.flag.category,
      t.flag.explanation,
      t.flag.recommendation,
    ]);
  }
  XLSX.utils.book_append_sheet(wb, buildSheet(unmatchedErp), "Unmatched ERP");

  const unmatchedBank: Cell[][] = [
    ["ID", "Date", "Description", "Amount", "Transaction ID", "Category", "Explanation", "Recommendation"],
  ];
  for (const t of r?.unmatchedBank ?? []) {
    unmatchedBank.push([
      t.id,
      t.date,
      t.description,
      { money: t.amountCents },
      t.transactionId,
      t.flag.category,
      t.flag.explanation,
      t.flag.recommendation,
    ]);
  }
  XLSX.utils.book_append_sheet(wb, buildSheet(unmatchedBank), "Unmatched Bank");

  const duplicates: Cell[][] = [
    ["ID", "Date", "Description", "Amount", "Transaction ID", "Duplicate of"],
  ];
  for (const d of r?.duplicates ?? []) {
    duplicates.push([
      d.id,
      d.date,
      d.description,
      { money: d.amountCents },
      d.transactionId,
      d.duplicateOf,
    ]);
  }
  XLSX.utils.book_append_sheet(wb, buildSheet(duplicates), "Duplicates");
}

/* -------------------------------------------------------------------------- */
/* AP detail sheets.                                                           */
/* -------------------------------------------------------------------------- */

function appendApSheets(wb: XLSX.WorkBook, steps: WorkflowStep[]): void {
  const q = finalStepOutput<ApApprovalQueue>(steps);

  const auto: Cell[][] = [
    ["Invoice ID", "PO ID", "Vendor", "Amount", "Recommended action", "Authorized by"],
  ];
  for (const a of q?.autoApprove ?? []) {
    auto.push([
      a.invoiceId,
      a.poId,
      a.vendor,
      { money: a.amountCents },
      a.recommendedAction,
      // Which authorization released this payment (Plan 3, D-A3).
      a.authorization
        ? a.authorization.source === "standing_rule"
          ? `standing rule ${a.authorization.standingRuleId ?? ""}`.trim()
          : (a.authorization.source ?? "")
        : "",
    ]);
  }
  XLSX.utils.book_append_sheet(wb, buildSheet(auto), "Auto-Approve");

  const hold: Cell[][] = [
    ["Invoice ID", "Invoice #", "Vendor", "Line item", "Amount", "PO ID", "Flags", "Authorization"],
  ];
  for (const h of q?.holdForReview ?? []) {
    const flags = h.flags
      .map((f) => `${f.category}: ${f.explanation}`)
      .join(" | ");
    hold.push([
      h.invoice.id,
      h.invoice.invoiceNumber,
      h.invoice.vendorName,
      h.invoice.lineItem,
      { money: h.invoice.amountCents },
      h.poId ?? "",
      flags,
      // Held for an authorization reason rather than a data flag (Plan 3, D-A5).
      h.authorization ? `${h.authorization.status}: ${h.authorization.reason ?? ""}` : "",
    ]);
  }
  XLSX.utils.book_append_sheet(wb, buildSheet(hold), "Hold for Review");
}

/* -------------------------------------------------------------------------- */
/* FP&A detail sheets.                                                         */
/* -------------------------------------------------------------------------- */

function appendFpaSheets(wb: XLSX.WorkBook, steps: WorkflowStep[]): void {
  const f = finalStepOutput<FpaOutput>(steps);

  const variances: Cell[][] = [
    [
      "Department",
      "Category",
      "Period",
      "Budget",
      "Actual",
      "Variance",
      "Variance %",
      "Direction",
      "Material",
      "Commentary",
    ],
  ];
  for (const line of f?.variances ?? []) {
    variances.push([
      line.department,
      line.category,
      line.period,
      { money: line.budgetedAmountCents },
      { money: line.actualAmountCents },
      { money: line.varianceCents },
      line.variancePct === null ? "" : Number(line.variancePct.toFixed(2)),
      line.direction,
      line.material,
      line.commentary ?? "",
    ]);
  }
  XLSX.utils.book_append_sheet(wb, buildSheet(variances), "Variances");

  const commentary: Cell[][] = [["Department", "Category", "Commentary"]];
  for (const c of f?.varianceComments ?? []) {
    commentary.push([c.department, c.category, c.commentary]);
  }
  commentary.push([]);
  commentary.push(["Department Summaries"]);
  commentary.push(["Department", "Summary"]);
  for (const s of f?.departmentSummaries ?? []) {
    commentary.push([s.department, s.summary]);
  }
  XLSX.utils.book_append_sheet(wb, buildSheet(commentary), "Commentary");
}

/* -------------------------------------------------------------------------- */
/* Authorization sheet (Plan 3 §7, Edge #4) — the per-action decision record.   */
/* -------------------------------------------------------------------------- */

function authorizationMatrix(
  actions: ActionRequest[],
  approverEmails: Record<string, string>,
): Cell[][] {
  const rows: Cell[][] = [
    [
      "Action",
      "Risk class",
      "Counterparty",
      "Amount",
      "Target",
      "Outcome",
      "Basis",
      "Standing rule",
      "Proposed at",
      "Decided at",
      "Committed at",
      "Reason",
      "Comment",
    ],
  ];
  for (const a of actions) {
    rows.push([
      actionTypeLabel(a.action_type),
      RISK_CLASS_SPECS[a.risk_class]?.label ?? a.risk_class,
      a.counterparty ?? "",
      a.amount_cents === null ? "" : { money: a.amount_cents },
      `${a.target_kind} ${a.target_id}`,
      a.status,
      decisionNarrative(a, approverEmails),
      a.standing_rule_id ?? "",
      a.proposed_at,
      a.decided_at ?? "",
      a.committed_at ?? "",
      a.decision_reason ?? "",
      a.comment ?? "",
    ]);
  }
  return rows;
}

/* -------------------------------------------------------------------------- */
/* Audit Certificate sheet (PLAN §12 — exact contents).                        */
/* -------------------------------------------------------------------------- */

function auditCertificateMatrix(
  workflow: Workflow,
  steps: WorkflowStep[],
  files: WorkflowFile[],
  decision: ReviewDecision | null,
  reviewerProfile: Profile | null,
  actions: ActionRequest[],
  approverEmails: Record<string, string>,
): Cell[][] {
  const rows: Cell[][] = [
    ["Audit Certificate"],
    [],
    ["Workflow"],
    ["ID", workflow.id],
    ["Type", workflow.type],
    ["Launched at", workflow.started_at ?? ""],
    ["Completed at", workflow.completed_at ?? ""],
    [],
    ["Files"],
    ["Filename", "Size (bytes)", "SHA-256"],
  ];
  for (const file of files) {
    rows.push([file.filename, file.size_bytes, file.sha256]);
  }

  rows.push([]);
  rows.push(["Steps"]);
  rows.push([
    "#",
    "Name",
    "Track",
    "Model",
    "Tokens In",
    "Tokens Out",
    "Latency",
    "Input hash",
    "Started",
    "Completed",
    "Duration",
  ]);
  const orderedSteps = [...steps].sort((a, b) => a.step_number - b.step_number);
  for (const step of orderedSteps) {
    rows.push([
      step.step_number,
      step.name,
      step.track,
      step.provider_used && step.model ? `${step.provider_used}:${step.model}` : "deterministic",
      step.tokens_in ?? "",
      step.tokens_out ?? "",
      step.latency_ms !== null ? `${(step.latency_ms / 1000).toFixed(1)}s` : "",
      step.input_hash ?? "",
      step.started_at ?? "",
      step.completed_at ?? "",
      formatDuration(step.started_at, step.completed_at),
    ]);
  }

  // Per-action authorization chain (Plan 3, D-A15) — the same rows as the Authorization
  // sheet, inline here so the certificate is self-contained.
  if (actions.length > 0) {
    rows.push([]);
    rows.push(["Authorization chain"]);
    for (const row of authorizationMatrix(actions, approverEmails)) rows.push(row);
  }

  rows.push([]);
  rows.push(["Review"]);
  rows.push(["Reviewer", "Decision", "Timestamp", "Comment"]);
  rows.push([
    reviewerProfile?.email ?? "",
    decision?.decision ?? "",
    decision?.decided_at ?? "",
    decision?.comment ?? "",
  ]);

  rows.push([]);
  const models = modelsUsed(orderedSteps);
  const authClause = authorizationFooterClause(authorizationSummary(actions));
  rows.push([
    "Generated by FinFlow · models used: " +
      (models.join(", ") || "none") +
      " · all step inputs hashed with SHA-256 at execution time" +
      (authClause ? ` · ${authClause}` : ""),
  ]);

  return rows;
}

/* -------------------------------------------------------------------------- */
/* Public API.                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Everything the workbook needs beyond the run itself. Optional so callers predating
 * Plan 3 still compile; when actions are passed, the workbook gains the Authorization
 * sheet and the certificate's authorization clause (D-A15).
 */
export interface WorkbookExtras {
  actions?: ActionRequest[];
  /** profile id → email, for naming approvers in the decision record. */
  approverEmails?: Record<string, string>;
}

/**
 * Build the full report workbook for an approved workflow. Sheet set is switched on
 * `workflow.type`; the Summary and Audit Certificate sheets are always present, and the
 * Authorization sheet appears whenever the run proposed consequential actions.
 */
export function buildWorkbook(
  workflow: Workflow,
  steps: WorkflowStep[],
  files: WorkflowFile[],
  decision: ReviewDecision | null,
  reviewerProfile: Profile | null,
  extras: WorkbookExtras = {},
): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  const actions = extras.actions ?? [];
  const approverEmails = extras.approverEmails ?? {};

  XLSX.utils.book_append_sheet(wb, buildSheet(summaryMatrix(workflow, steps)), "Summary");

  switch (workflow.type) {
    case "reconciliation":
      appendReconSheets(wb, steps);
      break;
    case "ap_matching":
      appendApSheets(wb, steps);
      break;
    case "fpa_commentary":
      appendFpaSheets(wb, steps);
      break;
  }

  if (actions.length > 0) {
    XLSX.utils.book_append_sheet(
      wb,
      buildSheet(authorizationMatrix(actions, approverEmails)),
      "Authorization",
    );
  }

  XLSX.utils.book_append_sheet(
    wb,
    buildSheet(
      auditCertificateMatrix(
        workflow,
        steps,
        files,
        decision,
        reviewerProfile,
        actions,
        approverEmails,
      ),
    ),
    "Audit Certificate",
  );

  return wb;
}

/** Build the workbook and serialize it to an xlsx Buffer for the report API route. */
export function buildWorkbookBuffer(
  workflow: Workflow,
  steps: WorkflowStep[],
  files: WorkflowFile[],
  decision: ReviewDecision | null,
  reviewerProfile: Profile | null,
  extras: WorkbookExtras = {},
): Buffer {
  const wb = buildWorkbook(workflow, steps, files, decision, reviewerProfile, extras);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
