/**
 * The action/observation loop (Plan 4 §1, D-H8) — the ONE primitive every step runs through.
 *
 *   step_started
 *     → action_proposed            (one per action the step intends to take)
 *     → action_verified | action_failed_verification   (deterministic rules, D-H9)
 *     → human_review_requested + workflow_paused       (if required — D-H10)
 *     → action_executed
 *     → observation_received       (the result, which is input to the next step)
 *     → step_completed | step_failed
 *
 * Two invariants, both structural rather than conventional:
 *
 *   1. **No LLM call happens outside this loop.** Step bodies receive `ctx.llm`, a closure
 *      over `router.dispatch`. They never import the router and never see a provider or a
 *      key. Enforced additionally by the `no-restricted-imports` boundary in eslint.config.
 *
 *   2. **Nothing executes before it verifies.** `verifyAction` is called between `propose`
 *      and `execute` in this one function body, and the verdicts are what the execute branch
 *      is conditioned on. There is no path to `def.run` that skips it — not "no path we
 *      intend", no path.
 *
 * ## Where FinFlow deliberately differs from OpenHands
 *
 * In OpenHands the LLM *emits* the action and the runtime executes it. Here, proposals are
 * derived **deterministically in TypeScript** from files and prior outputs (PLAN.md D3,
 * PLAN-3 D-A1/D-A13) — which is why `action_proposed` events carry `actor: 'system'` and no
 * `model_used`. The model's contribution is adjudicating ambiguity *inside* execution, and
 * that is where provider/model appear on the trail. This is the core correctness property of
 * the product: a model can influence which of several legal actions is taken, but it cannot
 * invent an action that the deterministic layer did not propose and the verifier did not pass.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { appendEvent, tryAppendEvent } from "@/lib/harness/events";
import { roleMayDeclareRisk, roleMayPropose, roleSpec } from "@/lib/harness/roles";
import {
  DEFAULT_VERIFICATION_POLICY,
  verifyAction,
  type VerificationContext,
  type VerificationPolicy,
  type VerificationVerdict,
} from "@/lib/harness/verifiers";
import { dispatch } from "@/lib/llm/router";
import { requiresAuthorization } from "@/lib/approvals/risk";
import { decisionMap, gateStepActions } from "@/lib/approvals/service";
import { sha256Json } from "@/lib/audit";
import type {
  ActionRequest,
  DagStepDefinition,
  LlmInvokeMeta,
  ParsedFile,
  ProposedAction,
  StepContext,
  StepResult,
  WorkflowType,
} from "@/lib/types";

/** How many rows of an output are previewed on an observation event. */
const OBSERVATION_PREVIEW_ROWS = 5;

export interface ExecuteStepArgs {
  db: SupabaseClient;
  workflowId: string;
  orgId: string;
  workflowType: WorkflowType;
  /** The `workflow_steps` row id, when one exists. Events carry `step_key` regardless. */
  stepId: string | null;
  /** Reused from the existing DAG definitions (D-H16) — role, kind, risk, propose, run. */
  def: DagStepDefinition;
  files: Record<string, ParsedFile>;
  priorOutputs: Record<string, unknown>;
  /** Org verification tolerances. Defaults are conservative (see DEFAULT_VERIFICATION_POLICY). */
  policy?: VerificationPolicy;
  /** Resolved by the caller from committed state — makes the double-match check resume-safe. */
  alreadyMatchedIds?: ReadonlySet<string>;
  chartOfAccounts?: ReadonlySet<string>;
}

export type StepOutcome =
  | {
      status: "completed";
      stepKey: string;
      output: unknown;
      observation: Observation;
      llmMeta?: LlmInvokeMeta;
    }
  /** A verifier rejected an action. Nothing executed; no human was asked. */
  | { status: "verification_failed"; stepKey: string; reasons: string[] }
  /** Waiting on a human. Nothing executed; the pending items are durable. */
  | { status: "suspended"; stepKey: string; pending: PendingReview[] }
  | { status: "failed"; stepKey: string; error: string };

