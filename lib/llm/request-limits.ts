import { capabilitiesFor } from "@/lib/llm/capabilities";
import type { ProviderId } from "@/lib/llm/provider";

/** A deployment may tighten this guard, but cannot turn source-size limits off. */
export const MAX_MODEL_INPUT_BYTES = 256 * 1024;

/** Reject oversized requests before network I/O. Never silently cut financial source rows. */
export function assertModelInputWithinLimits(
  provider: ProviderId,
  model: string,
  payload: unknown,
  maxOutputTokens: number,
): void {
  const configured = Number(process.env.LLM_MAX_INPUT_BYTES);
  const maxBytes = Number.isFinite(configured) && configured >= 1024
    ? Math.min(Math.trunc(configured), MAX_MODEL_INPUT_BYTES)
    : MAX_MODEL_INPUT_BYTES;
  const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  if (bytes > maxBytes) {
    throw new Error(`Financial input exceeds the ${Math.floor(maxBytes / 1024)} KiB request limit. Narrow the period or split the source into smaller workflows. No source rows were truncated.`);
  }
  const capability = capabilitiesFor(provider, model);
  // Financial JSON and identifiers tokenize more densely than ordinary prose. This is an
  // intentionally conservative estimate, with further context headroom for provider framing.
  const estimatedTokens = Math.ceil(bytes / 2);
  const availableInput = Math.floor(Math.max(0, capability.contextWindow - maxOutputTokens) * 0.8);
  if (estimatedTokens > availableInput) {
    throw new Error("Financial input exceeds this model's safe context budget. Narrow the period, split the source, or select a model with a larger supported context. No source rows were truncated.");
  }
}
