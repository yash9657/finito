import { describe, expect, it } from "vitest";
import {
  evaluateAction,
  normalizeCounterparty,
  ruleMatches,
  validateRuleInput,
} from "@/lib/approvals/engine";
import type {
  ApprovalPolicy,
  ApprovalRule,
  ApprovalRuleInput,
  ProposedAction,
  RiskClass,
} from "@/lib/types";

const NOW = "2026-07-24T12:00:00.000Z";
const WF = "wf-1";

function policy(over: Partial<ApprovalPolicy> = {}): ApprovalPolicy {
  return {
    org_id: "org-1",
    hard_deny_above_cents: null,
    auto_approve_max_cents: null,
    require_known_counterparty: false,
    approved_counterparties: [],
    require_separate_approver: false,
    updated_by: null,
    updated_at: null,
    ...over,
  };
}

function action(over: Partial<ProposedAction> = {}, target: Partial<ProposedAction["target"]> = {}): ProposedAction {
  return {
    actionKey: "approve_invoice_payment:inv-001",
    actionType: "approve_invoice_payment",
    riskClass: "moves_money" as RiskClass,
    summary: "Approve payment",
    ...over,
    target: {
      kind: "invoice",
      id: "inv-001",
      counterparty: "Acme Supplies",
      amountCents: 120_000, // $1,200.00
      ...target,
    },
  };
}

function rule(over: Partial<ApprovalRule> = {}): ApprovalRule {
  return {
    id: "rule-1",
    org_id: "org-1",
    scope: "standing",
    workflow_id: null,
    action_type: "approve_invoice_payment",
    target_kind: "invoice",
    target_id: null,
    counterparty: "Acme Supplies",
    max_amount_cents: 500_000,
    note: null,
    created_by: "user-1",
    created_at: "2026-07-01T00:00:00.000Z",
    expires_at: null,
    consumed_at: null,
    revoked_at: null,
    revoked_by: null,
    ...over,
  };
}

function evaluate(a: ProposedAction, p: ApprovalPolicy, rules: ApprovalRule[] = []) {
  return evaluateAction({ action: a, workflowId: WF, policy: p, rules, nowIso: NOW });
}

/* -------------------------------------------------------------------------- */
/* Defaults: a fresh org gates everything (fail closed).                       */
/* -------------------------------------------------------------------------- */

describe("evaluateAction — defaults", () => {
  it("sends every consequential action to a human when there is no policy and no rule", () => {
    const e = evaluate(action(), policy());
    expect(e.outcome).toBe("pending");
    expect(e.source).toBeNull();
    expect(e.ruleId).toBeNull();
    expect(e.reason).toMatch(/no standing rule covers/i);
  });

  it("never gates a read-class action", () => {
    const e = evaluate(action({ riskClass: "read" }), policy());
    expect(e.outcome).toBe("auto_approved");
    expect(e.source).toBe("policy");
  });

  it("sends an amountless money action to a human (cannot be ceiling-checked)", () => {
    const e = evaluate(action({}, { amountCents: null }), policy({ hard_deny_above_cents: 1 }));
    expect(e.outcome).toBe("pending");
    expect(e.reason).toMatch(/no amount on its target/i);
  });
});

/* -------------------------------------------------------------------------- */
/* Structural ceilings are absolute (D-A4).                                    */
/* -------------------------------------------------------------------------- */

