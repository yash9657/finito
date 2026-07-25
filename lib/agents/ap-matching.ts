/**
 * Workflow 2 — AP Invoice ↔ PO Matching steps (PLAN §8, §5.2).
 *
 * Mirrors reconciliation (§7) in shape: two deterministic parse steps (Tracks A/B),
 * a hybrid match step (deterministic pass from `lib/agents/matching.ts` + Claude
 * adjudication of the residual candidate pairs), an LLM flag step, and a
 * deterministic approval-queue split with an LLM narrative. Step 6 (human review) is
 * a gate represented by the workflow status — it has no step row (§8).
 *
 * Plan 3: the approval-queue step is the workflow's one money-moving act, so it is
 * `risk: 'moves_money'` and authorization-gated (D-A2/D-A3) — see the step's header.
 *
 * Hybrid discipline (D3/D7): every match, flag category, tolerance test and amount is
 * computed in code from the parsed rows; Claude only adjudicates ambiguous candidate
 * pairs and writes human-readable language. Every ID Claude returns is validated
 * against the real dataset — unknown/duplicate IDs trigger one corrective retry, then
 * the step throws (the runner does its own step-level retry, then marks `error`).
 */

import type {
  ApApprovalQueue,
  ApFlag,
  ApFlagCategory,
  AutoApproveItem,
  DagStepDefinition,
  HoldForReviewItem,
  Invoice,
  LlmFn,
  LlmInvokeResult,
  MatchConfidence,
  ProposedAction,
  PurchaseOrder,
  StepContext,
  StepResult,
  StepSource,
} from "@/lib/types";
import {
  apFlagsSchema,
  apMatchAdjudicationSchema,
  apQueueNarrativeSchema,
} from "@/lib/types";
import { APPROVE_INVOICE_PAYMENT } from "@/lib/approvals/action-types";
import { matchAp, withinTolerance } from "@/lib/agents/matching";
import type { ApMatchPass } from "@/lib/agents/matching";
import type { z } from "zod";

/* -------------------------------------------------------------------------- */
/* Step output shapes (persisted to workflow_steps.output; consumed via         */
/* ctx.priorOutputs by later steps). Not in lib/types — internal to AP.        */
/* -------------------------------------------------------------------------- */

interface ApMatchedPair {
  invoiceId: string;
  poId: string;
  amountCents: number; // invoice amount (cents)
  confidence: MatchConfidence;
  matchReason: string;
}

export interface ApMatchStepOutput {
  matchedPairs: ApMatchedPair[];
  unmatchedInvoices: Invoice[];
  unmatchedPos: PurchaseOrder[];
  duplicateInvoices: Array<{ id: string; duplicateOf: string }>;
  stats: {
    deterministicMatches: number;
    adjudicatedMatches: number;
    unmatchedInvoiceCount: number;
    unmatchedPoCount: number;
    duplicateInvoiceCount: number;
  };
}

interface ApFlagEntry {
  invoiceId: string;
  category: ApFlagCategory;
  explanation: string;
  recommendation: string;
}

export interface ApFlagStepOutput {
  flags: ApFlagEntry[];
}

/* -------------------------------------------------------------------------- */
/* ctx accessors                                                               */
/* -------------------------------------------------------------------------- */

function invoicesFrom(ctx: StepContext): Invoice[] {
  return (ctx.files["invoice"]?.rows ?? []) as unknown as Invoice[];
}

function posFrom(ctx: StepContext): PurchaseOrder[] {
  return (ctx.files["po"]?.rows ?? []) as unknown as PurchaseOrder[];
}

function fileNote(ctx: StepContext, fileType: string): StepSource {
  const meta = ctx.files[fileType]?.meta;
  return {
    file: meta?.filename || fileType,
    note: meta ? `sha256 ${meta.sha256}` : "file not found",
  };
}

/** Amounts as decimal strings for Claude readability (never trusted for arithmetic). */
function dollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

