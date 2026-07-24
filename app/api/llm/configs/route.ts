/**
 * GET  /api/llm/configs — list the org's model configs (browser-safe projection,
 *   never the ciphertext, D-P3) + step assignments. Any org member.
 * POST /api/llm/configs — create a config (admin-only). Encrypts the key (D-P2),
 *   stores ciphertext + key_last4, clears the prior default when is_default is set.
 *
 * DECISION (Plan 2 §5): audit_log is workflow-scoped (workflow_id NOT NULL, §4), so
 * config mutations are not written there in this pass — a future org-level audit table
 * would carry `llm_config_created`/`_updated`. All access is service-role per D5.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { jsonError, requireOrgAccess } from "@/lib/api/guard";
import { encryptApiKey, hasEncryptionSecret, keyLast4 } from "@/lib/llm/crypto";
import { configInputSchema, validateConfigInput } from "@/lib/llm/config-service";
import type {
  OrgModelConfig,
  OrgModelConfigPublic,
  WorkflowStepConfig,
} from "@/lib/types";

function toPublic(c: OrgModelConfig): OrgModelConfigPublic {
  return {
    id: c.id,
    provider: c.provider,
    display_name: c.display_name,
    key_last4: c.key_last4,
    base_url: c.base_url,
    default_model: c.default_model,
    is_default: c.is_default,
    is_active: c.is_active,
    created_at: c.created_at,
  };
}

export async function GET() {
  const g = await requireOrgAccess();
  if (!g.ok) return g.response;
  const { admin, profile } = g;

  const [configsRes, assignRes] = await Promise.all([
    admin
      .from("org_model_configs")
      .select("*")
      .eq("org_id", profile.org_id)
      .order("created_at", { ascending: true }),
    admin
      .from("workflow_step_configs")
      .select("workflow_type, step_key, assigned_provider_config_id")
      .eq("org_id", profile.org_id),
  ]);

  if (configsRes.error) return jsonError(`Failed to load configs: ${configsRes.error.message}`, 500);
  if (assignRes.error) return jsonError(`Failed to load assignments: ${assignRes.error.message}`, 500);

  const configs = (configsRes.data ?? []) as OrgModelConfig[];
  return NextResponse.json({
    configs: configs.map(toPublic),
    stepAssignments: (assignRes.data ?? []) as Pick<
      WorkflowStepConfig,
      "workflow_type" | "step_key" | "assigned_provider_config_id"
    >[],
  });
}

export async function POST(req: NextRequest) {
  const g = await requireOrgAccess();
  if (!g.ok) return g.response;
  const { admin, profile } = g;

  if (profile.role !== "admin") return jsonError("Admin role required", 403);
  if (!hasEncryptionSecret()) {
    return jsonError("LLM_KEY_ENCRYPTION_SECRET is not set on the server — cannot store keys", 500);
  }

  const parsed = configInputSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("Invalid config body", 400);
  const input = parsed.data;

  const invalid = validateConfigInput(input, { requireKey: true });
  if (invalid) return jsonError(invalid, 400);

  const apiKey = input.api_key?.trim() ?? "";
  const ciphertext = apiKey.length > 0 ? encryptApiKey(apiKey) : "";
  const last4 = apiKey.length > 0 ? keyLast4(apiKey) : "";

  // At most one default per org (the partial unique index enforces; clear first).
  if (input.is_default) {
    const { error } = await admin
      .from("org_model_configs")
      .update({ is_default: false })
      .eq("org_id", profile.org_id)
      .eq("is_default", true);
    if (error) return jsonError(`Failed to clear previous default: ${error.message}`, 500);
  }

  const { data, error } = await admin
    .from("org_model_configs")
    .insert({
      org_id: profile.org_id,
      provider: input.provider,
      display_name: input.display_name.trim(),
      api_key_ciphertext: ciphertext,
      key_last4: last4,
      base_url: input.base_url?.trim() || null,
      default_model: input.default_model.trim(),
      is_default: input.is_default ?? false,
      is_active: true,
    })
    .select("id")
    .single<{ id: string }>();

  if (error || !data) return jsonError(`Failed to create config: ${error?.message ?? "unknown"}`, 500);
  return NextResponse.json({ id: data.id }, { status: 201 });
}
