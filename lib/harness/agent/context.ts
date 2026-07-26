/**
 * Context management for a long investigation (Plan 5 §7, D-G22).
 *
 * A 40-turn investigation over financial data blows a context window on tool results alone. Two
 * separate mechanisms, because the trail and the context window have different jobs and sharing
 * one size limit between them optimizes neither:
 *
 *   - **Trimming** happens per tool result: `harness_events` gets the full payload (capped only
 *     by the existing 64 KB `redactAndCap`), and the model gets a bounded excerpt that SAYS it is
 *     an excerpt. An auditor needs every row; the model needs enough to reason.
 *
 *   - **Compaction** happens per conversation: when the estimate crosses a fraction of the
 *     model's window, the oldest turns become a structured digest and the recent ones stay.
 *
 * ## The one rule compaction may not break
 *
 * **Never compact away a source citation.** The final answer has to prove its numbers against
 * real rows (D-G1/D-G14), and a digest that dropped the ids would leave the agent able to
 * remember a finding but not to evidence it — which produces exactly the confident, uncitable
 * answer the whole design exists to prevent. So every source id seen in a dropped turn is carried
 * forward verbatim, and the digest is built around them rather than summarizing over them.
 */

import { estimateTokens, type CanonicalMessage } from "@/lib/llm/messages";

/** Compact when the estimate crosses this fraction of the window. */
const COMPACT_AT_FRACTION = 0.7;

/** Turns kept verbatim after a compaction — enough for the model to keep its immediate thread. */
const KEEP_RECENT_MESSAGES = 6;

/** Characters of a tool result the model sees. The event keeps the whole thing. */
export const TOOL_RESULT_EXCERPT_CHARS = 6_000;

/** Source ids look like `wf:abc12345/erp_export/erp-001`. */
const SOURCE_ID_PATTERN = /\bwf:[0-9a-f]{8}\/[a-z_]+\/[A-Za-z0-9-]+/g;

export interface CompactionResult {
  messages: CanonicalMessage[];
  compacted: boolean;
  /** What was dropped, for the `context_compacted` event. */
  droppedMessages: number;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  preservedSourceIds: string[];
}

/**
 * Trim a tool result for the model, stating the trim.
 *
 * The stated truncation is not politeness: an agent handed a silently-cut JSON payload will
 * either parse what it got as complete, or waste a turn discovering it is not.
 */
export function trimToolResult(full: string, limit = TOOL_RESULT_EXCERPT_CHARS): string {
  if (full.length <= limit) return full;
  const kept = full.slice(0, limit);
  return (
    `${kept}\n\n[TRUNCATED: showing the first ${limit.toLocaleString()} of ` +
    `${full.length.toLocaleString()} characters. The full result is on the audit trail. Narrow ` +
    `your filters, or use get_transactions with an offset, to see the rest.]`
  );
}

/** Should we compact before the next turn? */
export function shouldCompact(
  messages: CanonicalMessage[],
  systemPrompt: string,
  contextWindow: number,
): boolean {
  return estimateTokens(messages, systemPrompt) > contextWindow * COMPACT_AT_FRACTION;
}

/** Every source id mentioned anywhere in a set of messages, deduplicated, in first-seen order. */
export function extractSourceIds(messages: CanonicalMessage[]): string[] {
  const seen = new Set<string>();
  for (const msg of messages) {
    const haystacks = [
      msg.content,
      ...(msg.toolCalls ?? []).map((c) => JSON.stringify(c.arguments)),
      ...(msg.toolResults ?? []).map((r) => r.content),
    ];
    for (const text of haystacks) {
      for (const match of text.matchAll(SOURCE_ID_PATTERN)) seen.add(match[0]);
    }
  }
  return [...seen];
}

/**
 * The digest an LLM is asked to produce for the compacted turns.
 *
 * Structured rather than free prose so the important parts cannot be summarized away: findings,
 * what has been RULED OUT (which is what stops the agent re-investigating a dead end for the
 * second half of its budget), key figures with their ids, and open questions.
 */
export interface ContextDigest {
  findings: string[];
  ruledOut: string[];
  keyFigures: { label: string; valueCents: number | null; sourceIds: string[] }[];
  openQuestions: string[];
}