describe("evaluateAction — structural ceilings", () => {
  it("denies above the hard ceiling", () => {
    const e = evaluate(action({}, { amountCents: 5_000_00 }), policy({ hard_deny_above_cents: 1_000_00 }));
    expect(e.outcome).toBe("denied");
    expect(e.source).toBe("ceiling");
    expect(e.reason).toMatch(/regardless of approval/i);
  });

  it("ceiling denial beats a matching standing rule", () => {
    const e = evaluate(
      action({}, { amountCents: 400_000 }),
      policy({ hard_deny_above_cents: 100_000 }),
      [rule({ max_amount_cents: 500_000 })],
    );
    expect(e.outcome).toBe("denied");
    expect(e.ruleId).toBeNull();
  });

  it("allows exactly at the hard ceiling (inclusive)", () => {
    const e = evaluate(action({}, { amountCents: 100_000 }), policy({ hard_deny_above_cents: 100_000 }));
    expect(e.outcome).toBe("pending"); // not denied; just needs a human
  });

  it("denies an un-allowlisted counterparty when the policy requires one", () => {
    const e = evaluate(
      action({}, { counterparty: "Unknown LLC" }),
      policy({ require_known_counterparty: true, approved_counterparties: ["Acme Supplies"] }),
      [rule({ counterparty: "Unknown LLC" })],
    );
    expect(e.outcome).toBe("denied");
    expect(e.source).toBe("policy");
  });

  it("accepts an allowlisted counterparty regardless of case/whitespace", () => {
    const e = evaluate(
      action({}, { counterparty: "  acme   supplies " }),
      policy({ require_known_counterparty: true, approved_counterparties: ["Acme Supplies"] }),
    );
    expect(e.outcome).toBe("pending"); // allowlist passed, no rule → human
  });

  it("denies an action with no counterparty when the allowlist is required", () => {
    const e = evaluate(
      action({}, { counterparty: null }),
      policy({ require_known_counterparty: true, approved_counterparties: ["Acme Supplies"] }),
    );
    expect(e.outcome).toBe("denied");
  });

  it("demotes a rule hit to a human above the auto-approve ceiling", () => {
    const e = evaluate(
      action({}, { amountCents: 400_000 }),
      policy({ auto_approve_max_cents: 200_000 }),
      [rule({ max_amount_cents: 500_000 })],
    );
    expect(e.outcome).toBe("pending");
    expect(e.source).toBe("ceiling");
    expect(e.ruleId).toBe("rule-1"); // the rule that would have covered it is recorded
    expect(e.reason).toMatch(/auto-approve ceiling/i);
  });
});

/* -------------------------------------------------------------------------- */
/* Grants bind to arguments, not to the action type (D-A6).                    */
/* -------------------------------------------------------------------------- */

