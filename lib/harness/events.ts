/**
 * The harness event stream (Plan 4 §1, D-H2 … D-H6) — the ONLY history of a run.
 *
 * This module is the sole writer of `harness_events`. Nothing else inserts into that
 * table and nothing else calls `append_harness_event`; every other view of a run's past
 * (the live step cards, the Harness Trace, the audit certificate, the usage dashboard) is
 * a read through `readEvents`.
 *
 * Three deliberate properties:
 *
 *   - **Sequencing belongs to Postgres** (D-H3). Callers cannot pass a sequence number.
 *     Parallel steps of one workflow append concurrently, so allocating `max+1` in Node
 *     would race; the DB function takes a row lock on the parent workflow and allocates
 *     atomically. `appendEvent` therefore never retries on a sequence collision, because
 *     one cannot happen — if it ever does, the unique constraint surfaces it as a loud
 *     error rather than a silently reordered audit trail.
 *
 *   - **Payloads cannot carry a credential** (D-H6). Structurally, a decrypted API key
 *     never reaches this module: keys live only inside `resolveProvider → invoke →
 *     provider` frames and `ResolvedProvider` is never serialized. `sanitizePayload` is a
 *     defence-in-depth backstop over that guarantee, not the guarantee itself.
 *
 *   - **Appends are append-only** (D-H4). There is no `updateEvent` here and no UPDATE
 *     grant in the database. Correcting the record means appending to it.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { redactAndCap } from "@/lib/llm/redact";
import { sha256Json } from "@/lib/audit";
import type { HarnessEvent, HarnessEventType, HarnessActor } from "@/lib/types";

export interface AppendEventArgs {
  workflowId: string;
  eventType: HarnessEventType;
  actor: HarnessActor;
  /** Present for step-scoped events; null for workflow-level ones. */
  stepId?: string | null;
  /** The DAG step key. Always known to the loop even when the step row id is not. */
  stepKey?: string | null;
  payload?: unknown;
  /** Set ONLY on events an LLM generated (D-H13); null distinguishes bookkeeping. */
  providerUsed?: string | null;
  modelUsed?: string | null;
  /**
   * SHA-256 of the canonical JSON of the input this event consumed. Pass `inputForHash`
   * instead to have it computed here.
   */
  inputHash?: string | null;
  /** Convenience: hash this value into `input_hash` (canonical, key-sorted). */
  inputForHash?: unknown;
  /**
   * The id of the event that caused this one (Plan 5, D-G9). A `tool_returned` cites its
   * `tool_called`. The DB rejects a cause belonging to a different workflow, so a mis-threaded
   * trail fails loudly instead of quietly pointing somewhere else.
   */
  causedBy?: string | null;
  /** Which agent-loop iteration this belongs to; null for pipeline events (D-G10). */
  turnNumber?: number | null;
}

/**
 * Append exactly one event and return the stored row (including its allocated
 * `sequence_number`).
 *
 * Throws on a DB error. That is intentional and load-bearing: if the audit trail cannot
 * record what is about to happen, the harness must not proceed to do it. Callers that
 * genuinely must not fail on an append (the failure paths in `loop.ts`, which are already
 * handling an error) use `tryAppendEvent`.
 */
export async function appendEvent(
  db: SupabaseClient,
  args: AppendEventArgs,
): Promise<HarnessEvent> {
  const inputHash =
    args.inputHash ??
    (args.inputForHash === undefined ? null : sha256Json(args.inputForHash));

  const { data, error } = await db
    .rpc("append_harness_event", {
      p_workflow_id: args.workflowId,
      p_event_type: args.eventType,
      p_actor: args.actor,
      p_step_id: args.stepId ?? null,
      p_step_key: args.stepKey ?? null,
      p_payload: sanitizePayload(args.payload),
      p_provider_used: args.providerUsed ?? null,
      p_model_used: args.modelUsed ?? null,
      p_input_hash: inputHash,
      p_caused_by: args.causedBy ?? null,
      p_turn_number: args.turnNumber ?? null,
    })
    .single<HarnessEvent>();

  if (error || !data) {
    throw new Error(
      `appendEvent(${args.eventType}) failed: ${error?.message ?? "no row returned"}`,
    );
  }
  return data;
}

/**
 * Best-effort append for paths already handling a failure, where throwing would mask the
 * original error. Returns null if the append itself failed.
 *
 * Use this ONLY on error paths. On the happy path an unrecordable event must fail the
 * step — an action that executed without an event is exactly the hole this design exists
 * to close.
 */
export async function tryAppendEvent(
  db: SupabaseClient,
  args: AppendEventArgs,
): Promise<HarnessEvent | null> {
  try {
    return await appendEvent(db, args);
  } catch {
    return null;
  }
}

/** Read a workflow's stream in order — the primitive every projection is built on. */
export async function readEvents(
  db: SupabaseClient,
  workflowId: string,
  opts: { sinceSequence?: number; eventTypes?: HarnessEventType[] } = {},
): Promise<HarnessEvent[]> {
  let query = db
    .from("harness_events")
    .select("*")
    .eq("workflow_id", workflowId)
    .order("sequence_number", { ascending: true });

  if (opts.sinceSequence !== undefined) {
    query = query.gt("sequence_number", opts.sinceSequence);
  }
  if (opts.eventTypes && opts.eventTypes.length > 0) {
    query = query.in("event_type", opts.eventTypes);
  }

  const { data, error } = await query;
  if (error) throw new Error(`readEvents failed: ${error.message}`);
  return (data ?? []) as HarnessEvent[];
}

/**
 * Assert the stream is gapless and strictly increasing from 1 — the tamper-evidence
 * check the audit certificate runs before it will render (D-H2/D-H4). A gap means rows
 * were deleted despite the revoked grant; a duplicate means the unique constraint was
 * dropped. Either way the certificate must say so rather than present a clean summary.
 */
export function verifySequence(events: HarnessEvent[]): {
  intact: boolean;
  reason?: string;
} {
  for (let i = 0; i < events.length; i++) {
    const expected = i + 1;
    if (events[i].sequence_number !== expected) {
      return {
        intact: false,
        reason: `expected sequence ${expected} at position ${i}, found ${events[i].sequence_number}`,
      };
    }
  }
  return { intact: true };
}

/**
 * Redact sensitive keys and cap the size of a payload before it is stored.
 *
 * Reuses `redactAndCap` so the denylist and the 64 KB cap have exactly one definition
 * shared with `workflow_steps.llm_raw` (D-P11) — two divergent redaction rules would mean
 * a key redacted in one column and stored in the other. Returns null for an absent
 * payload so `payload is null` stays meaningful in SQL.
 */
function sanitizePayload(payload: unknown): unknown {
  if (payload === undefined || payload === null) return null;
  return redactAndCap(payload);
}
