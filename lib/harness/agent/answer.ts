/**
 * Answer validation and figure recomputation (Plan 5, D-G14) — the third clause of D-G1.
 *
 *     Numbers in the answer are recomputed in code and cited to source rows. The agent writes
 *     the prose around them; it does not supply the figures.
 *
 * Most systems that claim this enforce it with a prompt. Here it is a validator, and the
 * mechanism is a placeholder substitution:
 *
 *   1. The model writes prose containing `{{ref}}` tokens instead of monetary amounts, and
 *      declares each figure as `{ref, operation, sourceIds}` — a label and a set of rows, never
 *      a value.
 *   2. Code resolves the source ids against real data, computes each figure, and substitutes it.
 *   3. Any monetary literal left in the prose that did not come from a substitution is a
 *      validation failure.
 *
 * Step 3 is what makes the rule enforceable rather than aspirational. Without it the model could
 * simply write "$42,000" and no amount of citation checking would notice. With it, a figure in a
 * FinFlow answer either came out of `sumOf`/`countOf` over cited rows, or the answer was
 * rejected.
 *
 * One corrective retry, then fail — the same shape as `callWithPostValidation` in
 * `lib/agents/reconciliation.ts`, because it is the same problem: a model that cannot cite
 * correctly after being told exactly what was wrong will not get there on the third attempt
 * either, and each attempt costs a full generation.
 */

import { z } from "zod";
import { resolveSourceIds, type LedgerRow } from "@/lib/harness/agent/datasets";
import type { AnswerFigure, InvestigationAnswer } from "@/lib/types";
import type { DataSource, DataRow } from "@/lib/data/types";
import { aggregateExactDecimals } from "@/lib/harness/agent/sandbox/exact-decimal";

/**
 * What the model returns for a final answer.
 *
 * Flat and small on purpose (PLAN.md §5.3): objects, arrays, strings and enums only, so it
 * converts cleanly to every provider's schema dialect.
 */
export const answerSchema = z.object({
  prose: z
    .string()
    .describe(
      "The answer. Use {{ref}} placeholders for EVERY monetary amount — never write a currency " +
        "figure directly.",
    ),
  findings: z.array(
    z.object({
      statement: z.string(),
      sourceIds: z.array(z.string()),
    }),
  ),
  figures: z.array(
    z.object({
      ref: z.string(),
      label: z.string(),
      operation: z.enum(["sum", "count", "difference", "average"]),
      sourceIds: z.array(z.string()),
      column: z.string().max(500).optional().describe("For src: general-source figures only, the exact numeric column name. Do not set this for wf: ledger figures. Values are rendered in source units; no currency is inferred."),
    }),
  ),
  citations: z.array(
    z.object({
      sourceId: z.string(),
      note: z.string(),
    }),
  ),
});
export type RawAnswer = z.infer<typeof answerSchema>;

export type AnswerValidation =
  | { ok: true; answer: InvestigationAnswer }
  | { ok: false; problems: string[] };

/**
 * Currency-looking literals in the prose.
 *
 * Matches `$1,234.56`, `1234 dollars`, `USD 1234`. Deliberately does NOT match a bare integer:
 * "3 transactions" and "2026" are legitimate prose, and rejecting them would make the rule
 * unusable and push the model toward writing amounts in words to evade it. Currency markers are
 * the reliable signal that a number is a figure.
 */
const CURRENCY_LITERAL = /(?:\p{Sc}\s?[-+]?\s?[\d,]+(?:\.\d+)?)|(?:\b[\d,]+(?:\.\d+)?\s?(?:dollars|euros|pounds|yen|rupees|USD|EUR|GBP|JPY|CAD|AUD|CHF|INR|CNY|RMB|HKD|SGD|NZD)\b)|(?:\b(?:USD|EUR|GBP|JPY|CAD|AUD|CHF|INR|CNY|RMB|HKD|SGD|NZD)\s?[-+]?\s?[\d,]+(?:\.\d+)?)/giu;

