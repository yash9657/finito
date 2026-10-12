import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { requireWorkflowAccess } from "@/lib/api/guard";
import { listActions } from "@/lib/approvals/service";
import type { ReviewDecision, WorkflowStep } from "@/lib/types";

/**
 * GET /api/workflows/[id]/status — the 2-second polling target (D1).
 *
 * Observational only. Elapsed time is not proof of worker death: a slow model can still
 * complete after three minutes. Recovery must be performed by a leased worker/watchdog,
 * not a browser poll that can overwrite a concurrent successful completion.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const g = await requireWorkflowAccess(id);
  if (!g.ok) return g.response;
  const { admin } = g;
  const workflow = g.workflow;

  // Load steps ordered by step_number.
  const { data: stepsData, error: stepsError } = await admin
    .from("workflow_steps")
    .select("*")
    .eq("workflow_id", id)
    .order("step_number", { ascending: true });

  if (stepsError) {
    return NextResponse.json(
      { error: "Failed to load workflow steps. Retry shortly." },
      { status: 500 },
    );
  }

  const steps = (stepsData ?? []) as WorkflowStep[];

  // Consequential actions proposed by this run (Plan 3, D-A12) — the approval panel's
  // data source, so a suspended run needs no extra endpoint.
  let actions: Awaited<ReturnType<typeof listActions>>;
  try {
    actions = await listActions(admin, id);
  } catch {
    return NextResponse.json({ error: "Failed to load approval requests. Retry shortly." }, { status: 503 });
  }

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
      { error: "Failed to load workflow review. Retry shortly." },
      { status: 500 },
    );
  }

  return NextResponse.json({
    viewer: { canReview: g.profile.role === "admin" || g.profile.role === "reviewer" },
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
