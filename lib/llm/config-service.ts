/**
 * Shared validation + test-connection helpers for the /api/llm config routes
 * (Plan 2 §5). Keeps the per-provider required-field rules (D-P13 base_url, keyed
 * providers) and the connection test in one place, used by both create/patch and the
 * pre-save test path.
 */

import { z } from "zod";
import { getProvider } from "@/lib/llm/providers";
import { LLMProviderError, type ProviderId } from "@/lib/llm/provider";
import { validateBaseUrl } from "@/lib/llm/url-guard";
import { providerIdEnum } from "@/lib/types";

/** Providers that require an API key (ollama/custom may be keyless). */
const KEYED_PROVIDERS: ReadonlySet<ProviderId> = new Set(["anthropic", "openai", "google"]);
/** Providers that require a base_url reachable from the server (D-P13). */
const BASE_URL_PROVIDERS: ReadonlySet<ProviderId> = new Set(["ollama", "custom"]);

export const configInputSchema = z.object({
  provider: providerIdEnum,
  display_name: z.string().trim().min(1),
  api_key: z.string().optional(),
  base_url: z.string().optional(),
  default_model: z.string().trim().min(1),
  is_default: z.boolean().optional(),
});
export type ConfigInput = z.infer<typeof configInputSchema>;

/**
 * Validate per-provider required fields. `requireKey` is false on PATCH (rotation is
 * optional there — an unchanged key keeps the stored ciphertext). Returns an error
 * message or null.
 */
export function validateConfigInput(
  input: ConfigInput,
  opts: { requireKey: boolean } = { requireKey: true },
): string | null {
  const provider = input.provider;

  if (BASE_URL_PROVIDERS.has(provider)) {
    if (!input.base_url || input.base_url.trim().length === 0) {
      return `${provider} requires a base URL`;
    }
    const urlError = validateBaseUrl(input.base_url.trim());
    if (urlError) return urlError;
  } else if (input.base_url && input.base_url.trim().length > 0) {
    // Optional override for keyed providers — still must be a valid URL.
    const urlError = validateBaseUrl(input.base_url.trim());
    if (urlError) return urlError;
  }

  if (opts.requireKey && KEYED_PROVIDERS.has(provider)) {
    if (!input.api_key || input.api_key.trim().length === 0) {
      return `${provider} requires an API key`;
    }
  }
  return null;
}

export interface TestConnectionResult {
  ok: boolean;
  modelUsed?: string;
  latencyMs?: number;
  error?: string;
}

const TEST_TIMEOUT_MS = 15_000;

/**
 * Make a single minimal completion to confirm the provider authenticates and the model
 * exists. Not persisted, ~10 tokens (D-P12). Maps provider errors to human text.
 */
export async function testProviderConnection(args: {
  provider: ProviderId;
  apiKey?: string;
  baseUrl?: string;
  model: string;
}): Promise<TestConnectionResult> {
  const provider = getProvider(args.provider);
  try {
    const result = await Promise.race([
      provider.complete({
        systemPrompt: "You are a connection test.",
        messages: [{ role: "user", content: "Reply with exactly: OK" }],
        model: args.model,
        maxTokens: 8,
        responseFormat: "text",
        apiKey: args.apiKey,
        baseUrl: args.baseUrl,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new LLMProviderError(args.provider, undefined, "Endpoint unreachable")), TEST_TIMEOUT_MS),
      ),
    ]);
    return { ok: true, modelUsed: result.modelUsed, latencyMs: result.latencyMs };
  } catch (err) {
    const message = err instanceof LLMProviderError ? err.message : "Connection test failed";
    return { ok: false, error: message };
  }
}
