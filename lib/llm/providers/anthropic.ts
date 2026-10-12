/**
 * Anthropic provider (Plan 2 §2.2, D-P9/D-P10; tool calling added by Plan 5, D-G14). The ONLY
 * provider keeping an SDK — `@anthropic-ai/sdk` powers native structured outputs and typed errors.
 *
 * `buildAnthropicParams` is a pure exported function so the provider tests assert the exact body,
 * which is what makes "the legacy path is byte-identical" a checked claim rather than an intention.
 *
 * ## Two things this provider does that no other one does
 *
 * 1. **Thinking blocks must be echoed back verbatim.** They carry signatures, and the API rejects
 *    a modified or reordered one. They ride on the canonical message's `sidecar` and are replayed
 *    ahead of everything else in the assistant turn, which is the order the API requires.
 *
 * 2. **All parallel tool results go in ONE user message.** Splitting them across messages is
 *    accepted by the API but trains the model out of making parallel calls at all — a silent
 *    behavioural regression rather than an error, which is the worst kind.
 */

import Anthropic, { APIConnectionError, APIError, RateLimitError } from "@anthropic-ai/sdk";
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
} from "@/lib/llm/provider";
import { fromLegacyMessages, type CanonicalMessage, type StopReason, type ToolCall } from "@/lib/llm/messages";

/** The content blocks Anthropic requires to be replayed unchanged (thinking + its redacted form). */
type ReasoningBlock = Anthropic.ThinkingBlock | Anthropic.RedactedThinkingBlock;

/**
 * Turn the canonical conversation into Anthropic messages.
 *
 * Exported for the parity tests: the conversion is where the provider-specific rules live, so it
 * is the thing worth pinning.
 */
export function toAnthropicMessages(
  conversation: CanonicalMessage[],
): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];

  for (const msg of conversation) {
    if (msg.role === "user") {
      out.push({ role: "user", content: msg.content });
      continue;
    }

    if (msg.role === "tool") {
      // ONE user message carrying every result of the turn — see the module note.
      const blocks: Anthropic.ToolResultBlockParam[] = (msg.toolResults ?? []).map((r) => ({
        type: "tool_result",
        tool_use_id: r.toolCallId,
        content: r.content,
        ...(r.isError ? { is_error: true } : {}),
      }));
      if (blocks.length > 0) out.push({ role: "user", content: blocks });
      continue;
    }

    // Assistant. Thinking blocks first (the API requires that order), then text, then tool calls.
    const blocks: Anthropic.ContentBlockParam[] = [];
    const reasoning = sidecarBlocks(msg);
    for (const block of reasoning) {
      blocks.push(block as unknown as Anthropic.ContentBlockParam);
    }
    if (msg.content.length > 0) blocks.push({ type: "text", text: msg.content });
    for (const call of msg.toolCalls ?? []) {
      blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments });
    }
    // An assistant turn with no content at all is not a legal message; skip rather than send it.
    if (blocks.length > 0) out.push({ role: "assistant", content: blocks });
  }

  return out;
}

/** The replayable reasoning blocks on a message, if they came from this provider. */
function sidecarBlocks(msg: CanonicalMessage): ReasoningBlock[] {
  if (!msg.sidecar || msg.sidecar.providerId !== "anthropic") return [];
  const data = msg.sidecar.data;
  return Array.isArray(data) ? (data as ReasoningBlock[]) : [];
}

/** Canonical tool choice → Anthropic's. `required` is Anthropic's `any`. */
function toAnthropicToolChoice(
  choice: LLMCompleteParams["toolChoice"],
): Anthropic.ToolChoice | undefined {
  if (choice === undefined) return undefined;
  if (choice === "none") return { type: "none" };
  if (choice === "required") return { type: "any" };
  return { type: "auto" };
}

/**
 * Build the `messages.create` params (pure). `output_config.format` is assembled directly from the
 * plain JSON schema (D-P9) — zod→JSON-schema conversion happens once, router-side, so this file
 * never imports zod.
 */
export function buildAnthropicParams(
  params: LLMCompleteParams,
): Anthropic.MessageCreateParamsNonStreaming {
  const conversation = params.conversation ?? fromLegacyMessages(params.messages);
  const hasTools = (params.tools?.length ?? 0) > 0;

  const base: Anthropic.MessageCreateParamsNonStreaming = {
    model: params.model,
    max_tokens: params.maxTokens,
    thinking: { type: "adaptive" },
    system: params.systemPrompt,
    messages: toAnthropicMessages(conversation),
  };

  if (hasTools) {
    base.tools = params.tools!.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Tool.InputSchema,
    }));
    const choice = toAnthropicToolChoice(params.toolChoice);
    if (choice) base.tool_choice = choice;
  }

  // Native JSON output and tools are mutually exclusive here (D-G14): asking for a JSON object
  // while also offering tools is contradictory, and which one wins is provider-dependent.
  if (!hasTools && params.responseFormat === "json" && params.jsonSchema) {
    base.output_config = {
      format: { type: "json_schema", schema: params.jsonSchema },
    };
  }

  return base;
}

