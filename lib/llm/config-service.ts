/**
 * Shared validation + test-connection helpers for the /api/llm config routes
 * (Plan 2 §5). Keeps the per-provider required-field rules (D-P13 base_url, keyed
 * providers) and the connection test in one place, used by both create/patch and the
 * pre-save test path.
 */

import { z } from "zod";
import { getProvider } from "@/lib/llm/providers";
import type { ProviderId, TestConnectionResult } from "@/lib/llm/provider";
import { validateBaseUrl } from "@/lib/llm/url-guard";
import { providerIdEnum } from "@/lib/types";
import { FIREWORKS_BASE_URL } from "@/lib/llm/fireworks-config";

/** Providers that require an API key (ollama/custom may be keyless). */
const KEYED_PROVIDERS: ReadonlySet<ProviderId> = new Set(["fireworks", "anthropic", "openai", "google"]);
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
  if (provider === "fireworks" && input.base_url?.trim() && input.base_url.trim().replace(/\/+$/, "") !== FIREWORKS_BASE_URL) {
    return "Fireworks AI uses its standard hosted endpoint. Select Custom for another endpoint.";
  }

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

/**
 * Re-exported so the API routes keep importing the result type from here (Plan 2 §5)
 * while its definition lives with the interface that produces it (Plan 4, D-H11).
 */
export type { TestConnectionResult } from "@/lib/llm/provider";

/**
 * Confirm a provider config authenticates and its model is usable.
 *
 * Delegates to `provider.testConnection` (D-H11): the probe belongs to the provider, so
 * one with a better check than a throwaway completion — Ollama listing its pulled models
 * — can supply it without this function growing a branch per provider.
 */
export function testProviderConnection(args: {
  provider: ProviderId;
  apiKey?: string;
  baseUrl?: string;
  model: string;
}): Promise<TestConnectionResult> {
  return getProvider(args.provider).testConnection({
    model: args.model,
    apiKey: args.apiKey,
    baseUrl: args.baseUrl,
  });
}
