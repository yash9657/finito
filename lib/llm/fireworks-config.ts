/** Public identifiers only. Never put credentials in this module. */
export const FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1";
export const FIREWORKS_DEFAULT_MODEL = "accounts/fireworks/models/deepseek-v4p1-flash";
export const FIREWORKS_MODEL_OPTIONS = [
  { id: FIREWORKS_DEFAULT_MODEL, label: "DeepSeek V4.1 Flash" },
  { id: "accounts/fireworks/models/kimi-k3", label: "Kimi K3" },
] as const;
