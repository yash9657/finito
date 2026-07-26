/**
 * DAG orchestrator (Plan 2 §4.3, D-P5/D-P6; Plan 3 §4, D-A3/D-A10/D-A11).
 *
 * `runWorkflow(workflowId)` takes no key: the router owns provider resolution (D-P7).
 * Algorithm: load step rows → reset `error` AND `awaiting_approval` steps to `pending`
 * (resume, D-A10) → repeatedly run the ready set (steps whose deps are all `complete`)
 * concurrently via Promise.all → on a step's final failure, mark it + the workflow
 * `error`; on a step's suspension, mark it + the workflow `awaiting_approval`. Either way
 * stop scheduling new waves but let in-flight siblings finish and persist. Per step: up
 * to 3 attempts with 1s/4s backoff (D-P6). All complete → `awaiting_review`.
 *
 * The authorization gate (Plan 3, D-A3) sits between "step is running" and "step runs":
 * a step whose risk class requires authorization proposes its consequential actions
 * deterministically, they are evaluated + persisted, and the step either suspends (any
 * action still pending a human) or runs with `ctx.approvals` populated. Suspension is not
 * failure (D-A11): the workflow status says `awaiting_approval`, `error_message` stays
 * null, and resume is the same idempotent entry point.
 *
 * Every DB write / Storage read is service-role (D5). Decrypted keys live only inside
 * resolveProvider→invoke→provider frames; nothing here logs or serializes a key (§9).
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { parseFile } from "@/lib/csv/parser";
import { writeAudit, sha256Json } from "@/lib/audit";
import { resolveProvider, invoke, NoProviderConfiguredError } from "@/lib/llm/router";
import { workflowDefinitions } from "@/lib/agents/dag";
import { requiresAuthorization } from "@/lib/approvals/risk";
import { decisionMap, gateStepActions, markCommitted } from "@/lib/approvals/service";
import { isPipelineType } from "@/lib/types";
import type {
  ActionRequest,
  DagStepDefinition,
  LlmInvokeMeta,
  ParsedFile,
  StepContext,
  StepResult,
  Workflow,
  WorkflowFile,
  WorkflowStep,
  WorkflowType,
} from "@/lib/types";

const STORAGE_BUCKET = "workflow-files";
const MAX_DISPLAY_ROWS = 20;
/** Per-step attempt policy (D-P6): initial + 2 retries, backoff 1s then 4s. */
const RETRY_BACKOFFS_MS = [1_000, 4_000];

type SupabaseAdmin = ReturnType<typeof createAdminClient>;

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

