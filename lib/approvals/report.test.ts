import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import {
  authorizationFooterClause,
  authorizationSummary,
  decisionNarrative,
} from "@/lib/approvals/report";
import { buildWorkbook } from "@/lib/excel/writer";
import type {
  ActionRequest,
  ActionStatus,
  ApApprovalQueue,
  Workflow,
  WorkflowStep,
} from "@/lib/types";

function action(over: Partial<ActionRequest> = {}): ActionRequest {
  return {
    id: "a1",
    workflow_id: "wf-1",
    step_id: "s5",
    step_key: "approval_queue",
    action_key: "approve_invoice_payment:inv-001",
    action_type: "approve_invoice_payment",
    risk_class: "moves_money",
    target: { kind: "invoice", id: "inv-001", counterparty: "Acme Supplies", amountCents: 120_000 },
    target_kind: "invoice",
    target_id: "inv-001",
    counterparty: "Acme Supplies",
    amount_cents: 120_000,
    summary: "Approve payment of $1,200.00 to Acme Supplies",
    payload: null,
    status: "approved" as ActionStatus,
    decision_source: "human",
    decision_reason: "Approved by reviewer",
    standing_rule_id: null,
    decided_by: "user-1",
    comment: null,
    proposed_at: "2026-07-24T10:00:00.000Z",
    decided_at: "2026-07-24T10:05:00.000Z",
    committed_at: "2026-07-24T10:05:01.000Z",
    ...over,
  };
}

describe("authorizationSummary", () => {
  it("counts how each action was resolved", () => {
    const s = authorizationSummary([
      action({ id: "1", status: "approved" }),
      action({ id: "2", status: "auto_approved", decision_source: "standing_rule", standing_rule_id: "r1" }),
      action({ id: "3", status: "denied", decision_source: "ceiling", committed_at: null }),
      action({ id: "4", status: "rejected", committed_at: null }),
      action({ id: "5", status: "pending", committed_at: null }),
    ]);
    expect(s).toMatchObject({
      total: 5,
      byRule: 1,
      byHuman: 1,
      denied: 1,
      rejected: 1,
      authorized: 2,
      committed: 2,
    });
  });

  it("has an empty footer clause when the run had no consequential actions", () => {
    expect(authorizationFooterClause(authorizationSummary([]))).toBe("");
  });

  it("states the counts an auditor reads first", () => {
    const clause = authorizationFooterClause(
      authorizationSummary([
        action({ id: "1", status: "approved" }),
        action({ id: "2", status: "auto_approved", standing_rule_id: "r1" }),
        action({ id: "3", status: "denied", decision_source: "ceiling" }),
      ]),
    );
    expect(clause).toMatch(/2 of 3 consequential actions authorized/);
    expect(clause).toMatch(/1 by standing rule, 1 by a reviewer/);
    expect(clause).toMatch(/1 denied by policy/);
  });
});

