import { createHash } from "node:crypto";
import {
  LLMProviderError,
  type LLMCompleteParams,
  type LLMProvider,
} from "@/lib/llm/provider";
import {
  buildChatCompletionsBody,
  chatCompletionsComplete,
  composeSystemPrompt,
} from "@/lib/llm/providers/openai";
import { FIREWORKS_BASE_URL } from "@/lib/llm/fireworks-config";

/** Affinity improves prefix reuse; isolation is explicit across organizations.
 * Hashes keep internal identities out of routing metadata. Neither header replaces authorization.
 * https://docs.fireworks.ai/guides/prompt-caching
 */
export function fireworksCacheHeaders(
  scope: LLMCompleteParams["cacheScope"],
): Record<string, string> {
  if (!scope?.organizationId) return {};
  const hash = (parts: string[]) =>
    createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  return {
    "x-prompt-cache-isolation-key": hash(["finflow-v1", scope.organizationId]),
    ...(scope.sessionId
      ? {
          "x-session-affinity": hash([
            "finflow-v1",
            scope.organizationId,
            scope.sessionId,
          ]),
        }
      : {}),
  };
}

/** Fireworks needs max_tokens and the schema in the prompt as well as response_format.
 * https://docs.fireworks.ai/structured-responses/structured-response-formatting
 */
export function buildFireworksBody(
  params: LLMCompleteParams,
): Record<string, unknown> {
  const body = buildChatCompletionsBody(params, "json_schema");
  delete body.max_completion_tokens;
  body.max_tokens = params.maxTokens;
  const messages = body.messages as Record<string, unknown>[];
  messages[0].content = composeSystemPrompt(params, !params.tools?.length);
  // Preserve opaque reasoning state across native tool turns on this provider only.
  let index = 1;
  for (const msg of params.conversation ?? params.messages) {
    if (
      msg.role === "assistant" &&
      "sidecar" in msg &&
      msg.sidecar?.providerId === "fireworks" &&
      typeof msg.sidecar.data === "string"
    ) {
      messages[index].reasoning_content = msg.sidecar.data;
    }
    index +=
      msg.role === "tool" && "toolResults" in msg
        ? (msg.toolResults?.length ?? 0)
        : 1;
  }
  return body;
}

export const fireworksProvider: LLMProvider = {
  id: "fireworks",
  async testConnection(params) {
    try {
      const result = await fireworksProvider.complete({
        ...params,
        messages: [{ role: "user", content: 'Return JSON: {"ok": true}' }],
        systemPrompt: "Connection test. Respond in JSON.",
        maxTokens: 512,
        responseFormat: "json",
        jsonSchema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
          additionalProperties: false,
        },
        signal: AbortSignal.timeout(15_000),
      });
      return {
        ok: true,
        modelUsed: result.modelUsed,
        latencyMs: result.latencyMs,
      };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof LLMProviderError
            ? error.message
            : "Connection test failed",
      };
    }
  },
  async complete(params) {
    if (!params.apiKey?.trim())
      throw new LLMProviderError(
        "fireworks",
        undefined,
        "Fireworks AI requires an API key",
      );
    // A hosted provider's credentials must never be sent to an arbitrary base URL.
    if (
      params.baseUrl &&
      params.baseUrl.replace(/\/+$/, "") !== FIREWORKS_BASE_URL
    ) {
      throw new LLMProviderError(
        "fireworks",
        undefined,
        "Use the standard Fireworks endpoint; use Custom for other endpoints",
      );
    }
    const result = await chatCompletionsComplete(
      "fireworks",
      "json_schema",
      params,
      FIREWORKS_BASE_URL,
      buildFireworksBody,
      fireworksCacheHeaders(params.cacheScope),
    );
    const usage = (
      result.raw as {
        usage?: {
          prompt_tokens?: unknown;
          completion_tokens?: unknown;
          prompt_tokens_details?: { cached_tokens?: unknown };
        };
      }
    ).usage;
    if (
      ![usage?.prompt_tokens, usage?.completion_tokens].every(
        (value) =>
          typeof value === "number" && Number.isFinite(value) && value >= 0,
      )
    ) {
      throw new LLMProviderError(
        "fireworks",
        undefined,
        "Provider returned invalid token usage; the request cannot be safely budgeted",
      );
    }
    const cached = usage?.prompt_tokens_details?.cached_tokens;
    if (
      typeof cached === "number" &&
      Number.isSafeInteger(cached) &&
      cached >= 0 &&
      cached <= result.tokensIn
    )
      result.cachedTokensIn = cached;
    const raw = result.raw as {
      choices?: { message?: { reasoning_content?: unknown } }[];
    };
    const reasoning = raw.choices?.[0]?.message?.reasoning_content;
    if (typeof reasoning === "string")
      result.sidecar = { providerId: "fireworks", data: reasoning };
    return result;
  },
};
