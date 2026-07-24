/**
 * Anthropic provider (Plan 2 §2.2, D-P9/D-P10). The ONLY provider keeping an SDK —
 * `@anthropic-ai/sdk` powers native structured outputs and typed errors. This is the
 * transport half of the old `lib/agents/client.ts`: a single non-streaming
 * `messages.create` with adaptive thinking; the zod validation loop moved to
 * `router.invoke` (D-P1).
 *
 * `buildAnthropicParams` is a pure exported function so N1 tests assert the exact body
 * (including `output_config.format` built directly from a plain JSON schema, D-P9).
 */

import Anthropic, { APIError, RateLimitError } from "@anthropic-ai/sdk";
import {
  LLMProviderError,
  TransportError,
  parseRetryAfter,
  withTransportRetry,
  type LLMCompleteParams,
  type LLMCompleteResult,
  type LLMProvider,
} from "@/lib/llm/provider";

/**
 * Build the `messages.create` params (pure). `output_config.format` is assembled
 * directly from the plain JSON schema (D-P9) — zod→JSON-schema conversion happens
 * once, router-side, in json-schema.ts, so this file never imports zod.
 */
export function buildAnthropicParams(
  params: LLMCompleteParams,
): Anthropic.MessageCreateParamsNonStreaming {
  const base: Anthropic.MessageCreateParamsNonStreaming = {
    model: params.model,
    max_tokens: params.maxTokens,
    thinking: { type: "adaptive" },
    system: params.systemPrompt,
    messages: params.messages.map((m) => ({ role: m.role, content: m.content })),
  };
  if (params.responseFormat === "json" && params.jsonSchema) {
    base.output_config = {
      format: { type: "json_schema", schema: params.jsonSchema },
    };
  }
  return base;
}

/** Extract the first text block's string content. */
function firstText(message: Anthropic.Message): string {
  for (const block of message.content) {
    if (block.type === "text") return block.text;
  }
  throw new LLMProviderError("anthropic", undefined, "Response contained no text block");
}

/** Concatenate all thinking-type blocks into a single reasoning string. */
function thinkingReasoning(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.ThinkingBlock => block.type === "thinking")
    .map((block) => block.thinking)
    .join("\n")
    .trim();
}

export const anthropicProvider: LLMProvider = {
  id: "anthropic",
  async complete(params: LLMCompleteParams): Promise<LLMCompleteResult> {
    const client = new Anthropic({
      apiKey: params.apiKey,
      baseURL: params.baseUrl ?? undefined,
    });
    const createParams = buildAnthropicParams(params);

    const started = Date.now();
    const message = await withTransportRetry(async () => {
      try {
        return await client.messages.create(createParams);
      } catch (err) {
        if (err instanceof RateLimitError) {
          const retryAfter = parseRetryAfter(err.headers?.get("retry-after") ?? null);
          throw new TransportError(429, retryAfter, "HTTP 429");
        }
        if (err instanceof APIError && typeof err.status === "number" && err.status >= 500) {
          throw new TransportError(err.status, null, `HTTP ${err.status}`);
        }
        if (err instanceof APIError && (err.status === 401 || err.status === 403)) {
          throw new LLMProviderError("anthropic", err.status, "Invalid API key");
        }
        if (err instanceof APIError && err.status === 404) {
          throw new LLMProviderError("anthropic", err.status, "Model not found");
        }
        // Never surface the underlying message (could echo request context).
        const status = err instanceof APIError ? err.status : undefined;
        throw new LLMProviderError("anthropic", status, "Anthropic request failed");
      }
    });
    const latencyMs = Date.now() - started;

    return {
      content: firstText(message),
      modelUsed: message.model ?? params.model,
      tokensIn: message.usage?.input_tokens ?? 0,
      tokensOut: message.usage?.output_tokens ?? 0,
      latencyMs,
      raw: message,
      reasoningNative: thinkingReasoning(message) || undefined,
    };
  },
};
