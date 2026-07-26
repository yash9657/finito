/**
 * Agent loop tests (Plan 5, G3 — D-G1/D-G9/D-G16/D-G22).
 *
 * The model is scripted rather than mocked loosely: each test hands the loop an exact sequence of
 * turns and asserts what the loop did with them. That is the only way to test the properties that
 * matter, all of which are about the loop's behaviour rather than the model's:
 *
 *   - it always terminates, and always says why;
 *   - the event trail pairs each observation with its action (`caused_by`);
 *   - a repeated call is refused with a correctable message rather than silently broken;
 *   - a model that cannot call tools is refused BEFORE turn 1, not after twenty;
 *   - the answer's figures come from code.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The scripted turns, consumed in order by the mocked `dispatchTools`. */
interface ScriptedTurn {
  content: string;
  toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[];
  tokensIn?: number;
  tokensOut?: number;
}

const script: ScriptedTurn[] = [];
let dispatchCalls: { stepKey: string; toolNames: string[]; toolCount: number }[] = [];
let capabilityOverride: Partial<{ toolCalling: boolean; contextWindow: number; parallelToolCalls: boolean }> = {};
let resolutionFailure: string | null = null;

vi.mock("@/lib/llm/router", () => ({
  resolveInvestigatorModel: vi.fn(async () => {
    if (resolutionFailure) return { ok: false, reason: resolutionFailure };
    return {
      ok: true,
      providerId: "anthropic",
      model: "claude-opus-5",
      capabilities: {
        contextWindow: capabilityOverride.contextWindow ?? 1_000_000,
        maxOutputTokens: 16_000,
        toolCalling: capabilityOverride.toolCalling ?? true,
        parallelToolCalls: capabilityOverride.parallelToolCalls ?? true,
        vision: true,
        source: "vendored" as const,
        matched: "claude-opus-5",
      },
    };
  }),
  dispatchTools: vi.fn(async (_db: unknown, args: { stepKey: string; tools: { name: string }[] }) => {
    dispatchCalls.push({
      stepKey: args.stepKey,
      toolNames: args.tools.map((t) => t.name),
      toolCount: args.tools.length,
    });
    const turn = script.shift() ?? { content: "" };
    return {
      content: turn.content,
      toolCalls: turn.toolCalls ?? [],
      stopReason: (turn.toolCalls?.length ?? 0) > 0 ? "tool_use" : "end",
      sidecar: undefined,
      meta: {
        providerId: "anthropic",
        modelUsed: "claude-opus-5",
        tokensIn: turn.tokensIn ?? 100,
        tokensOut: turn.tokensOut ?? 50,
        latencyMs: 10,
        raw: {},
      },
      capabilities: {
        contextWindow: capabilityOverride.contextWindow ?? 1_000_000,
        maxOutputTokens: 16_000,
        toolCalling: true,
        parallelToolCalls: true,
        vision: true,
        source: "vendored" as const,
        matched: "claude-opus-5",
      },
      droppedSidecars: [],
    };
  }),
}));

import { runInvestigation, clampBudget, BUDGET_CEILINGS } from "@/lib/harness/agent/loop";
import { loadFixtureDatasets, makeFakeDb, FIXTURE_WORKFLOW_ID } from "@/lib/harness/agent/fixtures";

const datasets = loadFixtureDatasets(["erp_export", "bank_statement"]);
/** The whole demo set, for the recommendation-cap test — it needs real invoices and POs. */
const fullDatasets = loadFixtureDatasets();

/** A well-formed answer JSON citing two real rows. */
function answerJson(): string {
  const [a, b] = datasets.rows;
  return JSON.stringify({
    prose: "Two entries did not clear, totalling {{gap}}.",
    findings: [{ statement: "Two entries did not clear", sourceIds: [a.sourceId, b.sourceId] }],
    figures: [
      { ref: "gap", label: "Gap", operation: "sum", sourceIds: [a.sourceId, b.sourceId] },
    ],
    citations: [{ sourceId: a.sourceId, note: "First" }],
  });
}

function run(budget?: Parameters<typeof runInvestigation>[0]["budget"]) {
  const { db, state } = makeFakeDb();
  return {
    state,
    promise: runInvestigation({
      db,
      workflowId: FIXTURE_WORKFLOW_ID,
      orgId: "org-1",
      question: "Why doesn't the bank account tie out?",
      datasets,
      budget,
    }),
  };
}

beforeEach(() => {
  script.length = 0;
  dispatchCalls = [];
  capabilityOverride = {};
  resolutionFailure = null;
});
afterEach(() => {
  vi.clearAllMocks();
});

