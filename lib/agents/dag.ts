/**
 * Workflow graphs (Plan 2 §4.2, D-P5). Each workflow is a DAG of `DagStepDefinition`s
 * keyed by snake_case string ids; the executor derives concurrency from `dependsOn`,
 * not tracks (D-P5). The step `run` bodies live in the three agent files (their prompt
 * text is unchanged tested product surface); this module only assembles them into
 * validated `WorkflowDefinition`s.
 *
 * `validateDag` runs at import time: a duplicate key, an unknown dependency, or a cycle
 * throws immediately so a malformed graph can never reach production.
 */

import type {
  DagStepDefinition,
  WorkflowDefinition,
  WorkflowType,
  StepRole,
} from "@/lib/types";
import { requiresAuthorization } from "@/lib/approvals/risk";
import { reconciliationSteps } from "@/lib/agents/reconciliation";
import { apMatchingSteps } from "@/lib/agents/ap-matching";
import { fpaCommentarySteps } from "@/lib/agents/fpa-commentary";

/**
 * Validate a workflow graph: unique keys, all `dependsOn` refer to known keys, no
 * cycles, and (Plan 3, D-A2/D-A3) risk/proposeActions consistency — a consequential step
 * that proposes nothing, or an action-proposing step labelled `read`, is a mislabelled
 * gate and must fail at import time rather than silently bypass authorization.
 * Throws with a descriptive message on any violation.
 */
export function validateDag(def: WorkflowDefinition): void {
  const keys = new Set<string>();
  for (const step of def.steps) {
    if (keys.has(step.key)) {
      throw new Error(`[${def.type}] duplicate step key "${step.key}"`);
    }
    keys.add(step.key);
  }

  for (const step of def.steps) {
    const risk = step.risk ?? "read";
    const proposes = typeof step.proposeActions === "function";
    if (requiresAuthorization(risk) && !proposes) {
      throw new Error(
        `[${def.type}] step "${step.key}" has risk "${risk}" but no proposeActions()`,
      );
    }
    if (proposes && !requiresAuthorization(risk)) {
      throw new Error(
        `[${def.type}] step "${step.key}" declares proposeActions() but risk "${risk}"`,
      );
    }
  }

  for (const step of def.steps) {
    for (const dep of step.dependsOn) {
      if (!keys.has(dep)) {
        throw new Error(`[${def.type}] step "${step.key}" depends on unknown key "${dep}"`);
      }
    }
  }

  // Cycle detection via DFS with a recursion stack.
  const byKey = new Map(def.steps.map((s) => [s.key, s]));
  const state = new Map<string, "visiting" | "done">();
  const visit = (key: string): void => {
    const st = state.get(key);
    if (st === "done") return;
    if (st === "visiting") throw new Error(`[${def.type}] dependency cycle at "${key}"`);
    state.set(key, "visiting");
    for (const dep of byKey.get(key)!.dependsOn) visit(dep);
    state.set(key, "done");
  };
  for (const step of def.steps) visit(step.key);
}

function define(type: WorkflowType, steps: DagStepDefinition[]): WorkflowDefinition {
  const def: WorkflowDefinition = { type, steps };
  validateDag(def);
  return def;
}

export const workflowDefinitions: Record<WorkflowType, WorkflowDefinition> = {
  reconciliation: define("reconciliation", reconciliationSteps),
  ap_matching: define("ap_matching", apMatchingSteps),
  fpa_commentary: define("fpa_commentary", fpaCommentarySteps),
};

/** One LLM step's identity, for the Settings step→model matrix (§6). */
export interface LlmStepInfo {
  workflow_type: WorkflowType;
  step_key: string;
  name: string;
  role: StepRole;
}

/**
 * The LLM steps of every workflow (deterministic steps never consult the router, D-P8),
 * generated from the definitions so the Settings matrix stays in sync with the graphs.
 */
export function llmStepsForMatrix(): LlmStepInfo[] {
  const out: LlmStepInfo[] = [];
  for (const def of Object.values(workflowDefinitions)) {
    for (const step of def.steps) {
      if (step.kind === "llm") {
        out.push({
          workflow_type: def.type,
          step_key: step.key,
          name: step.name,
          role: step.role,
        });
      }
    }
  }
  return out;
}