export interface Observation {
  /** The one-line result, e.g. "3 of 5 transactions matched, 2 flagged". */
  summary: string;
  /** Counts the next step and the UI can read without parsing the output blob. */
  metrics: Record<string, number>;
  sources: { file: string; note: string }[];
}

export interface PendingReview {
  actionKey: string;
  actionType: string;
  summary: string;
  /** Why a human is needed: an unresolved authorization, or a high-risk verdict (D-H10). */
  reason: string;
  mandatory: boolean;
}

/* -------------------------------------------------------------------------- */
/* The loop                                                                    */
/* -------------------------------------------------------------------------- */

export async function executeStep(args: ExecuteStepArgs): Promise<StepOutcome> {
  const { db, workflowId, orgId, workflowType, stepId, def, files, priorOutputs } = args;
  const stepKey = def.key;
  const policy = args.policy ?? DEFAULT_VERIFICATION_POLICY;
  const risk = def.risk ?? "read";

  // The input this step consumes, hashed once and cited by every event below. Recomputing
  // it from the source data must reproduce the digest — that is the tamper-evidence.
  const inputSnapshot = buildInputSnapshot(files, priorOutputs);
  const inputHash = sha256Json(inputSnapshot);

  const event = (
    eventType: Parameters<typeof appendEvent>[1]["eventType"],
    rest: Omit<Parameters<typeof appendEvent>[1], "workflowId" | "eventType" | "stepId" | "stepKey">,
  ) => appendEvent(db, { workflowId, stepId, stepKey, eventType, ...rest });

  try {
    /* ---- 0. the step's own wiring ---------------------------------------- */
    // A step whose declared risk exceeds what its role could ever legitimately do is
    // mis-wired. Caught here rather than at import time because the message needs to reach
    // the run's trail — a graph that throws at import takes the whole app down instead.
    if (!roleMayDeclareRisk(def.role, risk)) {
      const reason =
        `Step "${stepKey}" declares risk "${risk}" but role "${def.role}" ` +
        `may not exceed "${roleSpec(def.role).maxRiskClass}"`;
      await tryAppendEvent(db, {
        workflowId,
        stepId,
        stepKey,
        eventType: "step_failed",
        actor: "system",
        payload: { step_key: stepKey, failure: "role_risk_mismatch", reason },
      });
      return { status: "failed", stepKey, error: reason };
    }

    /* ---- 1. step_started ------------------------------------------------- */
    await event("step_started", {
      actor: "system",
      payload: {
        step_key: stepKey,
        step_number: def.stepNumber,
        name: def.name,
        role: def.role,
        kind: def.kind,
        risk_class: risk,
        depends_on: def.dependsOn,
      },
      inputHash,
    });

    /* ---- 2. propose ------------------------------------------------------ */
    // Deterministic, never from the model (see the module note on OpenHands).
    const proposed = await proposeActions(def, {
      workflowId,
      db,
      files,
      priorOutputs,
      llm: forbiddenLlm(stepKey, "proposeActions"),
      approvals: new Map(),
    });

    for (const action of proposed) {
      await event("action_proposed", {
        actor: "system",
        payload: {
          action_type: action.actionType,
          action_key: action.actionKey,
          target: action.target,
          params: action.payload ?? null,
          risk_class: action.riskClass,
          reasoning: action.summary,
          proposed_by_role: def.role,
        },
        inputHash,
      });
    }

    /* ---- 3. verify ------------------------------------------------------- */
    const verificationContext: VerificationContext = {
      files,
      priorOutputs,
      policy,
      alreadyMatchedIds: args.alreadyMatchedIds,
      chartOfAccounts: args.chartOfAccounts,
    };

    const verdicts: { action: ProposedAction; verdict: VerificationVerdict }[] = [];
    const failures: string[] = [];

    for (const action of proposed) {
      // 3a. Role constraint (D-H15). Checked before the business rules because it is a
      // different KIND of problem: a programming error, not a rejected business act. A
      // writer proposing a journal entry is a bug in the step, and must never be presented
      // to a reviewer as though it were a borderline judgement call.
      if (!roleMayPropose(def.role, action.actionType)) {
        const reason =
          `Role "${def.role}" may not propose "${action.actionType}" ` +
          `(allowed: ${roleSpec(def.role).allowedActionTypes.join(", ") || "none"})`;
        await event("action_failed_verification", {
          actor: "system",
          payload: {
            action_key: action.actionKey,
            action_type: action.actionType,
            failure: "illegal_action_type",
            reason,
          },
          inputHash,
        });
        failures.push(reason);
        continue;
      }

      // 3b. Deterministic business rules (D-H9).
      const verdict = verifyAction(action, verificationContext);
      if (!verdict.pass) {
        const reason = verdict.reason ?? "verification failed without a stated reason";
        await event("action_failed_verification", {
          actor: "system",
          payload: {
            action_key: action.actionKey,
            action_type: action.actionType,
            failure: "business_rule",
            reason,
            risk_level: verdict.riskLevel,
          },
          inputHash,
        });
        failures.push(`${action.actionKey}: ${reason}`);
        continue;
      }

      await event("action_verified", {
        actor: "system",
        payload: {
          action_key: action.actionKey,
          action_type: action.actionType,
          risk_level: verdict.riskLevel,
          note: verdict.reason ?? null,
        },
        inputHash,
      });
      verdicts.push({ action, verdict });
    }

    // Any verification failure stops the step. Nothing executed, and deliberately no human
    // was asked: a reviewer must never be handed a machine-rejectable action to rubber-stamp.
    if (failures.length > 0) {
      await event("step_failed", {
        actor: "system",
        payload: {
          step_key: stepKey,
          failure: "verification",
          reasons: failures,
          verified_count: verdicts.length,
          rejected_count: failures.length,
        },
        inputHash,
      });
      return { status: "verification_failed", stepKey, reasons: failures };
    }

    /* ---- 4. authorization + the mandatory-review floor ------------------- */
    // Verified means legal. This asks a different question: who may allow it (D-H9).
    let gated: ActionRequest[] = [];
    if (requiresAuthorization(risk) && proposed.length > 0) {
      gated = await gateStepActions(db, {
        workflowId,
        orgId,
        stepKey,
        stepId,
        actions: proposed,
      });
    }

    const pending: PendingReview[] = [];

    // 4a. Unresolved authorizations (Plan 3, D-A3).
    for (const row of gated) {
      if (row.status === "pending") {
        pending.push({
          actionKey: row.action_key,
          actionType: row.action_type,
          summary: row.summary,
          reason: "awaiting per-action authorization",
          mandatory: false,
        });
      }
    }

    // 4b. THE HARDCODED SAFETY FLOOR (D-H10). A `high` verdict on a PASSING action forces a
    // human review request regardless of org config, of any standing rule that would
    // otherwise auto-approve it, and of the agent's own confidence. There is no parameter
    // here that disables this, by design. Do not add one — see verifiers/types.ts.
    for (const { action, verdict } of verdicts) {
      if (verdict.riskLevel !== "high") continue;
      const already = pending.some((p) => p.actionKey === action.actionKey);
      const entry: PendingReview = {
        actionKey: action.actionKey,
        actionType: action.actionType,
        summary: action.summary,
        reason: verdict.reason ?? "verifier classified this action as high risk",
        mandatory: true,
      };
      if (already) {
        // Already pending for authorization; mark it mandatory so no standing rule can
        // clear it on resume.
        const existing = pending.find((p) => p.actionKey === action.actionKey)!;
        existing.mandatory = true;
        existing.reason = `${existing.reason}; ${entry.reason}`;
      } else {
        pending.push(entry);
      }
    }

    if (pending.length > 0) {
      await event("human_review_requested", {
        actor: "system",
        payload: {
          step_key: stepKey,
          pending_count: pending.length,
          mandatory_count: pending.filter((p) => p.mandatory).length,
          actions: pending,
        },
        inputHash,
      });
      await event("workflow_paused", {
        actor: "system",
        payload: {
          step_key: stepKey,
          reason: "awaiting human review",
          action_keys: pending.map((p) => p.actionKey),
        },
      });
      return { status: "suspended", stepKey, pending };
    }

    /* ---- 5. execute ------------------------------------------------------ */
    // Every action is verified and authorized. `llmMeta` is captured from the LAST dispatch
    // so the executed/observed events can name the model that actually produced the work.
    let llmMeta: LlmInvokeMeta | undefined;
    let warning: string | undefined;

    const llm: StepContext["llm"] = async (opts) => {
      if (def.kind !== "llm") {
        // A deterministic step reaching for a model is a definition bug. Failing loudly
        // keeps the "arithmetic is never delegated to a model" guarantee honest (D3).
        throw new Error(`Deterministic step "${stepKey}" must not call ctx.llm`);
      }
      const result = await dispatch(db, {
        orgId,
        workflowType,
        role: def.role,
        stepKey,
        system: opts.system,
        user: opts.user,
        schema: opts.schema,
      });
      llmMeta = result.meta;
      warning = result.warning ?? warning;
      return result;
    };

    const ctx: StepContext = {
      workflowId,
      db,
      files,
      priorOutputs,
      llm,
      approvals: decisionMap(gated),
    };

    const startedAt = Date.now();
    const result: StepResult = await def.run(ctx);
    const durationMs = Date.now() - startedAt;

    for (const action of proposed) {
      await event("action_executed", {
        actor: def.kind === "llm" ? "agent" : "system",
        payload: {
          action_key: action.actionKey,
          action_type: action.actionType,
          target: action.target,
        },
        providerUsed: llmMeta?.providerId ?? null,
        modelUsed: llmMeta?.modelUsed ?? null,
        inputHash,
      });
    }

    /* ---- 6. observe ------------------------------------------------------ */
    const observation = buildObservation(result, durationMs);
    await event("observation_received", {
      actor: "system",
      payload: {
        step_key: stepKey,
        summary: observation.summary,
        metrics: observation.metrics,
        sources: observation.sources,
        output_preview: previewOutput(result.output),
        provider_warning: warning ?? null,
      },
      providerUsed: llmMeta?.providerId ?? null,
      modelUsed: llmMeta?.modelUsed ?? null,
      inputHash,
    });

    /* ---- 7. step_completed ---------------------------------------------- */
    await event("step_completed", {
      actor: llmMeta ? "agent" : "system",
      payload: {
        step_key: stepKey,
        duration_ms: durationMs,
        actions_executed: proposed.length,
        tokens_in: llmMeta?.tokensIn ?? null,
        tokens_out: llmMeta?.tokensOut ?? null,
        latency_ms: llmMeta?.latencyMs ?? null,
      },
      providerUsed: llmMeta?.providerId ?? null,
      modelUsed: llmMeta?.modelUsed ?? null,
      inputHash,
    });

    return { status: "completed", stepKey, output: result.output, observation, llmMeta };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Best-effort: this path is already handling a failure, so an append error here must
    // not replace the real cause (see events.ts on tryAppendEvent).
    await tryAppendEvent(db, {
      workflowId,
      stepId,
      stepKey,
      eventType: "step_failed",
      actor: "system",
      payload: { step_key: stepKey, failure: "error", error: message },
      inputHash,
    });
    return { status: "failed", stepKey, error: message };
  }
}

