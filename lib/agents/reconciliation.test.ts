import { describe, expect, it, vi } from "vitest";
import { reconciliationSteps } from "@/lib/agents/reconciliation";
import { parseFile } from "@/lib/csv/parser";
import { verifyReconciliationMatch } from "@/lib/harness/verifiers/reconciliation-match";
import { DEFAULT_VERIFICATION_POLICY } from "@/lib/harness/verifiers";
import type { LlmFn, ProposedAction, ReconMatchResult, ReconReportSummary, StepContext } from "@/lib/types";

function context(erp: string[], bank: string[], replies: unknown[] = []) {
  const calls: string[] = [];
  const llm: LlmFn = async (opts) => {
    calls.push(opts.user);
    return { data: opts.schema.parse(replies.shift()), reasoning: "Source facts.", meta: { providerId: "fireworks", modelUsed: "test", tokensIn: 1, tokensOut: 1, latencyMs: 1, raw: null } };
  };
  const files = {
    erp_export: parseFile(["date,description,amount,reference", ...erp].join("\n"), "erp_export"),
    bank_statement: parseFile(["date,description,amount,transaction_id", ...bank].join("\n"), "bank_statement"),
  };
  const ctx: StepContext = {
    workflowId: "test", db: {} as StepContext["db"], approvals: new Map(), llm: vi.fn(llm) as LlmFn, files,
    priorOutputs: { parse_erp: files.erp_export, parse_bank: files.bank_statement },
  };
  return { ctx, calls };
}

async function run(ctx: StepContext, key: string) {
  const result = await reconciliationSteps.find((step) => step.key === key)!.run(ctx);
  ctx.priorOutputs[key] = result.output;
  return result;
}

const emptyMatches: ReconMatchResult = {
  matchedPairs: [], unmatchedErp: [], unmatchedBank: [], duplicates: [],
  stats: { exactMatches: 0, adjudicatedMatches: 0, unmatchedErpCount: 0, unmatchedBankCount: 0, duplicateCount: 0 },
};

function matchReply(erpId: string, bankId: string) {
  return { reasoning: "r", confirmedMatches: [{ erpId, bankId, confidence: "high", matchReason: "Same vendor" }], rejectedPairs: [] };
}

describe("reconciliation financial integrity", () => {
  it("keeps amount-different model suggestions unresolved instead of hiding the adjustment", async () => {
    const { ctx } = context(["2026-01-01,Acme services,100,R1"], ["2026-01-05,Acme services,99,T1"], [matchReply("erp-001", "bank-001")]);
    const result = await run(ctx, "match");
    const output = result.output as ReconMatchResult;
    expect(output.matchedPairs).toHaveLength(0);
    expect(output.unmatchedErp).toHaveLength(1);
    expect(output.unmatchedBank).toHaveLength(1);
    expect(result.reasoning).toContain("unequal amounts remain unresolved");
  });

  it("accepts an equal-amount candidate after model adjudication", async () => {
    const { ctx } = context(["2026-01-01,Acme services,100,R1"], ["2026-01-05,Acme services,100,T1"], [matchReply("erp-001", "bank-001")]);
    const output = (await run(ctx, "match")).output as ReconMatchResult;
    expect(output.matchedPairs).toHaveLength(1);
    expect(output.unmatchedErp).toHaveLength(0);
    expect(output.unmatchedBank).toHaveLength(0);
  });

  it("rejects a model pairing of real IDs that was not a provided candidate", async () => {
    const bad = matchReply("erp-001", "bank-002");
    const { ctx } = context(["2026-01-01,Acme services,100,R1"], ["2026-01-05,Acme services,100,T1", "2026-01-05,Other goods,900,T2"], [bad, bad]);
    await expect(run(ctx, "match")).rejects.toThrow(/not a provided candidate/);
    expect(ctx.llm).toHaveBeenCalledTimes(2);
  });

  it("never reports CLEAN for a nonzero net difference even with a stale match output", async () => {
    const { ctx } = context(["2026-01-01,Acme services,100,R1"], ["2026-01-01,Acme services,99,T1"], [{ reasoning: "r", narrative: "Difference requires review." }]);
    ctx.priorOutputs.match = emptyMatches;
    const result = (await run(ctx, "report")).output as ReconReportSummary;
    expect(result.status).toBe("EXCEPTIONS_FOUND");
    expect(result.netDifferenceCents).toBe(100);
  });

  it("fails before narration when total cents exceed the supported exact range", async () => {
    const { ctx } = context(["2026-01-01,A,90071992547409.91,R1", "2026-01-02,B,0.01,R2"], ["2026-01-01,A,1,T1"]);
    ctx.priorOutputs.match = emptyMatches;
    await expect(run(ctx, "report")).rejects.toThrow(/exact-integer range/);
    expect(ctx.llm).not.toHaveBeenCalled();
  });

  it("rejects a net-difference overflow even when each source total is in range", async () => {
    const { ctx } = context(["2026-01-01,A,90071992547409.91,R1"], ["2026-01-01,A,-0.01,T1"]);
    ctx.priorOutputs.match = emptyMatches;
    await expect(run(ctx, "report")).rejects.toThrow(/exact-integer range/);
  });

  it("refuses incomplete input files before matching", async () => {
    const { ctx } = context(["2026-01-01,A,100,R1", "invalid,B,100,R2"], ["2026-01-01,A,100,T1"]);
    await expect(run(ctx, "parse_erp")).rejects.toThrow(/rejected rows/);
  });
});

describe("reconciliation verifier calendar and monetary boundaries", () => {
  const action = (payload: Record<string, unknown>): ProposedAction => ({
    actionKey: "m:1", actionType: "reconciliation_match", riskClass: "read",
    target: { kind: "match", id: "m1", counterparty: null, amountCents: null }, summary: "Match",
    payload: { erpId: "e1", bankId: "b1", erpAmountCents: 100, bankAmountCents: 100, erpDate: "2026-01-01", bankDate: "2026-01-01", ...payload },
  });
  const context = { files: {}, priorOutputs: {}, policy: DEFAULT_VERIFICATION_POLICY };

  it("rejects dates that Date.UTC would otherwise roll into another month", () => {
    expect(verifyReconciliationMatch(action({ erpDate: "2026-02-30", bankDate: "2026-03-02" }), context).pass).toBe(false);
    expect(verifyReconciliationMatch(action({ erpDate: "2024-02-29", bankDate: "2024-02-29" }), context).pass).toBe(true);
  });

  it("reports the exact difference across the full signed cents range", () => {
    const verdict = verifyReconciliationMatch(action({ erpAmountCents: Number.MAX_SAFE_INTEGER, bankAmountCents: -Number.MAX_SAFE_INTEGER }), context);
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain("18014398509481982c");
  });

  it("fails closed on malformed tolerance policy", () => {
    expect(verifyReconciliationMatch(action({}), { ...context, policy: { ...context.policy, matchAmountToleranceCents: Number.NaN } }).pass).toBe(false);
    expect(verifyReconciliationMatch(action({}), { ...context, policy: { ...context.policy, matchDateWindowDays: -1 } }).pass).toBe(false);
  });
});
