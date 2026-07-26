/**
 * Milestone H5 gates — reconciliation on Mastra (Plan 4 §5).
 *
 * Two things the brief requires proven, plus the parallelism claim:
 *
 *   1. **Resume happens from the last completed step, not from zero.** A run is interrupted
 *      after its parallel parse steps finish; a SECOND Mastra instance — new object, new
 *      storage client, same on-disk snapshot file — restarts it, and the parse steps must not
 *      execute again. Execution counts come from the event stream, so the assertion is on what
 *      the audit trail actually recorded rather than on an in-memory spy.
 *
 *   2. **A provider swap is invisible to the harness and visible in the trail.** The same
 *      workflow runs once against a Claude-shaped provider and once against a mocked local
 *      model, and both must produce valid output with correct events naming their own provider.
 *
 * Scope, stated honestly. The "crash" is reproduced rather than caused: the run is interrupted
 * mid-graph and its snapshot status is rewritten to `running`, which is the state a SIGKILL
 * leaves behind (nothing gets to write a terminal status). Two findings made that necessary,
 * both documented at the code that works around them:
 *
 *   - `run.cancel()` yields status `canceled`, which `restart()` explicitly rejects, so a
 *     graceful cancel is NOT a stand-in for a crash;
 *   - `start()` accepts no `abortSignal` (passing one type-errors, and would be silently ignored
 *     at runtime), and nothing cancels a step already in flight — so the only way to leave a run
 *     genuinely stuck mid-graph is to park a step on a promise that never resolves and abandon
 *     the run, which is also the closest analogue to a killed process.
 *
 * What this proves: our step wrappers are compatible with snapshot-based resume, and Mastra
 * carries completed `stepResults` forward instead of recomputing them. It does not exercise a
 * real process boundary — that version runs against durable Postgres snapshots in
 * `scripts/harness-proof.ts` once `DATABASE_URL` is configured.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { beforeEach, afterAll, describe, expect, it, vi } from "vitest";

/* -------------------------------------------------------------------------- */
/* Fakes. The database is module-level so it SURVIVES across the two Mastra    */
/* instances — which is the point: the snapshot is what resumes, and the event  */
/* stream is what we audit.                                                     */
/* -------------------------------------------------------------------------- */

const h = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const state: Record<string, Row[]> = { harness_events: [], workflow_files: [] };
  /** Which provider the fake router should claim. Flipped by the swap test. */
  const provider = { id: "anthropic", model: "claude-sonnet-4-6" };
  /**
   * A gate that holds the matcher step open indefinitely.
   *
   * The resume tests need the interrupted run to be genuinely stuck mid-graph, and with instant
   * stubs the whole five-step graph finishes inside a few ticks. A merely-slow step is not
   * enough either: nothing cancels a step in flight, so it goes on to finish and runs the rest of
   * the graph in the background after the test has moved on — which is what made `report`
   * execute twice while the assertions were being written.
   *
   * So the gate is a promise that is never resolved, not a timer that eventually fires. The
   * abandoned run parks on it forever and never reaches `flag`/`report`; because there is no
   * pending timer, nothing keeps the event loop alive at the end of the suite.
   */
  const matcherGate = { blocked: false };

  function makeDb() {
    return {
      rpc: (_fn: string, args: Row) => ({
        single: async () => {
          const wf = args.p_workflow_id;
          const seq =
            state.harness_events
              .filter((r) => r.workflow_id === wf)
              .reduce((m, r) => Math.max(m, r.sequence_number as number), 0) + 1;
          const row: Row = {
            id: `ev-${state.harness_events.length + 1}`,
            workflow_id: wf,
            step_id: args.p_step_id,
            step_key: args.p_step_key,
            sequence_number: seq,
            event_type: args.p_event_type,
            actor: args.p_actor,
            payload: args.p_payload,
            provider_used: args.p_provider_used,
            model_used: args.p_model_used,
            input_hash: args.p_input_hash,
            created_at: new Date(2026, 0, 1).toISOString(),
          };
          state.harness_events.push(row);
          return { data: row, error: null };
        },
      }),
      from: (table: string) => {
        const filters: [string, unknown][] = [];
        const q: Record<string, unknown> = {};
        Object.assign(q, {
          select: () => q,
          eq: (c: string, v: unknown) => {
            filters.push([c, v]);
            return q;
          },
          gt: () => q,
          in: () => q,
          order: () => q,
          then: (resolve: (x: unknown) => void) =>
            resolve({
              data: (state[table] ?? []).filter((r) => filters.every(([c, v]) => r[c] === v)),
              error: null,
            }),
        });
        return q;
      },
    };
  }

  /**
   * One flag per unmatched item, which is what the flag step's post-validation demands
   * (`validateFlags`: every unmatched ERP and bank item must be flagged exactly once). The
   * prompt is prose followed by JSON, so the payload starts at the first brace.
   */
  function stubFlagsFor(user: string) {
    const start = user.indexOf("{");
    if (start === -1) return [];
    let payload: {
      unmatchedErp?: { id: string }[];
      unmatchedBank?: { id: string }[];
    };
    try {
      payload = JSON.parse(user.slice(start));
    } catch {
      return [];
    }
    const flag = (id: string, source: "erp" | "bank") => ({
      id,
      source,
      category: source === "erp" ? "missing_from_bank" : "missing_from_erp",
      explanation: "stub explanation",
      recommendation: "stub recommendation",
    });
    return [
      ...(payload.unmatchedErp ?? []).map((e) => flag(e.id, "erp")),
      ...(payload.unmatchedBank ?? []).map((b) => flag(b.id, "bank")),
    ];
  }

  return { state, provider, matcherGate, makeDb, stubFlagsFor };
});

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.makeDb() }));

