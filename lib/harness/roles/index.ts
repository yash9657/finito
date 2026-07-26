/**
 * The role registry (Plan 4 §3, D-H15).
 *
 * A role is a single-responsibility agent that produces ONE constrained artifact type. The
 * load-bearing field is `allowedActionTypes`: a closed set of the action types a role may
 * propose. `executeStep` rejects anything outside it before verification, so
 * "`writer` can never propose `book_journal_entry`" is a property of this array rather than
 * a hope about a prompt.
 *
 * `verifier` is deliberately NOT a role here. It is not an LLM, it proposes nothing, and it
 * is never dispatched to a provider — it lives in `lib/harness/verifiers/`. Listing it
 * among the roles would imply otherwise, and the first thing someone would do is give it a
 * system prompt.
 *
 * System-prompt templates and output schemas still live with the step bodies in
 * `lib/agents/*` (D-H16: those strings are tested product surface and stay byte-identical).
 * They move here as each workflow is ported (milestone H7); this module is the constraint
 * layer first and the prompt home second.
 */

import type { RiskClass, StepRole } from "@/lib/types";
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

/*
 * Every step proposes an action, including analysis-only ones (D-H8: the lifecycle has no
 * exceptions). For a `read` step the proposed action IS the step's intended operation, and
 * verification checks that its INPUTS are sane — that the dataset it claims to normalize
 * exists, that the pairs it wants to adjudicate reference real rows. For a consequential
 * step the proposed action is the mutation itself, and verification checks THAT — that the
 * entry balances, that the amount is in tolerance. Same loop, different material.
 */

// Re-exported for convenience: most callers want the role and its action types together.
export * from "@/lib/harness/action-types";

export interface RoleSpec {
  id: StepRole;
  label: string;
  /** One line describing the single artifact this role produces. */
  produces: string;
  /**
   * The closed set of action types this role may propose (D-H15). A proposal outside it is
   * a programming error, not a business-rule failure — see `executeStep`.
   */
  allowedActionTypes: readonly string[];
  /**
   * The action type a `read` step of this role proposes for its own operation. Null for a
   * role that only ever proposes consequential actions explicitly.
   */
  defaultActionType: string | null;
  /** The highest risk class a step of this role may declare. */
  maxRiskClass: RiskClass;
}

export const ROLE_SPECS: Record<StepRole, RoleSpec> = {
  parser: {
    id: "parser",
    label: "Parser",
    produces: "Structured JSON normalized from raw file input — nothing else.",
    allowedActionTypes: [NORMALIZE_DATASET],
    defaultActionType: NORMALIZE_DATASET,
    // A parser reads a file and returns rows. It cannot be given a consequential action
    // type, so no config or prompt can turn one into a step that writes a ledger.
    maxRiskClass: "read",
  },
  matcher: {
    id: "matcher",
    label: "Matcher",
    produces: "{ matched[], unmatched[], confidence per match }.",
    // The step-level operation plus the two item-level match types. A matcher proposing
    // individual matches is the decomposition that lets each one be verified against
    // tolerance and checked for double-matching, rather than the whole batch passing or
    // failing together.
    allowedActionTypes: [ADJUDICATE_MATCHES, RECONCILIATION_MATCH, AP_MATCH],
    defaultActionType: ADJUDICATE_MATCHES,
    maxRiskClass: "read",
  },
  classifier: {
    id: "classifier",
    label: "Classifier",
    produces: "{ item_id, flag_type, reason }[].",
    // The role that owns consequential escalation: flagging an item, sending an invoice for
    // payment authorization (the AP approval_queue step), and proposing a ledger entry.
    //
    // `book_journal_entry` sits here as an interim home. A dedicated posting role would be
    // the better long-term shape — a classifier's artifact is a flag, not a journal entry —
    // but STEP_ROLES is a fixed four-value vocabulary shared with the settings matrix and a
    // DB check constraint, so adding a fifth role is a migration, not a registry edit. When
    // a real posting step lands, that is the moment to do it properly.
    allowedActionTypes: [FLAG_EXCEPTIONS, APPROVE_INVOICE_PAYMENT, BOOK_JOURNAL_ENTRY],
    defaultActionType: FLAG_EXCEPTIONS,
    // The most severe class among its allowed action types (approve_invoice_payment).
    maxRiskClass: "moves_money",
  },
  writer: {
    id: "writer",
    label: "Writer",
    produces: "Human-readable commentary/report citing its inputs.",
    // Deliberately the narrowest set in the registry. A writer produces prose. The brief's
    // example constraint — a writer must never be able to propose `book_journal_entry` —
    // is enforced by this array being exactly one element long.
    allowedActionTypes: [WRITE_COMMENTARY],
    defaultActionType: WRITE_COMMENTARY,
    maxRiskClass: "read",
  },
};

export function roleSpec(role: StepRole): RoleSpec {
  return ROLE_SPECS[role];
}

/**
 * Whether `role` is permitted to propose `actionType` (D-H15).
 *
 * Checked in `executeStep` for every proposed action, on every run — not once at import
 * time — because a step's proposals are computed from data and a data-driven bug could
 * otherwise produce an out-of-role action that no import-time check would have seen.
 */
export function roleMayPropose(role: StepRole, actionType: string): boolean {
  return ROLE_SPECS[role].allowedActionTypes.includes(actionType);
}

/**
 * Whether a step of this role may declare this risk class.
 *
 * Catches the mis-wiring that `roleMayPropose` cannot: a step whose *declared* risk exceeds
 * anything its role could legitimately do. A `writer` step marked `moves_money` would sail
 * through the per-action check (it proposes nothing consequential) while being routed
 * through the money-moving authorization path, which is a confusing and wrong place for a
 * prose step to be.
 */
export function roleMayDeclareRisk(role: StepRole, risk: RiskClass): boolean {
  return RISK_SEVERITY[risk] <= RISK_SEVERITY[ROLE_SPECS[role].maxRiskClass];
}

/**
 * Severity ordering, duplicated from `lib/approvals/risk.ts` deliberately: that module's
 * specs are the authority for the permission engine, and importing them here would drag
 * runtime dependencies into a module that client components read for role chips.
 * A test asserts the two orderings agree.
 */
const RISK_SEVERITY: Record<RiskClass, number> = {
  read: 0,
  writes_ledger: 1,
  moves_money: 2,
  external_filing: 3,
};
