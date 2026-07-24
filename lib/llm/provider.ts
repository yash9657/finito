/**
 * The provider transport contract (Plan 2 §2.1, D-P1).
 *
 * This layer is transport-ONLY: strings in, string + metadata out. All schema
 * validation, corrective retries, and reasoning extraction live one level up in
 * `router.invoke<T>()` (§2.3). JSON-schema enforcement differs wildly per provider
 * (D-P9) but zod validation + retry is provider-independent, so it must not be
 * duplicated five times.
 *
 * Providers throw `LLMProviderError` — its message is built from status codes, never
 * from request bodies, so a key can never leak into an error string (D-P10, §9).
 * Transport-retry policy (429 / 5xx) is the shared `withTransportRetry` helper below,
 * applied uniformly inside every provider file.
 */

export type ProviderId = "anthropic" | "openai" | "google" | "ollama" | "custom";

export interface LLMCompleteParams {
  systemPrompt: string;
  messages: { role: "user" | "assistant"; content: string }[];
  model: string;
  maxTokens: number;
  responseFormat?: "json" | "text";
  /** Plain JSON Schema for the expected output when responseFormat === 'json'.
   *  Providers with native schema enforcement use it (D-P9); others embed it in
   *  the prompt. Produced by lib/llm/json-schema.ts from the step's zod schema. */
  jsonSchema?: Record<string, unknown>;
  /** Transport config resolved by the router — never read from env inside providers. */
  apiKey?: string; // absent for keyless endpoints (ollama, some custom)
  baseUrl?: string; // required for ollama/custom; optional override elsewhere
}

export interface LLMCompleteResult {
  content: string; // the text the model returned (JSON string when 'json')
  modelUsed: string; // exact model id echoed by the provider (or params.model)
  tokensIn: number; // 0 if the provider reports none (some Ollama builds)
  tokensOut: number;
  latencyMs: number;
  raw: unknown; // full provider response body (router redacts+caps, D-P11)
  reasoningNative?: string; // provider-native reasoning (Anthropic thinking blocks)
}

export interface LLMProvider {
  id: ProviderId;
  complete(params: LLMCompleteParams): Promise<LLMCompleteResult>;
}

/**
 * A provider transport error. The message is constructed from the status code and a
 * short human label — NEVER from the request/response body — so an API key can never
 * end up in a log line (§9, "Never log keys").
 */
export class LLMProviderError extends Error {
  readonly providerId: ProviderId;
  readonly status: number | undefined;
  constructor(providerId: ProviderId, status: number | undefined, message: string) {
    super(message);
    this.name = "LLMProviderError";
    this.providerId = providerId;
    this.status = status;
  }
}

/** Per-call timeout for HTTP-first providers (D-P10). */
export const LLM_TIMEOUT_MS = 120_000;

const RETRY_AFTER_CAP_MS = 60_000;
const SERVER_ERROR_BACKOFF_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A transport-level failure carrying the HTTP status and (optionally) the parsed
 * `retry-after` seconds, so `withTransportRetry` can decide the backoff without ever
 * seeing the response body. Providers throw this from inside the retried thunk.
 */
export class TransportError extends Error {
  readonly status: number;
  readonly retryAfterSeconds: number | null;
  constructor(status: number, retryAfterSeconds: number | null, message: string) {
    super(message);
    this.name = "TransportError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Uniform transport retry (Plan 2 §2.1, ports the old `createWithRetry`):
 *   - HTTP 429: honor `retry-after` (capped at 60s), retry once.
 *   - HTTP 5xx: retry once after a 2s backoff.
 *   - anything else: rethrow immediately.
 * `fn` should throw a `TransportError` on 429/5xx; any other throw propagates as-is.
 */
export async function withTransportRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof TransportError) {
      if (err.status === 429) {
        const raw = err.retryAfterSeconds;
        const delay =
          raw != null && Number.isFinite(raw) && raw > 0
            ? Math.min(raw * 1000, RETRY_AFTER_CAP_MS)
            : 0;
        await sleep(delay);
        return fn();
      }
      if (err.status >= 500) {
        await sleep(SERVER_ERROR_BACKOFF_MS);
        return fn();
      }
    }
    throw err;
  }
}

/** Parse a `retry-after` header value (seconds) into a number or null. */
export function parseRetryAfter(header: string | null): number | null {
  if (header == null) return null;
  const n = Number(header);
  return Number.isFinite(n) && n > 0 ? n : null;
}
