/**
 * `GET /api/investigations/[id]` — the investigation and its full event trail (Plan 5, §9).
 *
 * Returns the projection row plus every `harness_events` row for the run, which is what the
 * transcript renders. The events are the authority; the projection is a convenience header
 * (D-G4), and the two are returned together so the client never has to reconcile them.
 */

import { NextResponse } from "next/server";
import { jsonError, requireWorkflowAccess } from "@/lib/api/guard";
import { readEvents } from "@/lib/harness/events";
import { loadInvestigation } from "@/lib/harness/agent/service";
import { listActions } from "@/lib/approvals/service";
import { isPipelineType } from "@/lib/types";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  // Reuses the workflow guard, which is the whole point of an investigation being a workflow
  // row (D-G3): org scoping, 404-vs-403 behaviour and audit context all come for free.
  const access = await requireWorkflowAccess(id);
  if (!access.ok) return access.response;
  const { admin, workflow, profile } = access;

  if (isPipelineType(workflow.type)) {
    return jsonError(
      "That workflow is a pipeline run, not an investigation.",
      400,
    );
  }

  const investigation = await loadInvestigation(admin, id);
  if (!investigation) {
    return jsonError("Investigation not found", 404);
  }

  const [events, actions, conversationResult] = await Promise.all([
    readEvents(admin, id),
    // Recommendations live in the SAME table the approval panel reads (D-G21) — there is no
    // parallel queue, so the transcript shows exactly what a reviewer will see.
    listActions(admin, id),
    admin
      .from("investigations")
      .select(
        "workflow_id, question, answer, status, created_at, parent_workflow_id",
      )
      .eq("org_id", profile.org_id)
      .eq("conversation_id", investigation.conversation_id ?? id)
      .order("created_at", { ascending: false })
      .limit(100),
  ]);

  if (conversationResult.error)
    return jsonError(
      "Conversation history could not be loaded. Please retry.",
      503,
    );

  return NextResponse.json({
    investigation,
    workflow: {
      id: workflow.id,
      name: workflow.name,
      status: workflow.status,
      created_at: workflow.created_at,
      completed_at: workflow.completed_at,
    },
    events,
    actions,
    conversation: conversationResult.data ?? [],
    viewer: {
      canReview: profile.role === "admin" || profile.role === "reviewer",
    },
  });
}
