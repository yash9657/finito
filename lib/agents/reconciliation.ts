/**
 * Reconciliation workflow steps (PLAN §7, the flagship). Exports the five executable
 * StepDefinitions (§7 steps 1–5); step 6 "Human review" is a gate represented by the
 * workflow status `awaiting_review` and is deliberately NOT a step row.
 *
 * Division of labour (D3): every number is computed in TypeScript from the matched
 * sets; Claude only adjudicates ambiguous candidate pairs, classifies why items are
 * unmatched, and writes the executive narrative. Every ID Claude returns is validated
 * against the real dataset — an unknown/reused ID triggers one retry with the error
 * appended, then the step errors. Money is integer cents throughout (D7).
 */

import {
  reconcile,
  nearestMiss,
  type ReconMatchPass,
  type NearestMiss,
} from "@/lib/agents/matching";
import { centsToDollars } from "@/lib/format";
import type { z } from "zod";
import {
  matchAdjudicationSchema,
  exceptionFlagsSchema,
  reportNarrativeSchema,
  type MatchAdjudication,
  type ExceptionFlags,
  type DagStepDefinition,
  type LlmFn,
  type LlmInvokeResult,
  type StepContext,
  type StepResult,
  type StepSource,
  type ParsedFile,
  type ErpTxn,
  type BankTxn,
  type MatchedPair,
  type ReconMatchResult,
  type ExceptionFlag,
  type ExceptionSource,
  type FlaggedErpTxn,
  type FlaggedBankTxn,
  type ReconReportSummary,
  type ReconStatus,
} from "@/lib/types";

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

/** Integer cents → a plain "1234.50" decimal string, for readable LLM payloads. */
function dollars(cents: number): string {
  return centsToDollars(cents).toFixed(2);
}

function sum(nums: number[]): number {
  return nums.reduce((acc, n) => acc + n, 0);
}

/**
 * Fetch a parsed file the runner staged in `ctx.files`, keyed by file_type. Throws
 * (runner marks the step `error`) when the file is absent or contained zero valid rows
 * (§6: `rows.length === 0` is the caller's cue to error).
 */
function requireParsedFile(ctx: StepContext, fileType: string): ParsedFile {
  const pf = ctx.files[fileType];
  if (!pf) throw new Error(`Required input file "${fileType}" was not provided`);
  if (pf.rows.length === 0) {
    throw new Error(`No valid rows parsed from "${fileType}" — cannot reconcile`);
  }
  return pf;
}

/** Read a prior step's output as a ParsedFile (parse steps output the ParsedFile). */
function priorParsedFile(ctx: StepContext, stepKey: string): ParsedFile {
  const out = ctx.priorOutputs[stepKey];
  if (!out || typeof out !== "object" || !("rows" in out)) {
    throw new Error(`Step "${stepKey}" output is missing or not a parsed file`);
  }
  return out as ParsedFile;
}

/**
 * Call the model via `ctx.llm`, then run an in-code post-validation over the returned
 * structured data. On a business-rule failure (e.g. an ID that does not exist, or is
 * reused), append the error to the user message and retry exactly once (D3); a second
 * failure throws. Returns the final `LlmInvokeResult` so the caller can pass through
 * `meta` as `llmMeta`.
 */
async function callWithPostValidation<T>(opts: {
  llm: LlmFn;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  validate: (data: T) => string | null;
}): Promise<LlmInvokeResult<T>> {
  const { llm, system, schema, validate } = opts;
  let user = opts.user;

  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await llm({ system, user, schema });
    const problem = validate(result.data);
    if (problem === null) return result;
    if (attempt === 1) {
      throw new Error(`Model output failed post-validation after retry: ${problem}`);
    }
    user = `${opts.user}\n\nYour previous response was invalid: ${problem}. Reference only IDs present in the data above, never reuse an ID, and return corrected JSON.`;
  }
  // Unreachable — the loop returns or throws on both attempts.
  throw new Error("callWithPostValidation exhausted retries without a result");
}

/* -------------------------------------------------------------------------- */
/* Steps 1 & 2 — Parse ERP export / bank statement (Tracks A/B, deterministic) */
/* -------------------------------------------------------------------------- */

