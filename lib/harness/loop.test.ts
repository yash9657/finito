/**
 * Tests for the action/observation loop (Plan 4 §1, D-H8 … D-H10).
 *
 * These assert on the EVENT SEQUENCE, not just on return values, because the sequence is
 * the product: a step that returns the right answer while emitting an incomplete trail has
 * failed at the thing this architecture exists to do.
 *
 * Covers the brief's Part 8 verification gate directly: an unbalanced journal entry is
 * rejected BEFORE execution, and the trail proves nothing executed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { executeStep } from "@/lib/harness/loop";
import {
  BOOK_JOURNAL_ENTRY,
  NORMALIZE_DATASET,
  WRITE_COMMENTARY,
} from "@/lib/harness/action-types";
import type {
  DagStepDefinition,
  HarnessEventType,
  ParsedFile,
  ProposedAction,
  StepContext,
  StepResult,
} from "@/lib/types";

/* -------------------------------------------------------------------------- */
/* Fakes: the RPC records events; approvals tables start empty.                */
/* -------------------------------------------------------------------------- */

type Row = Record<string, unknown>;

let events: Row[] = [];

/** Pending action keys the fake approvals gate should report as unresolved. */
let gatePending: string[] = [];

vi.mock("@/lib/approvals/service", () => ({
  gateStepActions: vi.fn(async (_db: unknown, args: { actions: ProposedAction[] }) =>
    args.actions.map((a) => ({
      id: `ar-${a.actionKey}`,
      action_key: a.actionKey,
      action_type: a.actionType,
      summary: a.summary,
      status: gatePending.includes(a.actionKey) ? "pending" : "auto_approved",
    })),
  ),
  decisionMap: vi.fn(() => new Map()),
}));

function fakeDb(): SupabaseClient {
  return {
    rpc: (_fn: string, args: Row) => ({
      single: async () => {
        const row: Row = {
          id: `ev-${events.length + 1}`,
          workflow_id: args.p_workflow_id,
          step_id: args.p_step_id,
          step_key: args.p_step_key,
          sequence_number: events.length + 1,
          event_type: args.p_event_type,
          actor: args.p_actor,
          payload: args.p_payload,
          provider_used: args.p_provider_used,
          model_used: args.p_model_used,
          input_hash: args.p_input_hash,
          created_at: new Date(2026, 0, 1).toISOString(),
        };
        events.push(row);
        return { data: row, error: null };
      },
    }),
  } as unknown as SupabaseClient;
}

const db = fakeDb();

function parsedFile(overrides: Partial<ParsedFile> = {}): ParsedFile {
  return {
    rows: [{ id: "e1", date: "2026-01-05", description: "ACME", amountCents: 12_500 }],
    errors: [],
    meta: {
      filename: "erp.csv",
      fileType: "erp_export",
      sha256: "abc123",
      rowCount: 1,
      skippedCount: 0,
    },
    ...overrides,
  } as ParsedFile;
}

/** A minimal deterministic parser step. */
function parserStep(over: Partial<DagStepDefinition> = {}): DagStepDefinition {
  return {
    key: "parse_erp",
    stepNumber: 1,
    dependsOn: [],
    role: "parser",
    track: "A",
    name: "Parse ERP export",
    kind: "deterministic",
    fileType: "erp_export",
    async run(): Promise<StepResult> {
      return {
        output: parsedFile(),
        reasoning: "Parsed 1 row from erp.csv.",
        sources: [{ file: "erp.csv", note: "sha256:abc123 — 1 valid row" }],
      };
    },
    ...over,
  } as DagStepDefinition;
}

const baseArgs = () => ({
  db,
  workflowId: "wf-1",
  orgId: "org-1",
  workflowType: "reconciliation" as const,
  stepId: "step-1",
  files: { erp_export: parsedFile() },
  priorOutputs: {},
});