/* -------------------------------------------------------------------------- */

describe("a complete investigation", () => {
  it("calls tools, then answers with figures computed in code", async () => {
    script.push(
      { content: "Let me see what data exists.", toolCalls: [{ id: "c1", name: "list_datasets", arguments: {} }] },
      {
        content: "Now the ERP totals.",
        toolCalls: [{ id: "c2", name: "query_ledger", arguments: { datasets: ["erp_export"] } }],
      },
      { content: "I have enough." },
      { content: answerJson() },
    );

    const { state, promise } = run();
    const outcome = await promise;

    expect(outcome.status).toBe("answered");
    expect(outcome.reason).toBe("answered");
    expect(outcome.answer?.partial).toBe(false);

    // The figure came from summing the cited rows, not from the model.
    const [a, b] = datasets.rows;
    expect(outcome.answer?.figures[0].valueCents).toBe(a.amountCents + b.amountCents);
    expect(outcome.answer?.prose).not.toContain("{{gap}}");

    // The full lifecycle is on the trail.
    const types = state.events.map((e) => e.eventType);
    expect(types).toContain("agent_turn_started");
    expect(types).toContain("agent_reasoning");
    expect(types).toContain("tool_called");
    expect(types).toContain("tool_returned");
    expect(types).toContain("agent_answered");
  });

  it("pairs every observation with the action that caused it (D-G9)", async () => {
    script.push(
      {
        content: "Checking two things at once.",
        toolCalls: [
          { id: "c1", name: "list_datasets", arguments: {} },
          { id: "c2", name: "query_ledger", arguments: { datasets: ["erp_export"] } },
        ],
      },
      { content: "Done." },
      { content: answerJson() },
    );

    const { state, promise } = run();
    await promise;

    const calls = state.events.filter((e) => e.eventType === "tool_called");
    const returns = state.events.filter((e) => e.eventType === "tool_returned");
    expect(calls).toHaveLength(2);
    expect(returns).toHaveLength(2);

    // Ordering alone cannot express this pairing when a turn issues parallel calls — which is
    // exactly why `caused_by` exists.
    const callIds = new Set(state.events.filter((e) => e.eventType === "tool_called").map((_, i) => `evt-${i}`));
    expect(callIds.size).toBeGreaterThan(0);
    for (const ret of returns) {
      expect(ret.causedBy).toBeTruthy();
      const cause = state.events.find(
        (e, i) => `evt-${i + 1}` === ret.causedBy && e.eventType === "tool_called",
      );
      expect(cause, "every tool_returned cites a tool_called").toBeTruthy();
      expect(cause?.payload.tool_call_id).toBe(ret.payload.tool_call_id);
    }
  });

  it("stamps a turn number on every agent event, so the UI can group", async () => {
    script.push(
      { content: "One.", toolCalls: [{ id: "c1", name: "list_datasets", arguments: {} }] },
      { content: "Two." },
      { content: answerJson() },
    );
    const { state, promise } = run();
    await promise;

    for (const event of state.events.filter((e) => e.eventType.startsWith("agent_") || e.eventType.startsWith("tool_"))) {
      expect(event.turnNumber).not.toBeNull();
    }
  });
});