/**
 * The router stub. Answers the reconciliation steps' schemas from the payload they send, so
 * no network and no key — and reports whichever provider `h.provider` currently names, which is
 * how the swap test changes models without changing anything in the harness.
 */
vi.mock("@/lib/llm/router", () => ({
  NoProviderConfiguredError: class extends Error {},
  resolveProvider: async () => ({
    provider: { id: h.provider.id, complete: async () => ({}) },
    configId: null,
    providerId: h.provider.id,
    model: h.provider.model,
  }),
  dispatch: async (_db: unknown, opts: { user: string; role: string }) => {
    // Keyed off the ROLE rather than by parsing the prompt: the reconciliation prompts are
    // prose wrapped around JSON, not pure JSON, and the role is exactly the thing the harness
    // routes on anyway.
    let data: unknown;
    if (opts.role === "matcher") {
      // Never resolves while blocked — see the note on `matcherGate`.
      if (h.matcherGate.blocked) await new Promise<void>(() => {});
      data = { reasoning: "stub adjudication", confirmedMatches: [], rejectedPairs: [] };
    } else if (opts.role === "classifier") {
      // The flag step post-validates that every unmatched item got a flag, so echo them back.
      data = { reasoning: "stub flags", flags: h.stubFlagsFor(opts.user) };
    } else {
      data = { reasoning: "stub narrative", narrative: "stub narrative" };
    }
    return {
      data,
      reasoning: "stub reasoning",
      meta: {
        providerId: h.provider.id,
        modelUsed: h.provider.model,
        tokensIn: 11,
        tokensOut: 22,
        latencyMs: 5,
        raw: null,
      },
    };
  },
  invoke: async () => {
    throw new Error("invoke must not be called from the harness path — use dispatch (D-H13)");
  },
}));

import { Mastra } from "@mastra/core";
import { LibSQLStore } from "@mastra/libsql";
import { parseFile } from "@/lib/csv/parser";
import { primeWorkflowFiles, clearWorkflowFiles } from "@/lib/harness/inputs";
import { reconciliationHarnessWorkflow } from "@/lib/harness/workflows/reconciliation";
import type { ParsedFile } from "@/lib/types";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const WORKFLOW_ID = "11111111-1111-1111-1111-111111111111";
const ORG_ID = "22222222-2222-2222-2222-222222222222";

const snapshotDir = mkdtempSync(join(tmpdir(), "finito-mastra-"));
afterAll(() => rmSync(snapshotDir, { recursive: true, force: true }));

