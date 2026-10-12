/**
 * Redaction + capping for stored payloads (Plan 2 §D-P11; extended by Plan 5).
 *
 * Applied to `workflow_steps.llm_raw` and, since Plan 4 (D-H6), to every `harness_events`
 * payload as a defence-in-depth backstop over the structural guarantee that a decrypted key
 * cannot reach those call frames at all.
 *
 *   1. Any object key case-insensitively matching `SENSITIVE_KEY` has its value replaced with
 *      "[redacted]" (recursively), UNLESS the key is an exact member of `COUNT_KEYS`.
 *   2. If the redacted value serializes to more than 64 KB it is replaced by
 *      { truncated: true, bytes: <n>, head: <first 8 KB of the serialization> }.
 *
 * ## Why `COUNT_KEYS` exists
 *
 * `/token/i` matches `tokens_in` and `tokens_out`. That was harmless while this only guarded
 * `llm_raw` — usage lived in dedicated columns (D-P12) — but Plan 4 reused it for event payloads,
 * where the harness writes its OWN token telemetry: `loop.ts` puts `tokens_in`/`tokens_out` on
 * every `step_completed`, and Plan 5's agent puts them on `agent_terminated` and its compaction
 * events. Those were all being stored as "[redacted]", which quietly made PLAN-4's "the usage
 * dashboard becomes a query over the event stream" impossible.
 *
 * The fix is an exact-match allowlist rather than a looser pattern, so the default stays
 * fail-closed: a key nobody has thought about — `session_token_hint`, say — is still redacted,
 * and only these specific, known-to-be-integers names pass. Adding one is a deliberate act.
 */

const SENSITIVE_KEY = /api[-_]?key|authorization|token|secret|password|credential/i;

/**
 * Exact key names that contain a sensitive-looking word but hold a COUNT, not a credential.
 *
 * Ours plus the four every provider uses in its usage block, since a raw response's usage is
 * worth keeping legible in the trail.
 */
const COUNT_KEYS: ReadonlySet<string> = new Set([
  // FinFlow's own event payloads.
  "tokens_in",
  "tokens_out",
  "tokens_so_far",
  "max_tokens",
  "total_tokens",
  "estimated_tokens_before",
  "estimated_tokens_after",
  "estimated_tokens",
  "estimated_input_tokens",
  "system_estimated_tokens",
  "tool_definitions_estimated_tokens",
  "question_estimated_tokens",
  "cached_tokens_in",
  // Provider usage blocks.
  "input_tokens",
  "output_tokens",
  "prompt_tokens",
  "completion_tokens",
  "promptTokenCount",
  "candidatesTokenCount",
  "prompt_eval_count",
  "eval_count",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
]);

const MAX_BYTES = 64 * 1024;
const HEAD_BYTES = 8 * 1024;
const REDACTED = "[redacted]";

/** True when a key looks sensitive AND is not a known count. */
export function isSensitiveKey(key: string): boolean {
  if (COUNT_KEYS.has(key)) return false;
  return SENSITIVE_KEY.test(key);
}

/** Recursively replace sensitive-keyed values with "[redacted]". */
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      // A count-shaped key is not permission to persist an arbitrary string or object.
      out[key] = COUNT_KEYS.has(key)
        ? v === null || (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) ? v : REDACTED
        : isSensitiveKey(key) ? REDACTED : redact(v);
    }
    return out;
  }
  return value;
}

/**
 * Redact sensitive keys, then cap the serialized size at 64 KB. Returns a
 * JSON-serializable value safe to persist in `llm_raw`.
 */
export function redactAndCap(raw: unknown): unknown {
  const redacted = redact(raw);
  let serialized: string;
  try {
    serialized = JSON.stringify(redacted) ?? "null";
  } catch {
    // Non-serializable (cycles, BigInt, …) — store a marker rather than throwing.
    return { truncated: true, bytes: 0, head: "[unserializable provider response]" };
  }
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > MAX_BYTES) {
    // Slice by bytes, not characters, so multibyte content can't overshoot the head cap.
    const head = Buffer.from(serialized, "utf8").subarray(0, HEAD_BYTES).toString("utf8");
    return { truncated: true, bytes, head };
  }
  return redacted;
}