describe("bounds — it always terminates, and always says why (D-G22)", () => {
  it("stops at maxTurns and returns a PARTIAL answer", async () => {
    // A model that never stops calling tools.
    for (let i = 0; i < 10; i++) {
      script.push({
        content: `Turn ${i}`,
        toolCalls: [{ id: `c${i}`, name: "query_ledger", arguments: { datasets: ["erp_export"], minAmountCents: i } }],
      });
    }
    script.push({ content: answerJson() });

    const { state, promise } = run({ maxTurns: 3 });
    const outcome = await promise;

    expect(outcome.reason).toBe("max_turns");
    expect(outcome.turnsUsed).toBe(3);
    // A partial answer that says it is partial, never a silent stop.
    expect(outcome.answer?.partial).toBe(true);
    const terminated = state.events.find((e) => e.eventType === "agent_terminated");
    expect(terminated?.payload.reason).toBe("max_turns");
    expect(String(terminated?.payload.detail)).toContain("3-turn limit");
  });

  it("stops on the token bound", async () => {
    for (let i = 0; i < 5; i++) {
      script.push({
        content: `Turn ${i}`,
        toolCalls: [{ id: `c${i}`, name: "query_ledger", arguments: { minAmountCents: i } }],
        tokensIn: 5_000,
        tokensOut: 5_000,
      });
    }
    script.push({ content: answerJson() });

    const outcome = await run({ maxTokens: 12_000 }).promise;
    expect(outcome.reason).toBe("max_tokens");
  });

  it("caps recommendations for the whole run, not just per turn", async () => {
    // From a real run: asked "is anything ready for payment?", the agent queued FIFTEEN payment
    // approvals across three turns. Every one was verified and left pending a human, so the
    // safety property held — but a queue of fifteen near-identical approvals is how reviewers
    // are trained to rubber-stamp. The prompt asked for restraint and did not get it, so the
    // bound has to be in the loop.
    // Real invoice rows, so each call genuinely queues — the cap counts SUCCESSFUL queues,
    // because it exists to protect a reviewer's attention and a rejected proposal never
    // reaches one.
    const invoices = fullDatasets.rows.filter((r) => r.dataset === "invoice").slice(0, 8);
    const base = { actionType: "approve_invoice_payment", summary: "s", rationale: "r" };
    for (let turn = 0; turn < 4; turn++) {
      script.push({
        content: `Queueing ${turn}`,
        toolCalls: [
          {
            id: `c${turn}a`,
            name: "recommend_action",
            arguments: { ...base, sourceId: invoices[turn * 2].sourceId },
          },
          {
            id: `c${turn}b`,
            name: "recommend_action",
            arguments: { ...base, sourceId: invoices[turn * 2 + 1].sourceId },
          },
        ],
      });
    }
    script.push({ content: "done" }, { content: answerJson() });

    const { db, state } = makeFakeDb();
    await runInvestigation({
      db,
      workflowId: FIXTURE_WORKFLOW_ID,
      orgId: "org-1",
      question: "Is anything ready for payment?",
      datasets: fullDatasets,
      budget: { maxRecommendations: 2, maxTurns: 5 },
    });

    const refused = state.events.filter(
      (e) => e.eventType === "tool_called" && e.payload.refused === "recommendation_limit",
    );
    expect(refused.length).toBeGreaterThan(0);
    expect(refused[0].payload.limit).toBe(2);
  });

  it("caps tool calls per turn and REFUSES the extras rather than dropping them", async () => {
    // Every call must be answered or the next request is malformed.
    script.push(
      {
        content: "Six at once.",
        toolCalls: Array.from({ length: 6 }, (_, i) => ({
          id: `c${i}`,
          name: "query_ledger",
          arguments: { minAmountCents: i },
        })),
      },
      { content: "Done." },
      { content: answerJson() },
    );

    const { state, promise } = run({ maxToolCallsPerTurn: 2 });
    await promise;
    // Only the first two ran.
    expect(state.events.filter((e) => e.eventType === "tool_called")).toHaveLength(2);
  });
});

describe("loop detection (D-G22)", () => {
  it("refuses the third identical call and TELLS the model why", async () => {
    const repeat = { id: "c", name: "query_ledger", arguments: { datasets: ["erp_export"] } };
    script.push(
      { content: "1", toolCalls: [{ ...repeat, id: "c1" }] },
      { content: "2", toolCalls: [{ ...repeat, id: "c2" }] },
      { content: "3", toolCalls: [{ ...repeat, id: "c3" }] },
      { content: "ok" },
      { content: answerJson() },
    );

    const { state, promise } = run();
    await promise;

    const refused = state.events.find(
      (e) => e.eventType === "tool_called" && e.payload.refused === "repeated_call",
    );
    // A silent break would look to the model like a tool that stopped working.
    expect(refused).toBeTruthy();
    expect(refused?.payload.repeat_count).toBe(3);
  });

  it("treats argument key ORDER as the same call", async () => {
    script.push(
      { content: "1", toolCalls: [{ id: "c1", name: "query_ledger", arguments: { a: 1, b: 2 } }] },
      { content: "2", toolCalls: [{ id: "c2", name: "query_ledger", arguments: { b: 2, a: 1 } }] },
      { content: "3", toolCalls: [{ id: "c3", name: "query_ledger", arguments: { a: 1, b: 2 } }] },
      { content: "ok" },
      { content: answerJson() },
    );
    const { state, promise } = run();
    await promise;
    expect(
      state.events.some((e) => e.payload.refused === "repeated_call"),
    ).toBe(true);
  });

  it("terminates after three consecutive stuck turns", async () => {
    const repeat = { name: "query_ledger", arguments: { datasets: ["erp_export"] } };
    for (let i = 0; i < 8; i++) script.push({ content: `${i}`, toolCalls: [{ id: `c${i}`, ...repeat }] });
    script.push({ content: answerJson() });

    const outcome = await run().promise;
    expect(outcome.reason).toBe("loop_detected");
  });
});