/* -------------------------------------------------------------------------- */
/* Proposal                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The actions this step intends to take.
 *
 * A consequential step supplies `proposeActions` (validateDag enforces that it does). A
 * `read` step has none to declare, so the loop synthesizes ONE action standing for the
 * step's own operation — normalizing a dataset, adjudicating matches, writing commentary.
 *
 * That synthesis is what makes the lifecycle exception-free (D-H8). Without it, read steps
 * would take a shortcut around propose/verify, and "every step is verified before it runs"
 * would quietly mean "every consequential step" — which is how the analysis step that reads
 * an empty file and reports a clean close gets through.
 */
async function proposeActions(
  def: DagStepDefinition,
  ctx: StepContext,
): Promise<ProposedAction[]> {
  if (def.proposeActions) return def.proposeActions(ctx);

  const spec = roleSpec(def.role);
  const actionType = spec.defaultActionType;
  if (!actionType) return [];

  // The file a parser step reads, inferred from what the step's own `run` requires. Passing
  // the file type lets the dataset verifier tie the action to specific bytes.
  const fileType = def.fileType ?? null;
  const parsed = fileType ? ctx.files[fileType] : undefined;

  return [
    {
      actionKey: `${actionType}:${def.key}`,
      actionType,
      riskClass: "read",
      target: {
        kind: fileType ? "dataset" : "analysis",
        id: fileType ?? def.key,
        counterparty: null,
        amountCents: null,
      },
      summary: def.name,
      payload: {
        step_key: def.key,
        role: def.role,
        ...(fileType ? { fileType } : {}),
        ...(parsed ? { expectedSha256: parsed.meta.sha256 } : {}),
      },
    },
  ];
}

