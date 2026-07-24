/**
 * Generic step executor (PLAN §5.2, D2, D3, D5).
 *
 * `runWorkflow(workflowId)` is the target passed to `waitUntil` from the `/run` route.
 * It is idempotent and resumable (D2): it loads the workflow, downloads + parses the
 * uploaded files once, ensures the step rows exist, then executes each step *whose
 * status is not `complete`* in order — so re-invoking after a crash continues rather
 * than restarts. Every DB write and Storage read goes through the service-role admin
 * client (D5). The runner never throws to the platform: a top-level try/catch marks the
 * workflow `error` on any unexpected failure.
 *
 * Per-step: set `running` + `started_at`, audit `step_started`, compute `input_hash`
 * (sha256 of the canonical JSON of the full input snapshot) and store a display snapshot
 * truncated to the first 20 rows of any array (+ its total count). Run the step; on a
 * throw, retry the whole step exactly once, then mark step + workflow `error`, audit
 * `step_failed`, and stop. On success persist output / reasoning / sources / model and
 * audit `step_completed` with `{ input_hash, duration_ms, model }`. After the last step
 * the workflow flips to `awaiting_review` with `completed_at` set.
 *
 * The two parse steps (Track A/B, step numbers 1 and 2) of reconciliation and AP run
 * concurrently via `Promise.all`; every other step — and all of FP&A — runs sequentially.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { parseFile } from "@/lib/csv/parser";
import { writeAudit, sha256Json } from "@/lib/audit";
import { AGENT_MODEL } from "@/lib/agents/client";
import type {
  ParsedFile,
  StepContext,
  StepDefinition,
  StepResult,
  Workflow,
  WorkflowFile,
  WorkflowStep,
  WorkflowType,
} from "@/lib/types";

import { reconciliationSteps } from "./reconciliation";
import { apMatchingSteps } from "./ap-matching";
import { fpaCommentarySteps } from "./fpa-commentary";

/**
 * The step catalogue per workflow type (SHARED CONTRACTS). Each array is authored in its
 * own `lib/agents/<type>.ts` module and stitched together here so the runner stays generic.
 */
export const stepRegistry: Record<WorkflowType, StepDefinition[]> = {
  reconciliation: reconciliationSteps,
  ap_matching: apMatchingSteps,
  fpa_commentary: fpaCommentarySteps,
};

const STORAGE_BUCKET = "workflow-files";
/** A step running longer than this in wall-clock is treated as crashed by /status (D2). */
const MAX_DISPLAY_ROWS = 20;

type SupabaseAdmin = ReturnType<typeof createAdminClient>;

type StepOutcome =
  | { ok: true; stepNumber: number; output: unknown }
  | { ok: false };

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Execute (or resume) a workflow to completion. Idempotent + resumable (D2). Never
 * throws — all failures are recorded on the workflow row.
 */