/** Concatenate every text block. Returns '' rather than throwing when a turn is tool calls only. */
function allText(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/** Concatenate all thinking-type blocks into a single reasoning string. */
function thinkingReasoning(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.ThinkingBlock => block.type === "thinking")
    .map((block) => block.thinking)
    .join("\n")
    .trim();
}

/** The blocks that must be replayed verbatim on the next turn, in their original order. */
function reasoningBlocks(message: Anthropic.Message): ReasoningBlock[] {
  return message.content.filter(
    (block): block is ReasoningBlock =>
      block.type === "thinking" || block.type === "redacted_thinking",
  );
}

function toolCallsFrom(message: Anthropic.Message): ToolCall[] {
  return message.content
    .filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use")
    .map((block) => ({
      id: block.id,
      name: block.name,
      arguments: (block.input ?? {}) as Record<string, unknown>,
    }));
}

function toStopReason(reason: string | null | undefined): StopReason {
  if (reason === "tool_use") return "tool_use";
  if (reason === "end_turn" || reason === "stop_sequence") return "end";
  if (reason === "max_tokens") return "length";
  return "other";
}

export const anthropicProvider: LLMProvider = {
  id: "anthropic",
  testConnection(params) {
    return defaultTestConnection(anthropicProvider, params);
  },
  async complete(params: LLMCompleteParams): Promise<LLMCompleteResult> {
    const client = new Anthropic({
      apiKey: params.apiKey,
      baseURL: params.baseUrl ?? undefined,
      // D-P10's per-call timeout applies here too. It was only ever wired into the fetch-based
      // providers, so a stalled request on this path hung for the SDK's ten-minute default —
      // and `maxRetries` defaulting to 2 stacked on top of withTransportRetry below, turning one
      // slow call into up to nine. Retries belong to withTransportRetry, which honours
      // Retry-After; the SDK should attempt exactly once.
      timeout: LLM_TIMEOUT_MS,
      maxRetries: 0,
    });
    const createParams = buildAnthropicParams(params);

    const started = Date.now();
    const message = await withTransportRetry(async () => {
      try {
        return await client.messages.create(createParams, { signal: params.signal });
      } catch (err) {
        if (err instanceof RateLimitError) {
          const retryAfter = parseRetryAfter(err.headers?.get("retry-after") ?? null);
          throw new TransportError(429, retryAfter, "HTTP 429");
        }
        if (err instanceof APIError && typeof err.status === "number" && err.status >= 500) {
          throw new TransportError(err.status, null, `HTTP ${err.status}`);
        }
        // A timed-out or dropped connection is a transport failure, so it belongs to
        // withTransportRetry like the others. Without this it fell through to the generic
        // branch and failed outright on the first try — which is how a single slow call at the
        // end of a long investigation threw away four turns of completed work.
        if (err instanceof APIConnectionError) {
          throw new TransportError(503, null, "connection failed or timed out");
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
    }, params.signal);
    const latencyMs = Date.now() - started;

    const toolCalls = toolCallsFrom(message);
    const text = allText(message);

    // The legacy JSON path expects text and treats its absence as a hard error — a response with
    // no text block there means the model returned nothing usable. With tools offered, a
    // text-free turn is the NORMAL shape of a tool call, so the check only applies without them.
    if (text.length === 0 && toolCalls.length === 0) {
      throw new LLMProviderError("anthropic", undefined, "Response contained no text block");
    }

    const reasoning = reasoningBlocks(message);

    return {
      content: text,
      modelUsed: message.model ?? params.model,
      tokensIn: message.usage?.input_tokens ?? 0,
      tokensOut: message.usage?.output_tokens ?? 0,
      latencyMs,
      raw: message,
      reasoningNative: thinkingReasoning(message) || undefined,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      stopReason: toStopReason(message.stop_reason),
      // Carried even when empty-ish so the next turn replays exactly what came back. Omitted
      // entirely when there is nothing to replay, so `sidecar` never means "an empty one".
      ...(reasoning.length > 0
        ? { sidecar: { providerId: "anthropic" as const, data: reasoning } }
        : {}),
    };
  },
};
