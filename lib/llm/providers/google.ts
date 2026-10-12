/**
 * Google Gemini provider (Plan 2 §2.2, D-P9/D-P10; tool calling added by Plan 5, D-G14/D-G15) —
 * plain `fetch` against the generateContent REST API, no `@google/generative-ai` SDK. The API key
 * rides in the `x-goog-api-key` header, NEVER in the URL query string (which would land in any URL
 * logging).
 *
 * ## The trap: Gemini has no tool call ids
 *
 * `functionCall` carries `{name, args}` and nothing else, and results are matched back by NAME.
 * That is ambiguous the moment a model calls one tool twice in a turn — which is exactly what a
 * financial investigation does (`query_ledger` for this period, `query_ledger` for the prior one).
 *
 * D-G15: we synthesize `` `${name}#${index}` `` from the call's POSITION in the response, and emit
 * the `functionResponse` parts back in that same order. Position is the identity; the name is a
 * label. The ambiguity is recorded on the event, so a trace shows where a provider limitation was
 * worked around rather than presenting the pairing as something the API guaranteed.
 *
 * Gemini also attaches thought signatures to parts. Like Anthropic's thinking signatures they are
 * opaque and must be replayed unmodified, so the whole `parts` array of a model turn rides on the
 * canonical message's `sidecar`.
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
import {
  fromLegacyMessages,
  type CanonicalMessage,
  type StopReason,
  type ToolCall,
  type ToolDefinition,
} from "@/lib/llm/messages";
import { salvageToolCalls } from "@/lib/llm/salvage";

const BASE_URL = "https://generativelanguage.googleapis.com";

/** A `contents[].parts[]` entry, in the shapes this provider emits and reads. */
interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
  /** Opaque; present on some models. Replayed verbatim, never interpreted. */
  thoughtSignature?: string;
  thought?: boolean;
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

/**
 * The id we give a Gemini tool call (D-G15). Deterministic in the call's position, so the same
 * response always yields the same ids and the trace is reproducible.
 */
export function synthesizeCallId(name: string, index: number): string {
  return `${name}#${index}`;
}

/**
 * Turn the canonical conversation into Gemini `contents`.
 *
 * Exported for the parity tests, which is where the ordering guarantee above is actually pinned.
 */
export function toGeminiContents(conversation: CanonicalMessage[]): GeminiContent[] {
  const out: GeminiContent[] = [];

  for (const msg of conversation) {
    if (msg.role === "user") {
      out.push({ role: "user", parts: [{ text: msg.content }] });
      continue;
    }

    if (msg.role === "tool") {
      // `functionResponse` parts go back in a user turn, in the SAME ORDER the calls were made —
      // that ordering is the only thing pairing them when two calls share a name.
      const parts: GeminiPart[] = (msg.toolResults ?? []).map((r) => ({
        functionResponse: {
          name: r.name,
          // The API wants an object here; tool output is a JSON string, so it is wrapped rather
          // than re-parsed — re-parsing would fail on a plain-text error message.
          response: r.isError ? { error: r.content } : { result: r.content },
        },
      }));
      if (parts.length > 0) out.push({ role: "user", parts });
      continue;
    }

    // Model turn. If we have the original parts (with their thought signatures) replay those
    // verbatim; reconstructing them would drop the signatures and change the bytes.
    const replay = sidecarParts(msg);
    if (replay.length > 0) {
      out.push({ role: "model", parts: replay });
      continue;
    }

    const parts: GeminiPart[] = [];
    if (msg.content.length > 0) parts.push({ text: msg.content });
    for (const call of msg.toolCalls ?? []) {
      parts.push({ functionCall: { name: call.name, args: call.arguments } });
    }
    if (parts.length > 0) out.push({ role: "model", parts });
  }

  return out;
}

function sidecarParts(msg: CanonicalMessage): GeminiPart[] {
  if (!msg.sidecar || msg.sidecar.providerId !== "google") return [];
  const data = msg.sidecar.data;
  return Array.isArray(data) ? (data as GeminiPart[]) : [];
}

