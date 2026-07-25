import { describe, expect, it } from "vitest";
import {
  apMatchingSteps,
  paymentActionKey,
  splitApprovalQueue,
  type ApFlagStepOutput,
  type ApMatchStepOutput,
} from "@/lib/agents/ap-matching";
import type {
  ActionDecision,
  ApApprovalQueue,
  Invoice,
  LlmInvokeResult,
  ProposedAction,
  StepContext,
} from "@/lib/types";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

function invoice(id: string, amountCents: number, vendor: string): Invoice {
  return {
    id,
    invoiceNumber: `INV-${id.slice(-3)}`,
    vendorName: vendor,
    lineItem: "Widgets",
    amountCents,
    invoiceDate: "2026-06-01",
    dueDate: "2026-07-01",
  };
}

const INVOICES: Invoice[] = [
  invoice("inv-001", 120_000, "Acme Supplies"),
  invoice("inv-002", 250_000, "Globex"),
  invoice("inv-003", 90_000, "Initech"), // unmatched → held on data
];

const MATCH: ApMatchStepOutput = {
  matchedPairs: [
    { invoiceId: "inv-001", poId: "po-001", amountCents: 120_000, confidence: "high", matchReason: "" },
    { invoiceId: "inv-002", poId: "po-002", amountCents: 250_000, confidence: "high", matchReason: "" },
  ],
  unmatchedInvoices: [INVOICES[2]],
  unmatchedPos: [],
  duplicateInvoices: [],
  stats: {
    deterministicMatches: 2,
    adjudicatedMatches: 0,
    unmatchedInvoiceCount: 1,
    unmatchedPoCount: 0,
    duplicateInvoiceCount: 0,
  },
};

const NO_FLAGS: ApFlagStepOutput = { flags: [] };

function decision(over: Partial<ActionDecision> = {}): ActionDecision {
  return {
    actionKey: "k",
    actionId: "a1",
    status: "approved",
    source: "human",
    reason: "Approved by reviewer",
    standingRuleId: null,
    decidedBy: "user-1",
    authorized: true,
    ...over,
  };
}

/** A StepContext whose llm() returns a canned narrative and records the payload it saw. */
function ctxWith(approvals: Array<[string, ActionDecision]>, seen: { user?: string } = {}): StepContext {
  return {
    workflowId: "wf-1",
    db: {} as StepContext["db"],
    files: { invoice: { rows: INVOICES, errors: [], meta: { filename: "inv.csv", fileType: "invoice", sha256: "x", rowCount: 3, skippedCount: 0 } } } as unknown as StepContext["files"],
    priorOutputs: { match_invoices: MATCH, flag_invoices: NO_FLAGS },
    llm: (async (opts: { user: string }) => {
      seen.user = opts.user;
      return {
        data: { reasoning: "r", narrative: "n" },
        reasoning: "r",
        meta: {
          providerId: "anthropic",
          modelUsed: "claude-sonnet-4-6",
          tokensIn: 1,
          tokensOut: 1,
          latencyMs: 1,
          raw: null,
        },
      } as unknown as LlmInvokeResult<unknown>;
    }) as StepContext["llm"],
    approvals: new Map(approvals),
  };
}

const approvalQueueStep = apMatchingSteps.find((s) => s.key === "approval_queue")!;

/* -------------------------------------------------------------------------- */

describe("splitApprovalQueue (deterministic, shared by gate and commit — D-A13)", () => {
  it("splits matched+unflagged into payable and everything else into held", () => {
    const split = splitApprovalQueue(INVOICES, MATCH, NO_FLAGS);
    expect(split.payable.map((p) => p.invoice.id)).toEqual(["inv-001", "inv-002"]);
    expect(split.payable[0].poId).toBe("po-001");
    expect(split.held.map((h) => h.invoice.id)).toEqual(["inv-003"]);
    expect(split.held[0].poId).toBeNull();
  });

  it("holds a flagged invoice even when it matched a PO", () => {
    const flagged: ApFlagStepOutput = {
      flags: [{ invoiceId: "inv-002", category: "amount_variance", explanation: "e", recommendation: "r" }],
    };
    const split = splitApprovalQueue(INVOICES, MATCH, flagged);
    expect(split.payable.map((p) => p.invoice.id)).toEqual(["inv-001"]);
    expect(split.held.map((h) => h.invoice.id).sort()).toEqual(["inv-002", "inv-003"]);
    expect(split.flagCategoryTally).toEqual({ amount_variance: 1 });
  });

  it("is pure: repeated calls give an identical split", () => {
    expect(splitApprovalQueue(INVOICES, MATCH, NO_FLAGS)).toEqual(
      splitApprovalQueue(INVOICES, MATCH, NO_FLAGS),
    );
  });
});

