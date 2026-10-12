/**
 * The model capability table (Plan 5 §4, D-G16).
 *
 * Before Plan 5 the codebase had no answer to "does this model support tool calling?", "can it
 * make parallel tool calls?", "how big is its context window?" — and an agent that plans around
 * capabilities it does not have fails confusingly, several turns in, with an empty answer.
 *
 * ## Vendored, never fetched
 *
 * OpenCode consumes models.dev at runtime. We deliberately do not. A runtime dependency would
 * make an investigation's ability to *start* contingent on a third party's uptime, and would mean
 * the same model could be judged tool-capable on Tuesday and not on Wednesday, with no diff to
 * point at. A stale table is a known quantity; a flaky one is not. Refreshing it is a code change
 * with a reviewer, which is the correct weight for something that decides whether a run may begin.
 *
 * ## Honesty about what is known
 *
 * `source` distinguishes a vendored fact from a per-provider default. Everything outside the
 * Anthropic block is a **conservative floor**, not a measurement: the context windows are set
 * below the real ones on purpose, because being wrong low costs an unnecessary compaction and
 * being wrong high costs a failed run mid-investigation. Anything reported as `assumed` should be
 * read as "we have not verified this model", and the agent surfaces that in its trace rather than
 * quietly relying on it.
 */

import type { ProviderId } from "@/lib/llm/provider";

export interface ModelCapabilities {
  /** Total context window in tokens (input + output). */
  contextWindow: number;
  /** Maximum tokens the model will emit in one response. */
  maxOutputTokens: number;
  toolCalling: boolean;
  /** Whether several tool calls may come back in ONE assistant turn. */
  parallelToolCalls: boolean;
  vision: boolean;
  /**
   * `vendored` — a recorded fact about this specific model.
   * `assumed`  — a conservative per-provider default; the model is not in the table.
   */
  source: "vendored" | "assumed";
  /** The table key that matched, for the trace. */
  matched: string;
}

interface CapabilityEntry extends Omit<ModelCapabilities, "source" | "matched"> {
  /** Model id prefix. Longest match wins, so `claude-opus-4-6` beats `claude-`. */
  prefix: string;
}

/*
 * Anthropic. Verified against the model catalogue; every current model does tool calling,
 * parallel tool calls and vision, so the interesting column is the context window.
 */
const ANTHROPIC: CapabilityEntry[] = [
  { prefix: "claude-opus-5", contextWindow: 1_000_000, maxOutputTokens: 128_000, toolCalling: true, parallelToolCalls: true, vision: true },
  { prefix: "claude-fable-5", contextWindow: 1_000_000, maxOutputTokens: 128_000, toolCalling: true, parallelToolCalls: true, vision: true },
  { prefix: "claude-mythos-5", contextWindow: 1_000_000, maxOutputTokens: 128_000, toolCalling: true, parallelToolCalls: true, vision: true },
  { prefix: "claude-opus-4-8", contextWindow: 1_000_000, maxOutputTokens: 128_000, toolCalling: true, parallelToolCalls: true, vision: true },
  { prefix: "claude-opus-4-7", contextWindow: 1_000_000, maxOutputTokens: 128_000, toolCalling: true, parallelToolCalls: true, vision: true },
  { prefix: "claude-opus-4-6", contextWindow: 1_000_000, maxOutputTokens: 128_000, toolCalling: true, parallelToolCalls: true, vision: true },
  { prefix: "claude-sonnet-5", contextWindow: 1_000_000, maxOutputTokens: 128_000, toolCalling: true, parallelToolCalls: true, vision: true },
  { prefix: "claude-sonnet-4-6", contextWindow: 1_000_000, maxOutputTokens: 128_000, toolCalling: true, parallelToolCalls: true, vision: true },
  { prefix: "claude-haiku-4-5", contextWindow: 200_000, maxOutputTokens: 64_000, toolCalling: true, parallelToolCalls: true, vision: true },
  { prefix: "claude-opus-4-5", contextWindow: 200_000, maxOutputTokens: 64_000, toolCalling: true, parallelToolCalls: true, vision: true },
  { prefix: "claude-sonnet-4-5", contextWindow: 200_000, maxOutputTokens: 64_000, toolCalling: true, parallelToolCalls: true, vision: true },
];

