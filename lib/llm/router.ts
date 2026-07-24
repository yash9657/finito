/**
 * The LLM router (Plan 2 §2.3, D-P1/D-P7) — the ONLY module agent steps reach through.
 *
 * `resolveProvider` implements the D-P7 resolution order for (org, workflow_type,
 * step_key) and decrypts the config's key in memory. `invoke<T>` ports the old
 * `callClaude` validation loop verbatim but provider-agnostic: it builds the JSON
 * schema once, calls `provider.complete`, then JSON.parse + zod.safeParse with a single
 * corrective retry. The decrypted key lives only on the resolved object / call frames —
 * it is never logged, serialized, or stored (§9).
 */

import { z } from "zod";
import type { createAdminClient } from "@/lib/supabase/admin";
import type { LLMProvider, LLMCompleteResult, ProviderId } from "@/lib/llm/provider";
import { getProvider } from "@/lib/llm/providers";
import { toJsonSchema } from "@/lib/llm/json-schema";
import { redactAndCap } from "@/lib/llm/redact";
import { decryptApiKey } from "@/lib/llm/crypto";
import type {
  LlmInvokeResult,
  OrgModelConfig,
  WorkflowType,
} from "@/lib/types";

type SupabaseAdmin = ReturnType<typeof createAdminClient>;

/** The model used for the env-fallback implicit Anthropic config (D-P4). */
export const ENV_FALLBACK_MODEL = "claude-sonnet-4-6";

const INVOKE_MAX_TOKENS = 16000;

/** Thrown when no provider can be resolved for a step (D-P7 step 4). */
export class NoProviderConfiguredError extends Error {
  constructor() {
    super("No LLM provider configured — add one in Settings → Models");
    this.name = "NoProviderConfiguredError";
  }
}

export interface ResolvedProvider {
  provider: LLMProvider;
  configId: string | null; // null for env-fallback
  providerId: ProviderId;
  model: string;
  apiKey?: string; // decrypted, in memory only
  baseUrl?: string;
  /** Set when the pinned step-config was inactive and we fell back (D-P7 step 1). */
  warning?: string;
}

/* -------------------------------------------------------------------------- */
/* Resolution (D-P7)                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Turn an `org_model_configs` row into a ResolvedProvider, decrypting its key.
 * Keyless providers (ollama, some custom) store `''` ciphertext → undefined apiKey.
 */
function resolveFromConfig(config: OrgModelConfig, warning?: string): ResolvedProvider {
  const apiKey = config.api_key_ciphertext
    ? decryptApiKey(config.api_key_ciphertext)
    : undefined;
  return {
    provider: getProvider(config.provider),
    configId: config.id,
    providerId: config.provider,
    model: config.default_model,
    apiKey: apiKey && apiKey.length > 0 ? apiKey : undefined,
    baseUrl: config.base_url ?? undefined,
    warning,
  };
}

/**
 * Resolve the provider for a step following the D-P7 order:
 *   1. workflow_step_configs pin (if the assigned config is active).
 *   2. else the org's active default config.
 *   3. else the env-var implicit Anthropic config (if ANTHROPIC_API_KEY set).
 *   4. else throw NoProviderConfiguredError.
 * An inactive pinned config is treated as absent, carrying a warning for the step footer.
 */
