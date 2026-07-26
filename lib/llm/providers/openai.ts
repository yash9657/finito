/**
 * OpenAI provider (Plan 2 §2.2, D-P9/D-P10) — plain `fetch` against the Chat
 * Completions REST API, no `openai` SDK. custom-endpoint.ts reuses the shared
 * helpers here (custom = same body shape, custom base_url, json_object mode).
 *
 * The request-body builder (`buildChatCompletionsBody`) is a pure exported function so
 * N1 tests can assert the exact JSON without a network call.
 */

import {
  defaultTestConnection,
  LLMProviderError,
  LLM_TIMEOUT_MS,
  TransportError,
  parseRetryAfter,
  withTransportRetry,
  type LLMCompleteParams,
  type LLMCompleteResult,
  type LLMProvider,
  type ProviderId,
} from "@/lib/llm/provider";

const DEFAULT_BASE_URL = "https://api.openai.com";

/** How the JSON output is requested: OpenAI native strict json_schema vs. json_object. */
export type JsonMode = "json_schema" | "json_object";

/**
 * Compose the system prompt, appending the schema for weak-JSON endpoints
 * (json_object mode) so the model still sees the target shape (D-P9). OpenAI strict
 * json_schema mode does NOT need this — the schema rides in `response_format`.
 */
export function composeSystemPrompt(params: LLMCompleteParams, appendSchema: boolean): string {
  if (appendSchema && params.responseFormat === "json" && params.jsonSchema) {
    return `${params.systemPrompt}\n\nRespond with JSON matching this schema: ${JSON.stringify(
      params.jsonSchema,
    )}`;
  }
  return params.systemPrompt;
}

/**
 * Build a Chat-Completions request body (pure). `jsonMode` selects the
 * `response_format`; when it is `json_object` the schema is appended to the system
 * prompt instead (weak-JSON path shared with custom endpoints).
 */
export function buildChatCompletionsBody(
  params: LLMCompleteParams,
  jsonMode: JsonMode,
): Record<string, unknown> {
  const wantsJson = params.responseFormat === "json";
  const schemaInPrompt = wantsJson && jsonMode === "json_object";
  const system = composeSystemPrompt(params, schemaInPrompt);

  const body: Record<string, unknown> = {
    model: params.model,
    max_completion_tokens: params.maxTokens,
    messages: [
      { role: "system", content: system },
      ...params.messages.map((m) => ({ role: m.role, content: m.content })),
    ],
  };

  if (wantsJson) {
    if (jsonMode === "json_schema" && params.jsonSchema) {
      body.response_format = {
        type: "json_schema",
        json_schema: { name: "output", schema: params.jsonSchema, strict: true },
      };
    } else {
      body.response_format = { type: "json_object" };
    }
  }

  return body;
}

interface ChatCompletionsResponse {
  model?: string;
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Execute one Chat-Completions call (shared by openai.ts and custom-endpoint.ts).
 * `id`/`jsonMode` differ per caller; `baseUrl` and key resolution follow the params.
 */
export async function chatCompletionsComplete(
  id: ProviderId,
  jsonMode: JsonMode,
  params: LLMCompleteParams,
  defaultBaseUrl: string,
): Promise<LLMCompleteResult> {
  const baseUrl = (params.baseUrl ?? defaultBaseUrl).replace(/\/$/, "");
  const url = `${baseUrl}/v1/chat/completions`;
  const body = buildChatCompletionsBody(params, jsonMode);

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (params.apiKey) headers.Authorization = `Bearer ${params.apiKey}`;

  const started = Date.now();
  const json = await withTransportRetry(async () => {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      });
    } catch {
      // Network/timeout — never include the request body in the message.
      throw new LLMProviderError(id, undefined, "Endpoint unreachable");
    }
    if (res.status === 429 || res.status >= 500) {
      throw new TransportError(
        res.status,
        parseRetryAfter(res.headers.get("retry-after")),
        `HTTP ${res.status}`,
      );
    }
    if (!res.ok) {
      throw new LLMProviderError(id, res.status, mapStatus(res.status));
    }
    return (await res.json()) as ChatCompletionsResponse;
  });
  const latencyMs = Date.now() - started;

  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new LLMProviderError(id, undefined, "Response contained no message content");
  }

  return {
    content,
    modelUsed: json.model ?? params.model,
    tokensIn: json.usage?.prompt_tokens ?? 0,
    tokensOut: json.usage?.completion_tokens ?? 0,
    latencyMs,
    raw: json,
  };
}

/** Map an HTTP status to a short human label (never the response body). */
export function mapStatus(status: number): string {
  if (status === 401 || status === 403) return "Invalid API key";
  if (status === 404) return "Model not found";
  return `Request failed (HTTP ${status})`;
}

export const openaiProvider: LLMProvider = {
  id: "openai",
  testConnection(params) {
    return defaultTestConnection(openaiProvider, params);
  },
  complete(params) {
    return chatCompletionsComplete("openai", "json_schema", params, DEFAULT_BASE_URL);
  },
};
