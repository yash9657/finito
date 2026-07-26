/**
 * Google Gemini provider (Plan 2 §2.2, D-P9/D-P10) — plain `fetch` against the
 * generateContent REST API, no `@google/generative-ai` SDK. The API key rides in the
 * `x-goog-api-key` header, NEVER in the URL query string (which would land in any URL
 * logging).
 *
 * `buildGenerateContentBody` is a pure exported function for N1 tests. JSON output uses
 * `responseMimeType: 'application/json'` + `responseSchema` translated to Gemini's
 * OpenAPI subset (json-schema.ts). If the schema can't convert we fall back to
 * schema-in-prompt for that call (D-P9 / §9).
 */

import {
  LLMProviderError,
  LLM_TIMEOUT_MS,
  TransportError,
  defaultTestConnection,
  parseRetryAfter,
  withTransportRetry,
  type LLMCompleteParams,
  type LLMCompleteResult,
  type LLMProvider,
} from "@/lib/llm/provider";
import { toGeminiSchema } from "@/lib/llm/json-schema";

const BASE_URL = "https://generativelanguage.googleapis.com";

/**
 * Build a generateContent request body (pure). Returns the body plus whether the JSON
 * schema had to be embedded in the system prompt (Gemini conversion failed) — the
 * caller uses that only for testing/telemetry; correctness rides on the router loop.
 */
export function buildGenerateContentBody(params: LLMCompleteParams): {
  body: Record<string, unknown>;
  schemaInPrompt: boolean;
} {
  const wantsJson = params.responseFormat === "json";
  let systemText = params.systemPrompt;
  let responseSchema: unknown = undefined;
  let schemaInPrompt = false;

  if (wantsJson && params.jsonSchema) {
    try {
      responseSchema = toGeminiSchema(params.jsonSchema);
    } catch {
      responseSchema = undefined;
      schemaInPrompt = true;
      systemText = `${systemText}\n\nRespond with JSON matching this schema: ${JSON.stringify(
        params.jsonSchema,
      )}`;
    }
  }

  const generationConfig: Record<string, unknown> = { maxOutputTokens: params.maxTokens };
  if (wantsJson) {
    generationConfig.responseMimeType = "application/json";
    if (responseSchema !== undefined) generationConfig.responseSchema = responseSchema;
  }

  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: systemText }] },
    contents: params.messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    })),
    generationConfig,
  };

  return { body, schemaInPrompt };
}

interface GenerateContentResponse {
  modelVersion?: string;
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

export const googleProvider: LLMProvider = {
  id: "google",
  testConnection(params) {
    return defaultTestConnection(googleProvider, params);
  },
  async complete(params: LLMCompleteParams): Promise<LLMCompleteResult> {
    if (!params.apiKey) {
      throw new LLMProviderError("google", undefined, "Google provider requires an API key");
    }
    const base = (params.baseUrl ?? BASE_URL).replace(/\/$/, "");
    const url = `${base}/v1beta/models/${encodeURIComponent(params.model)}:generateContent`;
    const { body } = buildGenerateContentBody(params);

    const started = Date.now();
    const json = await withTransportRetry(async () => {
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": params.apiKey as string,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
        });
      } catch {
        throw new LLMProviderError("google", undefined, "Endpoint unreachable");
      }
      if (res.status === 429 || res.status >= 500) {
        throw new TransportError(
          res.status,
          parseRetryAfter(res.headers.get("retry-after")),
          `HTTP ${res.status}`,
        );
      }
      if (!res.ok) {
        const label =
          res.status === 400 || res.status === 401 || res.status === 403
            ? "Invalid API key"
            : res.status === 404
              ? "Model not found"
              : `Request failed (HTTP ${res.status})`;
        throw new LLMProviderError("google", res.status, label);
      }
      return (await res.json()) as GenerateContentResponse;
    });
    const latencyMs = Date.now() - started;

    const parts = json.candidates?.[0]?.content?.parts ?? [];
    const content = parts.map((p) => p.text ?? "").join("");
    if (content.length === 0) {
      throw new LLMProviderError("google", undefined, "Response contained no content");
    }

    return {
      content,
      modelUsed: json.modelVersion ?? params.model,
      tokensIn: json.usageMetadata?.promptTokenCount ?? 0,
      tokensOut: json.usageMetadata?.candidatesTokenCount ?? 0,
      latencyMs,
      raw: json,
    };
  },
};
