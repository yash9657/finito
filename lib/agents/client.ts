/**
 * Claude API wrapper (PLAN §5.3 / D4). One entry point — `callClaude` — used by every
 * `llm`-kind step. All calls are non-streaming `client.messages.create` with:
 *   model: 'claude-sonnet-4-6' (D4 — recorded in the audit trail, keep exact),
 *   max_tokens: 16000, thinking: { type: 'adaptive' },
 *   structured outputs via output_config.format (never JSON-prompting, never assistant
 *   prefills, never temperature/top_p).
 *
 * The returned `reasoning` is the concatenation of the response's thinking-type blocks;
 * when those are empty (adaptive thinking may omit summaries) it falls back to the
 * parsed schema's own top-level `reasoning` field, which every agent schema carries.
 */

import Anthropic, { APIError, RateLimitError } from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

export const AGENT_MODEL = "claude-sonnet-4-6";

const MAX_TOKENS = 16000;
/** Cap on honoring a 429 `retry-after` header, in milliseconds. */
const RETRY_AFTER_CAP_MS = 60_000;
/** Fixed backoff before retrying a 5xx, in milliseconds. */
const SERVER_ERROR_BACKOFF_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parse a `retry-after` header (seconds) into a capped millisecond delay. */
function retryAfterMs(err: RateLimitError): number {
  const raw = err.headers?.get("retry-after");
  const seconds = raw != null ? Number(raw) : NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.min(seconds * 1000, RETRY_AFTER_CAP_MS);
}

/** Extract the first `text` block's string content from a message response. */
function firstText(message: Anthropic.Message): string {
  for (const block of message.content) {
    if (block.type === "text") return block.text;
  }
  throw new Error("Claude response contained no text block");
}

/** Concatenate all `thinking`-type blocks into a single reasoning string. */
function thinkingReasoning(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.ThinkingBlock => block.type === "thinking")
    .map((block) => block.thinking)
    .join("\n")
    .trim();
}

/**
 * Issue one structured-output request to Claude and validate the result against
 * `schema`. On a parse/validation failure, retries exactly once with a corrective
 * user message appended, then throws. Transport-level errors (429 / 5xx) are handled
 * separately by `createWithRetry` below.
 */
export async function callClaude<T>(opts: {
  system: string;
  user: string;
  schema: z.ZodType<T>;
  apiKey: string;
}): Promise<{ data: T; reasoning: string }> {
  const { system, user, schema, apiKey } = opts;
  if (!apiKey) throw new Error("No Anthropic API key provided");

  // BYOK: the client is constructed per call from the caller-supplied key, which lives
  // only for the duration of the request and is never persisted or logged.
  const anthropic = new Anthropic({ apiKey });
  const format = zodOutputFormat(schema);

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: user }];

  for (let attempt = 0; attempt < 2; attempt++) {
    const message = await createWithRetry(anthropic, {
      model: AGENT_MODEL,
      max_tokens: MAX_TOKENS,
      thinking: { type: "adaptive" },
      output_config: { format },
      system,
      messages,
    });

    const reasoningFromThinking = thinkingReasoning(message);

    let parsed: unknown;
    try {
      parsed = JSON.parse(firstText(message));
    } catch (err) {
      if (attempt === 0) {
        appendRetryPrompt(messages, message, String(err));
        continue;
      }
      throw new Error(`Claude response was not valid JSON: ${String(err)}`);
    }

    const result = schema.safeParse(parsed);
    if (result.success) {
      const data = result.data;
      const reasoning = reasoningFromThinking || fallbackReasoning(data);
      return { data, reasoning };
    }

    if (attempt === 0) {
      appendRetryPrompt(messages, message, result.error.message);
      continue;
    }
    throw new Error(`Claude response failed schema validation: ${result.error.message}`);
  }

  // Unreachable: the loop either returns or throws on both attempts.
  throw new Error("callClaude exhausted retries without a result");
}

/**
 * Append the failed assistant turn plus a corrective user message asking Claude to
 * return corrected JSON. Mutates `messages` in place for the retry attempt.
 */
function appendRetryPrompt(
  messages: Anthropic.MessageParam[],
  failed: Anthropic.Message,
  zodError: string,
): void {
  messages.push({ role: "assistant", content: failed.content });
  messages.push({
    role: "user",
    content: `Your previous response failed validation: ${zodError}. Return corrected JSON.`,
  });
}

/** Pull a `reasoning` string off the parsed data when the model omitted thinking summaries. */
function fallbackReasoning(data: unknown): string {
  if (
    data != null &&
    typeof data === "object" &&
    "reasoning" in data &&
    typeof (data as { reasoning: unknown }).reasoning === "string"
  ) {
    return (data as { reasoning: string }).reasoning;
  }
  return "";
}

/**
 * Wrap `messages.create` with typed transport-error retries (D4):
 *   - RateLimitError (429): wait the `retry-after` delay (capped at 60s), retry once.
 *   - APIError 5xx: retry once after a 2s backoff.
 *   - anything else: rethrow.
 */
async function createWithRetry(
  anthropic: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
): Promise<Anthropic.Message> {
  try {
    return await anthropic.messages.create(params);
  } catch (err) {
    if (err instanceof RateLimitError) {
      await sleep(retryAfterMs(err));
      return anthropic.messages.create(params);
    }
    if (err instanceof APIError && typeof err.status === "number" && err.status >= 500) {
      await sleep(SERVER_ERROR_BACKOFF_MS);
      return anthropic.messages.create(params);
    }
    throw err;
  }
}