/**
 * Call Claude, then apply a code-side semantic validation. On the first failure the
 * validation error is appended to the user prompt and the call is retried once; a
 * second failure throws (D3 — one retry with the error appended, then step error).
 */
async function callWithValidation<T>(opts: {
  llm: LlmFn;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  validate: (data: T) => string | null;
}): Promise<LlmInvokeResult<T>> {
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const user =
      attempt === 0
        ? opts.user
        : `${opts.user}\n\nYour previous response had a problem: ${lastError}. Fix it and return corrected JSON.`;
    const res = await opts.llm({ system: opts.system, user, schema: opts.schema });
    const err = opts.validate(res.data);
    if (err === null) return res;
    lastError = err;
  }
  throw new Error(`Model output failed post-validation after retry: ${lastError}`);
}

/* -------------------------------------------------------------------------- */
/* Step 1 (Track A) — Parse purchase orders (deterministic).                   */
/* -------------------------------------------------------------------------- */

const parsePos: DagStepDefinition = {
  key: "parse_pos",
  stepNumber: 1,
  dependsOn: [],
  role: "parser",
  track: "A",
  name: "Parse purchase orders",
  kind: "deterministic",
  async run(ctx: StepContext): Promise<StepResult> {
    const file = ctx.files["po"];
    const rows = posFrom(ctx);
    const skipped = file?.errors.length ?? 0;
    const filename = file?.meta.filename || "po file";
    return {
      output: {
        rows,
        rowCount: rows.length,
        skippedCount: skipped,
        errors: file?.errors ?? [],
      },
      reasoning: `Parsed ${rows.length} purchase-order rows from ${filename}. Normalized vendor names, dates and amounts to integer cents. ${skipped} row(s) skipped.`,
      sources: [fileNote(ctx, "po")],
    };
  },
};

/* -------------------------------------------------------------------------- */
/* Step 2 (Track B) — Parse invoices (deterministic).                          */
/* -------------------------------------------------------------------------- */

const parseInvoices: DagStepDefinition = {
  key: "parse_invoices",
  stepNumber: 2,
  dependsOn: [],
  role: "parser",
  track: "B",
  name: "Parse invoices",
  kind: "deterministic",
  async run(ctx: StepContext): Promise<StepResult> {
    const file = ctx.files["invoice"];
    const rows = invoicesFrom(ctx);
    const skipped = file?.errors.length ?? 0;
    const filename = file?.meta.filename || "invoice file";
    return {
      output: {
        rows,
        rowCount: rows.length,
        skippedCount: skipped,
        errors: file?.errors ?? [],
      },
      reasoning: `Parsed ${rows.length} invoice rows from ${filename}. Normalized vendor names, dates, due dates and amounts to integer cents. ${skipped} row(s) skipped.`,
      sources: [fileNote(ctx, "invoice")],
    };
  },
};

/* -------------------------------------------------------------------------- */
/* Step 3 (main) — Match invoices to POs (deterministic pass + LLM).           */
/* -------------------------------------------------------------------------- */

const AP_MATCH_SYSTEM = `You are an accounts-payable specialist matching supplier invoices to purchase orders. You are given unmatched invoices, unmatched purchase orders, and candidate pairs a deterministic matcher flagged as possibly related. Decide which candidate pairs are true matches. A true match is the same procurement: the same vendor and the same goods/services, allowing for small amount differences (freight, tax, minor billing variance) and vendor-name spelling variation. Never match an invoice to a purchase order for clearly different goods or a different vendor that merely shares a similar amount. Only reference invoice and PO IDs that appear in the data provided.`;

