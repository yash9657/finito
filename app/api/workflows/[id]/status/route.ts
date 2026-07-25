import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { requireWorkflowAccess } from "@/lib/api/guard";
import { writeAudit } from "@/lib/audit";
import { listActions } from "@/lib/approvals/service";
import type { ReviewDecision, WorkflowStep } from "@/lib/types";

// A step stuck in `running` beyond this is treated as crashed (D2).
const STALE_STEP_MS = 3 * 60 * 1000;
const STALE_MESSAGE = "Step timed out (running > 3 minutes)";

/**
 * GET /api/workflows/[id]/status — the 2-second polling target (D1).
 *
 * Before responding it performs the stale-step check (D2): any step still
 * `running` with `started_at` older than 3 minutes is treated as crashed and,
 * together with the workflow, flipped to `error` via the admin client.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const g = await requireWorkflowAccess(id);
  if (!g.ok) return g.response;
  const { admin } = g;
  let workflow = g.workflow;

  // Load steps ordered by step_number.
  const { data: stepsData, error: stepsError } = await admin
    .from("workflow_steps")
    .select("*")
    .eq("workflow_id", id)
    .order("step_number", { ascending: true });

  if (stepsError) {
    return NextResponse.json(
      { error: `Failed to load steps: ${stepsError.message}` },
      { status: 500 },
    );
  }

  let steps = (stepsData ?? []) as WorkflowStep[];

  // Stale-step check (D2): flip crashed step(s) + the workflow to `error`.
  const now = Date.now();
  const stale = steps.filter(
    (s) =>
      s.status === "running" &&
      s.started_at !== null &&
      now - new Date(s.started_at).getTime() > STALE_STEP_MS,
  );

  if (stale.length > 0) {
    const completedAt = new Date().toISOString();

    for (const step of stale) {
      await admin
        .from("workflow_steps")
        .update({
          status: "error",
          error_message: STALE_MESSAGE,
          completed_at: completedAt,
        })
        .eq("id", step.id);

      await writeAudit(admin, {
        workflowId: id,
        stepId: step.id,
        actorType: "system",
        actorId: "system",
        action: "step_failed",
        detail: { reason: STALE_MESSAGE, step_number: step.step_number },
      });
    }

    await admin
      .from("workflows")
      .update({ status: "error", error_message: STALE_MESSAGE })
      .eq("id", id);

    // Reflect the flips in the response without a full reload.
    const staleIds = new Set(stale.map((s) => s.id));
    steps = steps.map((s) =>
      staleIds.has(s.id)
        ? {
            ...s,
            status: "error",
            error_message: STALE_MESSAGE,
            completed_at: completedAt,
          }
        : s,
    );
    workflow = { ...workflow, status: "error", error_message: STALE_MESSAGE };
  }

  // Consequential actions proposed by this run (Plan 3, D-A12) — the approval panel's
  // data source, so a suspended run needs no extra endpoint.
  const actions = await listActions(admin, id);

  // Latest review decision (null if none yet).
  const { data: reviewData, error: reviewError } = await admin
    .from("review_decisions")
    .select("*")
    .eq("workflow_id", id)
    .order("decided_at", { ascending: false })
    .limit(1)
    .maybeSingle<ReviewDecision>();

  if (reviewError) {
    return NextResponse.json(
      { error: `Failed to load review: ${reviewError.message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({
    workflow: {
      id: workflow.id,
      name: workflow.name,
      type: workflow.type,
      status: workflow.status,
      error_message: workflow.error_message,
      created_at: workflow.created_at,
      completed_at: workflow.completed_at,
    },
    // NOTE: llm_raw is deliberately NOT projected here (D-P11 / §7) — it stays DB-only.
    steps: steps.map((s) => ({
      id: s.id,
      step_number: s.step_number,
      step_key: s.step_key,
      track: s.track,
      name: s.name,
      status: s.status,
      agent_reasoning: s.agent_reasoning,
      input_snapshot: s.input_snapshot,
      output: s.output,
      sources: s.sources,
      model: s.model,
      provider_used: s.provider_used,
      tokens_in: s.tokens_in,
      tokens_out: s.tokens_out,
      latency_ms: s.latency_ms,
      input_hash: s.input_hash,
      started_at: s.started_at,
      completed_at: s.completed_at,
    })),
    review: reviewData ?? null,
    actions,
  });
}
