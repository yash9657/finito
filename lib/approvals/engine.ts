/**
 * The permission engine (Plan 3 §3.1, D-A4/D-A6) — pure, no DB, no clock, no I/O.
 *
 * `evaluateAction` answers one question about one action: may it proceed, must a human
 * look at it, or is it structurally forbidden? The order is fixed and is the whole
 * compliance story:
 *
 *     ceilings  →  rules  →  human
 *
 * Ceilings come first and are absolute: an action above the org's hard ceiling (or to an
 * un-allowlisted counterparty when the policy requires one) is DENIED, and no in-band
 * click anywhere in the product can override it (D-A4). Only then do target-bound
 * standing grants get a say, and only within the org's auto-approve ceiling. Anything
 * left over goes to a human — that is the default for a fresh org, which has no policy
 * row and no rules, so every consequential action is gated (fail closed).
 *
 * Everything here is deterministic on its inputs (`nowIso` is passed in, never read from
 * the clock) so the evaluator is exhaustively testable and an audit row can be replayed.
 */

import { riskSpec } from "@/lib/approvals/risk";
import type {
  ApprovalPolicy,
  ApprovalRule,
  ApprovalRuleInput,
  DecisionSource,
  ProposedAction,
} from "@/lib/types";

export type ActionOutcome = "auto_approved" | "pending" | "denied";

export interface ActionEvaluation {
  outcome: ActionOutcome;
  /** Human-readable; stored in `action_requests.decision_reason` and shown in the UI. */
  reason: string;
  ruleId: string | null;
  source: DecisionSource | null;
}

export interface EvaluateActionInput {
  action: ProposedAction;
  workflowId: string;
  /** Defaults already applied (see `service.loadPolicy`). */
  policy: ApprovalPolicy;
  /** Candidate grants; the engine itself filters scope/expiry/revocation/consumption. */
  rules: ApprovalRule[];
  nowIso: string;
}

/* -------------------------------------------------------------------------- */
/* Counterparty comparison                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Case- and whitespace-insensitive comparison, and NOTHING more (D-A6). Fuzzy vendor
 * aliasing ("Acme Inc" ≈ "ACME, Inc.") belongs to the typed `vendor_alias` layer of
 * Edge #2, deliberately not here: a fuzzy match that silently widens an authorization is
 * exactly the failure this layer exists to prevent. Unmatched names fall through to a
 * human, which is the safe direction.
 */