function parseStep(
  key: string,
  stepNumber: number,
  track: "A" | "B",
  name: string,
  fileType: "erp_export" | "bank_statement",
): DagStepDefinition {
  return {
    key,
    stepNumber,
    dependsOn: [],
    role: "parser",
    track,
    name,
    kind: "deterministic",
    async run(ctx: StepContext): Promise<StepResult> {
      const pf = requireParsedFile(ctx, fileType);
      const { rowCount, skippedCount, filename, sha256 } = pf.meta;
      const label = filename || fileType;

      const reasoning =
        `Parsed ${rowCount} rows from ${label}. ` +
        `Normalized ${rowCount} dates and ${rowCount} amounts to integer cents. ` +
        `${skippedCount} row${skippedCount === 1 ? "" : "s"} skipped.`;

      const sources: StepSource[] = [
        {
          file: label,
          note: `sha256:${sha256} — ${rowCount} valid rows, ${skippedCount} skipped`,
        },
      ];

      return { output: pf, reasoning, sources };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Step 3 — Match transactions (Track main, hybrid deterministic + llm)        */
/* -------------------------------------------------------------------------- */

const MATCH_SYSTEM = `You are a professional accountant performing a bank reconciliation. You are given unmatched ERP transactions, unmatched bank transactions, and candidate pairs a deterministic matcher flagged as possibly related. Decide which candidate pairs are true matches. A true match is the same underlying economic transaction — allow for settlement delays (dates differing by more than 3 days) and small bank fees (amount differing by a fee-sized value). Never match two transactions that are clearly different payments that coincidentally share an amount. Only reference IDs that appear in the data provided.`;

function buildMatchUser(pass: ReconMatchPass, erp: ErpTxn[], bank: BankTxn[]): string {
  const erpById = new Map(erp.map((e) => [e.id, e]));
  const bankById = new Map(bank.map((b) => [b.id, b]));
  const payload = {
    unmatchedErp: pass.unmatchedErp.map((e) => ({
      id: e.id,
      date: e.date,
      description: e.description,
      amount: dollars(e.amountCents),
    })),
    unmatchedBank: pass.unmatchedBank.map((b) => ({
      id: b.id,
      date: b.date,
      description: b.description,
      amount: dollars(b.amountCents),
    })),
    candidatePairs: pass.candidatePairs.map((c) => ({
      erpId: c.erpId,
      bankId: c.bankId,
      erpAmount: dollars(erpById.get(c.erpId)?.amountCents ?? 0),
      bankAmount: dollars(bankById.get(c.bankId)?.amountCents ?? 0),
      amountDiff: dollars(c.amountDiffCents),
      daysDiff: c.daysDiff,
      descriptionSimilarity: Number(c.descriptionJaccard.toFixed(3)),
      note: c.reason,
    })),
  };
  return `Candidate pairs to adjudicate (amounts are decimal dollars):\n${JSON.stringify(payload, null, 2)}`;
}

function validateAdjudication(
  data: MatchAdjudication,
  pass: ReconMatchPass,
): string | null {
  const validErp = new Set(pass.unmatchedErp.map((e) => e.id));
  const validBank = new Set(pass.unmatchedBank.map((b) => b.id));
  const seenErp = new Set<string>();
  const seenBank = new Set<string>();
  const problems: string[] = [];

  for (const m of data.confirmedMatches) {
    if (!validErp.has(m.erpId)) {
      problems.push(`erpId "${m.erpId}" is not an unmatched ERP transaction`);
    }
    if (!validBank.has(m.bankId)) {
      problems.push(`bankId "${m.bankId}" is not an unmatched bank transaction`);
    }
    if (seenErp.has(m.erpId)) problems.push(`erpId "${m.erpId}" used in more than one match`);
    if (seenBank.has(m.bankId)) problems.push(`bankId "${m.bankId}" used in more than one match`);
    seenErp.add(m.erpId);
    seenBank.add(m.bankId);
  }
  return problems.length > 0 ? problems.join("; ") : null;
}

const matchStep: DagStepDefinition = {
  key: "match",
  stepNumber: 3,
  dependsOn: ["parse_erp", "parse_bank"],
  role: "matcher",
  track: "main",
  name: "Match transactions",
  kind: "llm",
  async run(ctx: StepContext): Promise<StepResult> {
    const erpFile = priorParsedFile(ctx, "parse_erp");
    const bankFile = priorParsedFile(ctx, "parse_bank");
    const erp = erpFile.rows as unknown as ErpTxn[];
    const bank = bankFile.rows as unknown as BankTxn[];
    const erpById = new Map(erp.map((e) => [e.id, e]));

    // Deterministic first pass (pure, auditable): exact matches + duplicates + candidates.
    const pass = reconcile(erp, bank);

    let confirmed: MatchAdjudication["confirmedMatches"] = [];
    let reasoning: string;
    let llmMeta: StepResult["llmMeta"];

    if (pass.candidatePairs.length === 0) {
      reasoning =
        `Deterministic pass matched ${pass.matchedPairs.length} pair(s) exactly and ` +
        `found no ambiguous candidate pairs, so no LLM adjudication was required. ` +
        `${pass.duplicates.length} duplicate bank row(s) excluded.`;
    } else {
      const result = await callWithPostValidation<MatchAdjudication>({
        llm: ctx.llm,
        system: MATCH_SYSTEM,
        user: buildMatchUser(pass, erp, bank),
        schema: matchAdjudicationSchema,
        validate: (d) => validateAdjudication(d, pass),
      });
      confirmed = result.data.confirmedMatches;
      reasoning = result.reasoning;
      llmMeta = result.meta;
    }

    // Merge confirmed matches with the exact deterministic ones; recompute everything.
    const confirmedErpIds = new Set(confirmed.map((c) => c.erpId));
    const confirmedBankIds = new Set(confirmed.map((c) => c.bankId));

    const adjudicatedPairs: MatchedPair[] = confirmed.map((c) => ({
      erpId: c.erpId,
      bankId: c.bankId,
      amountCents: erpById.get(c.erpId)?.amountCents ?? 0,
      confidence: c.confidence,
      matchReason: c.matchReason,
    }));

    const matchedPairs: MatchedPair[] = [...pass.matchedPairs, ...adjudicatedPairs];
    const unmatchedErp = pass.unmatchedErp.filter((e) => !confirmedErpIds.has(e.id));
    const unmatchedBank = pass.unmatchedBank.filter((b) => !confirmedBankIds.has(b.id));
    const duplicates = pass.duplicates;

    const output: ReconMatchResult = {
      matchedPairs,
      unmatchedErp,
      unmatchedBank,
      duplicates,
      stats: {
        exactMatches: pass.matchedPairs.length,
        adjudicatedMatches: adjudicatedPairs.length,
        unmatchedErpCount: unmatchedErp.length,
        unmatchedBankCount: unmatchedBank.length,
        duplicateCount: duplicates.length,
      },
    };

    const sources: StepSource[] = [
      { file: erpFile.meta.filename || "erp_export", note: `sha256:${erpFile.meta.sha256}` },
      { file: bankFile.meta.filename || "bank_statement", note: `sha256:${bankFile.meta.sha256}` },
    ];

    return { output, reasoning, sources, llmMeta };
  },
};

/* -------------------------------------------------------------------------- */
/* Step 4 — Flag exceptions (Track main, llm)                                  */
/* -------------------------------------------------------------------------- */

const FLAG_SYSTEM = `You are a professional accountant classifying reconciliation exceptions. For every unmatched item, choose the most likely reason and write one clear sentence a reviewer can act on. Categories: \`timing_difference\` (a near-identical counterpart exists but dates differ by more than 3 days), \`amount_mismatch\` (same counterparty and date but a different amount — often a bank fee), \`missing_from_erp\` (in the bank statement only — possibly an unrecorded transaction), \`missing_from_bank\` (in the ERP only — possibly an uncleared payment), \`duplicate\` (the same transaction appears twice in one source). Classify every item you are given; reference only provided IDs.`;

function missView(m: NearestMiss | null): unknown {
  if (m === null) return null;
  return {
    id: m.id,
    amountDiff: dollars(m.amountDiffCents),
    daysDiff: m.daysDiff,
    descriptionSimilarity: Number(m.descriptionJaccard.toFixed(3)),
  };
}

function buildFlagUser(match: ReconMatchResult): string {
  const payload = {
    unmatchedErp: match.unmatchedErp.map((e) => ({
      id: e.id,
      date: e.date,
      description: e.description,
      amount: dollars(e.amountCents),
      nearestBank: missView(nearestMiss(e, match.unmatchedBank)),
    })),
    unmatchedBank: match.unmatchedBank.map((b) => ({
      id: b.id,
      date: b.date,
      description: b.description,
      amount: dollars(b.amountCents),
      nearestErp: missView(nearestMiss(b, match.unmatchedErp)),
    })),
    duplicates: match.duplicates.map((d) => ({
      id: d.id,
      duplicateOf: d.duplicateOf,
      date: d.date,
      description: d.description,
      amount: dollars(d.amountCents),
    })),
  };
  return `Unmatched items to classify (each with its nearest-miss counterpart; amounts are decimal dollars):\n${JSON.stringify(payload, null, 2)}`;
}

/** Key an exception flag by its source + id, so lookups are unambiguous. */
function flagKey(source: ExceptionSource, id: string): string {
  return `${source}:${id}`;
}

/**
 * Verify every unmatched item received exactly one flag (§7 step 4). Returns an error
 * message naming omissions/duplications for the retry, or null when complete.
 */
function validateFlags(data: ExceptionFlags, match: ReconMatchResult): string | null {
  const required = new Map<string, string>(); // key -> human label
  for (const e of match.unmatchedErp) required.set(flagKey("erp", e.id), `ERP item ${e.id}`);
  for (const b of match.unmatchedBank) required.set(flagKey("bank", b.id), `bank item ${b.id}`);

  const counts = new Map<string, number>();
  for (const f of data.flags) {
    const key = flagKey(f.source, f.id);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const missing: string[] = [];
  const duplicated: string[] = [];
  for (const [key, label] of required) {
    const c = counts.get(key) ?? 0;
    if (c === 0) missing.push(label);
    else if (c > 1) duplicated.push(label);
  }

  const problems: string[] = [];
  if (missing.length > 0) problems.push(`did not flag: ${missing.join(", ")}`);
  if (duplicated.length > 0) problems.push(`flagged more than once: ${duplicated.join(", ")}`);
  return problems.length > 0 ? `You ${problems.join("; and you ")}` : null;
}

const flagStep: DagStepDefinition = {
  key: "flag",
  stepNumber: 4,
  dependsOn: ["match"],
  role: "classifier",
  track: "main",
  name: "Flag exceptions",
  kind: "llm",
  async run(ctx: StepContext): Promise<StepResult> {
    const match = ctx.priorOutputs["match"] as ReconMatchResult | undefined;
    if (!match) throw new Error('Step "match" output is missing');

    // Nothing unmatched → nothing to flag; skip the LLM call entirely.
    if (match.unmatchedErp.length === 0 && match.unmatchedBank.length === 0) {
      return {
        output: { flags: [] as ExceptionFlags["flags"] },
        reasoning:
          "No unmatched ERP or bank items remained after matching, so there were no exceptions to classify.",
        sources: [],
      };
    }

    const { data, reasoning, meta } = await callWithPostValidation<ExceptionFlags>({
      llm: ctx.llm,
      system: FLAG_SYSTEM,
      user: buildFlagUser(match),
      schema: exceptionFlagsSchema,
      validate: (d) => validateFlags(d, match),
    });

    return {
      output: { flags: data.flags },
      reasoning,
      sources: [],
      llmMeta: meta,
    };
  },
};

/* -------------------------------------------------------------------------- */
/* Step 5 — Generate reconciliation report (deterministic totals + llm summary)*/
/* -------------------------------------------------------------------------- */

const NARRATIVE_SYSTEM = `You are a professional accountant writing the executive summary at the top of a completed bank reconciliation report. You are given the fully computed reconciliation totals and exceptions. Write a concise 3–4 sentence narrative for a finance reviewer: state whether the reconciliation is clean or has exceptions, the net difference, and the most important exceptions to look at. Use the numbers exactly as given; do not invent figures.`;

function lookupFlag(
  flags: ExceptionFlags["flags"],
  source: ExceptionSource,
  id: string,
): ExceptionFlag {
  const found = flags.find((f) => f.source === source && f.id === id);
  if (found) {
    return {
      source: found.source,
      category: found.category,
      explanation: found.explanation,
      recommendation: found.recommendation,
    };
  }
  // Defensive fallback — step 4 guarantees a flag, but never emit an unflagged item.
  return {
    source,
    category: source === "erp" ? "missing_from_bank" : "missing_from_erp",
    explanation: "Unmatched item; no classification was produced.",
    recommendation: "Review manually.",
  };
}

const reportStep: DagStepDefinition = {
  key: "report",
  stepNumber: 5,
  dependsOn: ["flag"],
  role: "writer",
  track: "main",
  name: "Generate reconciliation report",
  kind: "llm",
  async run(ctx: StepContext): Promise<StepResult> {
    const erpFile = priorParsedFile(ctx, "parse_erp");
    const bankFile = priorParsedFile(ctx, "parse_bank");
    const erp = erpFile.rows as unknown as ErpTxn[];
    const bank = bankFile.rows as unknown as BankTxn[];

    const match = ctx.priorOutputs["match"] as ReconMatchResult | undefined;
    if (!match) throw new Error('Step "match" output is missing');
    const flagOut = ctx.priorOutputs["flag"] as { flags: ExceptionFlags["flags"] } | undefined;
    const flags = flagOut?.flags ?? [];

    // --- All totals computed in code (D3); Claude never supplies a number. ---
    const erpAmountCents = sum(erp.map((e) => e.amountCents));
    const bankAmountCents = sum(bank.map((b) => b.amountCents));
    const duplicatesTotalCents = sum(match.duplicates.map((d) => d.amountCents));
    const bankExcludingDuplicatesCents = bankAmountCents - duplicatesTotalCents;

    const matchedAmountCents = sum(match.matchedPairs.map((p) => p.amountCents));
    const netDifferenceCents = erpAmountCents - bankExcludingDuplicatesCents;

    const unmatchedErp: FlaggedErpTxn[] = match.unmatchedErp.map((e) => ({
      ...e,
      flag: lookupFlag(flags, "erp", e.id),
    }));
    const unmatchedBank: FlaggedBankTxn[] = match.unmatchedBank.map((b) => ({
      ...b,
      flag: lookupFlag(flags, "bank", b.id),
    }));

    const status: ReconStatus =
      unmatchedErp.length === 0 &&
      unmatchedBank.length === 0 &&
      match.duplicates.length === 0
        ? "CLEAN"
        : "EXCEPTIONS_FOUND";

    // --- Claude writes only the narrative, fed the computed summary. ---
    const narrativeInput = {
      status,
      totals: {
        erpCount: erp.length,
        erpAmount: dollars(erpAmountCents),
        bankCount: bank.length,
        bankAmount: dollars(bankAmountCents),
      },
      matched: { count: match.matchedPairs.length, amount: dollars(matchedAmountCents) },
      netDifference: dollars(netDifferenceCents),
      unmatchedErpCount: unmatchedErp.length,
      unmatchedBankCount: unmatchedBank.length,
      duplicateCount: match.duplicates.length,
      exceptions: [
        ...unmatchedErp.map((e) => ({
          id: e.id,
          source: "erp",
          category: e.flag.category,
          amount: dollars(e.amountCents),
          explanation: e.flag.explanation,
        })),
        ...unmatchedBank.map((b) => ({
          id: b.id,
          source: "bank",
          category: b.flag.category,
          amount: dollars(b.amountCents),
          explanation: b.flag.explanation,
        })),
      ],
    };

    const { data, reasoning, meta } = await ctx.llm({
      system: NARRATIVE_SYSTEM,
      user: `Computed reconciliation summary (amounts are decimal dollars):\n${JSON.stringify(narrativeInput, null, 2)}`,
      schema: reportNarrativeSchema,
    });

    const summary: ReconReportSummary = {
      totals: {
        erpCount: erp.length,
        erpAmountCents,
        bankCount: bank.length,
        bankAmountCents,
      },
      matched: { count: match.matchedPairs.length, amountCents: matchedAmountCents },
      matchedPairs: match.matchedPairs,
      unmatchedErp,
      unmatchedBank,
      duplicates: match.duplicates,
      netDifferenceCents,
      status,
      narrative: data.narrative,
    };

    const sources: StepSource[] = [
      { file: erpFile.meta.filename || "erp_export", note: `sha256:${erpFile.meta.sha256}` },
      { file: bankFile.meta.filename || "bank_statement", note: `sha256:${bankFile.meta.sha256}` },
    ];

    return { output: summary, reasoning, sources, llmMeta: meta };
  },
};

/* -------------------------------------------------------------------------- */
/* Exported step list (§7 steps 1–5; step 6 is a status gate, not a row).      */
/* -------------------------------------------------------------------------- */

export const reconciliationSteps: DagStepDefinition[] = [
  parseStep("parse_erp", 1, "A", "Parse ERP export", "erp_export"),
  parseStep("parse_bank", 2, "B", "Parse bank statement", "bank_statement"),
  matchStep,
  flagStep,
  reportStep,
];
