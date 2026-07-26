/**
 * Tests for the harness event stream (Plan 4 §1).
 *
 * Scope note, stated because it matters: the gapless-under-concurrency guarantee (D-H3)
 * lives in the `append_harness_event` plpgsql function, so a Node test with a fake client
 * cannot prove it — a fake that allocates sequences correctly only proves the fake does.
 * What IS tested here is everything the TypeScript side is actually responsible for:
 *
 *   - that `appendEvent` never sends a sequence number (sequencing is not its business),
 *   - that a credential planted in a payload cannot survive an append (D-H6),
 *   - that `input_hash` is canonical — key order cannot change the digest,
 *   - that `verifySequence` catches gaps and duplicates,
 *   - that the happy path throws on an unrecordable event while error paths do not (D-H8).
 *
 * The DB-side concurrency guarantee is verified against the live Postgres function by
 * `scripts/harness-proof.ts` (milestone H3), which appends from parallel steps for real.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  appendEvent,
  readEvents,
  tryAppendEvent,
  verifySequence,
} from "@/lib/harness/events";
import { sha256Json } from "@/lib/audit";
import type { HarnessEvent } from "@/lib/types";

/* -------------------------------------------------------------------------- */
/* A fake that emulates the RPC contract: it allocates the sequence itself     */
/* (as Postgres does) and records the exact args it was handed, so a test can  */
/* assert on what the module sent rather than on what the fake did with it.    */
/* -------------------------------------------------------------------------- */

type Row = Record<string, unknown>;

let rows: Row[] = [];
let rpcCalls: { fn: string; args: Row }[] = [];
let rpcError: string | null = null;

function fakeDb(): SupabaseClient {
  return {
    rpc: (fn: string, args: Row) => {
      rpcCalls.push({ fn, args });
      const result = () => {
        if (rpcError) return { data: null, error: { message: rpcError } };
        const wf = args.p_workflow_id;
        const seq =
          rows.filter((r) => r.workflow_id === wf).reduce(
            (max, r) => Math.max(max, r.sequence_number as number),
            0,
          ) + 1;
        const row: Row = {
          id: `ev-${rows.length + 1}`,
          workflow_id: wf,
          step_id: args.p_step_id,
          step_key: args.p_step_key,
          sequence_number: seq,
          event_type: args.p_event_type,
          actor: args.p_actor,
          payload: args.p_payload,
          provider_used: args.p_provider_used,
          model_used: args.p_model_used,
          input_hash: args.p_input_hash,
          created_at: new Date(2026, 0, 1, 0, 0, rows.length).toISOString(),
        };
        rows.push(row);
        return { data: row, error: null };
      };
      return { single: () => Promise.resolve(result()) };
    },
    from: () => {
      const filters: [string, unknown][] = [];
      const gt: [string, number][] = [];
      let inFilter: [string, unknown[]] | null = null;
      const run = () => {
        let out = rows.filter((r) => filters.every(([c, v]) => r[c] === v));
        for (const [c, v] of gt) out = out.filter((r) => (r[c] as number) > v);
        if (inFilter) out = out.filter((r) => inFilter![1].includes(r[inFilter![0]]));
        out = [...out].sort(
          (a, b) => (a.sequence_number as number) - (b.sequence_number as number),
        );
        return { data: out, error: null };
      };
      const q: Record<string, unknown> = {};
      Object.assign(q, {
        select: () => q,
        eq: (c: string, v: unknown) => {
          filters.push([c, v]);
          return q;
        },
        gt: (c: string, v: number) => {
          gt.push([c, v]);
          return q;
        },
        in: (c: string, v: unknown[]) => {
          inFilter = [c, v];
          return q;
        },
        order: () => q,
        then: (resolve: (x: unknown) => void) => resolve(run()),
      });
      return q;
    },
  } as unknown as SupabaseClient;
}

const db = fakeDb();
const WF = "wf-1";

beforeEach(() => {
  rows = [];
  rpcCalls = [];
  rpcError = null;
});

describe("appendEvent", () => {
  it("routes through the RPC and never sends a sequence number (D-H3)", async () => {
    await appendEvent(db, { workflowId: WF, eventType: "step_started", actor: "system" });

    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe("append_harness_event");
    // Sequencing is Postgres's job. If a caller could pass one, parallel steps would race.
    const argNames = Object.keys(rpcCalls[0].args);
    expect(argNames.some((k) => /sequence/i.test(k))).toBe(false);
  });

  it("returns the stored row with the DB-allocated sequence", async () => {
    const first = await appendEvent(db, {
      workflowId: WF,
      eventType: "step_started",
      actor: "system",
    });
    const second = await appendEvent(db, {
      workflowId: WF,
      eventType: "action_proposed",
      actor: "agent",
    });

    expect(first.sequence_number).toBe(1);
    expect(second.sequence_number).toBe(2);
  });

  it("sequences each workflow independently", async () => {
    await appendEvent(db, { workflowId: "wf-a", eventType: "step_started", actor: "system" });
    await appendEvent(db, { workflowId: "wf-b", eventType: "step_started", actor: "system" });
    const a2 = await appendEvent(db, {
      workflowId: "wf-a",
      eventType: "step_completed",
      actor: "system",
    });

    expect(a2.sequence_number).toBe(2);
  });

  it("carries provider/model only when passed, so usage aggregation can filter", async () => {
    const bookkeeping = await appendEvent(db, {
      workflowId: WF,
      eventType: "step_started",
      actor: "system",
    });
    const llmGenerated = await appendEvent(db, {
      workflowId: WF,
      eventType: "action_proposed",
      actor: "agent",
      providerUsed: "anthropic",
      modelUsed: "claude-sonnet-4-6",
    });

    expect(bookkeeping.provider_used).toBeNull();
    expect(bookkeeping.model_used).toBeNull();
    expect(llmGenerated.provider_used).toBe("anthropic");
    expect(llmGenerated.model_used).toBe("claude-sonnet-4-6");
  });

  it("throws when the event cannot be recorded (D-H8)", async () => {
    // Load-bearing: if the trail can't record what is about to happen, the harness must
    // not proceed to do it. A swallowed append here is an unaudited action later.
    rpcError = "connection reset";
    await expect(
      appendEvent(db, { workflowId: WF, eventType: "action_executed", actor: "agent" }),
    ).rejects.toThrow(/append_harness_event.*failed|appendEvent\(action_executed\) failed/);
  });
});