function demoFiles(): Record<string, ParsedFile> {
  const read = (name: string) => readFileSync(join(process.cwd(), "demo-data", name));
  return {
    erp_export: parseFile(read("erp_export_demo.csv"), "erp_export", {
      filename: "erp_export_demo.csv",
    }),
    bank_statement: parseFile(read("bank_statement_demo.csv"), "bank_statement", {
      filename: "bank_statement_demo.csv",
    }),
  };
}

/**
 * A Mastra instance over a named snapshot file. Building a SECOND one against the same file is
 * how these tests stand in for a process restart.
 */
function makeMastra(snapshotName: string) {
  return new Mastra({
    storage: new LibSQLStore({
      id: `test-${snapshotName}`,
      url: `file:${join(snapshotDir, `${snapshotName}.db`)}`,
    }),
    workflows: { reconciliation: reconciliationHarnessWorkflow },
  });
}

/** How many times a step reached `step_started` — i.e. actually executed. */
function executionCount(stepKey: string): number {
  return h.state.harness_events.filter(
    (e) => e.step_key === stepKey && e.event_type === "step_started",
  ).length;
}

function eventsFor(stepKey: string) {
  return h.state.harness_events.filter((e) => e.step_key === stepKey);
}

beforeEach(() => {
  h.state.harness_events = [];
  h.provider.id = "anthropic";
  h.provider.model = "claude-sonnet-4-6";
  h.matcherGate.blocked = false;
  clearWorkflowFiles();
  primeWorkflowFiles(WORKFLOW_ID, demoFiles());
});

/* -------------------------------------------------------------------------- */

