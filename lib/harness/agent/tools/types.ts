/**
 * The tool contract (Plan 5 §5, D-G19) — SWE-agent's ACI principles as a type.
 *
 * The paper's finding is that interface design mattered more than model choice. Its four
 * principles are load-bearing here, and each shows up as a field or a rule:
 *
 *   1. **Simplicity.** Seven tools. The registry is a closed list and adding an eighth should
 *      feel expensive.
 *   2. **Compact actions.** `query_ledger` filters, groups and aggregates in one call, so the
 *      agent makes real progress per turn instead of assembling a join over five.
 *   3. **Informative feedback.** Every result carries `summary` (one line the agent can reason
 *      over without re-parsing `data`) and, when a result is empty or suspicious, `hint` (what to
 *      try instead). A tool returning `{}` on no match is a dead end the agent cannot escape.
 *   4. **Guardrails against cascading errors.** A bad argument comes back as `ok: false` with a
 *      correctable message. It is never a thrown error, because a throw ends the turn and teaches
 *      the agent nothing.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { PlainJsonSchema } from "@/lib/llm/json-schema";
import type { LedgerRow, OrgDatasets } from "@/lib/harness/agent/datasets";
import type { ProposedAction, WorkflowRowType } from "@/lib/types";

/**
 * What every tool returns.
 *
 * `ok: false` is a NORMAL outcome, not an exception: it is how a tool says "that argument was
 * wrong, here is what to do instead" in a form the model can act on next turn.
 */
export interface ToolResultEnvelope {
  ok: boolean;
  /** One line the agent can reason over without re-parsing `data`. Always present. */
  summary: string;
  data?: unknown;
  /** What to try next. Present whenever a result is empty, truncated, or a rejection. */
  hint?: string;
  /** Set when the result was capped. NEVER silent — see D-G19. */
  truncated?: boolean;
  total?: number;
  showing?: number;
}

/** Everything a tool may reach. Deliberately narrow — no router, no provider, no LLM. */
export interface ToolContext {
  db: SupabaseClient;
  orgId: string;
  workflowId: string;
  workflowType: WorkflowRowType;
  /** Loaded once per investigation and shared across turns. */
  datasets: OrgDatasets;
  /** Convenience view of `datasets.rows`. */
  rows: LedgerRow[];
  /**
   * The turn this call belongs to.
   *
   * Only `recommend_action` uses it, and only to stamp the events it appends — without it an
   * `action_proposed` lands on the trail with a null turn and the transcript cannot group it
   * with the tool call that produced it. Mutated by the loop between turns rather than rebuilt,
   * so the context object stays identity-stable across a run.
   */
  turn: number;
  /**
   * Recommendations queued so far this run, so `recommend_action` is idempotent within a turn
   * and the loop can report them on the answer.
   */
  recommendations: { action: ProposedAction; status: string }[];
}

export interface AgentTool {
  name: string;
  description: string;
  parameters: PlainJsonSchema;
  /**
   * Tools never throw. The loop wraps a throw as a failed observation anyway, but a tool that
   * relies on that has given up its chance to say something useful to the model.
   */
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResultEnvelope>;
}

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                              */
/* -------------------------------------------------------------------------- */

export function fail(summary: string, hint: string): ToolResultEnvelope {
  return { ok: false, summary, hint };
}

export function empty(summary: string, hint: string): ToolResultEnvelope {
  return { ok: true, summary, data: [], hint };
}

/** Cents → a readable amount for `summary` lines. Display only; never used in arithmetic. */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${(abs / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Apply a result cap and say so explicitly.
 *
 * Silent truncation is the failure mode this exists to prevent: an agent that receives 50 of 4820
 * rows and is not told will compute a total from 50 and state it with confidence.
 */
export function capRows<T>(
  rows: T[],
  limit: number,
): { rows: T[]; truncated: boolean; total: number; showing: number } {
  const showing = Math.min(rows.length, limit);
  return {
    rows: rows.slice(0, limit),
    truncated: rows.length > limit,
    total: rows.length,
    showing,
  };
}

/** ISO date validity, checked here so a tool can return a correctable message. */
export function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function isIsoMonth(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}$/.test(value);
}

/** A compact projection of a row for a tool result — full rows would blow the context budget. */
export function projectRow(row: LedgerRow): Record<string, unknown> {
  return {
    sourceId: row.sourceId,
    dataset: row.dataset,
    date: row.date,
    period: row.period,
    description: row.description,
    counterparty: row.counterparty,
    department: row.department,
    category: row.category,
    amountCents: row.amountCents,
    reference: row.reference,
  };
}