export async function runWorkflow(workflowId: string): Promise<void> {
  const db = createAdminClient();

  try {
    const workflow = await loadWorkflow(db, workflowId);
    if (!workflow) return; // no row to mark

    // An investigation has no DAG (Plan 5, D-G3) and must never reach the pipeline runner. The
    // API route rejects it first; this is the backstop for any other caller.
    if (!isPipelineType(workflow.type)) {
      await markWorkflowError(
        db,
        workflowId,
        `"${workflow.type}" is not a pipeline workflow — it is driven by the agent loop`,
      );
      return;
    }
    const workflowType = workflow.type;

    const def = workflowDefinitions[workflowType];
    if (!def || def.steps.length === 0) {
      await markWorkflowError(db, workflowId, `No steps registered for type "${workflowType}"`);
      return;
    }
    const defs = def.steps;

    const files = await loadAndParseFiles(db, workflowId);

    // Ensure step rows exist (with step_key) + backfill legacy rows, then reset the
    // statuses a resume re-runs: `error` (D-P6) and `awaiting_approval` (D-A10).
    await ensureStepRows(db, workflowId, defs);
    await resetResumableSteps(db, workflowId);
    let steps = await loadSteps(db, workflowId);

    // `done`: completed step outputs, keyed by step_key (D-P5).
    const rowByNumber = () => new Map(steps.map((s) => [s.step_number, s]));
    const done = new Map<string, unknown>();
    for (const d of defs) {
      const row = rowByNumber().get(d.stepNumber);
      if (row?.status === "complete") done.set(d.key, row.output);
    }

    // Ready-set scheduling (D-P6).
    const aborted = { value: false };
    const suspended = { value: false };
    for (;;) {
      const rows = rowByNumber();
      const ready = defs.filter(
        (d) =>
          rows.get(d.stepNumber)?.status === "pending" &&
          d.dependsOn.every((k) => done.has(k)),
      );

      if (ready.length === 0) break; // nothing runnable: all done, or stuck on an error

      // Snapshot of prior outputs, stable for this concurrent wave.
      const wavePriors: Record<string, unknown> = Object.fromEntries(done);

      const outcomes = await Promise.all(
        ready.map((d) =>
          executeStep(db, workflowId, workflow.org_id, def.type, d, files, wavePriors, aborted, suspended),
        ),
      );

      // Reload rows to reflect this wave's persisted results.
      steps = await loadSteps(db, workflowId);
      for (const o of outcomes) {
        if (o.ok) done.set(o.key, o.output);
      }
      // A failure or a suspension stops scheduling; siblings in this wave already
      // finished and persisted, so their work is never wasted (D-P6/D-A11).
      if (aborted.value || suspended.value) break;
    }

    // All steps complete → human review gate.
    const allComplete = defs.every(
      (d) => rowByNumber().get(d.stepNumber)?.status === "complete",
    );
    if (allComplete && !aborted.value && !suspended.value) {
      await db
        .from("workflows")
        .update({
          status: "awaiting_review",
          completed_at: new Date().toISOString(),
          error_message: null,
        })
        .eq("id", workflowId);
      await writeAudit(db, {
        workflowId,
        actorType: "system",
        actorId: "system",
        action: "workflow_awaiting_review",
        detail: { stepCount: defs.length },
      });
    }
  } catch (err) {
    await markWorkflowError(db, workflowId, errMessage(err)).catch(() => {});
  }
}

/* -------------------------------------------------------------------------- */
/* Step execution                                                              */
/* -------------------------------------------------------------------------- */

type StepOutcome =
  | { ok: true; key: string; output: unknown }
  | { ok: false; suspended?: boolean };

