/**
 * Static per-provider UI metadata for the Settings → Models screen (Plan 2 §6).
 * Default-model strings are pre-fill hints only — users can edit them.
 */

import type { ProviderIdValue } from "@/lib/types";

export interface ProviderMeta {
  id: ProviderIdValue;
  label: string;
  defaultModel: string; // pre-fill hint
  needsKey: boolean; // anthropic/openai/google require a key
  needsBaseUrl: boolean; // ollama/custom require a reachable base_url (D-P13)
}

export const PROVIDER_META: Record<ProviderIdValue, ProviderMeta> = {
  anthropic: { id: "anthropic", label: "Anthropic", defaultModel: "claude-sonnet-4-6", needsKey: true, needsBaseUrl: false },
  openai: { id: "openai", label: "OpenAI", defaultModel: "gpt-4.1", needsKey: true, needsBaseUrl: false },
  google: { id: "google", label: "Google Gemini", defaultModel: "gemini-2.5-pro", needsKey: true, needsBaseUrl: false },
  ollama: { id: "ollama", label: "Ollama (local)", defaultModel: "llama3.2:3b", needsKey: false, needsBaseUrl: true },
  custom: { id: "custom", label: "Custom (OpenAI-compatible)", defaultModel: "", needsKey: false, needsBaseUrl: true },
};

export const PROVIDER_ORDER: ProviderIdValue[] = [
  "anthropic",
  "openai",
  "google",
  "ollama",
  "custom",
];