/** How the digest is rendered back into the conversation as a single user turn. */
export function renderDigest(digest: ContextDigest, preservedSourceIds: string[]): string {
  const lines: string[] = [
    "[EARLIER TURNS COMPACTED — this is a summary of the investigation so far.]",
    "",
  ];

  if (digest.findings.length > 0) {
    lines.push("Findings so far:");
    for (const f of digest.findings) lines.push(`  - ${f}`);
    lines.push("");
  }
  if (digest.ruledOut.length > 0) {
    lines.push("Already ruled out (do not re-investigate these):");
    for (const r of digest.ruledOut) lines.push(`  - ${r}`);
    lines.push("");
  }
  if (digest.keyFigures.length > 0) {
    lines.push("Key figures (cite these source ids; do not restate the numbers from memory):");
    for (const f of digest.keyFigures) {
      lines.push(
        `  - ${f.label}: ${f.valueCents === null ? "(see sources)" : `${f.valueCents}c`} ` +
          `[${f.sourceIds.join(", ")}]`,
      );
    }
    lines.push("");
  }
  if (digest.openQuestions.length > 0) {
    lines.push("Still open:");
    for (const q of digest.openQuestions) lines.push(`  - ${q}`);
    lines.push("");
  }

  // The rule that keeps a compacted answer provable. Every id seen is carried, whether or not
  // the summarizer thought it mattered — a citation is cheap and an uncitable finding is useless.
  if (preservedSourceIds.length > 0) {
    lines.push(
      "All source ids referenced so far (still valid to cite):",
      preservedSourceIds.map((id) => `  ${id}`).join("\n"),
      "",
    );
  }

  return lines.join("\n");
}

/**
 * Compact a conversation.
 *
 * `summarize` produces the digest — it is injected rather than called directly so this module
 * stays pure and testable, and so the loop keeps ownership of every model call (the D-H8
 * invariant: no LLM call happens outside the loop).
 *
 * The FIRST message is always kept: it is the question, and an investigation that forgets what
 * it was asked will answer something adjacent and plausible.
 */
export async function compact(
  messages: CanonicalMessage[],
  systemPrompt: string,
  summarize: (toSummarize: CanonicalMessage[]) => Promise<ContextDigest>,
): Promise<CompactionResult> {
  const before = estimateTokens(messages, systemPrompt);

  // Keep the question, drop the middle, keep the recent tail.
  const head = messages.slice(0, 1);
  const tailStart = Math.max(1, messages.length - KEEP_RECENT_MESSAGES);
  const middle = messages.slice(1, tailStart);
  const tail = messages.slice(tailStart);

  if (middle.length === 0) {
    // Nothing droppable. Compacting further would mean cutting into the recent window or the
    // question itself, and both are worse than a long context — the loop's token bound is the
    // backstop that stops this becoming unbounded.
    return {
      messages,
      compacted: false,
      droppedMessages: 0,
      estimatedTokensBefore: before,
      estimatedTokensAfter: before,
      preservedSourceIds: [],
    };
  }

  const preservedSourceIds = extractSourceIds(middle);
  const digest = await summarize(middle);

  const digestMessage: CanonicalMessage = {
    role: "user",
    content: renderDigest(digest, preservedSourceIds),
  };

  // A `tool` message whose matching assistant tool_call was dropped is an orphan every provider
  // rejects. Dropping the whole middle and rebuilding from the digest is what avoids that; the
  // tail is trimmed to start at a clean boundary for the same reason.
  const cleanTail = dropOrphanToolResults(tail);
  const out = [...head, digestMessage, ...cleanTail];

  return {
    messages: out,
    compacted: true,
    droppedMessages: middle.length,
    estimatedTokensBefore: before,
    estimatedTokensAfter: estimateTokens(out, systemPrompt),
    preservedSourceIds,
  };
}

/**
 * Drop leading `tool` messages whose originating assistant turn is no longer present.
 *
 * Anthropic rejects a `tool_result` with no preceding `tool_use`; OpenAI rejects a `role:'tool'`
 * message with no matching `tool_call_id`. Either is a hard 400 mid-investigation, which is a
 * miserable way to discover a compaction boundary was off by one.
 */
function dropOrphanToolResults(tail: CanonicalMessage[]): CanonicalMessage[] {
  let start = 0;
  const known = new Set<string>();
  for (const msg of tail) {
    for (const call of msg.toolCalls ?? []) known.add(call.id);
  }
  while (start < tail.length && tail[start].role === "tool") {
    const results = tail[start].toolResults ?? [];
    if (results.every((r) => known.has(r.toolCallId))) break;
    start++;
  }
  return tail.slice(start);
}