const matchInvoicesToPos: DagStepDefinition = {
  key: "match_invoices",
  stepNumber: 3,
  dependsOn: ["parse_pos", "parse_invoices"],
  role: "matcher",
  track: "main",
  name: "Match invoices to POs",
  kind: "llm",
  async run(ctx: StepContext): Promise<StepResult> {
    const invoices = invoicesFrom(ctx);
    const pos = posFrom(ctx);
    const pass: ApMatchPass = matchAp(invoices, pos);

    const matchedPairs: ApMatchedPair[] = pass.matchedPairs.map((m) => ({
      invoiceId: m.invoiceId,
      poId: m.poId,
      amountCents: m.amountCents,
      confidence: "high",
      matchReason: m.matchReason,
    }));

    const usedInv = new Set(matchedPairs.map((m) => m.invoiceId));
    const usedPo = new Set(matchedPairs.map((m) => m.poId));
    const invById = new Map(invoices.map((i) => [i.id, i]));

    let reasoning: string;
    let adjudicatedCount = 0;
    let llmMeta: StepResult["llmMeta"];

    if (pass.candidatePairs.length > 0) {
      const residualInvoiceIds = new Set(pass.unmatchedInvoices.map((i) => i.id));
      const residualPoIds = new Set(pass.unmatchedPos.map((p) => p.id));

      const user = JSON.stringify({
        unmatchedInvoices: pass.unmatchedInvoices.map((i) => ({
          id: i.id,
          vendor: i.vendorName,
          lineItem: i.lineItem,
          amount: dollars(i.amountCents),
          invoiceDate: i.invoiceDate,
        })),
        unmatchedPurchaseOrders: pass.unmatchedPos.map((p) => ({
          id: p.id,
          vendor: p.vendorName,
          lineItem: p.lineItem,
          amount: dollars(p.amountCents),
          issuedDate: p.issuedDate,
        })),
        candidatePairs: pass.candidatePairs.map((c) => ({
          invoiceId: c.invoiceId,
          poId: c.poId,
          amountDiff: dollars(c.amountDiffCents),
          amountWithinTolerance: c.amountWithinTolerance,
          vendorSimilarity: c.vendorJaccard.toFixed(2),
          lineItemSimilarity: c.lineItemJaccard.toFixed(2),
          note: c.reason,
        })),
      });

      const { data, reasoning: llmReasoning, meta } = await callWithValidation({
        llm: ctx.llm,
        system: AP_MATCH_SYSTEM,
        user,
        schema: apMatchAdjudicationSchema,
        validate: (d) => {
          const seenInv = new Set<string>();
          const seenPo = new Set<string>();
          for (const cm of d.confirmedMatches) {
            if (!residualInvoiceIds.has(cm.invoiceId)) {
              return `confirmed invoiceId "${cm.invoiceId}" is not one of the unmatched invoices`;
            }
            if (!residualPoIds.has(cm.poId)) {
              return `confirmed poId "${cm.poId}" is not one of the unmatched purchase orders`;
            }
            if (seenInv.has(cm.invoiceId)) {
              return `invoiceId "${cm.invoiceId}" was confirmed to more than one PO`;
            }
            if (seenPo.has(cm.poId)) {
              return `poId "${cm.poId}" was confirmed to more than one invoice`;
            }
            seenInv.add(cm.invoiceId);
            seenPo.add(cm.poId);
          }
          for (const rp of d.rejectedPairs) {
            if (!residualInvoiceIds.has(rp.invoiceId) || !residualPoIds.has(rp.poId)) {
              return `rejected pair references an unknown id (${rp.invoiceId}/${rp.poId})`;
            }
          }
          return null;
        },
      });

      for (const cm of data.confirmedMatches) {
        if (usedInv.has(cm.invoiceId) || usedPo.has(cm.poId)) continue;
        const inv = invById.get(cm.invoiceId);
        if (!inv) continue;
        usedInv.add(cm.invoiceId);
        usedPo.add(cm.poId);
        adjudicatedCount++;
        matchedPairs.push({
          invoiceId: cm.invoiceId,
          poId: cm.poId,
          amountCents: inv.amountCents,
          confidence: cm.confidence,
          matchReason: cm.matchReason,
        });
      }
      reasoning = llmReasoning;
      llmMeta = meta;
    } else {
      reasoning = `Deterministic matching resolved all matchable invoices; no ambiguous candidate pairs required adjudication. ${pass.matchedPairs.length} invoice(s) matched to POs.`;
    }

    const unmatchedInvoices = invoices.filter((i) => !usedInv.has(i.id));
    const unmatchedPos = pos.filter((p) => !usedPo.has(p.id));

    const output: ApMatchStepOutput = {
      matchedPairs,
      unmatchedInvoices,
      unmatchedPos,
      duplicateInvoices: pass.duplicateInvoices,
      stats: {
        deterministicMatches: pass.matchedPairs.length,
        adjudicatedMatches: adjudicatedCount,
        unmatchedInvoiceCount: unmatchedInvoices.length,
        unmatchedPoCount: unmatchedPos.length,
        duplicateInvoiceCount: pass.duplicateInvoices.length,
      },
    };

    return {
      output,
      reasoning,
      sources: [fileNote(ctx, "invoice"), fileNote(ctx, "po")],
      llmMeta,
    };
  },
};

