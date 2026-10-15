import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getCurrentProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit";
import { jsonError } from "@/lib/api/guard";
import { workflowTypeEnum, type Workflow, type WorkflowType } from "@/lib/types";

/**
 * POST /api/workflows — create a new workflow (§10).
 *
 * Body: `{ type, name? }`. Auth resolves the caller's profile from the Clerk
 * session; the row is inserted (status `idle`) via the admin client in the
 * caller's org; a `workflow_created` audit row is written. → 201 `{ id }`.
 */

const bodySchema = z.object({
  type: workflowTypeEnum,
  name: z.string().trim().min(1).optional(),
});

const TYPE_LABELS: Record<WorkflowType, string> = {
  reconciliation: "Reconciliation",
  ap_matching: "AP Matching",
  fpa_commentary: "FP&A Commentary",
};

/** "Reconciliation — Jul 23" style default name. */
function defaultName(type: WorkflowType): string {
  const day = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date());
  return `${TYPE_LABELS[type]} — ${day}`;
}

export async function POST(req: NextRequest) {
  // 1. Auth: the Clerk user's profile (org_id).
  const profile = await getCurrentProfile();
  if (!profile) {
    return jsonError("Not authenticated", 401);
  }

  // 2. Parse + validate body.
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return jsonError("Invalid request body", 400);
  }
  const { type } = parsed.data;
  const name = parsed.data.name ?? defaultName(type);

  const admin = createAdminClient();

  // 3. Insert the workflow row (status `idle`) in the caller's org.
  const { data: workflow, error: insertError } = await admin
    .from("workflows")
    .insert({
      org_id: profile.org_id,
      created_by: profile.id,
      name,
      type,
      status: "idle",
    })
    .select("*")
    .single<Workflow>();
  if (insertError || !workflow) {
    return jsonError("Failed to create workflow", 500);
  }

  // 4. Audit.
  await writeAudit(admin, {
    workflowId: workflow.id,
    actorType: "human",
    actorId: profile.id,
    action: "workflow_created",
    detail: { type, name },
  });

  return NextResponse.json({ id: workflow.id }, { status: 201 });
}