describe("decisionNarrative", () => {
  it("names the approver by email when known", () => {
    expect(decisionNarrative(action(), { "user-1": "cfo@acme.test" })).toBe(
      "approved by cfo@acme.test",
    );
    expect(decisionNarrative(action())).toBe("approved by user-1");
  });

  it("names the rule that authorized an auto-approval", () => {
    expect(
      decisionNarrative(action({ status: "auto_approved", decision_source: "standing_rule", standing_rule_id: "r-7" })),
    ).toBe("auto-approved under rule r-7");
  });

  it("distinguishes a ceiling denial from a policy denial", () => {
    expect(decisionNarrative(action({ status: "denied", decision_source: "ceiling" }))).toMatch(
      /amount ceiling/,
    );
    expect(decisionNarrative(action({ status: "denied", decision_source: "policy" }))).toMatch(
      /organization policy/,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The workbook (Plan 3 §7 acceptance criterion).                              */
/* -------------------------------------------------------------------------- */

const WORKFLOW: Workflow = {
  id: "wf-1",
  org_id: "org-1",
  created_by: "user-1",
  name: "July AP run",
  type: "ap_matching",
  status: "approved",
  error_message: null,
  created_at: "2026-07-24T09:00:00.000Z",
  started_at: "2026-07-24T09:00:00.000Z",
  completed_at: "2026-07-24T10:06:00.000Z",
};

const QUEUE: ApApprovalQueue = {
  autoApprove: [
    {
      invoiceId: "inv-001",
      poId: "po-001",
      amountCents: 120_000,
      vendor: "Acme Supplies",
      recommendedAction: "approve",
      authorization: {
        actionKey: "approve_invoice_payment:inv-001",
        actionId: "a1",
        status: "auto_approved",
        source: "standing_rule",
        reason: "Auto-approved under standing rule",
        standingRuleId: "r-7",
        decidedBy: null,
        authorized: true,
      },
    },
  ],
  holdForReview: [
    {
      invoice: {
        id: "inv-002",
        invoiceNumber: "INV-002",
        vendorName: "Globex",
        lineItem: "Widgets",
        amountCents: 5_000_000,
        invoiceDate: "2026-06-01",
        dueDate: "2026-07-01",
      },
      poId: "po-002",
      flags: [],
      authorization: {
        actionKey: "approve_invoice_payment:inv-002",
        actionId: "a2",
        status: "denied",
        source: "ceiling",
        reason: "$50,000.00 exceeds the organization's hard ceiling of $10,000.00",
        standingRuleId: null,
        decidedBy: null,
        authorized: false,
      },
    },
  ],
  narrative: "n",
  stats: {
    autoApproveCount: 1,
    holdCount: 1,
    autoApproveAmountCents: 120_000,
    holdAmountCents: 5_000_000,
  },
};

const STEPS: WorkflowStep[] = [
  {
    id: "s5",
    workflow_id: "wf-1",
    step_number: 5,
    step_key: "approval_queue",
    track: "main",
    name: "Approval queue",
    status: "complete",
    input_snapshot: null,
    output: QUEUE,
    agent_reasoning: "r",
    sources: null,
    model: "claude-sonnet-4-6",
    provider_used: "anthropic",
    tokens_in: 100,
    tokens_out: 50,
    latency_ms: 1200,
    llm_raw: null,
    input_hash: "abc123",
    error_message: null,
    started_at: "2026-07-24T10:05:00.000Z",
    completed_at: "2026-07-24T10:06:00.000Z",
  },
];

function sheetText(wb: XLSX.WorkBook, name: string): string {
  return XLSX.utils.sheet_to_csv(wb.Sheets[name]);
}

describe("buildWorkbook — Authorization sheet", () => {
  const actions = [
    action({ id: "a1", status: "auto_approved", decision_source: "standing_rule", standing_rule_id: "r-7" }),
    action({
      id: "a2",
      action_key: "approve_invoice_payment:inv-002",
      target_id: "inv-002",
      counterparty: "Globex",
      amount_cents: 5_000_000,
      status: "denied",
      decision_source: "ceiling",
      decision_reason: "$50,000.00 exceeds the organization's hard ceiling of $10,000.00",
      decided_by: null,
      committed_at: null,
    }),
  ];

  it("adds the sheet with every action, its basis and its rule", () => {
    const wb = buildWorkbook(WORKFLOW, STEPS, [], null, null, {
      actions,
      approverEmails: { "user-1": "cfo@acme.test" },
    });
    expect(wb.SheetNames).toContain("Authorization");

    const csv = sheetText(wb, "Authorization");
    expect(csv).toMatch(/Approve invoice payment/);
    expect(csv).toMatch(/Moves money/);
    expect(csv).toMatch(/auto-approved under rule r-7/);
    expect(csv).toMatch(/denied by the organization's amount ceiling/);
    expect(csv).toMatch(/Globex/);

    // Amounts are real dollar NUMBERS with the money format, never strings (D7).
    const amountCell = wb.Sheets["Authorization"]["D3"] as XLSX.CellObject;
    expect(amountCell.t).toBe("n");
    expect(amountCell.v).toBe(50_000);
    expect(amountCell.z).toBe("#,##0.00");
  });

  it("puts the authorization counts in the certificate footer", () => {
    const wb = buildWorkbook(WORKFLOW, STEPS, [], null, null, { actions });
    const csv = sheetText(wb, "Audit Certificate");
    expect(csv).toMatch(/1 of 2 consequential actions authorized/);
    expect(csv).toMatch(/1 denied by policy/);
    expect(csv).toMatch(/anthropic:claude-sonnet-4-6/);
    expect(csv).toMatch(/Authorization chain/);
  });

  it("omits the sheet and the clause when a run had no consequential actions", () => {
    const wb = buildWorkbook(WORKFLOW, STEPS, [], null, null);
    expect(wb.SheetNames).not.toContain("Authorization");
    expect(sheetText(wb, "Audit Certificate")).not.toMatch(/consequential actions/);
  });

  it("shows the authorization basis on the AP detail sheets", () => {
    const wb = buildWorkbook(WORKFLOW, STEPS, [], null, null, { actions });
    expect(sheetText(wb, "Auto-Approve")).toMatch(/standing rule r-7/);
    expect(sheetText(wb, "Hold for Review")).toMatch(/denied: .*hard ceiling/);
  });
});
