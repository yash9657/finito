/**
 * The canonical message format (Plan 5 §4, D-G13) — the transform layer.
 *
 * Every provider converts to and from this ONE internal representation, and the agent loop only
 * ever sees canonical messages. This is OpenCode's provider-transform seam given a name, so the
 * per-provider divergence lives in five `toXxx`/`fromXxx` functions rather than as
 * `if (provider === …)` scattered through the loop.
 *
 * The divergence is not cosmetic:
 *
 *   - Anthropic puts tool calls in content BLOCKS and all parallel tool results in ONE user
 *     message; splitting them across messages trains the model out of parallel calls.
 *   - OpenAI puts them in `message.tool_calls[]` with arguments as a JSON **string**, and wants
 *     one `role:'tool'` message per result.
 *   - Gemini has no call ids at all and matches by name (D-G15).
 *
 * A representation that papered over those would push the differences into the loop, which is the
 * one place that must stay provider-agnostic.
 *
 * ## The sidecar
 *
 * Anthropic thinking blocks carry signatures that must be echoed back **verbatim** or the API
 * rejects the turn; Gemini parts carry thought signatures with the same property. Both are opaque
 * and neither is portable. They ride on `sidecar`, and the rule is stated once, here:
 *
 *   same provider next turn  → replay verbatim
 *   different provider       → drop, and append a `provider_state_dropped` event
 *
 * That is the honest version of seamless model swapping. Silently dropping provider reasoning
 * state is a debugging nightmare; erroring is a worse product; saying so in the trace is neither.
 */

import type { PlainJsonSchema } from "@/lib/llm/json-schema";
import type { ProviderId } from "@/lib/llm/provider";

/* -------------------------------------------------------------------------- */
/* Tools                                                                       */
/* -------------------------------------------------------------------------- */

/** A tool as declared to a provider. `parameters` is a plain JSON Schema object. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: PlainJsonSchema;
}

/** How hard the model is pushed toward calling a tool. */
export type ToolChoice = "auto" | "none" | "required";

/** One tool call the model asked for. `arguments` is ALWAYS a parsed object here. */
export interface ToolCall {
  /**
   * The provider's call id, or a synthesized one for providers that issue none (Gemini —
   * D-G15). Unique within a turn; not meaningful across turns.
   */
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** True when `lib/llm/salvage.ts` recovered this from prose or malformed JSON (D-G17). */
  salvaged?: boolean;
  /** Which salvage strategy worked — surfaced on the `tool_called` event, never hidden. */
  salvageStrategy?: string;
}

/** The result of executing one tool call, on its way back to the model. */
export interface ToolResult {
  toolCallId: string;
  /** Carried because Gemini matches `functionResponse` by name, not by id (D-G15). */
  name: string;
  /** JSON-encoded tool output, already trimmed to the model's excerpt budget (D-G22). */
  content: string;
  isError?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Messages                                                                    */
/* -------------------------------------------------------------------------- */

export type CanonicalRole = "user" | "assistant" | "tool";

/**
 * Opaque provider-native reasoning state, replayable only to the provider that produced it.
 * `data` is deliberately `unknown`: nothing outside the owning provider file may interpret it.
 */
export interface ProviderSidecar {
  providerId: ProviderId;
  data: unknown;
}

export interface CanonicalMessage {
  role: CanonicalRole;
  /** Text content. Empty string when a turn is tool calls only — never null, so joins are safe. */
  content: string;
  /** Assistant turns only. */
  toolCalls?: ToolCall[];
  /** `tool` turns only. A single message may carry several, for parallel calls. */
  toolResults?: ToolResult[];
  sidecar?: ProviderSidecar;
}

export type StopReason = "tool_use" | "end" | "length" | "other";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

export function userMessage(content: string): CanonicalMessage {
  return { role: "user", content };
}

export function assistantMessage(
  content: string,
  toolCalls?: ToolCall[],
  sidecar?: ProviderSidecar,
): CanonicalMessage {
  const msg: CanonicalMessage = { role: "assistant", content };
  if (toolCalls && toolCalls.length > 0) msg.toolCalls = toolCalls;
  if (sidecar) msg.sidecar = sidecar;
  return msg;
}

/**
 * One `tool` message carrying every result for a turn.
 *
 * Deliberately batched rather than one message per result: Anthropic requires all parallel
 * `tool_result` blocks in a single user message, and providers that want them separate can split
 * on the way out. Modelling it the other way round would make the Anthropic conversion lossy.
 */
export function toolResultMessage(results: ToolResult[]): CanonicalMessage {
  return { role: "tool", content: "", toolResults: results };
}

/** Adapt the legacy text-only message list to canonical form (D-G14 compatibility path). */
export function fromLegacyMessages(
  messages: { role: "user" | "assistant"; content: string }[],
): CanonicalMessage[] {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

/**
 * Strip sidecars that belong to a different provider (D-G13).
 *
 * Returns the messages to send plus what was dropped, so the caller can append a
 * `provider_state_dropped` event. It does NOT write the event itself — this module is pure and
 * has no DB client, and keeping it that way is what lets the provider files use it too.
 */
export function stripForeignSidecars(
  messages: CanonicalMessage[],
  providerId: ProviderId,
): { messages: CanonicalMessage[]; dropped: { providerId: ProviderId; count: number }[] } {
  const droppedBy = new Map<ProviderId, number>();
  const out = messages.map((m) => {
    if (!m.sidecar || m.sidecar.providerId === providerId) return m;
    droppedBy.set(m.sidecar.providerId, (droppedBy.get(m.sidecar.providerId) ?? 0) + 1);
    const { sidecar: _dropped, ...rest } = m;
    void _dropped;
    return rest;
  });
  return {
    messages: out,
    dropped: [...droppedBy.entries()].map(([id, count]) => ({ providerId: id, count })),
  };
}

/**
 * Every tool call in a conversation, in order. Used by the loop for repetition detection and by
 * the trace for a flat call list.
 */
export function allToolCalls(messages: CanonicalMessage[]): ToolCall[] {
  return messages.flatMap((m) => m.toolCalls ?? []);
}

/**
 * A rough token estimate for a conversation, for the compaction trigger (D-G22).
 *
 * Four characters per token is the usual English approximation and it is deliberately crude:
 * the real count comes back from the provider on every call as `tokensIn`, and this only has to
 * be good enough to decide *when to check*. Being wrong by 20% moves compaction by a turn; being
 * exact would need a per-provider tokenizer, which is a dependency per provider for no gain.
 *
 * Rounds up per message so a conversation of many short messages is not systematically
 * under-counted, and adds a small per-message overhead for role framing.
 */
const CHARS_PER_TOKEN = 4;
const PER_MESSAGE_OVERHEAD_TOKENS = 4;

export function estimateTokens(messages: CanonicalMessage[], systemPrompt = ""): number {
  let chars = systemPrompt.length;
  let overhead = 0;
  for (const m of messages) {
    chars += m.content.length;
    for (const call of m.toolCalls ?? []) {
      chars += call.name.length + JSON.stringify(call.arguments).length;
      overhead += PER_MESSAGE_OVERHEAD_TOKENS;
    }
    for (const result of m.toolResults ?? []) {
      chars += result.name.length + result.content.length;
      overhead += PER_MESSAGE_OVERHEAD_TOKENS;
    }
    overhead += PER_MESSAGE_OVERHEAD_TOKENS;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN) + overhead;
}
