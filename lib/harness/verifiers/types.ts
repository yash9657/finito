/**
 * The verification contract (Plan 4 §1 step 2 + §4, D-H9/D-H10).
 *
 * Verification answers "is this action well-formed and legal?" — deterministic code, never
 * an LLM. It is a DIFFERENT question from authorization ("who may allow it?"), which
 * `lib/approvals/engine.ts` answers, and it runs FIRST. A malformed action is rejected
 * before any human is asked about it, because reviewers who are shown machine-rejectable
 * garbage learn to click through.
 */

import type { ParsedFile, ProposedAction, RiskClass } from "@/lib/types";

/**
 * `riskLevel` is the verifier's own assessment of the act, independent of the org's
 * configuration and of the agent's confidence.
 *
 * `'high'` is a HARDCODED SAFETY FLOOR (D-H10): it forces a human review request even if
 * the org has configured this workflow type for auto-approval, even if a standing rule
 * would otherwise cover the action, and even if the proposing agent reported high
 * confidence. This is intentionally NOT org-configurable — there is no setting, no env
 * var, and no function parameter that disables it. If a future requirement wants an
 * escape hatch here, that is a change to the product's safety posture and belongs in a
 * plan document, not in a config table.
 *
 * (The precedent is Plan 3's `hard_deny_above_cents` structural ceiling, D-A4, which is
 * likewise not overridable by an in-band approval click.)
 */
export interface VerificationVerdict {
  pass: boolean;
  /** Required when `pass` is false; shown to the reviewer and stored on the event. */
  reason?: string;
  riskLevel: "low" | "medium" | "high";
}

/**
 * What a verifier is allowed to look at. Deliberately narrow: source files, the outputs of
 * completed steps, and org-configured tolerances. No DB client — a verifier must be a pure
 * function of its inputs so it is trivially testable and cannot have I/O-dependent verdicts.
 *
 * The one thing that legitimately needs history — "is this transaction already matched?" —
 * is supplied as `alreadyMatchedIds`, resolved by the caller before verification, so the
 * verifier stays pure and the resume-safety of that lookup is the loop's responsibility.
 */
export interface VerificationContext {
  files: Record<string, ParsedFile>;
  priorOutputs: Record<string, unknown>;
  /** Org-configured tolerances/thresholds, already loaded. */
  policy: VerificationPolicy;
  /** Target ids already committed as matched in this workflow (resume-safe double-match check). */
  alreadyMatchedIds?: ReadonlySet<string>;
  /** Valid account codes, for journal-entry verification. */
  chartOfAccounts?: ReadonlySet<string>;
}

/**
 * Org-configurable verification tolerances. These widen or narrow what passes; none of
 * them can turn a `high` verdict into a lower one (D-H10).
 */
export interface VerificationPolicy {
  /** Reconciliation: max absolute amount difference, in cents. */
  matchAmountToleranceCents: number;
  /** Reconciliation: max date difference, in days. */
  matchDateWindowDays: number;
  /** AP: max invoice-vs-PO variance as a fraction (0.02 = 2%). */
  apVarianceFraction: number;
  /**
   * Journal entries at or above this force a `high` verdict and therefore mandatory human
   * review. The brief's example is $10,000; the default here is that, in cents.
   */
  journalEntryReviewThresholdCents: number;
}

/** The defaults an org inherits with no configuration — deliberately conservative. */
export const DEFAULT_VERIFICATION_POLICY: VerificationPolicy = {
  matchAmountToleranceCents: 100, // $1.00
  matchDateWindowDays: 3,
  apVarianceFraction: 0.02, // 2%, per the brief
  journalEntryReviewThresholdCents: 1_000_000, // $10,000, per the brief
};

/** A verifier: pure, deterministic, non-LLM. */
export type Verifier = (
  action: ProposedAction,
  context: VerificationContext,
) => VerificationVerdict;

/** Convenience for the common passing verdict. */
export function pass(riskLevel: VerificationVerdict["riskLevel"] = "low"): VerificationVerdict {
  return { pass: true, riskLevel };
}

/** Convenience for a failing verdict. A reason is mandatory by construction. */
export function fail(
  reason: string,
  riskLevel: VerificationVerdict["riskLevel"] = "high",
): VerificationVerdict {
  return { pass: false, reason, riskLevel };
}

/** Re-exported so verifier modules need one import. */
export type { ProposedAction, RiskClass };