/* -------------------------------------------------------------------------- */
/* Step 4 (main) — Flag invoices (LLM language over code-detected flags).       */
/* -------------------------------------------------------------------------- */

const AP_FLAG_SYSTEM = `You are an accounts-payable controller reviewing invoices for approval risk. You are given a set of concrete flag findings already detected in the data — each is an invoice paired with a flag category and the supporting facts. For every finding write one clear explanation sentence a reviewer can act on and one recommendation. Keep the exact category you are given for each finding; do not invent, drop, merge, or re-categorise findings. Reference only the invoice IDs provided. Categories: no_matching_po (an invoice with no purchase order — potential unauthorized spend), amount_variance (a matched invoice whose amount is more than 2% off its PO — possible billing error), duplicate_invoice (the same vendor and amount appears twice within 30 days — possible double payment), past_due (the due date has already passed).`;

interface FlagCandidate {
  invoiceId: string;
  category: ApFlagCategory;
  facts: Record<string, unknown>;
}

const flagInvoices: DagStepDefinition = {
  key: "flag_invoices",
  stepNumber: 4,
  dependsOn: ["match_invoices"],
  role: "classifier",
  track: "main",
  name: "Flag invoices",
  kind: "llm",
  async run(ctx: StepContext): Promise<StepResult> {
    const invoices = invoicesFrom(ctx);
    const pos = posFrom(ctx);
    const invById = new Map(invoices.map((i) => [i.id, i]));
    const poById = new Map(pos.map((p) => [p.id, p]));

    const match = ctx.priorOutputs["match_invoices"] as ApMatchStepOutput;

    // ---- Code-detected flag candidates (item + category are code-controlled). ----
    const today = new Date().toISOString().slice(0, 10);
    const candidates: FlagCandidate[] = [];

    // no_matching_po: every unmatched invoice.
    for (const inv of match.unmatchedInvoices) {
      candidates.push({
        invoiceId: inv.id,
        category: "no_matching_po",
        facts: {
          vendor: inv.vendorName,
          lineItem: inv.lineItem,
          amount: dollars(inv.amountCents),
        },
      });
    }

    // amount_variance: matched pairs whose amount is >2% off the PO.
    for (const m of match.matchedPairs) {
      const inv = invById.get(m.invoiceId);
      const po = poById.get(m.poId);
      if (!inv || !po) continue;
      if (!withinTolerance(inv.amountCents, po.amountCents, 0.02)) {
        const larger = Math.max(Math.abs(inv.amountCents), Math.abs(po.amountCents));
        const pct = larger === 0 ? 0 : (Math.abs(inv.amountCents - po.amountCents) / larger) * 100;
        candidates.push({
          invoiceId: inv.id,
          category: "amount_variance",
          facts: {
            vendor: inv.vendorName,
            invoiceAmount: dollars(inv.amountCents),
            poAmount: dollars(po.amountCents),
            variancePct: `${pct.toFixed(1)}%`,
          },
        });
      }
    }

    // duplicate_invoice: code-detected duplicate pairs.
    for (const dup of match.duplicateInvoices) {
      const inv = invById.get(dup.id);
      const original = invById.get(dup.duplicateOf);
      candidates.push({
        invoiceId: dup.id,
        category: "duplicate_invoice",
        facts: {
          vendor: inv?.vendorName,
          amount: inv ? dollars(inv.amountCents) : undefined,
          duplicateOf: dup.duplicateOf,
          originalInvoiceNumber: original?.invoiceNumber,
        },
      });
    }

    // past_due: due date already passed.
    for (const inv of invoices) {
      if (inv.dueDate && inv.dueDate < today) {
        candidates.push({
          invoiceId: inv.id,
          category: "past_due",
          facts: {
            vendor: inv.vendorName,
            amount: dollars(inv.amountCents),
            dueDate: inv.dueDate,
            asOf: today,
          },
        });
      }
    }

    const keyOf = (c: { invoiceId: string; category: ApFlagCategory }) =>
      `${c.invoiceId}|${c.category}`;

    let flags: ApFlagEntry[] = [];
    let reasoning: string;
    let llmMeta: StepResult["llmMeta"];

    if (candidates.length > 0) {
      const user = JSON.stringify({
        findings: candidates.map((c) => ({
          invoiceId: c.invoiceId,
          category: c.category,
          facts: c.facts,
        })),
      });

      const { data, reasoning: llmReasoning, meta } = await callWithValidation({
        llm: ctx.llm,
        system: AP_FLAG_SYSTEM,
        user,
        schema: apFlagsSchema,
        validate: (d) => {
          const got = new Set(d.flags.map(keyOf));
          const missing = candidates.filter((c) => !got.has(keyOf(c)));
          if (missing.length > 0) {
            const list = missing.map((m) => `${m.invoiceId} (${m.category})`).join(", ");
            return `these findings were not returned: ${list}`;
          }
          for (const f of d.flags) {
            if (!invById.has(f.invoiceId)) {
              return `flag references unknown invoiceId "${f.invoiceId}"`;
            }
          }
          return null;
        },
      });

      // Code controls item+category; take Claude's language for each candidate.
      const byKey = new Map(data.flags.map((f) => [keyOf(f), f]));
      flags = candidates.map((c) => {
        const f = byKey.get(keyOf(c));
        return {
          invoiceId: c.invoiceId,
          category: c.category,
          explanation: f?.explanation ?? "",
          recommendation: f?.recommendation ?? "",
        };
      });
      reasoning = llmReasoning;
      llmMeta = meta;
    } else {
      reasoning =
        "No exceptions detected: every invoice matched a purchase order within tolerance, with no duplicates or past-due dates.";
    }

    const wanted = new Set(candidates.map((c) => c.invoiceId));
    const output: ApFlagStepOutput = { flags };
    return {
      output,
      reasoning,
      sources: [
        {
          file: "invoices + POs",
          note: `${candidates.length} flag(s) across ${wanted.size} invoice(s)`,
        },
      ],
      llmMeta,
    };
  },
};

