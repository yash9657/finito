import { describe, expect, it, vi } from "vitest";
import { fpaCommentarySteps } from "@/lib/agents/fpa-commentary";
import { parseFile } from "@/lib/csv/parser";
import type { FpaLine, FpaOutput, LlmFn, StepContext } from "@/lib/types";

function context(budget: string[], actuals: string[], replies: unknown[] = []) {
  const calls: { system: string; user: string }[] = [];
  const llm: LlmFn = async (opts) => {
    calls.push({ system: opts.system, user: opts.user });
    return {
      data: opts.schema.parse(replies.shift()), reasoning: "Source facts only.",
      meta: { providerId: "fireworks", modelUsed: "test", tokensIn: 1, tokensOut: 1, latencyMs: 1, raw: null },
    };
  };
  const ctx: StepContext = {
    workflowId: "test", db: {} as StepContext["db"], approvals: new Map(), priorOutputs: {}, llm: vi.fn(llm) as LlmFn,
    files: {
      budget: parseFile(["department,category,budget,period", ...budget].join("\n"), "budget"),
      actuals: parseFile(["department,category,actual,period", ...actuals].join("\n"), "actuals"),
    },
  };
  return { ctx, calls };
}

async function run(ctx: StepContext, key: string) {
  const result = await fpaCommentarySteps.find((step) => step.key === key)!.run(ctx);
  ctx.priorOutputs[key] = result.output;
  return result;
}

async function compute(ctx: StepContext) {
  await run(ctx, "parse_join");
  return (await run(ctx, "compute_variances")).output as { variances: FpaLine[] };
}

describe("FP&A deterministic financial controls", () => {
  it("aggregates duplicate dimensions on both sides without losing source values", async () => {
    const { ctx } = context(
      ["Finance,Payroll,100,2026-01", " finance , payroll ,25,2026-01"],
      ["Finance,Payroll,90,2026-01", "Finance,Payroll,40,2026-01"],
    );
    const { variances } = await compute(ctx);
    expect(variances).toHaveLength(1);
    expect(variances[0]).toMatchObject({ department: "Finance", category: "Payroll", budgetedAmountCents: 12500, actualAmountCents: 13000, varianceCents: 500, unjoined: false });
  });

  it("does not collide delimiter-containing dimension keys", async () => {
    const { ctx } = context(["a|b,c,100,2026-01", "a,b|c,200,2026-01"], ["a|b,c,101,2026-01", "a,b|c,202,2026-01"]);
    expect((await compute(ctx)).variances.map((line) => line.varianceCents)).toEqual([100, 200]);
  });

  it("uses signed zero-budget variance, absolute negative-budget denominator and an inclusive 5% threshold", async () => {
    const { ctx } = context(
      ["A,Zero,0,2026-01", "A,Negative,-100,2026-01", "A,Boundary,100,2026-01", "A,Beyond,100,2026-01"],
      ["A,Zero,10,2026-01", "A,Negative,-90,2026-01", "A,Boundary,105,2026-01", "A,Beyond,105.01,2026-01"],
    );
    const { variances } = await compute(ctx);
    expect(variances[0]).toMatchObject({ variancePct: null, direction: "over" });
    expect(variances[1]).toMatchObject({ variancePct: 10, direction: "over" });
    expect(variances[2].direction).toBe("on_track");
    expect(variances[3].direction).toBe("over");
  });

  it("preserves missing-side flags and excludes zero differences from commentary selection", async () => {
    const { ctx } = context(["A,Only budget,100,2026-01", "A,Equal,100,2026-01"], ["A,Only actual,20,2026-01", "A,Equal,100,2026-01"]);
    const { variances } = await compute(ctx);
    expect(variances.filter((line) => line.unjoined)).toHaveLength(2);
    const ranked = (await run(ctx, "rank_variances")).output as { materialVariances: FpaLine[] };
    expect(ranked.materialVariances.map((line) => line.category)).toEqual(["Only budget", "Only actual"]);
  });

  it("fails closed on missing, rejected or unsafe source amounts", async () => {
    const empty = context([], ["A,Payroll,100,2026-01"]).ctx;
    await expect(run(empty, "parse_join")).rejects.toThrow(/no valid rows/);
    const dirty = context(["A,Payroll,100,2026-01", "A,Payroll,invalid,2026-01"], ["A,Payroll,100,2026-01"]).ctx;
    await expect(run(dirty, "parse_join")).rejects.toThrow(/rejected rows/);
    const overflow = context(["A,Payroll,90071992547409.91,2026-01", "A,Payroll,0.01,2026-01"], ["A,Payroll,100,2026-01"]).ctx;
    await expect(run(overflow, "parse_join")).rejects.toThrow(/exact-integer range/);
  });
});

describe("FP&A model output binding", () => {
  const entry = (period: string, commentary: string) => ({ department: "A", category: "Payroll", period, commentary });
  const reply = (varianceComments: unknown[]) => ({ reasoning: "r", varianceComments, overallStatus: "favorable" });

  it("binds comments to the period and keeps favorability neutral without account types", async () => {
    const { ctx, calls } = context(
      ["A,Payroll,100,2026-01", "A,Payroll,200,2026-02"],
      ["A,Payroll,110,2026-01", "A,Payroll,220,2026-02"],
      [reply([entry("2026-02", "February cause unconfirmed."), entry("2026-01", "January cause unconfirmed.")]), { reasoning: "r", executiveSummary: "Two reporting periods.", departmentSummaries: [{ department: "A", summary: "Above budget." }] }],
    );
    await compute(ctx);
    await run(ctx, "rank_variances");
    const commentary = await run(ctx, "commentary");
    expect(commentary.reasoning).toContain("favorability cannot be determined");
    const result = (await run(ctx, "board_deck")).output as FpaOutput;
    expect(result.overallStatus).toBe("mixed");
    expect(result.variances.map((line) => line.commentary)).toEqual(["January cause unconfirmed.", "February cause unconfirmed."]);
    expect(JSON.parse(calls[1].user).periods).toEqual(["2026-01", "2026-02"]);
  });

  it("retries unknown/duplicate commentary keys and never silently drops them", async () => {
    const bad = reply([entry("2026-02", "Wrong period")]);
    const { ctx } = context(["A,Payroll,100,2026-01"], ["A,Payroll,110,2026-01"], [bad, bad]);
    await compute(ctx);
    await run(ctx, "rank_variances");
    await expect(run(ctx, "commentary")).rejects.toThrow(/post-validation after retry/);
    expect(ctx.llm).toHaveBeenCalledTimes(2);
  });

  it("serializes the largest supported amount without dropping a cent", async () => {
    const { ctx, calls } = context(["A,Payroll,90071992547409.91,2026-01"], ["A,Payroll,90071992547408.91,2026-01"], [reply([entry("2026-01", "Cause unconfirmed.")])]);
    await compute(ctx);
    await run(ctx, "rank_variances");
    await run(ctx, "commentary");
    expect(JSON.parse(calls[0].user).materialVariances[0].budget).toBe("90071992547409.91");
  });

  it("skips commentary generation when all differences are zero", async () => {
    const { ctx } = context(["A,Payroll,100,2026-01"], ["A,Payroll,100,2026-01"]);
    await compute(ctx);
    await run(ctx, "rank_variances");
    expect((await run(ctx, "commentary")).output).toMatchObject({ varianceComments: [], materialVariances: [] });
    expect(ctx.llm).not.toHaveBeenCalled();
  });
});
