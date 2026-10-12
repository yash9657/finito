/**
 * OpenAI provider (Plan 2 §2.2, D-P9/D-P10; tool calling added by Plan 5, D-G14) — plain `fetch`
 * against the Chat Completions REST API, no `openai` SDK. custom-endpoint.ts reuses the shared
 * helpers here (custom = same body shape, custom base_url, json_object mode), which is also how
 * DeepSeek, vLLM and LM Studio are reached.
 *
 * The request-body builder is a pure exported function so the provider tests assert the exact JSON
 * without a network call — the regression gate for "the legacy path did not move".
 *
 * ## The trap, and it is a real one
 *
 * `function.arguments` comes back as a **JSON string**, not an object. A strong model emits valid
 * JSON in it; a weaker OpenAI-compatible gateway emits a trailing comma, a single-quoted key, or
 * the whole object double-encoded. Parsing it with a bare `JSON.parse` and letting the throw
 * escape turns a recoverable formatting slip into a failed investigation, so every parse goes
 * through `repairArguments` (D-G17) and every repair is marked.
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
import {
  fromLegacyMessages,
  type CanonicalMessage,
  type StopReason,
  type ToolCall,
  type ToolDefinition,
} from "@/lib/llm/messages";
import { repairArguments, salvageToolCalls } from "@/lib/llm/salvage";

const DEFAULT_BASE_URL = "https://api.openai.com";

/** How the JSON output is requested: OpenAI native strict json_schema vs. json_object. */
export type JsonMode = "json_schema" | "json_object";

/**
 * Compose the system prompt, appending the schema for weak-JSON endpoints (json_object mode) so
 * the model still sees the target shape (D-P9). OpenAI strict json_schema mode does NOT need this
 * — the schema rides in `response_format`.
 */
export function composeSystemPrompt(params: LLMCompleteParams, appendSchema: boolean): string {
  if (appendSchema && params.responseFormat === "json" && params.jsonSchema) {
    return `${params.systemPrompt}\n\nRespond with JSON matching this schema: ${JSON.stringify(
      params.jsonSchema,
    )}`;
  }
  return params.systemPrompt;
}

/** A Chat-Completions message, in the shapes this provider emits. */
type ChatMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: {
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

/**
 * Turn the canonical conversation into Chat-Completions messages.
 *
 * Note the asymmetry with Anthropic: results are emitted as ONE `role:'tool'` message PER call,
 * because that is what this API's `tool_call_id` field is for. The canonical form batches them
 * (Anthropic's requirement), so this is where the batch is unpacked.
 */
export function toChatMessages(conversation: CanonicalMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];

  for (const msg of conversation) {
    if (msg.role === "user") {
      out.push({ role: "user", content: msg.content });
      continue;
    }

    if (msg.role === "tool") {
      for (const result of msg.toolResults ?? []) {
        out.push({ role: "tool", tool_call_id: result.toolCallId, content: result.content });
      }
      continue;
    }

    const calls = msg.toolCalls ?? [];
    const assistant: ChatMessage = {
      role: "assistant",
      // `null`, not `''`: some OpenAI-compatible gateways reject an empty string alongside
      // tool_calls, and null is what the API's own examples use for a tool-only turn.
      content: msg.content.length > 0 ? msg.content : calls.length > 0 ? null : "",
    };
    if (calls.length > 0) {
      assistant.tool_calls = calls.map((c) => ({
        id: c.id,
        type: "function" as const,
        function: { name: c.name, arguments: JSON.stringify(c.arguments) },
      }));
    }
    out.push(assistant);
  }

  return out;
}

/** Canonical tool choice → the Chat-Completions spelling (they happen to match). */
function toChatToolChoice(choice: LLMCompleteParams["toolChoice"]): string | undefined {
  if (choice === undefined) return undefined;
  return choice;
}

/**
 * Build a Chat-Completions request body (pure). `jsonMode` selects the `response_format`; when it
 * is `json_object` the schema is appended to the system prompt instead (weak-JSON path shared with
 * custom endpoints).
 */
export function buildChatCompletionsBody(
  params: LLMCompleteParams,
  jsonMode: JsonMode,
): Record<string, unknown> {
  const hasTools = (params.tools?.length ?? 0) > 0;
  const wantsJson = params.responseFormat === "json" && !hasTools;
  const schemaInPrompt = wantsJson && jsonMode === "json_object";
  const system = composeSystemPrompt(params, schemaInPrompt);
  const conversation = params.conversation ?? fromLegacyMessages(params.messages);

  const body: Record<string, unknown> = {
    model: params.model,
    max_completion_tokens: params.maxTokens,
    messages: [{ role: "system", content: system }, ...toChatMessages(conversation)],
  };

  if (hasTools) {
    body.tools = params.tools!.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    const choice = toChatToolChoice(params.toolChoice);
    if (choice) body.tool_choice = choice;
  }

  // Forced JSON output and tools are mutually exclusive (D-G14).
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

interface ChatToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: unknown };
}

