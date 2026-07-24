/**
 * Raw-response redaction + capping for `workflow_steps.llm_raw` (Plan 2 §D-P11).
 *
 * Every LLM step stores the provider's full response for the audit trail, but only
 * AFTER this pass:
 *   1. Any object key case-insensitively matching /api[-_]?key|authorization|token/
 *      has its value replaced with "[redacted]" (recursively).
 *   2. If the redacted value serializes to more than 64 KB it is replaced by
 *      { truncated: true, bytes: <n>, head: <first 8 KB of the serialization> }.
 *
 * Usage metadata (tokens, latency, provider, model) lives in dedicated columns, NOT
 * inside llm_raw (D-P12), so aggregation stays a plain SQL query.
 */

const SENSITIVE_KEY = /api[-_]?key|authorization|token/i;
const MAX_BYTES = 64 * 1024;
const HEAD_BYTES = 8 * 1024;
const REDACTED = "[redacted]";

/** Recursively replace sensitive-keyed values with "[redacted]". */
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(v);
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