describe("refusing to start (D-G16)", () => {
  it("refuses BEFORE turn 1 when the model cannot call tools", async () => {
    resolutionFailure =
      'Model "text-embedding-3-large" on provider "openai" does not support tool calling';

    const { state, promise } = run();
    const outcome = await promise;

    expect(outcome.status).toBe("failed");
    expect(outcome.reason).toBe("no_tool_support");
    expect(outcome.turnsUsed).toBe(0);
    // Not a single turn was spent, and the reason names the model.
    expect(state.events.filter((e) => e.eventType === "agent_turn_started")).toHaveLength(0);
    expect(outcome.error).toContain("text-embedding-3-large");
  });
});

describe("compaction inside the loop (D-G22)", () => {
  it("compacts when the window demands it and records what was dropped", async () => {
    // A tiny window forces compaction after a couple of turns.
    capabilityOverride = { contextWindow: 900 };
    for (let i = 0; i < 6; i++) {
      script.push({
        content: `Turn ${i} `.repeat(50),
        toolCalls: [{ id: `c${i}`, name: "query_ledger", arguments: { minAmountCents: i } }],
      });
    }
    script.push({ content: "{}" }, { content: answerJson() });

    const { state, promise } = run({ maxTurns: 6 });
    await promise;

    const compacted = state.events.find((e) => e.eventType === "context_compacted");
    expect(compacted).toBeTruthy();
    expect(Number(compacted?.payload.dropped_messages)).toBeGreaterThan(0);
    expect(Number(compacted?.payload.estimated_tokens_after)).toBeLessThan(
      Number(compacted?.payload.estimated_tokens_before),
    );
  });
});

describe("the answering turn", () => {
  it("offers NO tools when asking for the final answer", async () => {
    // Offering tools there invites another round of exploration past the budget.
    script.push({ content: "Done." }, { content: answerJson() });
    await run().promise;

    const answering = dispatchCalls.filter((c) => c.stepKey === "investigate_answer");
    expect(answering.length).toBeGreaterThan(0);
    for (const call of answering) expect(call.toolCount).toBe(0);
  });

  it("retries once with a correction, then succeeds", async () => {
    const badAnswer = JSON.stringify({
      prose: "The gap is $4,120.00.", // a currency literal the model wrote itself
      findings: [],
      figures: [],
      citations: [],
    });
    script.push({ content: "Done." }, { content: badAnswer }, { content: answerJson() });

    const outcome = await run().promise;
    expect(outcome.status).toBe("answered");
    expect(outcome.answer?.figures).toHaveLength(1);
  });

  it("marks an answer UNVERIFIED when validation fails twice", async () => {
    const bad = JSON.stringify({
      prose: "The gap is $4,120.00.",
      findings: [],
      figures: [],
      citations: [],
    });
    script.push({ content: "Done." }, { content: bad }, { content: bad });

    const outcome = await run().promise;
    // Surfacing unvalidated numbers as though they were checked is the failure D-G14 prevents.
    expect(outcome.answer?.prose).toContain("UNVERIFIED");
    expect(outcome.answer?.figures).toEqual([]);
    expect(outcome.answer?.partial).toBe(true);
  });

  it("recovers an answer wrapped in a fenced block", async () => {
    script.push({ content: "Done." }, { content: "Here you go:\n```json\n" + answerJson() + "\n```" });
    const outcome = await run().promise;
    expect(outcome.status).toBe("answered");
  });
});

describe("clampBudget", () => {
  it("clamps to the non-negotiable ceilings", () => {
    const clamped = clampBudget({
      maxTurns: 10_000,
      maxRecommendations: 100,
      maxTokens: 999_999_999,
      maxWallClockMs: 86_400_000,
      maxToolCallsPerTurn: 100,
    });
    expect(clamped).toEqual(BUDGET_CEILINGS);
  });

  it("lets an org tighten but not loosen", () => {
    expect(clampBudget({ maxTurns: 5 }).maxTurns).toBe(5);
    expect(clampBudget({ maxTurns: 500 }).maxTurns).toBe(BUDGET_CEILINGS.maxTurns);
  });

  it("falls back to the minimum on a nonsense value", () => {
    expect(clampBudget({ maxTurns: Number.NaN }).maxTurns).toBe(1);
  });
});