export async function resolveProvider(
  db: SupabaseAdmin,
  args: { orgId: string; workflowType: WorkflowType; stepKey: string },
): Promise<ResolvedProvider> {
  const { orgId, workflowType, stepKey } = args;
  let warning: string | undefined;

  // 1. Per-step pin.
  const { data: pin } = await db
    .from("workflow_step_configs")
    .select("assigned_provider_config_id")
    .eq("org_id", orgId)
    .eq("workflow_type", workflowType)
    .eq("step_key", stepKey)
    .maybeSingle<{ assigned_provider_config_id: string }>();

  if (pin?.assigned_provider_config_id) {
    const { data: config } = await db
      .from("org_model_configs")
      .select("*")
      .eq("id", pin.assigned_provider_config_id)
      .maybeSingle<OrgModelConfig>();
    if (config && config.is_active) {
      return resolveFromConfig(config);
    }
    warning = `Pinned provider for step "${stepKey}" is inactive; using the org default instead.`;
  }

  // 2. Org default (active).
  const { data: def } = await db
    .from("org_model_configs")
    .select("*")
    .eq("org_id", orgId)
    .eq("is_default", true)
    .eq("is_active", true)
    .maybeSingle<OrgModelConfig>();
  if (def) return resolveFromConfig(def, warning);

  // 3. Env-var implicit Anthropic config (D-P4).
  const envKey = process.env.ANTHROPIC_API_KEY;
  if (envKey && envKey.length > 0) {
    return {
      provider: getProvider("anthropic"),
      configId: null,
      providerId: "anthropic",
      model: ENV_FALLBACK_MODEL,
      apiKey: envKey,
      warning,
    };
  }

  // 4. Nothing left.
  throw new NoProviderConfiguredError();
}

/* -------------------------------------------------------------------------- */
/* Invoke — the provider-agnostic validation loop (ports callClaude, D-P1)     */
/* -------------------------------------------------------------------------- */

/** Pull a `reasoning` string off parsed data when the model omitted native thinking. */
function fallbackReasoning(data: unknown): string {
  if (
    data != null &&
    typeof data === "object" &&
    "reasoning" in data &&
    typeof (data as { reasoning: unknown }).reasoning === "string"
  ) {
    return (data as { reasoning: string }).reasoning;
  }
  return "";
}

/**
 * Issue one structured-output request through the resolved provider and validate it
 * against `schema`. On a parse/validation failure, retry exactly once with the failed
 * assistant turn + a corrective user message appended, then throw. Token counts sum
 * across attempts; latency is the sum; `meta.raw` is the redacted+capped LAST response.
 */
export async function invoke<T>(
  resolved: ResolvedProvider,
  opts: { system: string; user: string; schema: z.ZodType<T> },
): Promise<LlmInvokeResult<T>> {
  const { system, user, schema } = opts;
  const jsonSchema = toJsonSchema(schema);

  const messages: { role: "user" | "assistant"; content: string }[] = [
    { role: "user", content: user },
  ];

  let tokensIn = 0;
  let tokensOut = 0;
  let latencyMs = 0;
  let lastResult: LLMCompleteResult | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await resolved.provider.complete({
      systemPrompt: system,
      messages,
      model: resolved.model,
      maxTokens: INVOKE_MAX_TOKENS,
      responseFormat: "json",
      jsonSchema,
      apiKey: resolved.apiKey,
      baseUrl: resolved.baseUrl,
    });
    lastResult = result;
    tokensIn += result.tokensIn;
    tokensOut += result.tokensOut;
    latencyMs += result.latencyMs;

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.content);
    } catch (err) {
      if (attempt === 0) {
        appendRetry(messages, result.content, `not valid JSON: ${String(err)}`);
        continue;
      }
      throw new Error(`Provider response was not valid JSON: ${String(err)}`);
    }

    const validated = schema.safeParse(parsed);
    if (validated.success) {
      const reasoning = result.reasoningNative || fallbackReasoning(validated.data);
      return {
        data: validated.data,
        reasoning,
        meta: {
          providerId: resolved.providerId,
          modelUsed: result.modelUsed,
          tokensIn,
          tokensOut,
          latencyMs,
          raw: redactAndCap(result.raw),
        },
      };
    }

    if (attempt === 0) {
      appendRetry(messages, result.content, validated.error.message);
      continue;
    }
    throw new Error(`Provider response failed schema validation: ${validated.error.message}`);
  }

  // Unreachable: the loop returns or throws on both attempts.
  void lastResult;
  throw new Error("invoke exhausted retries without a result");
}

/** Append the failed assistant turn + a corrective user message for the retry. */
function appendRetry(
  messages: { role: "user" | "assistant"; content: string }[],
  failedContent: string,
  error: string,
): void {
  messages.push({ role: "assistant", content: failedContent });
  messages.push({
    role: "user",
    content: `Your previous response failed validation: ${error}. Return corrected JSON.`,
  });
}