/** Canonical tool choice → Gemini's `functionCallingConfig.mode`. */
function toFunctionCallingMode(choice: LLMCompleteParams["toolChoice"]): string | undefined {
  if (choice === undefined) return undefined;
  if (choice === "none") return "NONE";
  if (choice === "required") return "ANY";
  return "AUTO";
}

/**
 * Gemini's `functionDeclarations` want an OpenAPI-subset schema, the same dialect
 * `responseSchema` uses — so tool parameters go through the same converter. A tool whose schema
 * cannot convert is dropped from the declaration rather than sent in a dialect the API will
 * reject, and the model simply never sees it.
 */
function toFunctionDeclarations(tools: ToolDefinition[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const tool of tools) {
    let parameters: unknown;
    try {
      parameters = toGeminiSchema(tool.parameters);
    } catch {
      continue;
    }
    out.push({ name: tool.name, description: tool.description, parameters });
  }
  return out;
}

/**
 * Build a generateContent request body (pure). Returns the body plus whether the JSON schema had
 * to be embedded in the system prompt (Gemini conversion failed) — the caller uses that only for
 * testing/telemetry; correctness rides on the router loop.
 */
export function buildGenerateContentBody(params: LLMCompleteParams): {
  body: Record<string, unknown>;
  schemaInPrompt: boolean;
} {
  const hasTools = (params.tools?.length ?? 0) > 0;
  const wantsJson = params.responseFormat === "json" && !hasTools;
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

  const conversation = params.conversation ?? fromLegacyMessages(params.messages);

  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: systemText }] },
    contents: toGeminiContents(conversation),
    generationConfig,
  };

  if (hasTools) {
    const declarations = toFunctionDeclarations(params.tools!);
    if (declarations.length > 0) {
      body.tools = [{ functionDeclarations: declarations }];
      const mode = toFunctionCallingMode(params.toolChoice);
      if (mode) body.toolConfig = { functionCallingConfig: { mode } };
    }
  }

  return { body, schemaInPrompt };
}

interface GenerateContentResponse {
  modelVersion?: string;
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

function toStopReason(finish: string | undefined, hasToolCalls: boolean): StopReason {
  if (hasToolCalls) return "tool_use";
  if (finish === "STOP") return "end";
  if (finish === "MAX_TOKENS") return "length";
  return "other";
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
          signal: params.signal
            ? AbortSignal.any([params.signal, AbortSignal.timeout(LLM_TIMEOUT_MS)])
            : AbortSignal.timeout(LLM_TIMEOUT_MS),
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
    }, params.signal);
    const latencyMs = Date.now() - started;

    const candidate = json.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    const content = parts.map((p) => p.text ?? "").join("");
    const offered = params.tools ?? [];

    let toolCalls: ToolCall[] = [];
    parts.forEach((part, index) => {
      const fc = part.functionCall;
      if (!fc?.name) return;
      if (offered.length > 0 && !offered.some((t) => t.name === fc.name)) return;
      toolCalls.push({
        id: synthesizeCallId(fc.name, index),
        name: fc.name,
        arguments: fc.args ?? {},
      });
    });

    if (toolCalls.length === 0 && offered.length > 0 && content.length > 0) {
      toolCalls = salvageToolCalls(content, offered).toolCalls;
    }

    if (content.length === 0 && toolCalls.length === 0) {
      throw new LLMProviderError("google", undefined, "Response contained no content");
    }

    return {
      content,
      modelUsed: json.modelVersion ?? params.model,
      tokensIn: json.usageMetadata?.promptTokenCount ?? 0,
      tokensOut: json.usageMetadata?.candidatesTokenCount ?? 0,
      latencyMs,
      raw: json,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      stopReason: toStopReason(candidate?.finishReason, toolCalls.length > 0),
      // The whole parts array, so a replay reproduces the model turn byte-for-byte including any
      // thought signatures. Only carried when the turn had tool calls — a plain text answer has
      // nothing that needs replaying, and an unnecessary sidecar would just pin the conversation
      // to this provider for no reason.
      ...(toolCalls.length > 0
        ? { sidecar: { providerId: "google" as const, data: parts } }
        : {}),
    };
  },
};
