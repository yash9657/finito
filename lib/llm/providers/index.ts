/**
 * Provider registry (Plan 2 §2). Maps a `ProviderId` to its `LLMProvider`
 * implementation. The router picks a provider by id; nothing else imports the
 * individual provider files directly.
 */

import type { LLMProvider, ProviderId } from "@/lib/llm/provider";
import { anthropicProvider } from "@/lib/llm/providers/anthropic";
import { openaiProvider } from "@/lib/llm/providers/openai";
import { googleProvider } from "@/lib/llm/providers/google";
import { ollamaProvider } from "@/lib/llm/providers/ollama";
import { customProvider } from "@/lib/llm/providers/custom-endpoint";
import { fireworksProvider } from "@/lib/llm/providers/fireworks";

export const providers: Record<ProviderId, LLMProvider> = {
  fireworks: fireworksProvider,
  anthropic: anthropicProvider,
  openai: openaiProvider,
  google: googleProvider,
  ollama: ollamaProvider,
  custom: customProvider,
};

export function getProvider(id: ProviderId): LLMProvider {
  return providers[id];
}