/*
 * Everything below is a FLOOR, not a measurement.
 *
 * These entries exist so the agent can start and behave sanely on a model we have not verified,
 * not so it can plan precisely. The context windows are deliberately set well below the vendors'
 * published numbers: an under-estimate compacts a turn early (a small cost, visible on the
 * trail), an over-estimate blows the window mid-investigation (a failed run). Where the tradeoff
 * is asymmetric, take the cheap side.
 */
const OPENAI: CapabilityEntry[] = [
  // The `gpt-` and `o`-series families have supported parallel function calling for several
  // generations; the floor here is on size, not on capability.
  { prefix: "gpt-", contextWindow: 128_000, maxOutputTokens: 16_384, toolCalling: true, parallelToolCalls: true, vision: true },
  { prefix: "o1", contextWindow: 128_000, maxOutputTokens: 32_768, toolCalling: true, parallelToolCalls: false, vision: false },
  { prefix: "o3", contextWindow: 128_000, maxOutputTokens: 32_768, toolCalling: true, parallelToolCalls: true, vision: true },
  // Embedding models are in the table specifically so the loop refuses to start on one with a
  // clear message, instead of looping until max_turns on a model that cannot answer.
  { prefix: "text-embedding", contextWindow: 8_191, maxOutputTokens: 0, toolCalling: false, parallelToolCalls: false, vision: false },
];

const GOOGLE: CapabilityEntry[] = [
  { prefix: "gemini-", contextWindow: 128_000, maxOutputTokens: 8_192, toolCalling: true, parallelToolCalls: true, vision: true },
  { prefix: "text-embedding", contextWindow: 2_048, maxOutputTokens: 0, toolCalling: false, parallelToolCalls: false, vision: false },
  { prefix: "embedding-", contextWindow: 2_048, maxOutputTokens: 0, toolCalling: false, parallelToolCalls: false, vision: false },
];

/*
 * Custom = any OpenAI-compatible endpoint, which is how DeepSeek, vLLM, LM Studio and friends are
 * reached. DeepSeek's current models are `deepseek-v4-pro` / `deepseek-v4-flash`; `deepseek-chat`
 * and `deepseek-reasoner` were deprecated 2026-07-24 and are deliberately absent rather than
 * listed-as-broken, so a config naming one falls through to the assumed default and the salvage
 * layer, instead of being told something specific and wrong about a model that no longer exists.
 */
const CUSTOM: CapabilityEntry[] = [
  { prefix: "deepseek-v4-pro", contextWindow: 128_000, maxOutputTokens: 8_192, toolCalling: true, parallelToolCalls: true, vision: false },
  { prefix: "deepseek-v4-flash", contextWindow: 128_000, maxOutputTokens: 8_192, toolCalling: true, parallelToolCalls: true, vision: false },
];

/*
 * Ollama support varies by MODEL, not by server version — a host running a current Ollama can
 * still be serving a model with no tool template at all. So the default assumes tool calling is
 * *attempted* (refusing outright would make every un-tabulated local model unusable) but that
 * parallel calls are not, and the salvage layer (D-G17) is what makes the attempt survive a weak
 * emitter. Known tool-capable families get a higher floor.
 */
const OLLAMA: CapabilityEntry[] = [
  { prefix: "llama3.1", contextWindow: 128_000, maxOutputTokens: 4_096, toolCalling: true, parallelToolCalls: true, vision: false },
  { prefix: "llama3.2", contextWindow: 128_000, maxOutputTokens: 4_096, toolCalling: true, parallelToolCalls: true, vision: false },
  { prefix: "llama3.3", contextWindow: 128_000, maxOutputTokens: 4_096, toolCalling: true, parallelToolCalls: true, vision: false },
  { prefix: "qwen2.5", contextWindow: 32_768, maxOutputTokens: 4_096, toolCalling: true, parallelToolCalls: true, vision: false },
  { prefix: "qwen3", contextWindow: 32_768, maxOutputTokens: 4_096, toolCalling: true, parallelToolCalls: true, vision: false },
  { prefix: "mistral", contextWindow: 32_768, maxOutputTokens: 4_096, toolCalling: true, parallelToolCalls: false, vision: false },
  { prefix: "firefunction", contextWindow: 32_768, maxOutputTokens: 4_096, toolCalling: true, parallelToolCalls: true, vision: false },
  // Embedding models again, for the same reason as above.
  { prefix: "nomic-embed", contextWindow: 8_192, maxOutputTokens: 0, toolCalling: false, parallelToolCalls: false, vision: false },
  { prefix: "mxbai-embed", contextWindow: 512, maxOutputTokens: 0, toolCalling: false, parallelToolCalls: false, vision: false },
];