interface ChatCompletionsResponse {
  model?: string;
  choices?: {
    message?: { content?: string | null; tool_calls?: ChatToolCall[] };
    finish_reason?: string;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Normalize `message.tool_calls[]` into canonical form.
 *
 * A call whose arguments cannot be repaired even against the schema is DROPPED rather than passed
 * on with empty arguments: running `query_ledger` with no filters because its arguments were
 * unreadable would return the whole ledger and look like a successful call. Dropping it leaves the
 * turn with no calls, which the loop reports back to the model as a correctable failure.
 */
export function toCanonicalToolCalls(
  raw: ChatToolCall[] | undefined,
  tools: ToolDefinition[],
): ToolCall[] {
  if (!raw) return [];
  const out: ToolCall[] = [];

  raw.forEach((call, index) => {
    const name = call.function?.name;
    if (!name) return;
    const tool = tools.find((t) => t.name === name);
    if (!tool) return; // a tool we did not offer is not a tool we will run

    const repaired = repairArguments(call.function?.arguments, tool);
    if (!repaired) return;

    out.push({
      id: call.id ?? `call-${index}-${name}`,
      name,
      arguments: repaired.arguments,
      ...(repaired.salvaged
        ? { salvaged: true, salvageStrategy: repaired.strategy ?? "arguments_repair" }
        : {}),
    });
  });

  return out;
}

function toStopReason(finish: string | undefined): StopReason {
  if (finish === "tool_calls" || finish === "function_call") return "tool_use";
  if (finish === "stop") return "end";
  if (finish === "length") return "length";
  return "other";
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
  buildBody: typeof buildChatCompletionsBody = buildChatCompletionsBody,
  routingHeaders: Record<string, string> = {},
): Promise<LLMCompleteResult> {
  const baseUrl = (params.baseUrl ?? defaultBaseUrl).replace(/\/+$/, "");
  const url = `${baseUrl}${baseUrl.endsWith("/v1") ? "" : "/v1"}/chat/completions`;
  const body = buildBody(params, jsonMode);

  const headers: Record<string, string> = { ...routingHeaders, "Content-Type": "application/json" };
  if (params.apiKey) headers.Authorization = `Bearer ${params.apiKey}`;

  const started = Date.now();
  const json = await withTransportRetry(async () => {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: params.signal
          ? AbortSignal.any([params.signal, AbortSignal.timeout(LLM_TIMEOUT_MS)])
          : AbortSignal.timeout(LLM_TIMEOUT_MS),
        redirect: "error",
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
    try {
      return (await res.json()) as ChatCompletionsResponse;
    } catch {
      throw new LLMProviderError(id, undefined, "Provider returned an invalid response");
    }
  }, params.signal);
  const latencyMs = Date.now() - started;

  const choice = json?.choices?.[0];
  if (!choice?.message) throw new LLMProviderError(id, undefined, "Provider returned no completion");
  if (choice.finish_reason === "length") {
    throw new LLMProviderError(id, undefined, "Model output exceeded its token limit. Use a smaller input or a model with a larger output budget.");
  }
  if (choice.finish_reason === "content_filter") {
    throw new LLMProviderError(id, undefined, "Provider declined this request");
  }
  const content = choice?.message?.content;
  const tools = params.tools ?? [];
  const rawCalls = choice.message.tool_calls;
  if (rawCalls !== undefined && !Array.isArray(rawCalls)) {
    throw new LLMProviderError(id, undefined, "Provider returned malformed tool calls");
  }
  let toolCalls = toCanonicalToolCalls(rawCalls, tools);
  // A partially decoded action turn is not a complete plan. Never execute the valid subset
  // while silently discarding the rest, or mistake failed tool decoding for a final answer.
  if ((rawCalls?.length ?? 0) !== toolCalls.length ||
      new Set(toolCalls.map(call => call.id)).size !== toolCalls.length ||
      (choice.finish_reason === "tool_calls" && toolCalls.length === 0)) {
    throw new LLMProviderError(id, undefined, "Provider returned invalid or unsupported tool calls");
  }

  // A tool-only turn legitimately carries no content, so the strict check applies only when we
  // asked for no tools — otherwise the normal shape of a tool call would read as a failure.
  if (typeof content !== "string" && toolCalls.length === 0 && tools.length === 0) {
    throw new LLMProviderError(id, undefined, "Response contained no message content");
  }

  const text = typeof content === "string" ? content : "";

  // Weak endpoints (Ollama behind an OpenAI shim, quantized local models, some gateways) write
  // the tool call into the prose instead of `tool_calls`. Recover it, validated against the
  // schema, and mark it — see D-G17 on why this is never silent.
  if (toolCalls.length === 0 && tools.length > 0 && text.length > 0) {
    toolCalls = salvageToolCalls(text, tools).toolCalls;
  }
  if (text.trim().length === 0 && toolCalls.length === 0) {
    throw new LLMProviderError(id, undefined, "Provider returned an empty completion");
  }

  return {
    content: text,
    modelUsed: json.model ?? params.model,
    tokensIn: json.usage?.prompt_tokens ?? 0,
    tokensOut: json.usage?.completion_tokens ?? 0,
    latencyMs,
    raw: json,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    stopReason:
      toolCalls.length > 0 ? "tool_use" : toStopReason(choice?.finish_reason),
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