describe("the graph runs end to end on Mastra", () => {
  it("completes all five steps and writes one event stream", async () => {
    const mastra = makeMastra("happy");
    const workflow = mastra.getWorkflow("reconciliation");
    const run = await workflow.createRun();

    const result = await run.start({ inputData: { workflowId: WORKFLOW_ID, orgId: ORG_ID } });

    expect(result.status).toBe("success");
    for (const key of ["parse_erp", "parse_bank", "match", "flag", "report"]) {
      expect(executionCount(key), `${key} should have run exactly once`).toBe(1);
      expect(eventsFor(key).map((e) => e.event_type)).toContain("step_completed");
    }
  });

  it("keeps one gapless sequence across the whole run, including the parallel steps", async () => {
    const mastra = makeMastra("sequencing");
    const run = await mastra.getWorkflow("reconciliation").createRun();
    await run.start({ inputData: { workflowId: WORKFLOW_ID, orgId: ORG_ID } });

    const seqs = h.state.harness_events.map((e) => e.sequence_number as number);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
  });

  it("attributes LLM steps to a provider and deterministic steps to none", async () => {
    const mastra = makeMastra("attribution");
    const run = await mastra.getWorkflow("reconciliation").createRun();
    await run.start({ inputData: { workflowId: WORKFLOW_ID, orgId: ORG_ID } });

    // parse steps are deterministic — a provider on their events would corrupt usage totals.
    for (const key of ["parse_erp", "parse_bank"]) {
      expect(eventsFor(key).every((e) => e.provider_used === null)).toBe(true);
    }
    // match/flag/report are LLM steps.
    for (const key of ["match", "flag", "report"]) {
      const attributed = eventsFor(key).filter((e) => e.provider_used !== null);
      expect(attributed.length, `${key} should attribute a provider`).toBeGreaterThan(0);
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("resume happens from the last completed step, not from zero", () => {
  /**
   * Reproduce the snapshot state a KILLED process leaves behind, then resume from it.
   *
   * The distinction matters and cost a debugging round to find: `run.cancel()` produces a
   * snapshot with status `canceled`, and `restart()` rejects that with "This workflow run was
   * not active". A `SIGKILL` is different — nothing gets the chance to write a terminal status,
   * so the snapshot is left at `running`, which is exactly what `restart()` accepts. Cancelling
   * is therefore NOT a valid stand-in for crashing.
   *
   * So: run until the parse steps complete, abort to stop the graph, then rewrite the snapshot's
   * status back to `running` — reproducing the post-kill state directly rather than approximating
   * it. Completed step results in `snapshot.context` are left exactly as the run wrote them.
   *
   * The genuine SIGKILL version, against durable Postgres snapshots, is phase 2 of
   * `scripts/harness-proof.ts`.
   */
  async function crashAfterParseSteps(snapshotName: string, runId: string) {
    // Park the graph inside `match` so the interruption lands mid-run, and so the abandoned
    // run can never proceed to `flag`/`report` in the background.
    h.matcherGate.blocked = true;
    const first = makeMastra(snapshotName);
    const workflow = first.getWorkflow("reconciliation");
    const run = await workflow.createRun({ runId });

    const store = await first.getStorage()?.getStore("workflows");
    if (!store) throw new Error("no workflow store");

    // Deliberately NOT awaited: this run's `match` step parks on a promise that never resolves,
    // so awaiting it would hang. Abandoning a run whose step never returns, with its snapshot
    // left mid-graph, is precisely the state a killed process leaves behind.
    const started = run.start({ inputData: { workflowId: WORKFLOW_ID, orgId: ORG_ID } });
    void started.catch(() => undefined);

    // Wait on the SNAPSHOT, not on our own events. Our events are appended inside `execute`
    // before it returns, so seeing `step_completed` does not yet mean Mastra has persisted that
    // step's result — and aborting in that window loses it, which makes the step re-run.
    await vi.waitFor(
      async () => {
        const snap = await store.loadWorkflowSnapshot({ workflowName: "reconciliation", runId });
        const done = Object.keys(snap?.context ?? {});
        expect(done).toContain("parse_erp");
        expect(done).toContain("parse_bank");
      },
      { timeout: 5_000, interval: 5 },
    );
    // The resumed run must get past `match`; the abandoned one stays parked forever.
    h.matcherGate.blocked = false;

    // Rewrite only the status; the step results stay as the interrupted run left them.
    const snapshot = await store.loadWorkflowSnapshot({
      workflowName: "reconciliation",
      runId,
    });
    if (!snapshot) throw new Error("no snapshot was written before the interruption");
    await store.persistWorkflowSnapshot({
      workflowName: "reconciliation",
      runId,
      snapshot: { ...snapshot, status: "running" },
    });

    return snapshot;
  }

  it("does not re-run the parse steps when a fresh instance restarts a crashed run", async () => {
    const runId = "33333333-3333-3333-3333-333333333333";
    const crashed = await crashAfterParseSteps("resume", runId);

    // The crash snapshot really did record the completed parse steps.
    expect(Object.keys(crashed.context ?? {})).toEqual(
      expect.arrayContaining(["parse_erp", "parse_bank"]),
    );
    expect(executionCount("parse_erp") + executionCount("parse_bank")).toBe(2);

    // A NEW Mastra instance over the same durable snapshot — the restart.
    const second = makeMastra("resume");
    const secondWorkflow = second.getWorkflow("reconciliation");

    const readBack = await secondWorkflow.getWorkflowRunById(runId);
    expect(readBack, "a fresh instance must be able to find the run").toBeTruthy();

    const result = await (await secondWorkflow.createRun({ runId })).restart();

    // ---- The assertion the brief asks for. ----
    expect(executionCount("parse_erp"), "parse_erp must not re-run").toBe(1);
    expect(executionCount("parse_bank"), "parse_bank must not re-run").toBe(1);
    expect(result.status).toBe("success");
    // And the remainder did run, so resuming actually finished the work.
    expect(executionCount("report")).toBe(1);
  });

  it("carries the completed steps' outputs forward rather than recomputing them", async () => {
    const runId = "44444444-4444-4444-4444-444444444444";
    await crashAfterParseSteps("carry", runId);

    const second = makeMastra("carry");
    const result = await (await second.getWorkflow("reconciliation").createRun({ runId })).restart();

    expect(result.status).toBe("success");

    // `match` consumes both parse outputs. Since the parse steps never ran again, `match` could
    // only have produced a result if those outputs survived in the snapshot.
    expect(executionCount("parse_erp")).toBe(1);
    expect(executionCount("parse_bank")).toBe(1);
    expect(eventsFor("match").some((e) => e.event_type === "observation_received")).toBe(true);

    // `match` itself STARTED twice and COMPLETED once, which is the correct distinction: it was
    // interrupted mid-flight, so re-running it is right. Only steps that finished are skipped —
    // "resume from the last completed step" means completed, not attempted.
    expect(executionCount("match")).toBe(2);
    expect(eventsFor("match").filter((e) => e.event_type === "step_completed")).toHaveLength(1);
  });

  it("refuses to restart a gracefully cancelled run — cancel is not a crash", async () => {
    const runId = "55555555-5555-5555-5555-555555555555";
    const mastra = makeMastra("cancelled");
    const run = await mastra.getWorkflow("reconciliation").createRun({ runId });

    h.matcherGate.blocked = true;
    const started = run.start({ inputData: { workflowId: WORKFLOW_ID, orgId: ORG_ID } });
    void started.catch(() => undefined);

    await vi.waitFor(() => expect(executionCount("match")).toBe(1), {
      timeout: 5_000,
      interval: 10,
    });
    // `run.cancel()` is the real API. `start()` has no `abortSignal` option, so passing one
    // type-errors and would otherwise have been ignored at runtime — a good way to write a test
    // that appears to prove something and does not.
    await run.cancel();
    h.matcherGate.blocked = false;

    // Documents the distinction the helper above exists to work around, so a future reader does
    // not "fix" the status rewrite by switching back to plain abort.
    const fresh = makeMastra("cancelled");
    await expect(
      (await fresh.getWorkflow("reconciliation").createRun({ runId })).restart(),
    ).rejects.toThrow(/was not active/);
  });
});

/* -------------------------------------------------------------------------- */

describe("provider swap", () => {
  it("produces valid output and correct events on a Claude-shaped provider", async () => {
    h.provider.id = "anthropic";
    h.provider.model = "claude-sonnet-4-6";

    const mastra = makeMastra("swap-claude");
    const run = await mastra.getWorkflow("reconciliation").createRun();
    const result = await run.start({ inputData: { workflowId: WORKFLOW_ID, orgId: ORG_ID } });

    expect(result.status).toBe("success");
    const attributed = eventsFor("match").filter((e) => e.provider_used !== null);
    expect(attributed.every((e) => e.provider_used === "anthropic")).toBe(true);
    expect(attributed.every((e) => e.model_used === "claude-sonnet-4-6")).toBe(true);
  });

  it("produces valid output and correct events on a mocked local model", async () => {
    // The BYOK/local-model story: nothing in the harness changes, only the resolved provider.
    h.provider.id = "ollama";
    h.provider.model = "llama3.2:3b";

    const mastra = makeMastra("swap-ollama");
    const run = await mastra.getWorkflow("reconciliation").createRun();
    const result = await run.start({ inputData: { workflowId: WORKFLOW_ID, orgId: ORG_ID } });

    expect(result.status).toBe("success");
    const attributed = eventsFor("match").filter((e) => e.provider_used !== null);
    expect(attributed.length).toBeGreaterThan(0);
    expect(attributed.every((e) => e.provider_used === "ollama")).toBe(true);
    expect(attributed.every((e) => e.model_used === "llama3.2:3b")).toBe(true);
  });

  it("emits the same event shape either way — the trail is provider-independent", async () => {
    const shapeFor = async (id: string, model: string, snapshot: string) => {
      h.state.harness_events = [];
      h.provider.id = id;
      h.provider.model = model;
      const mastra = makeMastra(snapshot);
      const run = await mastra.getWorkflow("reconciliation").createRun();
      await run.start({ inputData: { workflowId: WORKFLOW_ID, orgId: ORG_ID } });
      return h.state.harness_events.map((e) => `${e.step_key}:${e.event_type}`);
    };

    const claude = await shapeFor("anthropic", "claude-sonnet-4-6", "shape-claude");
    const local = await shapeFor("ollama", "llama3.2:3b", "shape-local");

    // Identical lifecycle, identical ordering. Only provider_used/model_used differ, which is
    // exactly what "the harness should not care which model is reasoning" has to mean.
    expect(local).toEqual(claude);
  });
});
