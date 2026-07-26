/**
 * Custom OpenAI-compatible endpoint provider (Plan 2 §2.2, D-P9/D-P10).
 *
 * Identical body shape to openai.ts (reuses its shared Chat-Completions helper) but
 * `base_url` is REQUIRED, the key is optional (some self-hosted gateways are keyless),
 * and JSON uses best-effort `response_format: { type: 'json_object' }` with the schema
 * appended to the system prompt. The router's validate-retry loop does the real
 * enforcement for this weak-JSON path.
 */

import {
  LLMProviderError,
  defaultTestConnection,
  type LLMProvider,
} from "@/lib/llm/provider";
import { chatCompletionsComplete } from "@/lib/llm/providers/openai";

export const customProvider: LLMProvider = {
  id: "custom",
  testConnection(params) {
    return defaultTestConnection(customProvider, params);
  },
  complete(params) {
    if (!params.baseUrl) {
      throw new LLMProviderError("custom", undefined, "Custom endpoint requires a base URL");
    }
    // json_object mode → schema is embedded in the system prompt (D-P9).
    return chatCompletionsComplete("custom", "json_object", params, params.baseUrl);
  },
};