const TABLE: Record<ProviderId, CapabilityEntry[]> = {
  // Conservative execution limits; supported tools verified in Fireworks' catalogue, 2026-10-12.
  fireworks: [
    { prefix: "deepseek-v4p1-flash", contextWindow: 128_000, maxOutputTokens: 16_000, toolCalling: true, parallelToolCalls: false, vision: true },
    { prefix: "kimi-k3", contextWindow: 128_000, maxOutputTokens: 16_000, toolCalling: true, parallelToolCalls: false, vision: true },
  ],
  anthropic: ANTHROPIC,
  openai: OPENAI,
  google: GOOGLE,
  ollama: OLLAMA,
  custom: CUSTOM,
};

/** The floor used when nothing in the table matches. Small, cautious, tool-calling attempted. */
const DEFAULTS: Record<ProviderId, Omit<CapabilityEntry, "prefix">> = {
  fireworks: { contextWindow: 32_768, maxOutputTokens: 4_096, toolCalling: false, parallelToolCalls: false, vision: false },
  anthropic: { contextWindow: 200_000, maxOutputTokens: 8_192, toolCalling: true, parallelToolCalls: true, vision: true },
  openai: { contextWindow: 32_768, maxOutputTokens: 4_096, toolCalling: true, parallelToolCalls: true, vision: false },
  google: { contextWindow: 32_768, maxOutputTokens: 4_096, toolCalling: true, parallelToolCalls: true, vision: false },
  ollama: { contextWindow: 8_192, maxOutputTokens: 2_048, toolCalling: true, parallelToolCalls: false, vision: false },
  custom: { contextWindow: 32_768, maxOutputTokens: 4_096, toolCalling: true, parallelToolCalls: false, vision: false },
};

/**
 * Capabilities for one (provider, model).
 *
 * Longest-prefix match, case-insensitive, and tolerant of the decorations real model ids carry:
 * an Ollama tag (`llama3.1:8b-instruct-q4`), a vendor namespace (`accounts/x/models/llama3.1`),
 * or a dated snapshot suffix. A config that names the model slightly differently from the table
 * should still get the table's answer rather than silently falling to the floor.
 */
export function capabilitiesFor(providerId: ProviderId, model: string): ModelCapabilities {
  const normalized = normalizeModelId(model);
  const entries = TABLE[providerId] ?? [];

  let best: CapabilityEntry | null = null;
  for (const entry of entries) {
    if (!normalized.startsWith(entry.prefix)) continue;
    if (best === null || entry.prefix.length > best.prefix.length) best = entry;
  }

  if (best) {
    const { prefix, ...caps } = best;
    return { ...caps, source: "vendored", matched: prefix };
  }
  return { ...DEFAULTS[providerId], source: "assumed", matched: `${providerId}:default` };
}

/**
 * Strip the decorations that stop an exact prefix match: a leading vendor namespace, and an
 * Ollama `:tag`. The tag is dropped because `llama3.1:8b` and `llama3.1:70b` share a tool
 * template — the thing this table is actually about.
 */
function normalizeModelId(model: string): string {
  const lower = model.trim().toLowerCase();
  const lastSlash = lower.lastIndexOf("/");
  const withoutNamespace = lastSlash >= 0 ? lower.slice(lastSlash + 1) : lower;
  return withoutNamespace;
}

/**
 * Whether an investigation may start on this model, and why not if not (D-G16).
 *
 * The loop calls this BEFORE turn 1. Refusing up front with the model named and Settings pointed
 * at is a far better failure than 20 turns of a model that cannot call a tool, terminating on
 * max_turns with nothing to show — which is what "just try it and see" produces.
 */
export function canRunInvestigation(
  providerId: ProviderId,
  model: string,
): { ok: true; capabilities: ModelCapabilities } | { ok: false; reason: string } {
  const capabilities = capabilitiesFor(providerId, model);
  if (!capabilities.toolCalling) {
    return {
      ok: false,
      reason:
        `Model "${model}" on provider "${providerId}" does not support tool calling, which an ` +
        `investigation requires. Assign a tool-capable model to the "investigator" role in ` +
        `Settings → Models.`,
    };
  }
  return { ok: true, capabilities };
}