async function executeStep(
  db: SupabaseAdmin,
  workflowId: string,
  orgId: string,
  // Narrowed from `Workflow["type"]`, which Plan 5 widened to include `investigation` (D-G3).
  // `runWorkflow` proves the narrowing before it gets here; the router's step-config tier is
  // keyed by (workflow_type, step_key) and an investigation has no step keys.
  workflowType: WorkflowType,
  def: DagStepDefinition,
  files: Record<string, ParsedFile>,
  priorOutputs: Record<string, unknown>,
  aborted: { value: boolean },
  suspended: { value: boolean },
): Promise<StepOutcome> {
  const stepRow = (await loadSteps(db, workflowId)).find((s) => s.step_number === def.stepNumber);
  const stepId = stepRow?.id ?? null;

  try {
    // The ctx.llm closure: LLM steps call it; deterministic steps must not. `resolved` is
    // filled in below (after the gate, so a suspended step never resolves a provider) and
    // read at call time.
    let resolved: Awaited<ReturnType<typeof resolveProvider>> | null = null;
    const llm: StepContext["llm"] = async (opts) => {
      if (!resolved) throw new Error(`Deterministic step "${def.key}" must not call ctx.llm`);
      return invoke(resolved, opts);
    };
    // `approvals` is populated by the authorization gate (Plan 3, D-A3) before `run`.
    const ctx: StepContext = {
      workflowId,
      db,
      files,
      priorOutputs,
      llm,
      approvals: new Map(),
    };

    // Full input snapshot → hash; a row-truncated copy → stored for display.
    const fullSnapshot = buildInputSnapshot(files, priorOutputs);
    const inputHash = sha256Json(fullSnapshot);
    const displaySnapshot = truncateForDisplay(fullSnapshot);

    const startedAt = new Date().toISOString();
    await updateStep(db, workflowId, def.stepNumber, {
      status: "running",
      started_at: startedAt,
      input_snapshot: displaySnapshot,
      input_hash: inputHash,
      output: null,
      agent_reasoning: null,
      sources: null,
      model: null,
      provider_used: null,
      tokens_in: null,
      tokens_out: null,
      latency_ms: null,
      llm_raw: null,
      error_message: null,
      completed_at: null,
    });
    await writeAudit(db, {
      workflowId,
      stepId,
      actorType: "system",
      actorId: "system",
      action: "step_started",
      detail: { step_key: def.key, step_number: def.stepNumber, name: def.name, track: def.track },
    });

    /* ---- The authorization gate (Plan 3, D-A3): propose → evaluate → gate ---- */
    let gatedActions: ActionRequest[] = [];
    if (requiresAuthorization(def.risk ?? "read")) {
      // Deterministic proposal from files + prior outputs (D-A1); never the model.
      const proposed = def.proposeActions ? await def.proposeActions(ctx) : [];
      gatedActions = await gateStepActions(db, {
        workflowId,
        orgId,
        stepKey: def.key,
        stepId,
        actions: proposed,
      });

      const stillPending = gatedActions.filter((a) => a.status === "pending");
      if (stillPending.length > 0) {
        await suspendStep(db, workflowId, def, stepId, stillPending, suspended);
        return { ok: false, suspended: true };
      }
      // Every action is resolved (authorized, rejected, or denied) — the step may run and
      // must commit only what `ctx.approvals` authorizes (D-A3/D-A5).
      ctx.approvals = decisionMap(gatedActions);
    }

    // Resolve the provider for LLM steps (D-P7). A missing provider is a clean step
    // failure with no retries — the message points to Settings → Models.
    if (def.kind === "llm") {
      try {
        resolved = await resolveProvider(db, { orgId, workflowType, stepKey: def.key });
      } catch (err) {
        if (err instanceof NoProviderConfiguredError) {
          await failStep(db, workflowId, def, stepId, "system", "system", err.message, aborted);
          return { ok: false };
        }
        throw err;
      }
    }

    // Attempt loop: up to 3 attempts with 1s/4s backoff (D-P6).
    const t0 = Date.now();
    let result: StepResult | null = null;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < RETRY_BACKOFFS_MS.length + 1; attempt++) {
      if (attempt > 0) await sleep(RETRY_BACKOFFS_MS[attempt - 1]);
      try {
        result = await def.run(ctx);
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
      }
    }
    if (!result) throw lastError instanceof Error ? lastError : new Error(String(lastError));
    const durationMs = Date.now() - t0;

    // Provenance columns from llmMeta (D-P11/D-P14); deterministic (or skipped-LLM) → null.
    const meta: LlmInvokeMeta | undefined = result.llmMeta;
    const reasoning = resolved?.warning
      ? `${result.reasoning}\n\n⚠ ${resolved.warning}`
      : result.reasoning;

    await updateStep(db, workflowId, def.stepNumber, {
      status: "complete",
      output: result.output,
      agent_reasoning: reasoning,
      sources: result.sources,
      model: meta?.modelUsed ?? null,
      provider_used: meta?.providerId ?? null,
      tokens_in: meta?.tokensIn ?? null,
      tokens_out: meta?.tokensOut ?? null,
      latency_ms: meta?.latencyMs ?? null,
      llm_raw: meta?.raw ?? null,
      error_message: null,
      completed_at: new Date().toISOString(),
    });
    await writeAudit(db, {
      workflowId,
      stepId,
      actorType: meta ? "agent" : "system",
      actorId: meta?.modelUsed ?? "system",
      action: "step_completed",
      detail: {
        step_key: def.key,
        input_hash: inputHash,
        duration_ms: durationMs,
        model: meta?.modelUsed ?? null,
        provider: meta?.providerId ?? null,
        tokens_in: meta?.tokensIn ?? null,
        tokens_out: meta?.tokensOut ?? null,
      },
    });

    // Close each action's authorization chain now that the step's output is durable:
    // `action_committed` for what happened, `action_withheld` for what was left out
    // (Plan 3, D-A15).
    if (gatedActions.length > 0) {
      await markCommitted(db, { workflowId, stepId, rows: gatedActions });
    }

    return { ok: true, key: def.key, output: result.output };
  } catch (err) {
    await failStep(db, workflowId, def, stepId, "system", "system", errMessage(err), aborted);
    return { ok: false };
  }
}

