/**
 * Reconciliation as a Mastra DAG (Plan 4 §4, milestone H5).
 *
 * This is the port the brief's Part 3 asks for: a workflow defined as a DAG of role
 * invocations, with Mastra owning the graph, the concurrency and the retries, and each step's
 * `execute` being a thin wrapper around `executeStep` so the harness keeps owning verification,
 * the event stream and provider routing (D-H17).
 *
 * It runs SIDE BY SIDE with `lib/agents/orchestrator.ts` — nothing is deleted until H8. The
 * step bodies are the same `DagStepDefinition.run` functions the old runner calls, imported
 * from the same graph, so the two paths cannot drift in what they actually compute and every
 * prompt string stays byte-identical (D-H16).
 *
 * ## How data flows, and why it looks like this
 *
 * Mastra chains steps by matching one step's `outputSchema` to the next one's `inputSchema`.
 * A DAG whose nodes read *several* named predecessors does not fit that shape, so instead:
 *
 *   - every step's `inputSchema` is permissive and its real inputs come from
 *     `getInitData()` (the run identity) and `getStepResult(step)` (named predecessors),
 *   - source files are reloaded per step rather than threaded through the snapshot
 *     (see `lib/harness/inputs.ts` for why),
 *   - `.parallel([...])` needs no collapsing `.map()` afterwards because the following step
 *     ignores `inputData` entirely.
 *
 * The result is that the dependency edges live in `getStepResult` calls, which mirror the
 * `dependsOn` arrays in `lib/agents/dag.ts` exactly.
 *
 * ## Suspension
 *
 * When `executeStep` returns `suspended`, the step calls Mastra's native `suspend()` — no
 * custom status flag, no polling, per the brief's explicit instruction. On resume the step
 * simply calls `executeStep` again: the gate is idempotent by `action_key` (Plan 3, D-A1), so
 * it finds the human's persisted decisions and proceeds rather than re-asking. That is why the
 * resume path needs no special case here — the idempotency lives in the layer below.
 */

import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { harnessDb } from "@/lib/harness/db";
import { executeStep, type PendingReview } from "@/lib/harness/loop";
import { appendEvent } from "@/lib/harness/events";
import { loadWorkflowFiles } from "@/lib/harness/inputs";
import { workflowDefinitions } from "@/lib/agents/dag";
import type { DagStepDefinition } from "@/lib/types";

/** Initial input: which run this is. Everything else is loaded or derived. */
const runInput = z.object({
  workflowId: z.string(),
  orgId: z.string(),
});
type RunInput = z.infer<typeof runInput>;

/** What each step contributes to the snapshot: enough to feed successors and render the UI. */
const stepOutput = z.object({
  stepKey: z.string(),
  summary: z.string(),
  metrics: z.record(z.string(), z.number()),
  output: z.unknown(),
});

/** What a suspended step tells the reviewer. Mirrors the human_review_requested payload. */
const suspendPayload = z.object({
  stepKey: z.string(),
  reason: z.string(),
  pending: z.array(
    z.object({
      actionKey: z.string(),
      actionType: z.string(),
      summary: z.string(),
      reason: z.string(),
      mandatory: z.boolean(),
    }),
  ),
});

/**
 * What resuming requires. The decisions themselves are recorded in `action_requests` by the
 * approvals API before resume is called, so this carries only who resumed and why — the step
 * re-reads the authoritative decisions from the database.
 *
 * Deliberately NOT "approved: boolean". A single boolean at the step level would undo Plan 3's
 * per-action authorization: it cannot express "approve these three payments, reject that one",
 * and it would let a step-level click authorize actions the reviewer never saw.
 */
const resumeInput = z.object({
  resumedBy: z.string(),
  note: z.string().optional(),
});

/** Per-step attempt policy, matching the old runner's D-P6 (initial + 2 retries). */
const RETRIES = 2;

/* -------------------------------------------------------------------------- */
/* The step factory                                                            */
/* -------------------------------------------------------------------------- */

const defs = workflowDefinitions.reconciliation.steps;

function def(key: string): DagStepDefinition {
  const found = defs.find((s) => s.key === key);
  if (!found) throw new Error(`No step "${key}" in the reconciliation graph`);
  return found;
}

/**
 * Wrap one `DagStepDefinition` as a Mastra step.
 *
 * Prior outputs are collected from EVERY step that has produced a result, not only from the
 * step's declared `dependsOn`. That matches the old runner exactly, which builds `priorOutputs`
 * from all completed steps — and it has to, because the real graph relies on it: `report`
 * declares `dependsOn: ["flag"]` but reads `parse_erp`, `parse_bank` and `match` too. Passing
 * only the declared dependencies would have quietly broken it.
 *
 * `dependsOn` is still enforced, as a scheduling assertion: those results MUST be present, and
 * their absence is a graph bug rather than a missing optional input. The dependency list is read
 * from `lib/agents/dag.ts`, so the two execution paths cannot drift.
 */