const PLACEHOLDER = /\{\{([A-Za-z0-9_]+)\}\}/g;

/**
 * Validate a model answer and produce the final, code-computed one.
 *
 * Returns every problem at once rather than the first: a model told about one error at a time
 * takes a turn per error, and the corrective retry budget is one.
 */
export function validateAnswer(
  raw: RawAnswer,
  rows: LedgerRow[],
  opts: { partial: boolean; dataSources?: DataSource[] },
): AnswerValidation {
  const problems: string[] = [];
  const genericRows = new Map<string, { row: DataRow; basis: string; header?: boolean }>();
  for (const source of opts.dataSources ?? []) {
    for (const table of source.tables) {
      for (const row of [...table.preamble, ...table.rows]) genericRows.set(row.sourceId, { row, basis: `${source.id}/${table.id}` });
      if (table.header) genericRows.set(table.header.sourceId, { row: table.header, basis: `${source.id}/${table.id}`, header: true });
    }
  }

  /* ---- 1. Every cited source id must resolve to a real row --------------- */
  const allCited = [
    ...raw.citations.map((c) => c.sourceId),
    ...raw.findings.flatMap((f) => f.sourceIds),
    ...raw.figures.flatMap((f) => f.sourceIds),
  ];
  const { unresolved } = resolveSourceIds(rows, allCited.filter((id) => !genericRows.has(id)));
  if (unresolved.length > 0) {
    const shown = [...new Set(unresolved)].slice(0, 10);
    problems.push(
      `These source ids do not exist in the data: ${shown.join(", ")}` +
        `${unresolved.length > shown.length ? ` (and ${unresolved.length - shown.length} more)` : ""}. ` +
        `Cite only ids exactly as a tool returned them.`,
    );
  }

  /* ---- 2. Every figure must be computable, and every placeholder declared - */
  const byRef = new Map(raw.figures.map((f) => [f.ref, f]));
  if (byRef.size !== raw.figures.length) problems.push("Each figure ref must be unique.");
  const narrativeFields = [raw.prose, ...raw.findings.map(f => f.statement), ...raw.citations.map(c => c.note), ...raw.figures.map(f => f.label)];
  const usedRefs = narrativeFields.flatMap(text => [...text.matchAll(PLACEHOLDER)].map((m) => m[1]));
  if (narrativeFields.some(text => /\{\{|\}\}/.test(text.replace(PLACEHOLDER, "")))) problems.push("A placeholder is malformed. Use a short ref like {{total}}, never a source ID or column expression inside braces, and declare that ref in figures.");
  for (const finding of raw.findings) {
    if (finding.sourceIds.length === 0) problems.push("Every finding must cite at least one source row.");
  }

  for (const ref of new Set(usedRefs)) {
    if (!byRef.has(ref)) {
      problems.push(
        `The prose uses {{${ref}}} but no figure declares ref "${ref}". Every placeholder needs ` +
          `a figure entry naming the source rows it is computed from.`,
      );
    }
  }
  for (const figure of raw.figures) {
    if (!/^[A-Za-z0-9_]{1,64}$/.test(figure.ref)) problems.push(`Figure ref must contain only 1–64 letters, digits or underscores: ${figure.ref}.`);
    if (new Set(figure.sourceIds).size !== figure.sourceIds.length) {
      problems.push(`Figure "${figure.ref}" repeats a source row; count each source only once.`);
    }
    if (figure.operation === "difference" && figure.sourceIds.length !== 2) {
      problems.push(`Figure "${figure.ref}" must cite exactly two rows for a difference.`);
    }
    if (figure.sourceIds.length === 0) {
      problems.push(
        `Figure "${figure.ref}" cites no source rows, so it cannot be computed. Every figure ` +
          `must name the rows it comes from.`,
      );
    }
    if (!usedRefs.includes(figure.ref)) {
      // Not fatal — a declared-but-unused figure is clutter, not a correctness problem — so it
      // is left alone rather than spent from the one corrective retry.
      continue;
    }
  }

  /* ---- 3. Compute every figure IN CODE ----------------------------------- */
  const computed: AnswerFigure[] = [];
  for (const figure of raw.figures) {
    const general = figure.sourceIds.map((id) => genericRows.get(id));
    if (general.some(Boolean)) {
      if (!general.every(Boolean)) {
        problems.push(`Figure "${figure.ref}" mixes general source rows with ledger or unknown rows. Keep source bases separate.`);
        continue;
      }
      const resolved = general as { row: DataRow; basis: string; header?: boolean }[];
      if (resolved.some((item) => item.header)) {
        problems.push(`Figure "${figure.ref}" includes a header row. Headers can evidence column interpretation but cannot count or aggregate as data records.`);
        continue;
      }
      if (new Set(resolved.map((entry) => entry.basis)).size !== 1) {
        problems.push(`Figure "${figure.ref}" combines different source tables. Their currency, scale and entity basis have not been verified; use a labeled analysis artifact for cross-table calculations.`);
        continue;
      }
      const base = { ref: figure.ref, label: figure.label, operation: figure.operation, sourceIds: figure.sourceIds };
      if (figure.operation === "count") {
        computed.push({ ...base, value: resolved.length });
        continue;
      }
      if (!figure.column || resolved.some(({ row }) => !Object.hasOwn(row.values, figure.column!))) {
        problems.push(`Figure "${figure.ref}" needs an exact numeric column present in every cited general source row. Inspect the table and set column; units and currencies are not inferred.`);
        continue;
      }
      try {
        computed.push({ ...base, column: figure.column, decimalValue: aggregateExactDecimals(resolved.map(({ row }) => row.values[figure.column!]), figure.operation) });
      } catch (error) {
        problems.push(`Figure "${figure.ref}": ${error instanceof Error ? error.message : "Source values cannot be computed exactly"}.`);
      }
      continue;
    }
    if (figure.column !== undefined) {
      problems.push(`Figure "${figure.ref}" sets column on ledger rows. Ledger figures use validated amountCents; omit column.`);
      continue;
    }
    const { resolved, unresolved: missing } = resolveSourceIds(rows, figure.sourceIds);
    if (missing.length > 0) continue; // already reported in step 1
    if (resolved.length === 0) continue;
    if ((figure.operation === "sum" || figure.operation === "average") && new Set(resolved.map(row => `${row.workflowId}/${row.dataset}`)).size !== 1) {
      problems.push(`Figure "${figure.ref}" combines financial sources. Sum or average rows from one workflow and dataset only; do not consolidate different bases or overlapping uploads.`);
      continue;
    }
    if (resolved.some(row => !Number.isSafeInteger(row.amountCents))) {
      problems.push(`Figure "${figure.ref}" contains amounts outside exact integer-cent arithmetic limits.`);
      continue;
    }
    const result = computeFigure(figure, resolved);
    if (result.valueCents !== undefined && !Number.isSafeInteger(result.valueCents)) {
      problems.push(`Figure "${figure.ref}" exceeds exact integer-cent arithmetic limits.`);
      continue;
    }
    computed.push(result);
  }

  /* ---- 4. No bare currency literal may survive --------------------------- */
  // Checked BEFORE substitution: afterwards every figure is a literal by construction, so the
  // only moment the distinction exists is now.
  const narrative = [raw.prose, ...raw.findings.map(finding => finding.statement), ...raw.citations.map(citation => citation.note), ...raw.figures.map(figure => figure.label)].join("\n");
  const literals = [...narrative.matchAll(CURRENCY_LITERAL)].map((m) => m[0].trim());
  if (literals.length > 0) {
    const shown = [...new Set(literals)].slice(0, 5);
    problems.push(
      `The answer contains monetary amounts written directly: ${shown.join(", ")}. Every ` +
        `monetary figure must be a {{ref}} placeholder backed by a figure entry, so it can be ` +
        `recomputed from the source rows rather than taken from your text.`,
    );
  }

  if (problems.length > 0) return { ok: false, problems };

  /* ---- 5. Substitute, and produce the final answer ----------------------- */
  const computedByRef = new Map(computed.map((f) => [f.ref, f]));
  const substitute = (text: string) => text.replace(PLACEHOLDER, (match, ref: string) => {
    const figure = computedByRef.get(ref);
    if (!figure) return match; // unreachable: step 2 rejected undeclared refs
    return renderFigure(figure);
  });

  return {
    ok: true,
    answer: {
      prose: substitute(raw.prose),
      proseTemplate: raw.prose,
      findings: raw.findings.map(finding => ({ ...finding, statement: substitute(finding.statement) })),
      figures: computed.map(figure => ({ ...figure, label: substitute(figure.label) })),
      citations: raw.citations.map(citation => ({ ...citation, note: substitute(citation.note) })),
      partial: opts.partial,
    },
  };
}