/**
 * Suspend a gated step and its workflow on `awaiting_approval` (Plan 3, D-A10/D-A11).
 * NOT an error: `error_message` stays null and the pending items live in
 * `action_requests`, so the run survives a restart and resumes from any surface once they
 * are decided. Setting `suspended` stops the scheduler launching new waves.
 */
async function suspendStep(
  db: SupabaseAdmin,
  workflowId: string,
  def: DagStepDefinition,
  stepId: string | null,
  pending: ActionRequest[],
  suspended: { value: boolean },
): Promise<void> {
  suspended.value = true;
  await updateStep(db, workflowId, def.stepNumber, {
    status: "awaiting_approval",
    error_message: null,
    completed_at: null,
  });
  await db
    .from("workflows")
    .update({ status: "awaiting_approval", error_message: null })
    .eq("id", workflowId);
  await writeAudit(db, {
    workflowId,
    stepId,
    actorType: "system",
    actorId: "system",
    action: "workflow_suspended",
    detail: {
      step_key: def.key,
      name: def.name,
      pending_actions: pending.length,
      action_keys: pending.map((p) => p.action_key),
      reason: "awaiting per-action authorization",
    },
  });
}

/**
 * Mark a step (and the workflow) `error`, audit `step_failed`, and set the shared
 * `aborted` flag so the scheduler stops launching new waves (D-P6). Best-effort DB.
 */
async function failStep(
  db: SupabaseAdmin,
  workflowId: string,
  def: DagStepDefinition,
  stepId: string | null,
  actorType: "agent" | "system",
  actorId: string,
  message: string,
  aborted: { value: boolean },
): Promise<void> {
  aborted.value = true;
  try {
    await updateStep(db, workflowId, def.stepNumber, {
      status: "error",
      error_message: message,
      completed_at: new Date().toISOString(),
    });
    await db
      .from("workflows")
      .update({
        status: "error",
        error_message: `Step "${def.name}" failed: ${message}`,
      })
      .eq("id", workflowId);
    await writeAudit(db, {
      workflowId,
      stepId,
      actorType,
      actorId,
      action: "step_failed",
      detail: { step_key: def.key, step_number: def.stepNumber, name: def.name, error: message },
    });
  } catch {
    // Best-effort; the top-level catch in runWorkflow is the final backstop.
  }
}

/* -------------------------------------------------------------------------- */
/* Loading + setup helpers                                                     */
/* -------------------------------------------------------------------------- */

async function loadWorkflow(db: SupabaseAdmin, workflowId: string): Promise<Workflow | null> {
  const { data, error } = await db.from("workflows").select("*").eq("id", workflowId).single();
  if (error || !data) return null;
  return data as Workflow;
}

async function loadAndParseFiles(
  db: SupabaseAdmin,
  workflowId: string,
): Promise<Record<string, ParsedFile>> {
  const { data, error } = await db
    .from("workflow_files")
    .select("*")
    .eq("workflow_id", workflowId);
  if (error) throw new Error(`Failed to load workflow files: ${error.message}`);

  const files: Record<string, ParsedFile> = {};
  for (const row of (data ?? []) as WorkflowFile[]) {
    const { data: blob, error: dlError } = await db.storage
      .from(STORAGE_BUCKET)
      .download(row.storage_path);
    if (dlError || !blob) {
      throw new Error(`Failed to download "${row.storage_path}": ${dlError?.message ?? "no data"}`);
    }
    const buffer = Buffer.from(await blob.arrayBuffer());
    files[row.file_type] = parseFile(buffer, row.file_type, { filename: row.filename });
  }
  return files;
}