const types = (): HarnessEventType[] => events.map((e) => e.event_type as HarnessEventType);
const payloadOf = (t: HarnessEventType) =>
  events.find((e) => e.event_type === t)?.payload as Row | undefined;

beforeEach(() => {
  events = [];
  gatePending = [];
});

/* -------------------------------------------------------------------------- */

describe("the happy path emits the full lifecycle (D-H8)", () => {
  it("runs propose → verify → execute → observe in order", async () => {
    const outcome = await executeStep({ ...baseArgs(), def: parserStep() });

    expect(outcome.status).toBe("completed");
    expect(types()).toEqual([
      "step_started",
      "action_proposed",
      "action_verified",
      "action_executed",
      "observation_received",
      "step_completed",
    ]);
  });

  it("synthesizes the role's own action for a read step, so no step skips the gate", async () => {
    await executeStep({ ...baseArgs(), def: parserStep() });

    const proposed = payloadOf("action_proposed")!;
    expect(proposed.action_type).toBe(NORMALIZE_DATASET);
    expect(proposed.proposed_by_role).toBe("parser");
    // Bound to specific bytes — the trail cannot later be reconciled against another file.
    expect((proposed.params as Row).expectedSha256).toBe("abc123");
  });

  it("stamps every event with the same input hash", async () => {
    await executeStep({ ...baseArgs(), def: parserStep() });

    const hashes = new Set(events.map((e) => e.input_hash).filter(Boolean));
    expect(hashes.size).toBe(1);
    expect([...hashes][0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("attributes a deterministic step to `system`, with no model on the trail", async () => {
    await executeStep({ ...baseArgs(), def: parserStep() });

    const executed = events.find((e) => e.event_type === "action_executed")!;
    expect(executed.actor).toBe("system");
    expect(executed.provider_used).toBeNull();
    expect(executed.model_used).toBeNull();
  });

  it("derives observation metrics from the output's own shape", async () => {
    const def = parserStep({
      async run(): Promise<StepResult> {
        return {
          output: { matched: [1, 2, 3], unmatched: [4, 5] },
          reasoning: "3 of 5 transactions matched, 2 flagged.",
          sources: [],
        };
      },
    });
    await executeStep({ ...baseArgs(), def });

    const obs = payloadOf("observation_received")!;
    expect(obs.summary).toBe("3 of 5 transactions matched, 2 flagged.");
    expect(obs.metrics).toMatchObject({ matched: 3, unmatched: 2 });
  });
});

/* -------------------------------------------------------------------------- */

describe("verification blocks a bad action before execution (the Part 8 gate)", () => {
  /** A classifier step proposing an unbalanced journal entry. */
  function unbalancedEntryStep(): DagStepDefinition {
    return {
      key: "post_entry",
      stepNumber: 2,
      dependsOn: [],
      role: "classifier",
      track: "main",
      name: "Post adjusting entry",
      kind: "deterministic",
      risk: "writes_ledger",
      async proposeActions(): Promise<ProposedAction[]> {
        return [
          {
            actionKey: "book_journal_entry:je-1",
            actionType: BOOK_JOURNAL_ENTRY,
            riskClass: "writes_ledger",
            target: { kind: "journal_entry", id: "je-1", counterparty: null, amountCents: 50_000 },
            summary: "Adjusting entry for bank fees",
            payload: {
              lines: [
                { accountCode: "6000", debitCents: 50_000 },
                { accountCode: "1000", creditCents: 49_900 }, // off by $1.00
              ],
            },
          },
        ];
      },
      async run(): Promise<StepResult> {
        throw new Error("run() must never be reached for an unverified action");
      },
    } as DagStepDefinition;
  }

  it("rejects an unbalanced entry and never executes it", async () => {
    const outcome = await executeStep({
      ...baseArgs(),
      def: unbalancedEntryStep(),
      chartOfAccounts: new Set(["6000", "1000"]),
    });

    expect(outcome.status).toBe("verification_failed");
    if (outcome.status !== "verification_failed") throw new Error("unreachable");
    expect(outcome.reasons[0]).toMatch(/does not balance.*off by 100c/);

    // The trail proves it: verified/executed never appear, and the step failed at verification.
    expect(types()).toEqual([
      "step_started",
      "action_proposed",
      "action_failed_verification",
      "step_failed",
    ]);
    expect(types()).not.toContain("action_executed");
  });

  it("does not ask a human about a machine-rejectable action", async () => {
    await executeStep({
      ...baseArgs(),
      def: unbalancedEntryStep(),
      chartOfAccounts: new Set(["6000", "1000"]),
    });
    // Reviewers shown garbage learn to click through it. A failed verification is not a
    // borderline judgement call, so it must not reach the review queue.
    expect(types()).not.toContain("human_review_requested");
  });

  it("rejects an entry citing an unknown account code", async () => {
    const def = unbalancedEntryStep();
    const outcome = await executeStep({
      ...baseArgs(),
      def,
      chartOfAccounts: new Set(["6000"]), // 1000 is absent
    });
    expect(outcome.status).toBe("verification_failed");
    if (outcome.status !== "verification_failed") throw new Error("unreachable");
    expect(outcome.reasons[0]).toMatch(/Unknown account code: 1000/);
  });

  it("fails closed for an action type with no registered verifier", async () => {
    const def = {
      ...parserStep(),
      role: "parser" as const,
      async proposeActions(): Promise<ProposedAction[]> {
        return [
          {
            actionKey: "x:1",
            actionType: NORMALIZE_DATASET,
            riskClass: "read" as const,
            target: { kind: "dataset", id: "nope", counterparty: null, amountCents: null },
            summary: "normalize a file that was never uploaded",
            payload: { fileType: "nope" },
          },
        ];
      },
      risk: "read" as const,
    } as unknown as DagStepDefinition;

    // `read` risk + proposeActions would fail validateDag in a real graph; here it exercises
    // the verifier directly. The dataset verifier must reject an unknown file type.
    const outcome = await executeStep({ ...baseArgs(), def });
    expect(outcome.status).toBe("verification_failed");
  });

  it("rejects a parse that yielded zero rows rather than reporting a clean result", async () => {
    const empty = parsedFile({ rows: [], meta: { ...parsedFile().meta, rowCount: 0, skippedCount: 4 } });
    const outcome = await executeStep({
      ...baseArgs(),
      files: { erp_export: empty },
      def: parserStep(),
    });

    expect(outcome.status).toBe("verification_failed");
    if (outcome.status !== "verification_failed") throw new Error("unreachable");
    expect(outcome.reasons[0]).toMatch(/0 usable rows/);
  });
});

/* -------------------------------------------------------------------------- */

describe("role constraints are enforced in code (D-H15)", () => {
  it("a writer cannot propose a journal entry, however it was configured", async () => {
    const def = {
      key: "report",
      stepNumber: 5,
      dependsOn: [],
      role: "writer" as const,
      track: "main",
      name: "Generate report",
      kind: "deterministic" as const,
      // Risk stays `read`, which IS legal for a writer. That is the point: the action-type
      // constraint does not depend on the risk declaration, so mislabelling the step cannot
      // be used to smuggle an out-of-role action past it.
      risk: "read" as const,
      async proposeActions(): Promise<ProposedAction[]> {
        return [
          {
            actionKey: "book_journal_entry:je-9",
            actionType: BOOK_JOURNAL_ENTRY,
            riskClass: "writes_ledger" as const,
            target: { kind: "journal_entry", id: "je-9", counterparty: null, amountCents: 100 },
            summary: "a writer trying to post to the ledger",
            // Deliberately a perfectly VALID entry: it must be rejected for being
            // out-of-role, not for being malformed.
            payload: {
              lines: [
                { accountCode: "6000", debitCents: 100 },
                { accountCode: "1000", creditCents: 100 },
              ],
            },
          },
        ];
      },
      async run(): Promise<StepResult> {
        throw new Error("run() must never be reached for an out-of-role action");
      },
    } as unknown as DagStepDefinition;

    const outcome = await executeStep({
      ...baseArgs(),
      def,
      chartOfAccounts: new Set(["6000", "1000"]),
    });

    expect(outcome.status).toBe("verification_failed");
    if (outcome.status !== "verification_failed") throw new Error("unreachable");
    expect(outcome.reasons[0]).toMatch(/Role "writer" may not propose "book_journal_entry"/);

    const failure = payloadOf("action_failed_verification")!;
    // Distinguished from a business-rule rejection: this is a programming error.
    expect(failure.failure).toBe("illegal_action_type");
  });

  it("names the role's allowed set in the rejection, so the bug is obvious", async () => {
    const def = {
      ...parserStep(),
      role: "parser" as const,
      risk: "read" as const,
      async proposeActions(): Promise<ProposedAction[]> {
        return [
          {
            actionKey: "w:1",
            actionType: WRITE_COMMENTARY,
            riskClass: "read" as const,
            target: { kind: "analysis", id: "x", counterparty: null, amountCents: null },
            summary: "a parser trying to write prose",
          },
        ];
      },
    } as unknown as DagStepDefinition;

    const outcome = await executeStep({ ...baseArgs(), def });
    expect(outcome.status).toBe("verification_failed");
    if (outcome.status !== "verification_failed") throw new Error("unreachable");
    expect(outcome.reasons[0]).toContain(NORMALIZE_DATASET);
  });
});

/* -------------------------------------------------------------------------- */

describe("the high-risk floor is not overridable (D-H10)", () => {
  /**
   * A large but perfectly valid journal entry — passes verification at `high`.
   *
   * `runnable: false` (the default) makes `run` throw, so a test asserting suspension proves
   * execution never happened rather than merely that the status said so.
   */
  function largeEntryStep(opts: { runnable?: boolean } = {}): DagStepDefinition {
    return {
      key: "post_large",
      stepNumber: 3,
      dependsOn: [],
      role: "classifier" as const,
      track: "main",
      name: "Post large entry",
      kind: "deterministic" as const,
      risk: "writes_ledger" as const,
      async proposeActions(): Promise<ProposedAction[]> {
        return [
          {
            actionKey: "book_journal_entry:big",
            actionType: BOOK_JOURNAL_ENTRY,
            riskClass: "writes_ledger" as const,
            target: {
              kind: "journal_entry",
              id: "big",
              counterparty: null,
              amountCents: 2_500_000,
            },
            summary: "Reclass $25,000",
            payload: {
              lines: [
                { accountCode: "6000", debitCents: 2_500_000 },
                { accountCode: "1000", creditCents: 2_500_000 },
              ],
            },
          },
        ];
      },
      async run(): Promise<StepResult> {
        if (!opts.runnable) {
          throw new Error("run() must never be reached while review is pending");
        }
        return { output: { posted: ["big"] }, reasoning: "Posted 1 entry.", sources: [] };
      },
    } as unknown as DagStepDefinition;
  }

  it("suspends a $25,000 entry even when the org's gate auto-approved it", async () => {
    // gatePending is empty, i.e. authorization CLEARED the action. The floor still holds.
    const outcome = await executeStep({
      ...baseArgs(),
      def: largeEntryStep(),
      chartOfAccounts: new Set(["6000", "1000"]),
    });

    expect(outcome.status).toBe("suspended");
    if (outcome.status !== "suspended") throw new Error("unreachable");
    expect(outcome.pending[0].mandatory).toBe(true);
    expect(outcome.pending[0].reason).toMatch(/review threshold/);

    expect(types()).toEqual([
      "step_started",
      "action_proposed",
      "action_verified", // it PASSED verification — it is legal, just large
      "human_review_requested",
      "workflow_paused",
    ]);
    expect(types()).not.toContain("action_executed");
  });

  it("marks an already-pending action mandatory so no standing rule can clear it on resume", async () => {
    gatePending = ["book_journal_entry:big"];
    const outcome = await executeStep({
      ...baseArgs(),
      def: largeEntryStep(),
      chartOfAccounts: new Set(["6000", "1000"]),
    });

    if (outcome.status !== "suspended") throw new Error("expected suspension");
    expect(outcome.pending).toHaveLength(1);
    expect(outcome.pending[0].mandatory).toBe(true);
    // Both reasons are preserved — the authorization one and the floor.
    expect(outcome.pending[0].reason).toMatch(/authorization/);
    expect(outcome.pending[0].reason).toMatch(/threshold/);
  });

  it("respects a raised threshold — configurable in degree, not in existence", async () => {
    const outcome = await executeStep({
      ...baseArgs(),
      def: largeEntryStep({ runnable: true }),
      chartOfAccounts: new Set(["6000", "1000"]),
      policy: {
        matchAmountToleranceCents: 100,
        matchDateWindowDays: 3,
        apVarianceFraction: 0.02,
        journalEntryReviewThresholdCents: 10_000_000, // $100k
      },
    });
    // Below the raised threshold, so it proceeds — but the entry still had to be valid.
    expect(outcome.status).toBe("completed");
  });
});

/* -------------------------------------------------------------------------- */

describe("authorization suspension (Plan 3 D-A3, via the loop)", () => {
  it("suspends without executing when an action awaits a human", async () => {
    gatePending = ["book_journal_entry:je-2"];
    const def = {
      key: "post_entry",
      stepNumber: 2,
      dependsOn: [],
      role: "classifier" as const,
      track: "main",
      name: "Post entry",
      kind: "deterministic" as const,
      risk: "writes_ledger" as const,
      async proposeActions(): Promise<ProposedAction[]> {
        return [
          {
            actionKey: "book_journal_entry:je-2",
            actionType: BOOK_JOURNAL_ENTRY,
            riskClass: "writes_ledger" as const,
            target: { kind: "journal_entry", id: "je-2", counterparty: null, amountCents: 5_000 },
            summary: "Small adjusting entry",
            payload: {
              lines: [
                { accountCode: "6000", debitCents: 5_000 },
                { accountCode: "1000", creditCents: 5_000 },
              ],
            },
          },
        ];
      },
      async run(): Promise<StepResult> {
        throw new Error("run() must never be reached while authorization is pending");
      },
    } as unknown as DagStepDefinition;

    const outcome = await executeStep({
      ...baseArgs(),
      def,
      chartOfAccounts: new Set(["6000", "1000"]),
    });

    expect(outcome.status).toBe("suspended");
    if (outcome.status !== "suspended") throw new Error("unreachable");
    // Not mandatory: a standing rule may legitimately clear this one on resume.
    expect(outcome.pending[0].mandatory).toBe(false);
    expect(types()).toContain("workflow_paused");
  });
});

/* -------------------------------------------------------------------------- */

describe("failure handling", () => {
  it("records step_failed when the step body throws, and reports the cause", async () => {
    const def = parserStep({
      async run(): Promise<StepResult> {
        throw new Error("storage download failed");
      },
    });
    const outcome = await executeStep({ ...baseArgs(), def });

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.error).toBe("storage download failed");
    expect(types()).toContain("step_failed");
    // The action was verified and executed-attempted before the throw, so the trail shows
    // where it got to rather than pretending the step never started.
    expect(types()).toContain("action_verified");
  });

  it("refuses to let a deterministic step call a model (D3)", async () => {
    const def = parserStep({
      async run(ctx: StepContext): Promise<StepResult> {
        await ctx.llm({ system: "s", user: "u", schema: {} as never });
        return { output: {}, reasoning: "", sources: [] };
      },
    });
    const outcome = await executeStep({ ...baseArgs(), def });

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.error).toMatch(/must not call ctx\.llm/);
  });
});
