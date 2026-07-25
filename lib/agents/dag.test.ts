import { describe, expect, it } from "vitest";
import { validateDag, workflowDefinitions, llmStepsForMatrix } from "@/lib/agents/dag";
import type { DagStepDefinition, StepResult, WorkflowDefinition } from "@/lib/types";

function stub(key: string, stepNumber: number, dependsOn: string[]): DagStepDefinition {
  return {
    key,
    stepNumber,
    dependsOn,
    role: "parser",
    track: "main",
    name: key,
    kind: "deterministic",
    async run(): Promise<StepResult> {
      return { output: null, reasoning: "", sources: [] };
    },
  };
}

function def(steps: DagStepDefinition[]): WorkflowDefinition {
  return { type: "reconciliation", steps };
}

describe("validateDag", () => {
  it("accepts a valid acyclic graph", () => {
    expect(() =>
      validateDag(def([stub("a", 1, []), stub("b", 2, ["a"]), stub("c", 3, ["a", "b"])])),
    ).not.toThrow();
  });

  it("rejects a duplicate key", () => {
    expect(() => validateDag(def([stub("a", 1, []), stub("a", 2, [])]))).toThrow(/duplicate/i);
  });

  it("rejects an unknown dependency", () => {
    expect(() => validateDag(def([stub("a", 1, ["missing"])]))).toThrow(/unknown/i);
  });

  it("rejects a dependency cycle", () => {
    expect(() =>
      validateDag(def([stub("a", 1, ["b"]), stub("b", 2, ["a"])])),
    ).toThrow(/cycle/i);
  });

  /* Plan 3, D-A2/D-A3 — a mislabelled authorization gate must fail at import time. */

  it("rejects a consequential step with no proposeActions", () => {
    const s = { ...stub("pay", 1, []), risk: "moves_money" as const };
    expect(() => validateDag(def([s]))).toThrow(/no proposeActions/i);
  });

  it("rejects an action-proposing step labelled read", () => {
    const s = { ...stub("pay", 1, []), proposeActions: async () => [] };
    expect(() => validateDag(def([s]))).toThrow(/proposeActions\(\) but risk "read"/i);
  });

  it("accepts a consequential step that proposes actions", () => {
    const s = {
      ...stub("pay", 1, []),
      risk: "moves_money" as const,
      proposeActions: async () => [],
    };
    expect(() => validateDag(def([s]))).not.toThrow();
  });
});

describe("workflowDefinitions", () => {
  it("registers all three workflow types and they pass validation", () => {
    expect(Object.keys(workflowDefinitions).sort()).toEqual([
      "ap_matching",
      "fpa_commentary",
      "reconciliation",
    ]);
    for (const d of Object.values(workflowDefinitions)) {
      expect(() => validateDag(d)).not.toThrow();
    }
  });

  it("reconciliation ready-set sequence is [parse_erp,parse_bank] → [match] → [flag] → [report]", () => {
    const defs = workflowDefinitions.reconciliation.steps;
    const done = new Set<string>();
    const waves: string[][] = [];
    // Simulate the orchestrator's ready-set scheduling deterministically.
    while (done.size < defs.length) {
      const ready = defs
        .filter((d) => !done.has(d.key) && d.dependsOn.every((k) => done.has(k)))
        .map((d) => d.key);
      if (ready.length === 0) throw new Error("stuck");
      waves.push(ready);
      for (const k of ready) done.add(k);
    }
    expect(waves).toEqual([["parse_erp", "parse_bank"], ["match"], ["flag"], ["report"]]);
  });

  it("fpa board_deck depends on both rank_variances and commentary", () => {
    const board = workflowDefinitions.fpa_commentary.steps.find((s) => s.key === "board_deck")!;
    expect(board.dependsOn.sort()).toEqual(["commentary", "rank_variances"]);
  });
});

describe("llmStepsForMatrix", () => {
  it("lists only LLM steps with type/key/name/role", () => {
    const rows = llmStepsForMatrix();
    // Deterministic steps (parse_erp, compute_variances, …) must be absent.
    expect(rows.some((r) => r.step_key === "parse_erp")).toBe(false);
    expect(rows.some((r) => r.step_key === "compute_variances")).toBe(false);
    // Known LLM steps present.
    const recon = rows.filter((r) => r.workflow_type === "reconciliation").map((r) => r.step_key);
    expect(recon).toEqual(["match", "flag", "report"]);
    for (const r of rows) expect(["matcher", "classifier", "writer"]).toContain(r.role);
  });
});