/**
 * Insert all step rows as `pending` (with step_key) if none exist; otherwise backfill a
 * null step_key on legacy rows by matching step_number to the definition (§3 backfill).
 */
async function ensureStepRows(
  db: SupabaseAdmin,
  workflowId: string,
  defs: DagStepDefinition[],
): Promise<void> {
  const existing = await loadSteps(db, workflowId);
  if (existing.length === 0) {
    const insertRows = defs.map((d) => ({
      workflow_id: workflowId,
      step_number: d.stepNumber,
      step_key: d.key,
      track: d.track,
      name: d.name,
      status: "pending" as const,
    }));
    const { error } = await db.from("workflow_steps").insert(insertRows);
    if (error) throw new Error(`Failed to insert step rows: ${error.message}`);
    return;
  }

  // Backfill null step_key on legacy rows by step_number.
  const byNumber = new Map(defs.map((d) => [d.stepNumber, d]));
  for (const row of existing) {
    if (row.step_key == null) {
      const d = byNumber.get(row.step_number);
      if (d) {
        const { error } = await db
          .from("workflow_steps")
          .update({ step_key: d.key })
          .eq("id", row.id);
        if (error) throw new Error(`Failed to backfill step_key: ${error.message}`);
      }
    }
  }
}

/**
 * Reset the statuses a resume re-runs: `error` (D-P6) and `awaiting_approval` (D-A10).
 * A re-gated step finds its existing decisions by `action_key` (D-A1), so it either
 * proceeds with them or suspends again — never duplicating a pending item. `complete`
 * steps are untouched and never re-run (D2).
 */
async function resetResumableSteps(db: SupabaseAdmin, workflowId: string): Promise<void> {
  for (const status of ["error", "awaiting_approval"] as const) {
    const { error } = await db
      .from("workflow_steps")
      .update({ status: "pending", error_message: null })
      .eq("workflow_id", workflowId)
      .eq("status", status);
    if (error) throw new Error(`Failed to reset ${status} steps: ${error.message}`);
  }
}

async function loadSteps(db: SupabaseAdmin, workflowId: string): Promise<WorkflowStep[]> {
  const { data, error } = await db
    .from("workflow_steps")
    .select("*")
    .eq("workflow_id", workflowId)
    .order("step_number", { ascending: true });
  if (error) throw new Error(`Failed to load steps: ${error.message}`);
  return (data ?? []) as WorkflowStep[];
}

async function updateStep(
  db: SupabaseAdmin,
  workflowId: string,
  stepNumber: number,
  patch: Record<string, unknown>,
): Promise<void> {
  const { error } = await db
    .from("workflow_steps")
    .update(patch)
    .eq("workflow_id", workflowId)
    .eq("step_number", stepNumber);
  if (error) throw new Error(`Failed to update step ${stepNumber}: ${error.message}`);
}

async function markWorkflowError(
  db: SupabaseAdmin,
  workflowId: string,
  message: string,
): Promise<void> {
  await db.from("workflows").update({ status: "error", error_message: message }).eq("id", workflowId);
  await writeAudit(db, {
    workflowId,
    actorType: "system",
    actorId: "system",
    action: "workflow_error",
    detail: { error: message },
  });
}

/* -------------------------------------------------------------------------- */
/* Snapshot helpers (ported unchanged from the old runner)                     */
/* -------------------------------------------------------------------------- */

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

function truncateForDisplay(value: unknown): unknown {
  if (Array.isArray(value)) {
    const sample = value.slice(0, MAX_DISPLAY_ROWS).map(truncateForDisplay);
    if (value.length > MAX_DISPLAY_ROWS) {
      return { truncated: true, totalRows: value.length, rows: sample };
    }
    return sample;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = truncateForDisplay(v);
    }
    return out;
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
