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
const CURRENCY_LITERAL = /(\$\s?[\d,]+(?:\.\d+)?)|(\b[\d,]+(?:\.\d+)?\s?(?:dollars|USD)\b)|(\bUSD\s?[\d,]+(?:\.\d+)?)/gi;

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
  opts: { partial: boolean },
): AnswerValidation {
  const problems: string[] = [];

  /* ---- 1. Every cited source id must resolve to a real row --------------- */
  const allCited = [
    ...raw.citations.map((c) => c.sourceId),
    ...raw.findings.flatMap((f) => f.sourceIds),
    ...raw.figures.flatMap((f) => f.sourceIds),
  ];
  const { unresolved } = resolveSourceIds(rows, allCited);
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
  const usedRefs = [...raw.prose.matchAll(PLACEHOLDER)].map((m) => m[1]);

  for (const ref of new Set(usedRefs)) {
    if (!byRef.has(ref)) {
      problems.push(
        `The prose uses {{${ref}}} but no figure declares ref "${ref}". Every placeholder needs ` +
          `a figure entry naming the source rows it is computed from.`,
      );
    }
  }
  for (const figure of raw.figures) {
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
    const { resolved, unresolved: missing } = resolveSourceIds(rows, figure.sourceIds);
    if (missing.length > 0) continue; // already reported in step 1
    if (resolved.length === 0) continue;
    computed.push(computeFigure(figure, resolved));
  }

  /* ---- 4. No bare currency literal may survive --------------------------- */
  // Checked BEFORE substitution: afterwards every figure is a literal by construction, so the
  // only moment the distinction exists is now.
  const literals = [...raw.prose.matchAll(CURRENCY_LITERAL)].map((m) => m[0].trim());
  if (literals.length > 0) {
    const shown = [...new Set(literals)].slice(0, 5);
    problems.push(
      `The prose contains monetary amounts written directly: ${shown.join(", ")}. Every ` +
        `monetary figure must be a {{ref}} placeholder backed by a figure entry, so it can be ` +
        `recomputed from the source rows rather than taken from your text.`,
    );
  }

  if (problems.length > 0) return { ok: false, problems };

  /* ---- 5. Substitute, and produce the final answer ----------------------- */
  const computedByRef = new Map(computed.map((f) => [f.ref, f]));
  const prose = raw.prose.replace(PLACEHOLDER, (match, ref: string) => {
    const figure = computedByRef.get(ref);
    if (!figure) return match; // unreachable: step 2 rejected undeclared refs
    return renderFigure(figure);
  });

  return {
    ok: true,
    answer: {
      prose,
      proseTemplate: raw.prose,
      findings: raw.findings,
      figures: computed,
      citations: raw.citations,
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
      return { ...base, valueCents: rows.reduce((s, r) => s + r.amountCents, 0) };

    case "average": {
      const total = rows.reduce((s, r) => s + r.amountCents, 0);
      // Integer cents, rounded once — a float mean would reintroduce the drift D7 exists to stop.
      return { ...base, valueCents: Math.round(total / rows.length) };
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
      return { ...base, valueCents: last - first };
    }
  }
}

/** How a computed figure appears in the prose. Display only — the value is already fixed. */
function renderFigure(figure: AnswerFigure): string {
  if (figure.operation === "count") return String(figure.value ?? 0);
  const cents = figure.valueCents ?? 0;
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${(abs / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
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
