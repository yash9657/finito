/**
 * The verifier registry (Plan 4 §4, D-H9).
 *
 * Maps `action_type` → verifier. The important property is what happens for an action type
 * that is NOT in the table: `verifyAction` FAILS it. An unregistered action type means
 * someone added a new consequential act and did not write the rules for it, and the safe
 * reading of "we have no rules for this" is "this does not execute" — not "this executes
 * unchecked". Registering a verifier is therefore part of adding an action type, enforced
 * by the loop rather than by review discipline.
 */

import { verifyJournalEntry } from "@/lib/harness/verifiers/journal-entry";
import { verifyReconciliationMatch } from "@/lib/harness/verifiers/reconciliation-match";
import { verifyApMatch } from "@/lib/harness/verifiers/ap-match";
import { verifyNormalizeDataset } from "@/lib/harness/verifiers/dataset";
import {
  ADJUDICATE_MATCHES,
  AP_MATCH,
  APPROVE_INVOICE_PAYMENT,
  BOOK_JOURNAL_ENTRY,
  FLAG_EXCEPTIONS,
  NORMALIZE_DATASET,
  RECONCILIATION_MATCH,
  WRITE_COMMENTARY,
} from "@/lib/harness/action-types";
import { pass, type VerificationContext, type Verifier, type VerificationVerdict } from "@/lib/harness/verifiers/types";
import type { ProposedAction } from "@/lib/types";

/**
 * Analysis operations whose verification is "the inputs exist and are non-degenerate".
 * They still go through the registry — a read step that cannot be verified must not run
 * either — but their rules are shared rather than bespoke.
 */
const verifyAnalysisOperation: Verifier = (action, context): VerificationVerdict => {
  // Every analysis step consumes prior outputs or files; if it has neither, its result
  // would be manufactured from nothing.
  const hasFiles = Object.keys(context.files).length > 0;
  const hasPriors = Object.keys(context.priorOutputs).length > 0;
  if (!hasFiles && !hasPriors) {
    return {
      pass: false,
      reason: `"${action.actionType}" has no source data — neither files nor prior step outputs`,
      riskLevel: "high",
    };
  }
  return pass("low");
};

const VERIFIERS: Record<string, Verifier> = {
  // Consequential — bespoke business rules (Part 5).
  [BOOK_JOURNAL_ENTRY]: verifyJournalEntry,
  [RECONCILIATION_MATCH]: verifyReconciliationMatch,
  [AP_MATCH]: verifyApMatch,
  [APPROVE_INVOICE_PAYMENT]: verifyApMatch,
  // Read/analysis — the role's own operation.
  [NORMALIZE_DATASET]: verifyNormalizeDataset,
  [ADJUDICATE_MATCHES]: verifyAnalysisOperation,
  [FLAG_EXCEPTIONS]: verifyAnalysisOperation,
  [WRITE_COMMENTARY]: verifyAnalysisOperation,
};

/** Whether an action type has rules. Used by tests and by the action-type registry check. */
export function hasVerifier(actionType: string): boolean {
  return actionType in VERIFIERS;
}

/**
 * Verify one proposed action.
 *
 * Fails closed on an unregistered action type (see the module note) and on a verifier that
 * throws — a verifier crash is not a pass. Never calls an LLM and never touches the network.
 */
export function verifyAction(
  action: ProposedAction,
  context: VerificationContext,
): VerificationVerdict {
  const verifier = VERIFIERS[action.actionType];
  if (!verifier) {
    return {
      pass: false,
      reason:
        `No verifier registered for action type "${action.actionType}" — an action whose ` +
        `rules are unwritten does not execute`,
      riskLevel: "high",
    };
  }
  try {
    return verifier(action, context);
  } catch (err) {
    // A verifier is pure code over plain data, so a throw means a bug. Treating it as a
    // pass would let the bug become an executed action.
    const message = err instanceof Error ? err.message : String(err);
    return {
      pass: false,
      reason: `Verifier for "${action.actionType}" threw: ${message}`,
      riskLevel: "high",
    };
  }
}

export {
  DEFAULT_VERIFICATION_POLICY,
  type VerificationContext,
  type VerificationPolicy,
  type VerificationVerdict,
  type Verifier,
} from "@/lib/harness/verifiers/types";
