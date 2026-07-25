import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { requireWorkflowAccess, jsonError } from "@/lib/api/guard";
import { writeAudit } from "@/lib/audit";
import { runWorkflow } from "@/lib/agents/orchestrator";
import { resolveProvider, NoProviderConfiguredError } from "@/lib/llm/router";
import { pendingActions } from "@/lib/approvals/service";
import { workflowDefinitions } from "@/lib/agents/dag";
import type { FileType, WorkflowType } from "@/lib/types";

// Long-running background execution kicked off via waitUntil (D2).
export const maxDuration = 300;

/**
 * Required uploaded file types per workflow type (§10).
 * recon → erp_export + bank_statement; AP → po + invoice; FP&A → budget + actuals.
 */
const REQUIRED_FILES: Record<WorkflowType, FileType[]> = {
  reconciliation: ["erp_export", "bank_statement"],
  ap_matching: ["po", "invoice"],
  fpa_commentary: ["budget", "actuals"],
};

/**
 * POST /api/workflows/[id]/run — validate readiness, verify a provider resolves for
 * every LLM step (D-P4/D-P7), mark the workflow `running`, then fire the DAG
 * orchestrator in the background (D2/D-P6) and return 202.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const g = await requireWorkflowAccess(id);
  if (!g.ok) return g.response;
  const { admin, profile, workflow } = g;

  // Re-running after a crash/failure = resume (D2); `awaiting_approval` is the third
  // resumable state (Plan 3, D-A10) — but only once every pending action is decided.
  if (
    workflow.status !== "idle" &&
    workflow.status !== "error" &&
    workflow.status !== "awaiting_approval"
  ) {
    return jsonError(
      `Workflow is '${workflow.status}'; only 'idle', 'error' or 'awaiting_approval' workflows can be run.`,
      409,
    );
  }

  if (workflow.status === "awaiting_approval") {
    const pending = await pendingActions(admin, id);
    if (pending.length > 0) {
      return jsonError(
        `${pending.length} action(s) still await approval — resolve them before resuming.`,
        409,
      );
    }
  }

  // All required files must be present for this workflow type.
  const required = REQUIRED_FILES[workflow.type];
  const { data: files, error: filesError } = await admin
    .from("workflow_files")
    .select("file_type")
    .eq("workflow_id", id);

  if (filesError) {
    return jsonError(`Failed to load files: ${filesError.message}`, 500);
  }

  const present = new Set((files ?? []).map((f) => f.file_type as FileType));
  const missing = required.filter((ft) => !present.has(ft));
  if (missing.length > 0) {
    return jsonError(`Missing required files: ${missing.join(", ")}`, 400);
  }

  // Fail fast (D-P4): the org must resolve a provider for every LLM step before we flip
  // to running, so a misconfigured org gets a clear 400 up front instead of a paused run.
  const def = workflowDefinitions[workflow.type];
  try {
    for (const step of def.steps) {
      if (step.kind !== "llm") continue;
      await resolveProvider(admin, {
        orgId: profile.org_id,
        workflowType: workflow.type,
        stepKey: step.key,
      });
    }
  } catch (err) {
    if (err instanceof NoProviderConfiguredError) {
      return jsonError(err.message, 400);
    }
    return jsonError(err instanceof Error ? err.message : "Provider resolution failed", 500);
  }

  // Mark running + record launch time. Clear any prior error_message from a failed run.
  // A resume keeps the original `started_at` so the audit certificate reports when the
  // run actually launched, not when it was last resumed.
  const { error: updateError } = await admin
    .from("workflows")
    .update({
      status: "running",
      started_at: workflow.started_at ?? new Date().toISOString(),
      error_message: null,
    })
    .eq("id", id);

  if (updateError) {
    return jsonError(`Failed to launch workflow: ${updateError.message}`, 500);
  }

  await writeAudit(admin, {
    workflowId: id,
    actorType: "human",
    actorId: profile.id,
    // A relaunch from `error`/`awaiting_approval` is a resume, not a launch (D-A10).
    action: workflow.status === "idle" ? "workflow_launched" : "workflow_resumed",
    detail: { type: workflow.type, from_status: workflow.status },
  });

  // Primary path: run in the background via waitUntil (works under `next dev`, D2/§15).
  // Fallback (§15): if waitUntil is unavailable at runtime, fire-and-catch.
  try {
    const { waitUntil } = await import("@vercel/functions");
    waitUntil(runWorkflow(id));
  } catch {
    void runWorkflow(id).catch((err: unknown) => {
      console.error(`[run] background runWorkflow(${id}) failed:`, err);
    });
  }

  return NextResponse.json({ status: "running" }, { status: 202 });
}