export async function runWorkflow(workflowId: string): Promise<void> {
  const db = createAdminClient();

  try {
    // 1. Load workflow + files; download from Storage; parse once (keyed by file_type).
    const workflow = await loadWorkflow(db, workflowId);
    if (!workflow) return; // nothing we can do — no row to mark

    const defs = stepRegistry[workflow.type];
    if (!defs || defs.length === 0) {
      await markWorkflowError(db, workflowId, `No steps registered for type "${workflow.type}"`);
      return;
    }

    const files = await loadAndParseFiles(db, workflowId);

    // 2. Ensure the step rows exist (insert all as `pending` if none yet), then load them.
    const steps = await ensureStepRows(db, workflowId, defs);
    const stepRowByNumber = new Map<number, WorkflowStep>();
    for (const s of steps) stepRowByNumber.set(s.step_number, s);

    // Seed priorOutputs from steps already `complete` (resume support, D2).
    const priorOutputs: Record<number, unknown> = {};
    for (const s of steps) {
      if (s.status === "complete") priorOutputs[s.step_number] = s.output;
    }

    // 3. Execute steps in dependency-respecting groups, skipping `complete` ones.
    const groups = buildGroups(workflow.type, defs);
    for (const group of groups) {
      const pending = group.filter(
        (d) => stepRowByNumber.get(d.stepNumber)?.status !== "complete",
      );
      if (pending.length === 0) continue;

      // priorOutputs is frozen for the duration of a (possibly parallel) group so the
      // concurrent parse steps observe a stable, race-free snapshot.
      const groupPriors: Record<number, unknown> = { ...priorOutputs };

      const outcomes = await Promise.all(
        pending.map((def) =>
          executeStep(db, workflowId, def, files, groupPriors, stepRowByNumber.get(def.stepNumber)),
        ),
      );

      for (const outcome of outcomes) {
        if (!outcome.ok) return; // executeStep already marked step + workflow `error`
        priorOutputs[outcome.stepNumber] = outcome.output;
      }
    }

    // 4. All steps complete → human review gate (workflow status only; no step row).
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
  } catch (err) {
    // The runner must never throw to the platform (D2/§5.2).
    await markWorkflowError(db, workflowId, errMessage(err)).catch(() => {});
  }
}

/* -------------------------------------------------------------------------- */
/* Step execution                                                              */
/* -------------------------------------------------------------------------- */

async function executeStep(
  db: SupabaseAdmin,
  workflowId: string,
  def: StepDefinition,
  files: Record<string, ParsedFile>,
  priorOutputs: Record<number, unknown>,
  stepRow: WorkflowStep | undefined,
): Promise<StepOutcome> {
  const stepId = stepRow?.id ?? null;
  const model = def.kind === "llm" ? AGENT_MODEL : null;
  const actorType = def.kind === "llm" ? "agent" : "system";
  const actorId = model ?? "system";

  try {
    const ctx: StepContext = { workflowId, db, files, priorOutputs };

    // Full input snapshot → hash; a row-truncated copy → stored for display (§5.2).
    const fullSnapshot = buildInputSnapshot(files, priorOutputs);
    const inputHash = sha256Json(fullSnapshot);
    const displaySnapshot = truncateForDisplay(fullSnapshot);

    // Mark running + record the snapshot/hash up front so /status can show inputs live.
    const startedAt = new Date().toISOString();
    await updateStep(db, workflowId, def.stepNumber, {
      status: "running",
      started_at: startedAt,
      input_snapshot: displaySnapshot,
      input_hash: inputHash,
      output: null,
      agent_reasoning: null,
      sources: null,
      model,
      error_message: null,
      completed_at: null,
    });
    await writeAudit(db, {
      workflowId,
      stepId,
      actorType,
      actorId,
      action: "step_started",
      detail: { step_number: def.stepNumber, name: def.name, track: def.track },
    });

    // Run with a single whole-step retry on throw (D3).
    const t0 = Date.now();
    let result: StepResult;
    try {
      result = await def.run(ctx);
    } catch {
      result = await def.run(ctx); // retry once; a second throw propagates to the catch below
    }
    const durationMs = Date.now() - t0;

    await updateStep(db, workflowId, def.stepNumber, {
      status: "complete",
      output: result.output,
      agent_reasoning: result.reasoning,
      sources: result.sources,
      model,
      error_message: null,
      completed_at: new Date().toISOString(),
    });
    await writeAudit(db, {
      workflowId,
      stepId,
      actorType,
      actorId,
      action: "step_completed",
      detail: { input_hash: inputHash, duration_ms: durationMs, model },
    });

    return { ok: true, stepNumber: def.stepNumber, output: result.output };
  } catch (err) {
    await failStep(db, workflowId, def, stepId, actorType, actorId, errMessage(err));
    return { ok: false };
  }
}

/**
 * Mark a step (and the workflow) `error`, audit `step_failed`, swallowing any secondary
 * DB error so the outcome is still reported to the runner.
 */