describe("payload hygiene (D-H6)", () => {
  it("redacts a planted credential rather than storing it", async () => {
    const row = await appendEvent(db, {
      workflowId: WF,
      eventType: "action_proposed",
      actor: "agent",
      payload: {
        action_type: "match_transactions",
        api_key: "sk-ant-PLANTED-SECRET",
        nested: { authorization: "Bearer PLANTED-TOKEN" },
      },
    });

    const serialized = JSON.stringify(row.payload);
    expect(serialized).not.toContain("PLANTED-SECRET");
    expect(serialized).not.toContain("PLANTED-TOKEN");
    expect(serialized).toContain("[redacted]");
    // Non-sensitive content survives — redaction must not gut the trace.
    expect(serialized).toContain("match_transactions");
  });

  it("stores null for an absent payload so `payload is null` stays meaningful in SQL", async () => {
    const row = await appendEvent(db, {
      workflowId: WF,
      eventType: "step_started",
      actor: "system",
    });
    expect(row.payload).toBeNull();
  });

  it("caps an oversized payload instead of refusing the append", async () => {
    const row = await appendEvent(db, {
      workflowId: WF,
      eventType: "observation_received",
      actor: "system",
      payload: { blob: "x".repeat(100 * 1024) },
    });
    expect((row.payload as { truncated?: boolean }).truncated).toBe(true);
  });
});

describe("input_hash", () => {
  it("is the canonical hash of the consumed input", async () => {
    const input = { rows: [1, 2, 3], source: "erp_export" };
    const row = await appendEvent(db, {
      workflowId: WF,
      eventType: "step_started",
      actor: "system",
      inputForHash: input,
    });
    expect(row.input_hash).toBe(sha256Json(input));
  });

  it("is independent of key order — tamper-evidence must not depend on serialization", async () => {
    const a = await appendEvent(db, {
      workflowId: WF,
      eventType: "step_started",
      actor: "system",
      inputForHash: { alpha: 1, beta: 2 },
    });
    const b = await appendEvent(db, {
      workflowId: WF,
      eventType: "step_started",
      actor: "system",
      inputForHash: { beta: 2, alpha: 1 },
    });
    expect(a.input_hash).toBe(b.input_hash);
  });

  it("is null when the event consumed no input", async () => {
    const row = await appendEvent(db, {
      workflowId: WF,
      eventType: "workflow_resumed",
      actor: "human",
    });
    expect(row.input_hash).toBeNull();
  });
});

describe("tryAppendEvent", () => {
  it("returns null instead of throwing, so an error path can't mask its own cause", async () => {
    rpcError = "connection reset";
    const result = await tryAppendEvent(db, {
      workflowId: WF,
      eventType: "step_failed",
      actor: "system",
    });
    expect(result).toBeNull();
  });
});

describe("readEvents", () => {
  beforeEach(async () => {
    await appendEvent(db, { workflowId: WF, eventType: "step_started", actor: "system" });
    await appendEvent(db, { workflowId: WF, eventType: "action_proposed", actor: "agent" });
    await appendEvent(db, { workflowId: WF, eventType: "action_verified", actor: "system" });
    await appendEvent(db, { workflowId: "wf-other", eventType: "step_started", actor: "system" });
  });

  it("returns one workflow's events in sequence order", async () => {
    const events = await readEvents(db, WF);
    expect(events.map((e) => e.sequence_number)).toEqual([1, 2, 3]);
    expect(events.every((e) => e.workflow_id === WF)).toBe(true);
  });

  it("supports incremental reads for the live view", async () => {
    const events = await readEvents(db, WF, { sinceSequence: 1 });
    expect(events.map((e) => e.event_type)).toEqual(["action_proposed", "action_verified"]);
  });

  it("filters by event type", async () => {
    const events = await readEvents(db, WF, { eventTypes: ["action_proposed"] });
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe("action_proposed");
  });
});

describe("verifySequence", () => {
  const ev = (n: number): HarnessEvent =>
    ({ sequence_number: n }) as HarnessEvent;

  it("accepts a gapless run starting at 1", () => {
    expect(verifySequence([ev(1), ev(2), ev(3)]).intact).toBe(true);
  });

  it("accepts an empty stream", () => {
    expect(verifySequence([]).intact).toBe(true);
  });

  it("reports a gap — rows deleted despite the revoked grant", () => {
    const result = verifySequence([ev(1), ev(3)]);
    expect(result.intact).toBe(false);
    expect(result.reason).toMatch(/expected sequence 2/);
  });

  it("reports a duplicate — the unique constraint was dropped", () => {
    expect(verifySequence([ev(1), ev(1)]).intact).toBe(false);
  });

  it("reports a stream that does not start at 1", () => {
    expect(verifySequence([ev(2), ev(3)]).intact).toBe(false);
  });
});
