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
import { reviewDecisionEnum } from "@/lib/types";

const reviewBodySchema = z.object({
  decision: reviewDecisionEnum,
  comment: z.string().max(5000).optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  const g = await requireWorkflowAccess(id);
  if (!g.ok) return g.response;
  const { admin, profile, workflow } = g;

  if (!["admin", "reviewer"].includes(profile.role)) return jsonError("Reviewer or administrator access is required", 403);

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

  const { data: nextStatus, error } = await admin.rpc("submit_workflow_review", {
    p_workflow_id: workflow.id, p_org_id: profile.org_id, p_reviewer_id: profile.id,
    p_decision: decision, p_comment: comment ?? null,
  });
  if (error) {
    const status = error.code === "42501" ? 403 : error.code === "55000" ? 409 : 500;
    const message = status === 500 ? "Could not save the review. Check database migrations and retry." : error.message;
    return jsonError(message, status);
  }
  return NextResponse.json({ status: nextStatus }, { status: 200 });
}
