import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DagStepDefinition, StepResult } from "@/lib/types";

/* -------------------------------------------------------------------------- */
/* Hoisted shared state: an in-memory Supabase-admin mock + a settable graph.   */
/* -------------------------------------------------------------------------- */

const h = vi.hoisted(() => {
  interface Row {
    [k: string]: unknown;
  }
  const state: { workflows: Row[]; workflow_steps: Row[]; workflow_files: Row[]; audit_log: Row[] } = {
    workflows: [],
    workflow_steps: [],
    workflow_files: [],
    audit_log: [],
  };
  const graph: { steps: unknown[] } = { steps: [] };

  function makeDb() {
    const tbl = (t: keyof typeof state) => state[t];
    function query(table: keyof typeof state) {
      const q: Record<string, unknown> = {};
      let op: "select" | "insert" | "update" | "delete" = "select";
      let payload: Row[] | Row | null = null;
      const filters: [string, unknown][] = [];
      const match = (row: Row) => filters.every(([c, v]) => row[c] === v);
      const run = () => {
        const arr = tbl(table);
        if (op === "insert") {
          const rows = Array.isArray(payload) ? payload : [payload as Row];
          for (const r of rows) arr.push({ id: (r.id as string) ?? `id-${arr.length + 1}`, ...r });
          return { data: null, error: null };
        }
        if (op === "update") {
          for (const row of arr) if (match(row)) Object.assign(row, payload as Row);
          return { data: null, error: null };
        }
        if (op === "delete") {
          for (let i = arr.length - 1; i >= 0; i--) if (match(arr[i])) arr.splice(i, 1);
          return { data: null, error: null };
        }
        const rows = arr
          .filter(match)
          .sort((a, b) => ((a.step_number as number) ?? 0) - ((b.step_number as number) ?? 0));
        return { data: rows, error: null };
      };
      Object.assign(q, {
        select: () => q,
        insert: (rows: Row[] | Row) => {
          op = "insert";
          payload = rows;
          return q;
        },
        update: (patch: Row) => {
          op = "update";
          payload = patch;
          return q;
        },
        delete: () => {
          op = "delete";
          return q;
        },
        eq: (col: string, val: unknown) => {
          filters.push([col, val]);
          return q;
        },
        order: () => q,
        single: () => Promise.resolve({ data: (run().data ?? [])[0] ?? null, error: null }),
        maybeSingle: () => Promise.resolve({ data: (run().data ?? [])[0] ?? null, error: null }),
        then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
          try {
            resolve(run());
          } catch (e) {
            reject(e);
          }
        },
      });
      return q;
    }
    return {
      from: (t: keyof typeof state) => query(t),
      storage: {
        from: () => ({ download: async () => ({ data: null, error: { message: "no files" } }) }),
      },
    };
  }

  return { state, graph, makeDb };
});

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.makeDb() }));
vi.mock("@/lib/agents/dag", () => ({
  workflowDefinitions: {
    reconciliation: { type: "reconciliation", get steps() { return h.graph.steps; } },
    ap_matching: { type: "ap_matching", steps: [] },
    fpa_commentary: { type: "fpa_commentary", steps: [] },
  },
}));

import { runWorkflow } from "@/lib/agents/orchestrator";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                      */
/* -------------------------------------------------------------------------- */

function step(
  key: string,
  stepNumber: number,
  dependsOn: string[],
  run: DagStepDefinition["run"],
): DagStepDefinition {
  return { key, stepNumber, dependsOn, role: "parser", track: "main", name: key, kind: "deterministic", run };
}

const ok = (output: unknown): Promise<StepResult> =>
  Promise.resolve({ output, reasoning: "done", sources: [] });

function seedWorkflow() {
  h.state.workflows.push({
    id: "wf1",
    org_id: "org1",
    type: "reconciliation",
    status: "running",
    error_message: null,
    completed_at: null,
  });
}

function stepRows() {
  return h.state.workflow_steps
    .filter((s) => s.workflow_id === "wf1")
    .sort((a, b) => (a.step_number as number) - (b.step_number as number));
}

beforeEach(() => {
  h.state.workflows = [];
  h.state.workflow_steps = [];
  h.state.workflow_files = [];
  h.state.audit_log = [];
  h.graph.steps = [];
});