describe("evaluateAction — target-bound grants", () => {
  it("auto-approves within the bound counterparty + cap", () => {
    const e = evaluate(action(), policy(), [rule()]);
    expect(e.outcome).toBe("auto_approved");
    expect(e.source).toBe("standing_rule");
    expect(e.ruleId).toBe("rule-1");
    expect(e.reason).toMatch(/Acme Supplies/);
  });

  it("does not auto-approve above the rule's cap", () => {
    const e = evaluate(action({}, { amountCents: 500_001 }), policy(), [rule({ max_amount_cents: 500_000 })]);
    expect(e.outcome).toBe("pending");
  });

  it("does not auto-approve a different counterparty", () => {
    const e = evaluate(action({}, { counterparty: "Globex" }), policy(), [rule()]);
    expect(e.outcome).toBe("pending");
  });

  it("does not auto-approve a different action type or target kind", () => {
    expect(evaluate(action({ actionType: "post_journal_entry" }), policy(), [rule()]).outcome).toBe("pending");
    expect(evaluate(action({}, { kind: "purchase_order" }), policy(), [rule()]).outcome).toBe("pending");
  });

  it("ignores revoked, expired and consumed rules", () => {
    expect(evaluate(action(), policy(), [rule({ revoked_at: NOW })]).outcome).toBe("pending");
    expect(
      evaluate(action(), policy(), [rule({ expires_at: "2026-07-01T00:00:00.000Z" })]).outcome,
    ).toBe("pending");
    expect(
      evaluate(action(), policy(), [
        rule({ scope: "once", workflow_id: WF, target_id: "inv-001", consumed_at: NOW }),
      ]).outcome,
    ).toBe("pending");
  });

  it("honors a future expiry", () => {
    const e = evaluate(action(), policy(), [rule({ expires_at: "2027-01-01T00:00:00.000Z" })]);
    expect(e.outcome).toBe("auto_approved");
  });

  it("keeps run-scoped grants inside their own run", () => {
    const runRule = rule({ scope: "run", workflow_id: "wf-other", counterparty: null });
    expect(evaluate(action(), policy(), [runRule]).outcome).toBe("pending");
    expect(
      evaluate(action(), policy(), [{ ...runRule, workflow_id: WF }]).outcome,
    ).toBe("auto_approved");
  });

  it("once-grants match only their exact target", () => {
    const once = rule({ scope: "once", workflow_id: WF, target_id: "inv-002", counterparty: null, max_amount_cents: null });
    expect(evaluate(action(), policy(), [once]).outcome).toBe("pending");
    expect(evaluate(action(), policy(), [{ ...once, target_id: "inv-001" }]).outcome).toBe("auto_approved");
  });

  it("prefers once over run over standing when several match", () => {
    const standing = rule({ id: "r-standing", scope: "standing" });
    const runScoped = rule({ id: "r-run", scope: "run", workflow_id: WF });
    const once = rule({ id: "r-once", scope: "once", workflow_id: WF, target_id: "inv-001" });
    const e = evaluate(action(), policy(), [standing, runScoped, once]);
    expect(e.ruleId).toBe("r-once");
    const e2 = evaluate(action(), policy(), [standing, runScoped]);
    expect(e2.ruleId).toBe("r-run");
  });

  it("a capped rule never matches an amountless action", () => {
    expect(
      ruleMatches(rule({ max_amount_cents: 100 }), action({}, { amountCents: null }), WF, NOW),
    ).toBe(false);
  });

  it("normalizes counterparty comparison but nothing more (Edge #2 seam)", () => {
    expect(normalizeCounterparty("  ACME   Supplies ")).toBe("acme supplies");
    // "Acme Inc" vs "ACME, Inc." must NOT match here — it falls through to a human.
    expect(ruleMatches(rule({ counterparty: "Acme Inc" }), action({}, { counterparty: "ACME, Inc." }), WF, NOW)).toBe(
      false,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Grant validation (D-A6).                                                    */
/* -------------------------------------------------------------------------- */

describe("validateRuleInput", () => {
  const base: ApprovalRuleInput = {
    scope: "standing",
    action_type: "approve_invoice_payment",
    target_kind: "invoice",
  };

  it("rejects an unbounded standing grant", () => {
    expect(validateRuleInput(base)).toMatch(/unbounded standing grants are not allowed/i);
  });

  it("accepts a standing grant bound by counterparty or by cap", () => {
    expect(validateRuleInput({ ...base, counterparty: "Acme Supplies" })).toBeNull();
    expect(validateRuleInput({ ...base, max_amount_cents: 100_000 })).toBeNull();
  });

  it("rejects a standing grant bound to a workflow", () => {
    expect(validateRuleInput({ ...base, counterparty: "Acme", workflow_id: WF })).toMatch(
      /must not be bound to a workflow/i,
    );
  });

  it("requires a workflow + target id for a once grant", () => {
    expect(validateRuleInput({ ...base, scope: "once" })).toMatch(/bound to a workflow/i);
    expect(validateRuleInput({ ...base, scope: "once", workflow_id: WF })).toMatch(/exact target id/i);
    expect(
      validateRuleInput({ ...base, scope: "once", workflow_id: WF, target_id: "inv-001" }),
    ).toBeNull();
  });

  it("requires a workflow + one constraint for a run grant", () => {
    expect(validateRuleInput({ ...base, scope: "run" })).toMatch(/bound to a workflow/i);
    expect(validateRuleInput({ ...base, scope: "run", workflow_id: WF })).toMatch(/binding constraint/i);
    expect(
      validateRuleInput({ ...base, scope: "run", workflow_id: WF, max_amount_cents: 5_000 }),
    ).toBeNull();
  });

  it("rejects a non-positive or fractional cap, and a bad expiry", () => {
    expect(validateRuleInput({ ...base, max_amount_cents: 0 })).toMatch(/positive integer/i);
    expect(validateRuleInput({ ...base, max_amount_cents: 10.5 })).toMatch(/positive integer/i);
    expect(
      validateRuleInput({ ...base, counterparty: "Acme", expires_at: "not-a-date" }),
    ).toMatch(/ISO timestamp/i);
  });

  it("requires action_type and target_kind", () => {
    expect(validateRuleInput({ ...base, action_type: " " })).toMatch(/action_type/);
    expect(validateRuleInput({ ...base, target_kind: "" })).toMatch(/target_kind/);
  });
});
