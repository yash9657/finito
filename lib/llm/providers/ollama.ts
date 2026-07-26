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

/** `/api/tags` should answer instantly — it reads local state, it does not infer. */
const TAGS_TIMEOUT_MS = 10_000;

/** The subset of Ollama's `/api/tags` body the connection test reads. */
interface OllamaTagsResponse {
  models?: { name?: string }[];
}

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

  /**
   * Overrides the shared completion probe (Plan 4, D-H11) because Ollama has something
   * strictly better: `/api/tags` lists the models actually pulled onto the host. That
   * answers the question an org configuring a local model really has — "is this model
   * present on my box?" — which a completion cannot distinguish from "the model name was
   * silently substituted", and it costs no tokens and no inference time.
   *
   * A cold local model can take minutes to load on first token, so a completion probe
   * against Ollama is also the case most likely to time out spuriously.
   */
  async testConnection(params) {
    if (!params.baseUrl) {
      return { ok: false, error: "Ollama provider requires a base URL" };
    }
    const base = params.baseUrl.replace(/\/$/, "");
    const headers: Record<string, string> = {};
    if (params.apiKey) headers.Authorization = `Bearer ${params.apiKey}`;

    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(`${base}/api/tags`, {
        headers,
        signal: AbortSignal.timeout(TAGS_TIMEOUT_MS),
      });
    } catch {
      return { ok: false, error: "Endpoint unreachable" };
    }
    if (!res.ok) {
      return { ok: false, error: `Request failed (HTTP ${res.status})` };
    }

    let tags: OllamaTagsResponse;
    try {
      tags = (await res.json()) as OllamaTagsResponse;
    } catch {
      return { ok: false, error: "Endpoint did not return a model list" };
    }
    const latencyMs = Date.now() - started;

    // Ollama reports tags as `name:tag`; a config naming the bare model should match.
    const names = (tags.models ?? []).map((m) => m.name).filter((n): n is string => !!n);
    const match = names.find((n) => n === params.model || n.split(":")[0] === params.model);
    if (!match) {
      const available = names.length > 0 ? names.slice(0, 5).join(", ") : "none";
      return {
        ok: false,
        error: `Model "${params.model}" is not pulled on this host (available: ${available})`,
      };
    }

    return { ok: true, modelUsed: match, latencyMs };
  },

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
