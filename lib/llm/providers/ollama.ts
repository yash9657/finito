/**
 * Ollama provider (Plan 2 §2.2, D-P9/D-P10) — plain `fetch` against `/api/chat` with
 * `stream: false`. `base_url` is required and must be reachable from the FinFlow
 * server process (D-P13). JSON uses `format: 'json'` PLUS the schema appended to the
 * system prompt — the weakest native path, so the router's validate-retry loop does
 * the real enforcement.
 *
 * `buildOllamaChatBody` is a pure exported function for N1 tests. No auth header is
 * required; if a key is present we still send `Authorization: Bearer` (some proxies
 * in front of Ollama want it).
 */

import {
  LLMProviderError,
  LLM_TIMEOUT_MS,
  TransportError,
  parseRetryAfter,
  withTransportRetry,
  type LLMCompleteParams,
  type LLMCompleteResult,
  type LLMProvider,
} from "@/lib/llm/provider";

/** Build the `/api/chat` request body (pure). Schema is appended to the system prompt. */
export function buildOllamaChatBody(params: LLMCompleteParams): Record<string, unknown> {
  const wantsJson = params.responseFormat === "json";
  const system =
    wantsJson && params.jsonSchema
      ? `${params.systemPrompt}\n\nRespond with JSON matching this schema: ${JSON.stringify(
          params.jsonSchema,
        )}`
      : params.systemPrompt;

  const body: Record<string, unknown> = {
    model: params.model,
    stream: false,
    options: { num_predict: params.maxTokens },
    messages: [
      { role: "system", content: system },
      ...params.messages.map((m) => ({ role: m.role, content: m.content })),
    ],
  };
  if (wantsJson) body.format = "json";
  return body;
}

interface OllamaChatResponse {
  model?: string;
  message?: { content?: string };
  prompt_eval_count?: number;
  eval_count?: number;
}

export const ollamaProvider: LLMProvider = {
  id: "ollama",
  async complete(params: LLMCompleteParams): Promise<LLMCompleteResult> {
    if (!params.baseUrl) {
      throw new LLMProviderError("ollama", undefined, "Ollama provider requires a base URL");
    }
    const base = params.baseUrl.replace(/\/$/, "");
    const url = `${base}/api/chat`;
    const body = buildOllamaChatBody(params);

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
        throw new LLMProviderError("ollama", undefined, "Endpoint unreachable");
      }
      if (res.status === 429 || res.status >= 500) {
        throw new TransportError(
          res.status,
          parseRetryAfter(res.headers.get("retry-after")),
          `HTTP ${res.status}`,
        );
      }
      if (!res.ok) {
        const label = res.status === 404 ? "Model not found" : `Request failed (HTTP ${res.status})`;
        throw new LLMProviderError("ollama", res.status, label);
      }
      return (await res.json()) as OllamaChatResponse;
    });
    const latencyMs = Date.now() - started;

    const content = json.message?.content;
    if (typeof content !== "string") {
      throw new LLMProviderError("ollama", undefined, "Response contained no message content");
    }

    return {
      content,
      modelUsed: json.model ?? params.model,
      tokensIn: json.prompt_eval_count ?? 0,
      tokensOut: json.eval_count ?? 0,
      latencyMs,
      raw: json,
    };
  },
};