afterEach(() => {
  vi.useRealTimers();
});

/* -------------------------------------------------------------------------- */
/* Tests                                                                        */
/* -------------------------------------------------------------------------- */

describe("runWorkflow (orchestrator)", () => {
  it("happy path: runs the graph and marks the workflow awaiting_review", async () => {
    const order: string[] = [];
    h.graph.steps = [
      step("a", 1, [], () => { order.push("a"); return ok({ v: "a" }); }),
      step("b", 2, [], () => { order.push("b"); return ok({ v: "b" }); }),
      step("c", 3, ["a", "b"], (ctx) => {
        order.push("c");
        // Prior outputs are keyed by step_key (D-P5).
        expect(ctx.priorOutputs["a"]).toEqual({ v: "a" });
        expect(ctx.priorOutputs["b"]).toEqual({ v: "b" });
        return ok({ v: "c" });
      }),
    ];
    seedWorkflow();

    await runWorkflow("wf1");

    expect(stepRows().map((s) => s.status)).toEqual(["complete", "complete", "complete"]);
    expect(stepRows().map((s) => s.step_key)).toEqual(["a", "b", "c"]);
    expect(h.state.workflows[0].status).toBe("awaiting_review");
    expect(h.state.workflows[0].completed_at).not.toBeNull();
    // c ran after both a and b.
    expect(order.indexOf("c")).toBeGreaterThan(order.indexOf("a"));
    expect(order.indexOf("c")).toBeGreaterThan(order.indexOf("b"));
  });

  it("failing middle step pauses the workflow; sibling in the same wave still persists", async () => {
    vi.useFakeTimers();
    h.graph.steps = [
      step("a", 1, [], () => ok({ v: "a" })), // sibling of b in the first wave
      step("b", 2, [], () => Promise.reject(new Error("boom"))),
      step("c", 3, ["a", "b"], () => ok({ v: "c" })), // depends on b → never becomes ready
    ];
    seedWorkflow();

    const p = runWorkflow("wf1");
    // b retries 3× with 1s + 4s backoff before final failure (D-P6).
    await vi.advanceTimersByTimeAsync(6000);
    await p;

    const byKey = Object.fromEntries(stepRows().map((s) => [s.step_key, s.status]));
    expect(byKey.a).toBe("complete"); // sibling persisted, work not wasted
    expect(byKey.b).toBe("error");
    expect(byKey.c).toBe("pending"); // downstream never scheduled
    expect(h.state.workflows[0].status).toBe("error");
    expect(String(h.state.workflows[0].error_message)).toMatch(/failed/i);
  });

  it("retries a flaky step up to 3 attempts with 1s/4s backoff", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    h.graph.steps = [
      step("a", 1, [], () => {
        attempts += 1;
        if (attempts < 3) return Promise.reject(new Error("transient"));
        return ok({ v: "a" });
      }),
    ];
    seedWorkflow();

    const p = runWorkflow("wf1");
    await vi.advanceTimersByTimeAsync(5000); // 1s + 4s
    await p;

    expect(attempts).toBe(3);
    expect(stepRows()[0].status).toBe("complete");
    expect(h.state.workflows[0].status).toBe("awaiting_review");
  });

  it("resume: only non-complete steps re-run; complete steps are not re-executed", async () => {
    const ran: string[] = [];
    h.graph.steps = [
      step("a", 1, [], () => { ran.push("a"); return ok({ v: "a-fresh" }); }),
      step("b", 2, ["a"], () => { ran.push("b"); return ok({ v: "b" }); }),
    ];
    seedWorkflow();
    // Pre-seed: a already complete, b errored (a prior partial run).
    h.state.workflow_steps.push(
      { id: "s1", workflow_id: "wf1", step_number: 1, step_key: "a", track: "main", name: "a", status: "complete", output: { v: "a-original" } },
      { id: "s2", workflow_id: "wf1", step_number: 2, step_key: "b", track: "main", name: "b", status: "error", output: null },
    );
    h.state.workflows[0].status = "error";

    await runWorkflow("wf1");

    expect(ran).toEqual(["b"]); // a was not re-run (idempotent, D2)
    expect(stepRows().map((s) => s.status)).toEqual(["complete", "complete"]);
    expect(h.state.workflows[0].status).toBe("awaiting_review");
  });
});