function harnessStep(key: string) {
  const stepDef = def(key);

  return createStep({
    id: key,
    description: stepDef.name,
    // Permissive: real inputs come from getInitData/getStepResult (see the module note).
    inputSchema: z.any(),
    outputSchema: stepOutput,
    suspendSchema: suspendPayload,
    resumeSchema: resumeInput,
    retries: RETRIES,

    async execute({ getInitData, getStepResult, suspend, resumeData }) {
      const init = getInitData() as RunInput;
      const db = harnessDb();

      // On a resume, record who released the run before doing any work, so the trail shows
      // the decision preceding its consequences rather than the other way round.
      if (resumeData) {
        await appendEvent(db, {
          workflowId: init.workflowId,
          stepKey: key,
          eventType: "workflow_resumed",
          actor: "human",
          payload: {
            step_key: key,
            resumed_by: resumeData.resumedBy,
            note: resumeData.note ?? null,
          },
        });
      }

      const files = await loadWorkflowFiles(db, init.workflowId);

      // Everything completed so far, keyed by step_key — same contract as the old runner.
      const priorOutputs: Record<string, unknown> = {};
      for (const [otherKey, step] of Object.entries(stepsByKey)) {
        if (otherKey === key) continue;
        // Mastra returns null (not undefined) for a step that has not produced a result.
        const prior = getStepResult(step) as z.infer<typeof stepOutput> | null | undefined;
        if (prior != null) priorOutputs[otherKey] = prior.output;
      }

      // Declared dependencies are a hard requirement: Mastra must not schedule a step before
      // its predecessors, so an absence here is a malformed graph, not a late input.
      for (const depKey of stepDef.dependsOn) {
        if (!(depKey in priorOutputs)) {
          throw new Error(`Step "${key}" ran before its dependency "${depKey}" produced output`);
        }
      }

      const outcome = await executeStep({
        db,
        workflowId: init.workflowId,
        orgId: init.orgId,
        workflowType: "reconciliation",
        stepId: null,
        def: stepDef,
        files,
        priorOutputs,
        alreadyMatchedIds: collectMatchedIds(priorOutputs),
      });

      switch (outcome.status) {
        case "completed":
          return {
            stepKey: outcome.stepKey,
            summary: outcome.observation.summary,
            metrics: outcome.observation.metrics,
            output: outcome.output,
          };

        case "suspended":
          // Mastra's native suspend (D-H17). The pending items are already durable in
          // `action_requests`; this pauses the graph around them.
          return suspend({
            stepKey: outcome.stepKey,
            reason: describePending(outcome.pending),
            pending: outcome.pending,
          });

        case "verification_failed":
          // Not retryable: the same inputs will fail the same rules. Distinguished from a
          // transient error so `retries` does not burn attempts re-rejecting a bad action.
          throw new NonRetryableStepError(
            `Verification rejected ${outcome.reasons.length} action(s) in "${key}": ` +
              outcome.reasons.join("; "),
          );

        case "failed":
          throw new Error(outcome.error);
      }
    },
  });
}

/**
 * A failure that retrying cannot fix.
 *
 * Mastra retries a throwing step, which is right for a provider timeout and wrong for a
 * business-rule rejection — the inputs are unchanged, so attempts 2 and 3 re-reject
 * identically, burning tokens and delaying the error the reviewer needs to see. The class is
 * distinct so the message says so plainly in the trail; Mastra will still consume its retries,
 * which is a known cost of using its native retry policy rather than hand-rolling one.
 */
export class NonRetryableStepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableStepError";
  }
}

/** One line describing why a run stopped, for the review banner. */
function describePending(pending: PendingReview[]): string {
  const mandatory = pending.filter((p) => p.mandatory).length;
  const base = `${pending.length} action${pending.length === 1 ? "" : "s"} awaiting review`;
  return mandatory > 0 ? `${base} (${mandatory} require sign-off regardless of policy)` : base;
}

/**
 * Transaction ids already matched, from predecessors' outputs — the resume-safe input to the
 * double-match verifier. Derived from committed step output rather than from in-memory state
 * so that a resumed run sees the same set a fresh one would.
 */
function collectMatchedIds(priorOutputs: Record<string, unknown>): ReadonlySet<string> {
  const ids = new Set<string>();
  const matchOut = priorOutputs["match"] as
    | { matches?: { erpId?: unknown; bankId?: unknown }[] }
    | undefined;
  for (const m of matchOut?.matches ?? []) {
    if (typeof m.erpId === "string") ids.add(m.erpId);
    if (typeof m.bankId === "string") ids.add(m.bankId);
  }
  return ids;
}

/* -------------------------------------------------------------------------- */
/* The graph — edges mirror `dependsOn` in lib/agents/dag.ts                    */
/* -------------------------------------------------------------------------- */

const parseErp = harnessStep("parse_erp");
const parseBank = harnessStep("parse_bank");
const match = harnessStep("match");
const flag = harnessStep("flag");
const report = harnessStep("report");

/**
 * Read inside `execute`, never at module scope, so a step created before its predecessors can
 * still reach them — `harnessStep` builds all five and each needs the others' references.
 */
const stepsByKey: Record<string, ReturnType<typeof harnessStep>> = {
  parse_erp: parseErp,
  parse_bank: parseBank,
  match,
  flag,
  report,
};

export const reconciliationHarnessWorkflow = createWorkflow({
  id: "reconciliation",
  inputSchema: runInput,
  outputSchema: stepOutput,
})
  // Genuinely concurrent, not a UI animation: two independent source files, no shared state.
  .parallel([parseErp, parseBank])
  .then(match)
  .then(flag)
  .then(report)
  .commit();