export function normalizeCounterparty(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function counterpartyEquals(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false;
  return normalizeCounterparty(a) === normalizeCounterparty(b);
}

function counterpartyAllowed(policy: ApprovalPolicy, counterparty: string | null): boolean {
  if (counterparty === null) return false; // fail closed: no name, no allowlist hit
  const wanted = normalizeCounterparty(counterparty);
  return policy.approved_counterparties.some((c) => normalizeCounterparty(c) === wanted);
}

/* -------------------------------------------------------------------------- */
/* Rule matching                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Does this grant cover this action? Every declared constraint must hold, and a rule
 * that constrains a dimension the action does not carry never matches (fail closed).
 */
export function ruleMatches(
  rule: ApprovalRule,
  action: ProposedAction,
  workflowId: string,
  nowIso: string,
): boolean {
  if (rule.revoked_at !== null) return false;
  if (rule.expires_at !== null && rule.expires_at <= nowIso) return false;

  // `once`/`run` grants are bound to the run they were minted in (D-A6).
  if (rule.scope !== "standing" && rule.workflow_id !== workflowId) return false;

  if (rule.scope === "once") {
    if (rule.consumed_at !== null) return false;
    if (rule.target_id === null || rule.target_id !== action.target.id) return false;
  }

  if (rule.action_type !== action.actionType) return false;
  if (rule.target_kind !== action.target.kind) return false;

  if (rule.counterparty !== null && !counterpartyEquals(rule.counterparty, action.target.counterparty)) {
    return false;
  }

  if (rule.max_amount_cents !== null) {
    const amount = action.target.amountCents;
    if (amount === null) return false; // amountless action vs a capped rule → no match
    if (amount > rule.max_amount_cents) return false;
  }

  return true;
}

/** Most specific / most deliberate grant first: `once` → `run` → `standing`, newest first. */
const SCOPE_PRECEDENCE: Record<ApprovalRule["scope"], number> = {
  once: 0,
  run: 1,
  standing: 2,
};

function pickRule(
  rules: ApprovalRule[],
  action: ProposedAction,
  workflowId: string,
  nowIso: string,
): ApprovalRule | null {
  const matching = rules.filter((r) => ruleMatches(r, action, workflowId, nowIso));
  if (matching.length === 0) return null;
  matching.sort((a, b) => {
    const s = SCOPE_PRECEDENCE[a.scope] - SCOPE_PRECEDENCE[b.scope];
    if (s !== 0) return s;
    return b.created_at.localeCompare(a.created_at); // newest first
  });
  return matching[0];
}

/* -------------------------------------------------------------------------- */
/* Evaluation                                                                  */
/* -------------------------------------------------------------------------- */

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function describe(action: ProposedAction): string {
  const who = action.target.counterparty ?? "an unnamed counterparty";
  const amount = action.target.amountCents === null ? "an unspecified amount" : money(action.target.amountCents);
  return `${action.actionType} → ${who} · ${amount}`;
}

export function evaluateAction(input: EvaluateActionInput): ActionEvaluation {
  const { action, policy, rules, workflowId, nowIso } = input;
  const spec = riskSpec(action.riskClass);
  const amount = action.target.amountCents;

  // 1. Read-only acts need no authorization at all (D-A2). Read steps propose nothing,
  //    so this is a guard rather than a path.
  if (!spec.requiresAuthorization) {
    return {
      outcome: "auto_approved",
      reason: `${spec.label} action — no authorization required`,
      ruleId: null,
      source: "policy",
    };
  }

  // 2. A money-class action with no amount can never be ceiling-checked → always human.
  if (spec.ceilingApplies && amount === null) {
    return {
      outcome: "pending",
      reason: `${spec.label} action with no amount on its target — human approval required`,
      ruleId: null,
      source: null,
    };
  }

  // 3. The absolute ceiling. Terminal, and deliberately not overridable in-band (D-A4).
  if (
    spec.ceilingApplies &&
    policy.hard_deny_above_cents !== null &&
    amount !== null &&
    amount > policy.hard_deny_above_cents
  ) {
    return {
      outcome: "denied",
      reason:
        `${money(amount)} exceeds the organization's hard ceiling of ` +
        `${money(policy.hard_deny_above_cents)} — denied regardless of approval`,
      ruleId: null,
      source: "ceiling",
    };
  }

  // 4. Counterparty allowlist, when the org requires one. Also absolute (D-A4).
  if (policy.require_known_counterparty && !counterpartyAllowed(policy, action.target.counterparty)) {
    const who = action.target.counterparty ?? "(no counterparty on target)";
    return {
      outcome: "denied",
      reason: `"${who}" is not an approved counterparty — denied regardless of approval`,
      ruleId: null,
      source: "policy",
    };
  }

  // 5. Target-bound grants, capped by the org's auto-approve ceiling.
  const rule = pickRule(rules, action, workflowId, nowIso);
  if (rule !== null) {
    if (
      spec.ceilingApplies &&
      policy.auto_approve_max_cents !== null &&
      amount !== null &&
      amount > policy.auto_approve_max_cents
    ) {
      return {
        outcome: "pending",
        reason:
          `A ${rule.scope} rule covers this action, but ${money(amount)} is above the ` +
          `organization's auto-approve ceiling of ${money(policy.auto_approve_max_cents)} — ` +
          `human approval required`,
        ruleId: rule.id,
        source: "ceiling",
      };
    }
    return {
      outcome: "auto_approved",
      reason: `Auto-approved under ${rule.scope} rule ${ruleSummary(rule)}`,
      ruleId: rule.id,
      source: "standing_rule",
    };
  }

  // 6. Default: a human decides.
  return {
    outcome: "pending",
    reason: `No standing rule covers ${describe(action)} — human approval required`,
    ruleId: null,
    source: null,
  };
}

/** Compact human description of a grant's binding, for reasons and the UI. */
export function ruleSummary(rule: ApprovalRule): string {
  const parts: string[] = [];
  if (rule.counterparty !== null) parts.push(`counterparty "${rule.counterparty}"`);
  if (rule.max_amount_cents !== null) parts.push(`up to ${money(rule.max_amount_cents)}`);
  if (rule.target_id !== null) parts.push(`target ${rule.target_id}`);
  return parts.length > 0 ? `(${parts.join(", ")})` : "(unbounded)";
}

/* -------------------------------------------------------------------------- */
/* Grant validation (D-A6) — the reason "approve the action type" is not       */
/* expressible: an unbounded standing rule is rejected here, server-side.      */
/* -------------------------------------------------------------------------- */

export function validateRuleInput(input: ApprovalRuleInput): string | null {
  if (!input.action_type || input.action_type.trim().length === 0) {
    return "action_type is required";
  }
  if (!input.target_kind || input.target_kind.trim().length === 0) {
    return "target_kind is required";
  }

  const cap = input.max_amount_cents ?? null;
  if (cap !== null) {
    if (!Number.isInteger(cap) || cap <= 0) {
      return "max_amount_cents must be a positive integer number of cents";
    }
  }

  const counterparty = input.counterparty?.trim() ? input.counterparty.trim() : null;
  const targetId = input.target_id?.trim() ? input.target_id.trim() : null;

  switch (input.scope) {
    case "once":
      if (!input.workflow_id) return "a 'once' grant must be bound to a workflow";
      if (targetId === null) return "a 'once' grant must name the exact target id";
      break;
    case "run":
      if (!input.workflow_id) return "a 'run' grant must be bound to a workflow";
      if (counterparty === null && cap === null && targetId === null) {
        return "a 'run' grant needs at least one binding constraint (counterparty, amount cap, or target id)";
      }
      break;
    case "standing":
      if (input.workflow_id) return "a 'standing' grant must not be bound to a workflow";
      if (counterparty === null && cap === null) {
        return "a 'standing' grant must be bound to a counterparty and/or an amount cap — unbounded standing grants are not allowed";
      }
      break;
  }

  if (input.expires_at) {
    const t = Date.parse(input.expires_at);
    if (Number.isNaN(t)) return "expires_at must be an ISO timestamp";
  }

  return null;
}