describe("approval_queue step gating (D-A2/D-A3)", () => {
  it("is declared money-moving and proposes one action per payable invoice", async () => {
    expect(approvalQueueStep.risk).toBe("moves_money");
    const actions = (await approvalQueueStep.proposeActions!(ctxWith([]))) as ProposedAction[];
    expect(actions.map((a) => a.actionKey)).toEqual([
      "approve_invoice_payment:inv-001",
      "approve_invoice_payment:inv-002",
    ]);
    // Bound to arguments, from source data (D-A1/D-A3).
    expect(actions[0].target).toEqual({
      kind: "invoice",
      id: "inv-001",
      counterparty: "Acme Supplies",
      amountCents: 120_000,
    });
    expect(actions[0].riskClass).toBe("moves_money");
    expect(actions[0].payload).toMatchObject({ poId: "po-001", invoiceNumber: "INV-001" });
    // The unmatched invoice is never proposed for payment.
    expect(actions.some((a) => a.target.id === "inv-003")).toBe(false);
  });

  it("commits only authorized payments and withholds the rest", async () => {
    const seen: { user?: string } = {};
    const ctx = ctxWith(
      [
        [paymentActionKey("inv-001"), decision({ actionKey: paymentActionKey("inv-001") })],
        [
          paymentActionKey("inv-002"),
          decision({
            actionKey: paymentActionKey("inv-002"),
            status: "denied",
            source: "ceiling",
            reason: "exceeds the organization's hard ceiling",
            authorized: false,
            decidedBy: null,
          }),
        ],
      ],
      seen,
    );

    const result = await approvalQueueStep.run(ctx);
    const out = result.output as ApApprovalQueue;

    expect(out.autoApprove.map((a) => a.invoiceId)).toEqual(["inv-001"]);
    expect(out.autoApprove[0].authorization?.decidedBy).toBe("user-1");
    expect(out.stats.autoApproveAmountCents).toBe(120_000);

    // inv-002 withheld by the ceiling, inv-003 held on data — both in holdForReview.
    const heldIds = out.holdForReview.map((h) => h.invoice.id).sort();
    expect(heldIds).toEqual(["inv-002", "inv-003"]);
    const denied = out.holdForReview.find((h) => h.invoice.id === "inv-002")!;
    expect(denied.flags).toEqual([]);
    expect(denied.authorization?.status).toBe("denied");
    expect(out.stats.holdCount).toBe(2);
    expect(out.stats.holdAmountCents).toBe(250_000 + 90_000);

    // The narrative payload learns about the withheld payment (D-A14: prompt unchanged).
    const payload = JSON.parse(seen.user!) as Record<string, unknown>;
    expect(payload.authorizationHolds).toMatchObject({ count: 1 });
  });

  it("fails closed when a payable invoice has no decision at all", async () => {
    const ctx = ctxWith([[paymentActionKey("inv-001"), decision({ actionKey: paymentActionKey("inv-001") })]]);
    const out = (await approvalQueueStep.run(ctx)).output as ApApprovalQueue;
    expect(out.autoApprove.map((a) => a.invoiceId)).toEqual(["inv-001"]);
    expect(out.holdForReview.some((h) => h.invoice.id === "inv-002")).toBe(true);
  });

  it("keeps the narrative payload free of authorizationHolds when everything is authorized", async () => {
    const seen: { user?: string } = {};
    const ctx = ctxWith(
      [
        [paymentActionKey("inv-001"), decision({ actionKey: paymentActionKey("inv-001") })],
        [
          paymentActionKey("inv-002"),
          decision({ actionKey: paymentActionKey("inv-002"), status: "auto_approved", source: "standing_rule" }),
        ],
      ],
      seen,
    );
    const out = (await approvalQueueStep.run(ctx)).output as ApApprovalQueue;
    expect(out.autoApprove).toHaveLength(2);
    expect(out.autoApprove[1].authorization?.source).toBe("standing_rule");
    expect(JSON.parse(seen.user!).authorizationHolds).toBeUndefined();
  });
});
