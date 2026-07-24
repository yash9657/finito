/**
 * POST /api/llm/configs/[id]/test — test a provider connection (Plan 2 §5).
 *
 * Two modes:
 *   - id === 'new'  → PRE-SAVE test. Body carries { provider, api_key?, base_url?,
 *     default_model }; nothing is stored.
 *   - real id       → test a stored config, decrypting its key server-side.
 * Returns { ok, modelUsed, latencyMs } or { ok:false, error } with provider errors
 * mapped to human text. Any org member may test; admin is not required.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { jsonError, requireOrgAccess } from "@/lib/api/guard";
import { decryptApiKey, DecryptionError } from "@/lib/llm/crypto";
import { testProviderConnection } from "@/lib/llm/config-service";
import { providerIdEnum, type OrgModelConfig } from "@/lib/types";

// A connection test should never run long (D-P13); cap the invocation.
export const maxDuration = 30;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const g = await requireOrgAccess();
  if (!g.ok) return g.response;
  const { admin, profile } = g;

  // Pre-save test: use the transient body, store nothing.
  if (id === "new") {
    const body = (await req.json().catch(() => null)) as {
      provider?: unknown;
      api_key?: unknown;
      base_url?: unknown;
      default_model?: unknown;
    } | null;
    const provider = providerIdEnum.safeParse(body?.provider);
    if (!provider.success) return jsonError("Invalid provider", 400);
    if (typeof body?.default_model !== "string" || body.default_model.trim().length === 0) {
      return jsonError("default_model is required", 400);
    }
    const result = await testProviderConnection({
      provider: provider.data,
      apiKey: typeof body.api_key === "string" && body.api_key ? body.api_key : undefined,
      baseUrl: typeof body.base_url === "string" && body.base_url ? body.base_url : undefined,
      model: body.default_model.trim(),
    });
    return NextResponse.json(result);
  }

  // Stored-config test: decrypt server-side.
  const { data: config } = await admin
    .from("org_model_configs")
    .select("*")
    .eq("id", id)
    .eq("org_id", profile.org_id)
    .maybeSingle<OrgModelConfig>();
  if (!config) return jsonError("Config not found", 404);

  let apiKey: string | undefined;
  try {
    apiKey = config.api_key_ciphertext ? decryptApiKey(config.api_key_ciphertext) : undefined;
  } catch (err) {
    if (err instanceof DecryptionError) {
      return NextResponse.json({ ok: false, error: err.message });
    }
    return jsonError("LLM_KEY_ENCRYPTION_SECRET is not set on the server", 500);
  }

  const result = await testProviderConnection({
    provider: config.provider,
    apiKey: apiKey && apiKey.length > 0 ? apiKey : undefined,
    baseUrl: config.base_url ?? undefined,
    model: config.default_model,
  });
  return NextResponse.json(result);
}
