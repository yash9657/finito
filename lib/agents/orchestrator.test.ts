import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DagStepDefinition, ProposedAction, StepContext, StepResult } from "@/lib/types";

/* -------------------------------------------------------------------------- */
/* Hoisted shared state: an in-memory Supabase-admin mock + a settable graph.   */
/* -------------------------------------------------------------------------- */

const h = vi.hoisted(() => {
  interface Row {
    [k: string]: unknown;
  }
  const state: {
    workflows: Row[];
    workflow_steps: Row[];
    workflow_files: Row[];
    audit_log: Row[];
    action_requests: Row[];
    approval_rules: Row[];
    org_approval_policies: Row[];
  } = {
    workflows: [],
    workflow_steps: [],
    workflow_files: [],
    audit_log: [],
    action_requests: [],
    approval_rules: [],
    org_approval_policies: [],
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
          // Return the affected rows, like PostgREST does for `.update().select()` —
          // this is what makes the conditional resolve-exactly-once update testable.
          const hit = arr.filter(match);
          for (const row of hit) Object.assign(row, payload as Row);
          return { data: hit, error: null };
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

/** A consequential step (Plan 3, D-A2/D-A3) proposing one moves_money action. */
function gatedStep(
  key: string,
  stepNumber: number,
  dependsOn: string[],
  run: DagStepDefinition["run"],
  actions: ProposedAction[] = [payment("inv-001", 120_000, "Acme Supplies")],
): DagStepDefinition {
  return {
    ...step(key, stepNumber, dependsOn, run),
    risk: "moves_money",
    proposeActions: async () => actions,
  };
}

function payment(id: string, amountCents: number, counterparty: string): ProposedAction {
  return {
    actionKey: `approve_invoice_payment:${id}`,
    actionType: "approve_invoice_payment",
    riskClass: "moves_money",
    target: { kind: "invoice", id, counterparty, amountCents },
    summary: `Approve payment of ${amountCents} cents to ${counterparty}`,
  };
}

function actionRows() {
  return h.state.action_requests.filter((a) => a.workflow_id === "wf1");
}

function auditActions(): string[] {
  return h.state.audit_log.map((a) => String(a.action));
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
  h.state.action_requests = [];
  h.state.approval_rules = [];
  h.state.org_approval_policies = [];
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

  /* ---- Plan 3: the authorization gate (D-A3/D-A10/D-A11) ---- */

  it("a consequential step suspends the workflow instead of running; siblings still persist", async () => {
    let ran = false;
    h.graph.steps = [
      step("a", 1, [], () => ok({ v: "a" })), // sibling in the same wave
      gatedStep("pay", 2, [], () => {
        ran = true;
        return ok({ v: "pay" });
      }),
      step("after", 3, ["pay"], () => ok({ v: "after" })),
    ];
    seedWorkflow();

    await runWorkflow("wf1");

    expect(ran).toBe(false); // gate ran BEFORE the step body
    const byKey = Object.fromEntries(stepRows().map((s) => [s.step_key, s.status]));
    expect(byKey.a).toBe("complete"); // sibling's work is not wasted
    expect(byKey.pay).toBe("awaiting_approval");
    expect(byKey.after).toBe("pending"); // downstream never scheduled
    expect(h.state.workflows[0].status).toBe("awaiting_approval");
    expect(h.state.workflows[0].error_message).toBeNull(); // suspension is not failure
    expect(h.state.workflows[0].completed_at).toBeNull();

    // The durable pending item + its audit chain.
    expect(actionRows()).toHaveLength(1);
    const action = actionRows()[0];
    expect(action.status).toBe("pending");
    expect(action.action_key).toBe("approve_invoice_payment:inv-001");
    expect(action.amount_cents).toBe(120_000);
    expect(action.counterparty).toBe("Acme Supplies");
    expect(String(action.decision_reason)).toMatch(/no standing rule covers/i);
    expect(auditActions()).toContain("action_proposed");
    expect(auditActions()).toContain("approval_requested");
    expect(auditActions()).toContain("workflow_suspended");
  });

  it("resume after approval runs the gated step with ctx.approvals and completes the run", async () => {
    const seen: { authorized?: boolean; source?: string | null } = {};
    const gated = gatedStep("pay", 1, [], (ctx: StepContext) => {
      const d = ctx.approvals.get("approve_invoice_payment:inv-001");
      seen.authorized = d?.authorized;
      seen.source = d?.source ?? null;
      return ok({ v: "pay" });
    });
    h.graph.steps = [gated];
    seedWorkflow();

    await runWorkflow("wf1"); // suspends
    expect(h.state.workflows[0].status).toBe("awaiting_approval");

    // A human resolves the pending item (what the decide route does).
    const action = actionRows()[0];
    Object.assign(action, {
      status: "approved",
      decision_source: "human",
      decided_by: "user-1",
      decided_at: new Date().toISOString(),
    });
    h.state.workflows[0].status = "running";

    await runWorkflow("wf1"); // resume

    expect(seen.authorized).toBe(true);
    expect(seen.source).toBe("human");
    expect(stepRows()[0].status).toBe("complete");
    expect(h.state.workflows[0].status).toBe("awaiting_review");
    // Idempotent: re-proposing the action found its decision, no duplicate row.
    expect(actionRows()).toHaveLength(1);
    expect(actionRows()[0].committed_at).not.toBeNull();
    expect(auditActions()).toContain("action_committed");
  });

  it("an action covered by a standing rule never suspends the run", async () => {
    h.graph.steps = [gatedStep("pay", 1, [], () => ok({ v: "pay" }))];
    seedWorkflow();
    h.state.approval_rules.push({
      id: "rule-1",
      org_id: "org1",
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
    });

    await runWorkflow("wf1");

    expect(actionRows()[0].status).toBe("auto_approved");
    expect(actionRows()[0].standing_rule_id).toBe("rule-1");
    expect(stepRows()[0].status).toBe("complete");
    expect(h.state.workflows[0].status).toBe("awaiting_review");
    expect(auditActions()).toContain("action_auto_approved");
    expect(auditActions()).not.toContain("workflow_suspended");
  });

  it("a ceiling-denied action does not block the run and is never authorized", async () => {
    let sawAuthorized: boolean | undefined;
    h.graph.steps = [
      gatedStep(
        "pay",
        1,
        [],
        (ctx: StepContext) => {
          sawAuthorized = ctx.approvals.get("approve_invoice_payment:inv-big")?.authorized;
          return ok({ v: "pay" });
        },
        [payment("inv-big", 5_000_000, "Acme Supplies")],
      ),
    ];
    seedWorkflow();
    h.state.org_approval_policies.push({
      org_id: "org1",
      hard_deny_above_cents: 1_000_000,
      auto_approve_max_cents: null,
      require_known_counterparty: false,
      approved_counterparties: [],
      require_separate_approver: false,
      updated_by: null,
      updated_at: null,
    });

    await runWorkflow("wf1");

    expect(actionRows()[0].status).toBe("denied");
    expect(actionRows()[0].decision_source).toBe("ceiling");
    expect(sawAuthorized).toBe(false); // step must fail closed on it
    expect(stepRows()[0].status).toBe("complete"); // denial resolves; the run continues
    expect(h.state.workflows[0].status).toBe("awaiting_review");
    expect(auditActions()).toContain("action_denied_by_ceiling");
    expect(auditActions()).toContain("action_withheld");
  });

  it("re-entering the gate does not duplicate action rows", async () => {
    h.graph.steps = [gatedStep("pay", 1, [], () => ok({ v: "pay" }))];
    seedWorkflow();

    await runWorkflow("wf1");
    h.state.workflows[0].status = "running";
    await runWorkflow("wf1"); // still pending → suspends again

    expect(actionRows()).toHaveLength(1);
    expect(h.state.workflows[0].status).toBe("awaiting_approval");
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