/** A `ctx.llm` that always throws — for phases where a model must not be consulted. */
function forbiddenLlm(stepKey: string, phase: string): StepContext["llm"] {
  return () => {
    // Proposals must be reproducible from the source data alone (D-A1/D-A13). A model call
    // here would make the gate's input non-deterministic, so the same run could propose
    // different actions on resume.
    throw new Error(`Step "${stepKey}" must not call ctx.llm during ${phase}`);
  };
}

/* -------------------------------------------------------------------------- */
/* Observation                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Turn a step result into the observation the next step and the UI consume.
 *
 * `metrics` is derived from the output's own shape rather than from a per-workflow special
 * case: any array-valued top-level field contributes its length. So a matcher returning
 * `{ matched: [...], unmatched: [...] }` yields `{ matched: 3, unmatched: 2 }` with no
 * matcher-specific code here, and a new workflow's counts appear on the trail for free.
 */
function buildObservation(result: StepResult, durationMs: number): Observation {
  const metrics: Record<string, number> = { duration_ms: durationMs };
  const output = result.output;

  if (output !== null && typeof output === "object") {
    for (const [key, value] of Object.entries(output as Record<string, unknown>)) {
      if (Array.isArray(value)) metrics[key] = value.length;
    }
    // A ParsedFile-shaped output reports its parse counts.
    const meta = (output as { meta?: { rowCount?: unknown; skippedCount?: unknown } }).meta;
    if (meta && typeof meta.rowCount === "number") metrics.rows = meta.rowCount;
    if (meta && typeof meta.skippedCount === "number") metrics.skipped = meta.skippedCount;
  }

  // The step's own reasoning is the most faithful one-line summary available; it is written
  // by the step (or the model) specifically to describe what happened.
  const summary = result.reasoning.trim().split("\n")[0] || "Step completed";

  return { summary, metrics, sources: result.sources };
}

/** A small, bounded excerpt of the output — the trail cites, it does not duplicate. */
function previewOutput(output: unknown): unknown {
  if (Array.isArray(output)) {
    return {
      total: output.length,
      rows: output.slice(0, OBSERVATION_PREVIEW_ROWS),
    };
  }
  if (output !== null && typeof output === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(output as Record<string, unknown>)) {
      out[key] = Array.isArray(value)
        ? { total: value.length, rows: value.slice(0, OBSERVATION_PREVIEW_ROWS) }
        : value;
    }
    return out;
  }
  return output;
}

/** The full input a step consumed — hashed, never stored whole (the events cite it). */
function buildInputSnapshot(
  files: Record<string, ParsedFile>,
  priorOutputs: Record<string, unknown>,
): unknown {
  const fileSnapshot: Record<string, unknown> = {};
  for (const [fileType, pf] of Object.entries(files)) {
    fileSnapshot[fileType] = {
      sha256: pf.meta.sha256,
      rowCount: pf.meta.rowCount,
      skippedCount: pf.meta.skippedCount,
      rows: pf.rows,
    };
  }
  return { files: fileSnapshot, priorOutputs };
}
