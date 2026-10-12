import { describe, expect, it } from "vitest";
import { approvalScopeTotal, paymentReviewEvidence } from "./review-evidence";
import type { ActionRequestRow, StepRow } from "@/lib/types";
const action = {
  target_id: "inv-1",
  amount_cents: 12500,
  payload: { poId: "po-1" },
} as unknown as ActionRequestRow;
function fixture(): StepRow[] {
  return [
    {
      step_number: 1,
      status: "complete",
      sources: [{ file: "po.csv", note: "sha256 abc" }],
      output: {
        rows: [{ id: "po-1", amountCents: 12500, approvedBy: "Controller" }],
      },
    },
    {
      step_number: 2,
      status: "complete",
      sources: [{ file: "invoice.csv", note: "sha256 def" }],
      output: { rows: [{ id: "inv-1", amountCents: 12500 }] },
    },
    {
      step_number: 3,
      status: "complete",
      output: {
        matchedPairs: [
          { invoiceId: "inv-1", poId: "po-1", confidence: "high" },
        ],
      },
    },
    { step_number: 4, status: "complete", output: { flags: [] } },
  ] as unknown as StepRow[];
}
describe("authorization evidence", () => {
  it("requires source-backed high confidence invoice/PO evidence", () =>
    expect(paymentReviewEvidence(action, fixture()).ready).toBe(true));
  it("rejects absent legacy source rows", () =>
    expect(paymentReviewEvidence(action, []).ready).toBe(false));
  it("rejects a proposal whose amount differs from source", () =>
    expect(
      paymentReviewEvidence({ ...action, amount_cents: 12501 }, fixture())
        .ready,
    ).toBe(false));
  it("rejects a proposal for a different PO", () =>
    expect(
      paymentReviewEvidence(
        { ...action, payload: { poId: "po-other" } },
        fixture(),
      ).ready,
    ).toBe(false));
  it("blocks unresolved flags", () => {
    const steps = fixture();
    steps[3].output = {
      flags: [{ invoiceId: "inv-1", category: "duplicate_invoice" }],
    };
    expect(paymentReviewEvidence(action, steps).ready).toBe(false);
  });
  it("rejects missing provenance", () => {
    const steps = fixture();
    steps[0].sources = [];
    expect(paymentReviewEvidence(action, steps).ready).toBe(false);
  });
  it("sums bulk monetary scope exactly and rejects unsafe totals", () => {
    expect(approvalScopeTotal([action, action])).toBe(25000);
    expect(
      approvalScopeTotal([
        { ...action, amount_cents: Number.MAX_SAFE_INTEGER },
        action,
      ]),
    ).toBe(null);
  });
  it("does not display unknown amounts as zero", () =>
    expect(approvalScopeTotal([{ ...action, amount_cents: null }])).toBe(null));
});