/**
 * Compute one figure from its cited rows. The only place an answer's numbers come from.
 *
 * `difference` is the earliest row minus the latest by date — the "what changed" shape — and
 * falls back to first-minus-last in citation order when the rows are undated (budget/actuals),
 * because a period comparison there is expressed by which rows are cited, not by their dates.
 */
function computeFigure(
  figure: RawAnswer["figures"][number],
  rows: LedgerRow[],
): AnswerFigure {
  const base = {
    ref: figure.ref,
    label: figure.label,
    operation: figure.operation,
    sourceIds: figure.sourceIds,
  };

  switch (figure.operation) {
    case "count":
      return { ...base, value: rows.length };

    case "sum":
      return { ...base, valueCents: Number(rows.reduce((sum, row) => sum + BigInt(row.amountCents), BigInt(0))) };

    case "average": {
      const total = rows.reduce((sum, row) => sum + BigInt(row.amountCents), BigInt(0));
      const count = BigInt(rows.length);
      const quotient = total / count;
      const remainder = total % count;
      // Match Math.round's half-towards-positive-infinity rule without a lossy float division.
      const rounded = remainder * BigInt(2) >= count ? quotient + BigInt(1)
        : -remainder * BigInt(2) > count ? quotient - BigInt(1) : quotient;
      return { ...base, valueCents: Number(rounded) };
    }

    case "difference": {
      if (rows.length < 2) {
        return { ...base, valueCents: rows[0]?.amountCents ?? 0 };
      }
      const dated = rows.every((r) => r.date !== null);
      const ordered = dated
        ? [...rows].sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""))
        : rows;
      const first = ordered[0].amountCents;
      const last = ordered[ordered.length - 1].amountCents;
      return { ...base, valueCents: Number(BigInt(last) - BigInt(first)) };
    }
  }
}

/** How a computed figure appears in the prose. Display only — the value is already fixed. */
function renderFigure(figure: AnswerFigure): string {
  if (figure.operation === "count") return String(figure.value ?? 0);
  if (figure.decimalValue !== undefined) return `${figure.decimalValue} (source units)`;
  const cents = figure.valueCents ?? 0;
  const sign = cents < 0 ? "-" : "";
  const abs = BigInt(Math.abs(cents));
  const whole = (abs / BigInt(100)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = (abs % BigInt(100)).toString().padStart(2, "0");
  return `${sign}$${whole}.${fraction}`;
}

/** The corrective message sent back to the model after a failed validation. */
export function correctionMessage(problems: string[]): string {
  return (
    `Your answer was rejected by validation:\n\n${problems.map((p) => `  - ${p}`).join("\n")}\n\n` +
    `Produce a corrected answer. Remember: write every monetary amount as a {{ref}} placeholder ` +
    `and declare it in "figures" with the exact source ids it is computed from. Do not write any ` +
    `currency amount directly — the numbers are computed from the cited rows, not from your text.`
  );
}
