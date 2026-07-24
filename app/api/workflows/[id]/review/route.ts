/**
 * Human review gate (PLAN §10, D9).
 *
 * `POST /api/workflows/[id]/review` — body `{ decision, comment? }`.
 * Requires the workflow to be `awaiting_review`. Records a `review_decisions`
 * row, then advances the workflow status: `approved` → approved, `rejected` →
 * rejected, `revision_requested` → stays `awaiting_review` (decision recorded
 * only). Writes a `review_submitted` audit row.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireWorkflowAccess, jsonError } from "@/lib/api/guard";
import { writeAudit } from "@/lib/audit";
import { reviewDecisionEnum } from "@/lib/types";

const reviewBodySchema = z.object({
  decision: reviewDecisionEnum,
  comment: z.string().optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  const g = await requireWorkflowAccess(id);
  if (!g.ok) return g.response;
  const { admin, profile, workflow } = g;

  if (workflow.status !== "awaiting_review") {
    return jsonError("Workflow is not awaiting review", 409);
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const parsed = reviewBodySchema.safeParse(json);
  if (!parsed.success) {
    return jsonError("Invalid request body", 400);
  }
  const { decision, comment } = parsed.data;

  const { error: insertError } = await admin.from("review_decisions").insert({
    workflow_id: workflow.id,
    reviewer_id: profile.id,
    decision,
    comment: comment ?? null,
  });
  if (insertError) {
    return jsonError(`Failed to record decision: ${insertError.message}`, 500);
  }

  // revision_requested keeps the workflow awaiting_review; the others are terminal.
  const nextStatus =
    decision === "approved"
      ? "approved"
      : decision === "rejected"
        ? "rejected"
        : "awaiting_review";

  if (nextStatus !== workflow.status) {
    const { error: updateError } = await admin
      .from("workflows")
      .update({ status: nextStatus })
      .eq("id", workflow.id);
    if (updateError) {
      return jsonError(
        `Failed to update workflow status: ${updateError.message}`,
        500,
      );
    }
  }

  await writeAudit(admin, {
    workflowId: workflow.id,
    actorType: "human",
    actorId: profile.id,
    action: "review_submitted",
    detail: { decision, reviewer: profile.id },
  });

  return NextResponse.json({ status: nextStatus }, { status: 200 });
}
