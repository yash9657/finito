/**
 * Excel report download (PLAN §10, §12).
 *
 * `GET /api/workflows/[id]/report?format=xlsx` — requires the workflow to be
 * `approved`. Loads the workflow, its steps, files, and the latest review
 * decision (plus the reviewer's profile) via the admin client, builds the report
 * workbook (§12), and streams the xlsx bytes back as an attachment.
 */

import { NextResponse, type NextRequest } from "next/server";
import { requireWorkflowAccess, jsonError } from "@/lib/api/guard";
import { buildWorkbookBuffer } from "@/lib/excel/writer";
import { listActions } from "@/lib/approvals/service";
import type {
  WorkflowStep,
  WorkflowFile,
  ReviewDecision,
  Profile,
} from "@/lib/types";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  const format = req.nextUrl.searchParams.get("format");
  if (format && format !== "xlsx") {
    return jsonError("Unsupported format", 400);
  }

  const g = await requireWorkflowAccess(id);
  if (!g.ok) return g.response;
  const { admin, workflow } = g;

  if (workflow.status !== "approved") {
    return jsonError("Workflow is not approved", 409);
  }

  const [stepsRes, filesRes, decisionRes] = await Promise.all([
    admin
      .from("workflow_steps")
      .select("*")
      .eq("workflow_id", workflow.id)
      .order("step_number", { ascending: true }),
    admin
      .from("workflow_files")
      .select("*")
      .eq("workflow_id", workflow.id)
      .order("uploaded_at", { ascending: true }),
    admin
      .from("review_decisions")
      .select("*")
      .eq("workflow_id", workflow.id)
      .order("decided_at", { ascending: false })
      .limit(1)
      .maybeSingle<ReviewDecision>(),
  ]);

  if (stepsRes.error) {
    return jsonError(`Failed to load steps: ${stepsRes.error.message}`, 500);
  }
  if (filesRes.error) {
    return jsonError(`Failed to load files: ${filesRes.error.message}`, 500);
  }
  if (decisionRes.error) {
    return jsonError(
      `Failed to load review decision: ${decisionRes.error.message}`,
      500,
    );
  }

  const steps = (stepsRes.data ?? []) as WorkflowStep[];
  const files = (filesRes.data ?? []) as WorkflowFile[];
  const decision = decisionRes.data ?? null;

  let reviewerProfile: Profile | null = null;
  if (decision) {
    const { data } = await admin
      .from("profiles")
      .select("*")
      .eq("id", decision.reviewer_id)
      .maybeSingle<Profile>();
    reviewerProfile = data ?? null;
  }

  // The authorization chain (Plan 3, D-A15): every consequential action this run
  // proposed, plus the emails of whoever approved them, so the workbook can name them.
  const actions = await listActions(admin, workflow.id);
  const approverIds = [...new Set(actions.map((a) => a.decided_by).filter((x): x is string => !!x))];
  const approverEmails: Record<string, string> = {};
  for (const approverId of approverIds) {
    const { data } = await admin
      .from("profiles")
      .select("id, email")
      .eq("id", approverId)
      .maybeSingle<Pick<Profile, "id" | "email">>();
    if (data) approverEmails[data.id] = data.email;
  }

  const buffer = buildWorkbookBuffer(workflow, steps, files, decision, reviewerProfile, {
    actions,
    approverEmails,
  });

  const filename = `finflow-${workflow.type}-${workflow.id.slice(0, 8)}.xlsx`;

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
