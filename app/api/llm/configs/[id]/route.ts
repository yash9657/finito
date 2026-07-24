/**
 * PATCH  /api/llm/configs/[id] — rotate key / rename / change model, base_url,
 *   is_default (admin-only). An omitted `api_key` keeps the stored ciphertext.
 * DELETE /api/llm/configs/[id] — soft-deactivate (D-P15): is_active=false, ciphertext
 *   overwritten with '' so key material is gone, and step assignments pointing at it
 *   are removed. Admin-only, org-scoped.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { jsonError, requireOrgAccess } from "@/lib/api/guard";
import { encryptApiKey, hasEncryptionSecret, keyLast4 } from "@/lib/llm/crypto";
import { configInputSchema, validateConfigInput } from "@/lib/llm/config-service";
import type { OrgModelConfig } from "@/lib/types";

async function loadOwned(
  admin: SupabaseClient,
  id: string,
  orgId: string,
): Promise<OrgModelConfig | null> {
  const { data } = await admin
    .from("org_model_configs")
    .select("*")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle<OrgModelConfig>();
  return data ?? null;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const g = await requireOrgAccess();
  if (!g.ok) return g.response;
  const { admin, profile } = g;
  if (profile.role !== "admin") return jsonError("Admin role required", 403);

  const existing = await loadOwned(admin, id, profile.org_id);
  if (!existing) return jsonError("Config not found", 404);

  const parsed = configInputSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("Invalid config body", 400);
  const input = parsed.data;

  const rotating = typeof input.api_key === "string" && input.api_key.trim().length > 0;
  const invalid = validateConfigInput(input, { requireKey: false });
  if (invalid) return jsonError(invalid, 400);

  const patch: Record<string, unknown> = {
    provider: input.provider,
    display_name: input.display_name.trim(),
    base_url: input.base_url?.trim() || null,
    default_model: input.default_model.trim(),
  };

  if (rotating) {
    if (!hasEncryptionSecret()) {
      return jsonError("LLM_KEY_ENCRYPTION_SECRET is not set on the server — cannot store keys", 500);
    }
    const key = input.api_key!.trim();
    patch.api_key_ciphertext = encryptApiKey(key);
    patch.key_last4 = keyLast4(key);
  }

  if (input.is_default === true && !existing.is_default) {
    const { error } = await admin
      .from("org_model_configs")
      .update({ is_default: false })
      .eq("org_id", profile.org_id)
      .eq("is_default", true);
    if (error) return jsonError(`Failed to clear previous default: ${error.message}`, 500);
    patch.is_default = true;
  } else if (input.is_default === false) {
    patch.is_default = false;
  }

  const { error } = await admin.from("org_model_configs").update(patch).eq("id", id);
  if (error) return jsonError(`Failed to update config: ${error.message}`, 500);
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const g = await requireOrgAccess();
  if (!g.ok) return g.response;
  const { admin, profile } = g;
  if (profile.role !== "admin") return jsonError("Admin role required", 403);

  const existing = await loadOwned(admin, id, profile.org_id);
  if (!existing) return jsonError("Config not found", 404);

  // Remove step assignments that point at this config (they'd otherwise be blocked).
  const { error: assignError } = await admin
    .from("workflow_step_configs")
    .delete()
    .eq("org_id", profile.org_id)
    .eq("assigned_provider_config_id", id);
  if (assignError) return jsonError(`Failed to clear assignments: ${assignError.message}`, 500);

  // Soft-deactivate + wipe key material (D-P15).
  const { error } = await admin
    .from("org_model_configs")
    .update({ is_active: false, is_default: false, api_key_ciphertext: "" })
    .eq("id", id);
  if (error) return jsonError(`Failed to deactivate config: ${error.message}`, 500);
  return NextResponse.json({ ok: true });
}