/* -------------------------------------------------------------------------- */
/* Step 5 (main) — Approval queue: the one money-moving step (Plan 3, D-A2).    */
/*                                                                             */
/* Deciding an invoice is payable IS the consequential act, so this step is     */
/* `risk: 'moves_money'` and gated: it proposes one `approve_invoice_payment`   */
/* action per payable invoice BEFORE it runs, and commits only what             */
/* `ctx.approvals` authorizes (D-A3/D-A5). Both halves derive their candidate    */
/* set from the same `splitApprovalQueue` helper, so the gate and the commit     */
/* can never disagree about which payments exist (D-A13).                       */
/* -------------------------------------------------------------------------- */

const AP_QUEUE_SYSTEM = `You are an accounts-payable manager summarising an approval queue for a finance reviewer. Given the counts and amounts for auto-approvable invoices (matched to a PO within tolerance, no flags) and the invoices held for review with their flags, write a concise 3-4 sentence narrative: state how many invoices and what total value can be auto-approved, summarise why the held invoices need attention, and highlight the highest-risk category. Professional and factual, no filler.`;

/** An invoice that passed every data check: matched to a PO, no flags → payable. */
export interface PayableInvoice {
  invoice: Invoice;
  poId: string;
}

export interface ApQueueSplit {
  /** Candidates for payment — each becomes one proposed action (D-A1). */
  payable: PayableInvoice[];
  /** Held for a DATA reason (unmatched or flagged); authorization is not involved. */
  held: HoldForReviewItem[];
  flagCategoryTally: Record<string, number>;
}

