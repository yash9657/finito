/**
 * PUT /api/llm/step-configs — pin (or unpin) a workflow step to a provider config
 * (Plan 2 §5, admin-only). Body: { workflow_type, step_key, provider_config_id|null }.
 * A null provider_config_id deletes the assignment (the step falls back to the org
 * default, D-P7). The assigned config must be active and in the caller's org.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { jsonError, requireOrgAccess } from "@/lib/api/guard";
import { workflowTypeEnum, type OrgModelConfig } from "@/lib/types";

export async function PUT(req: NextRequest) {
  const g = await requireOrgAccess();
  if (!g.ok) return g.response;
  const { admin, profile } = g;
  if (profile.role !== "admin") return jsonError("Admin role required", 403);

  const body = (await req.json().catch(() => null)) as {
    workflow_type?: unknown;
    step_key?: unknown;
    provider_config_id?: unknown;
  } | null;

  const wf = workflowTypeEnum.safeParse(body?.workflow_type);
  if (!wf.success) return jsonError("Invalid workflow_type", 400);
  if (typeof body?.step_key !== "string" || body.step_key.length === 0) {
    return jsonError("step_key is required", 400);
  }
  const stepKey = body.step_key;
  const configId = body.provider_config_id;

  // null → unassign (fall back to org default).
  if (configId === null || configId === undefined) {
    const { error } = await admin
      .from("workflow_step_configs")
      .delete()
      .eq("org_id", profile.org_id)
      .eq("workflow_type", wf.data)
      .eq("step_key", stepKey);
    if (error) return jsonError(`Failed to clear assignment: ${error.message}`, 500);
    return NextResponse.json({ ok: true });
  }

  if (typeof configId !== "string") return jsonError("Invalid provider_config_id", 400);

  // The config must be active and in this org.
  const { data: config } = await admin
    .from("org_model_configs")
    .select("id, is_active")
    .eq("id", configId)
    .eq("org_id", profile.org_id)
    .maybeSingle<Pick<OrgModelConfig, "id" | "is_active">>();
  if (!config) return jsonError("Provider config not found", 404);
  if (!config.is_active) return jsonError("Cannot assign a step to an inactive provider config", 400);

  // Upsert on the unique (org_id, workflow_type, step_key) triple.
  const { error } = await admin
    .from("workflow_step_configs")
    .upsert(
      {
        org_id: profile.org_id,
        workflow_type: wf.data,
        step_key: stepKey,
        assigned_provider_config_id: configId,
      },
      { onConflict: "org_id,workflow_type,step_key" },
    );
  if (error) return jsonError(`Failed to save assignment: ${error.message}`, 500);
  return NextResponse.json({ ok: true });
}