async function failStep(
  db: SupabaseAdmin,
  workflowId: string,
  def: StepDefinition,
  stepId: string | null,
  actorType: "agent" | "system",
  actorId: string,
  message: string,
): Promise<void> {
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
        error_message: `Step ${def.stepNumber} (${def.name}) failed: ${message}`,
      })
      .eq("id", workflowId);
    await writeAudit(db, {
      workflowId,
      stepId,
      actorType,
      actorId,
      action: "step_failed",
      detail: { step_number: def.stepNumber, name: def.name, error: message },
    });
  } catch {
    // Best-effort; the top-level catch in runWorkflow is the final backstop.
  }
}

/* -------------------------------------------------------------------------- */
/* Loading + setup helpers                                                     */
/* -------------------------------------------------------------------------- */

async function loadWorkflow(db: SupabaseAdmin, workflowId: string): Promise<Workflow | null> {
  const { data, error } = await db
    .from("workflows")
    .select("*")
    .eq("id", workflowId)
    .single();
  if (error || !data) return null;
  return data as Workflow;
}

/**
 * Download every uploaded file from private Storage and parse it once into a
 * `Record<file_type, ParsedFile>` for the step context (§5.2, D5).
 */
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
      throw new Error(
        `Failed to download "${row.storage_path}": ${dlError?.message ?? "no data"}`,
      );
    }
    const buffer = Buffer.from(await blob.arrayBuffer());
    files[row.file_type] = parseFile(buffer, row.file_type, { filename: row.filename });
  }
  return files;
}

/**
 * Insert all step rows as `pending` if none exist yet (one insert), then return the
 * current step rows ordered by step_number.
 */
async function ensureStepRows(
  db: SupabaseAdmin,
  workflowId: string,
  defs: StepDefinition[],
): Promise<WorkflowStep[]> {
  const existing = await loadSteps(db, workflowId);
  if (existing.length > 0) return existing;

  const insertRows = defs.map((d) => ({
    workflow_id: workflowId,
    step_number: d.stepNumber,
    track: d.track,
    name: d.name,
    status: "pending" as const,
  }));
  const { error } = await db.from("workflow_steps").insert(insertRows);
  if (error) throw new Error(`Failed to insert step rows: ${error.message}`);

  return loadSteps(db, workflowId);
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
/* Grouping + snapshot helpers                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Split ordered step definitions into execution groups. For reconciliation and AP the
 * two Track-A/B parse steps (numbers 1 and 2) form a single parallel group; every other
 * step is its own group. FP&A is fully sequential (§5.2).
 */
function buildGroups(type: WorkflowType, defs: StepDefinition[]): StepDefinition[][] {
  const sorted = [...defs].sort((a, b) => a.stepNumber - b.stepNumber);
  if (type === "fpa_commentary") return sorted.map((d) => [d]);

  const parallel = sorted.filter((d) => d.stepNumber === 1 || d.stepNumber === 2);
  const rest = sorted.filter((d) => d.stepNumber !== 1 && d.stepNumber !== 2);

  const groups: StepDefinition[][] = [];
  if (parallel.length > 0) groups.push(parallel);
  for (const d of rest) groups.push([d]);
  return groups;
}

/**
 * The canonical full input snapshot for a step: the parsed files (content-addressed by
 * sha256, with all rows) plus every prior step's validated output. Hashed verbatim for
 * `input_hash`; `truncateForDisplay` produces the row-capped copy stored for display.
 */
function buildInputSnapshot(
  files: Record<string, ParsedFile>,
  priorOutputs: Record<number, unknown>,
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

/**
 * Recursively cap any array at the first `MAX_DISPLAY_ROWS` elements, replacing a longer
 * array with `{ truncated, totalRows, rows }` so the stored snapshot stays small while
 * still reporting the true row count (§5.2). Scalars pass through unchanged.
 */
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

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