/**
 * The deterministic queue split (D-A13). Pure: same inputs → same output, no clock, no
 * model, so `proposeActions` and `run` always see the identical candidate set.
 */
export function splitApprovalQueue(
  invoices: Invoice[],
  match: ApMatchStepOutput,
  flagStep: ApFlagStepOutput,
): ApQueueSplit {
  const poByInvoice = new Map(match.matchedPairs.map((m) => [m.invoiceId, m.poId]));
  const flagsByInvoice = new Map<string, ApFlag[]>();
  for (const f of flagStep.flags) {
    const arr = flagsByInvoice.get(f.invoiceId) ?? [];
    arr.push({
      category: f.category,
      explanation: f.explanation,
      recommendation: f.recommendation,
    });
    flagsByInvoice.set(f.invoiceId, arr);
  }

  const payable: PayableInvoice[] = [];
  const held: HoldForReviewItem[] = [];
  for (const inv of invoices) {
    const poId = poByInvoice.get(inv.id) ?? null;
    const flags = flagsByInvoice.get(inv.id) ?? [];
    if (poId !== null && flags.length === 0) {
      payable.push({ invoice: inv, poId });
    } else {
      held.push({ invoice: inv, poId, flags });
    }
  }

  const flagCategoryTally: Record<string, number> = {};
  for (const f of flagStep.flags) {
    flagCategoryTally[f.category] = (flagCategoryTally[f.category] ?? 0) + 1;
  }

  return { payable, held, flagCategoryTally };
}

/** The action key for one payable invoice — deterministic + stable across resumes (D-A1). */
export function paymentActionKey(invoiceId: string): string {
  return `${APPROVE_INVOICE_PAYMENT}:${invoiceId}`;
}

/** One payable invoice → one proposed money-moving action, bound to its target (D-A3). */
function paymentAction(p: PayableInvoice): ProposedAction {
  const inv = p.invoice;
  return {
    actionKey: paymentActionKey(inv.id),
    actionType: APPROVE_INVOICE_PAYMENT,
    riskClass: "moves_money",
    target: {
      kind: "invoice",
      id: inv.id,
      counterparty: inv.vendorName,
      amountCents: inv.amountCents,
    },
    summary: `Approve payment of $${dollars(inv.amountCents)} to ${inv.vendorName} for invoice ${inv.invoiceNumber} (matched to ${p.poId})`,
    payload: {
      poId: p.poId,
      invoiceNumber: inv.invoiceNumber,
      lineItem: inv.lineItem,
      dueDate: inv.dueDate,
    },
  };
}

function queueInputs(ctx: StepContext): ApQueueSplit {
  const invoices = invoicesFrom(ctx);
  const match = ctx.priorOutputs["match_invoices"] as ApMatchStepOutput;
  const flagStep = ctx.priorOutputs["flag_invoices"] as ApFlagStepOutput;
  return splitApprovalQueue(invoices, match, flagStep);
}

const approvalQueue: DagStepDefinition = {
  key: "approval_queue",
  stepNumber: 5,
  dependsOn: ["flag_invoices"],
  role: "writer",
  track: "main",
  name: "Approval queue",
  kind: "llm",
  risk: "moves_money",
  async proposeActions(ctx: StepContext): Promise<ProposedAction[]> {
    return queueInputs(ctx).payable.map(paymentAction);
  },
  async run(ctx: StepContext): Promise<StepResult> {
    const { payable, held, flagCategoryTally } = queueInputs(ctx);

    const autoApprove: AutoApproveItem[] = [];
    const holdForReview: HoldForReviewItem[] = [...held];
    /** Payments the gate did NOT authorize — surfaced to the reviewer and the narrative. */
    const withheld: HoldForReviewItem[] = [];

    for (const p of payable) {
      // Fail closed (D-A3): a missing decision is not an authorization.
      const decision = ctx.approvals.get(paymentActionKey(p.invoice.id));
      if (decision?.authorized) {
        autoApprove.push({
          invoiceId: p.invoice.id,
          poId: p.poId,
          amountCents: p.invoice.amountCents,
          vendor: p.invoice.vendorName,
          recommendedAction: "approve",
          authorization: decision,
        });
      } else {
        withheld.push({
          invoice: p.invoice,
          poId: p.poId,
          flags: [],
          authorization: decision,
        });
      }
    }
    holdForReview.push(...withheld);

    const autoApproveAmountCents = autoApprove.reduce((s, a) => s + a.amountCents, 0);
    const holdAmountCents = holdForReview.reduce((s, h) => s + h.invoice.amountCents, 0);

    // The prompt is unchanged (D-A14); the payload gains `authorizationHolds` only when
    // an authorization decision actually withheld a payment.
    const userPayload: Record<string, unknown> = {
      autoApprove: {
        count: autoApprove.length,
        totalAmount: dollars(autoApproveAmountCents),
      },
      holdForReview: {
        count: holdForReview.length,
        totalAmount: dollars(holdAmountCents),
        byFlagCategory: flagCategoryTally,
        items: holdForReview.map((h) => ({
          vendor: h.invoice.vendorName,
          amount: dollars(h.invoice.amountCents),
          flags: h.flags.map((f) => f.category),
        })),
      },
    };
    if (withheld.length > 0) {
      userPayload.authorizationHolds = {
        count: withheld.length,
        totalAmount: dollars(withheld.reduce((s, w) => s + w.invoice.amountCents, 0)),
        items: withheld.map((w) => ({
          vendor: w.invoice.vendorName,
          amount: dollars(w.invoice.amountCents),
          reason: w.authorization?.reason ?? "not authorized",
        })),
      };
    }

    const { data: narr, reasoning, meta } = await ctx.llm({
      system: AP_QUEUE_SYSTEM,
      user: JSON.stringify(userPayload),
      schema: apQueueNarrativeSchema,
    });

    const output: ApApprovalQueue = {
      autoApprove,
      holdForReview,
      narrative: narr.narrative,
      stats: {
        autoApproveCount: autoApprove.length,
        holdCount: holdForReview.length,
        autoApproveAmountCents,
        holdAmountCents,
      },
    };

    const authNote =
      withheld.length > 0 ? `, ${withheld.length} withheld pending authorization` : "";
    return {
      output,
      reasoning,
      sources: [
        {
          file: "approval queue",
          note: `${autoApprove.length} authorized for payment, ${held.length} held on data flags${authNote}`,
        },
      ],
      llmMeta: meta,
    };
  },
};

/* -------------------------------------------------------------------------- */
/* Exported step list. Step 6 (human review) is a status gate — no row (§8).   */
/* -------------------------------------------------------------------------- */

export const apMatchingSteps: DagStepDefinition[] = [
  parsePos,
  parseInvoices,
  matchInvoicesToPos,
  flagInvoices,
  approvalQueue,
];
