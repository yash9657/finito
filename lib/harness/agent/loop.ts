/**
 * The investigator agent loop (Plan 5 §5/§7, D-G1/D-G22).
 *
 * The one place in FinFlow where the model chooses what happens next. It is a sibling of
 * `lib/harness/loop.ts`, not a fork of it: `executeStep` runs a KNOWN action through
 * propose → verify → execute → observe, while this runs an UNKNOWN sequence of reads and then
 * routes anything consequential back through that same machinery via `recommend_action`.
 *
 * Every turn:
 *
 *     agent_turn_started
 *       → dispatchTools()                     (the model decides)
 *       → agent_reasoning                     (if it said anything)
 *       → tool_called      ×N                 (caused_by the turn)
 *       → tool_returned    ×N                 (caused_by its tool_called)
 *       → [context_compacted]                 (when the window demands it)
 *       → agent_answered | agent_terminated   (eventually, always)
 *
 * ## Three properties that are structural rather than hoped for
 *
 * 1. **It always terminates, and always says why.** Four bounds plus loop detection, each
 *    producing `agent_terminated` with a reason and whatever was found so far, labelled partial.
 *    There is no path that stops silently.
 *
 * 2. **It cannot change anything.** The only tool with consequences queues a proposal for a
 *    human. There is no execute path from this file to a mutation, and adding one would mean
 *    adding a tool — which is the closed list in `tools/index.ts`.
 *
 * 3. **Its numbers are not its own.** The final answer's figures are recomputed in TypeScript
 *    from cited rows before the answer exists (`answer.ts`).
 */

import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { appendEvent, tryAppendEvent } from "@/lib/harness/events";
import { dispatchTools, resolveInvestigatorModel } from "@/lib/llm/router";
import {
  assistantMessage,
  toolResultMessage,
  userMessage,
  type CanonicalMessage,
  type ToolCall,
  type ToolResult,
} from "@/lib/llm/messages";
import { loadOrgDatasets, type OrgDatasets } from "@/lib/harness/agent/datasets";
import { lookupTool, toolDefinitionsForRole } from "@/lib/harness/agent/tools";
import type { ToolContext } from "@/lib/harness/agent/tools/types";
import { compact, shouldCompact, trimToolResult, type ContextDigest } from "@/lib/harness/agent/context";
import { answerSchema, correctionMessage, validateAnswer, type RawAnswer } from "@/lib/harness/agent/answer";
import { buildSystemPrompt, DIGEST_SYSTEM, FINAL_ANSWER_INSTRUCTION } from "@/lib/harness/agent/prompt";
import { INVESTIGATION_TYPE, type InvestigationAnswer, type InvestigationBudget, type ProposedAction, type TerminationReason } from "@/lib/types";

/* -------------------------------------------------------------------------- */
/* Budget (D-G22)                                                              */
/* -------------------------------------------------------------------------- */

export const DEFAULT_BUDGET: InvestigationBudget = {
  maxTurns: 20,
  maxTokens: 300_000,
  maxWallClockMs: 5 * 60_000,
  maxToolCallsPerTurn: 5,
  // Low on purpose. An investigation's job is to find the thing that needs a decision, not to
  // hand a person a worklist — see the note on the field.
  maxRecommendations: 5,
};

/**
 * The ceilings. NOT org-configurable, by design.
 *
 * An org can tighten any of these; it cannot loosen them. An open-ended loop on a metered API is
 * a cost incident waiting to happen, and "the operator can raise the limit" is not a bound — it
 * is a bound with a hole in it, and the hole is exactly where a runaway run goes.
 */
export const BUDGET_CEILINGS: InvestigationBudget = {
  maxTurns: 40,
  maxTokens: 1_000_000,
  maxWallClockMs: 15 * 60_000,
  maxToolCallsPerTurn: 8,
  maxRecommendations: 10,
};

export function clampBudget(requested: Partial<InvestigationBudget> = {}): InvestigationBudget {
  const merged = { ...DEFAULT_BUDGET, ...requested };
  return {
    maxTurns: clamp(merged.maxTurns, 1, BUDGET_CEILINGS.maxTurns),
    maxTokens: clamp(merged.maxTokens, 1_000, BUDGET_CEILINGS.maxTokens),
    maxWallClockMs: clamp(merged.maxWallClockMs, 10_000, BUDGET_CEILINGS.maxWallClockMs),
    maxToolCallsPerTurn: clamp(merged.maxToolCallsPerTurn, 1, BUDGET_CEILINGS.maxToolCallsPerTurn),
    maxRecommendations: clamp(merged.maxRecommendations, 0, BUDGET_CEILINGS.maxRecommendations),
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

/* -------------------------------------------------------------------------- */
/* Public shape                                                                */
/* -------------------------------------------------------------------------- */

export interface RunInvestigationArgs {
  db: SupabaseClient;
  workflowId: string;
  orgId: string;
  question: string;
  budget?: Partial<InvestigationBudget>;
  /** Injected by tests and the proof script so they need no Storage round trip. */
  datasets?: OrgDatasets;
}

export interface InvestigationOutcome {
  status: "answered" | "terminated" | "failed";
  reason: TerminationReason;
  answer: InvestigationAnswer | null;
  turnsUsed: number;
  tokensIn: number;
  tokensOut: number;
  recommendations: { action: ProposedAction; status: string }[];
  /** Populated when the run could not start at all — a provider or capability problem. */
  error?: string;
}

/** The same tool with the same arguments this many times is a stuck agent (D-G22). */
const REPEAT_LIMIT = 3;
/** Consecutive refused-because-repeated turns before we give up on it correcting itself. */
const CONSECUTIVE_LOOP_LIMIT = 3;

/* -------------------------------------------------------------------------- */
/* The loop                                                                    */
/* -------------------------------------------------------------------------- */

export async function runInvestigation(
  args: RunInvestigationArgs,
): Promise<InvestigationOutcome> {
  const { db, workflowId, orgId, question } = args;
  const budget = clampBudget(args.budget);
  const startedAt = Date.now();

  let turnsUsed = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  const recommendations: { action: ProposedAction; status: string }[] = [];

  const finish = async (
    status: InvestigationOutcome["status"],
    reason: TerminationReason,
    answer: InvestigationAnswer | null,
    detail?: string,
  ): Promise<InvestigationOutcome> => {
    // Best-effort: this path may already be handling a failure, and an append error must not
    // replace the real cause (the same reasoning as `tryAppendEvent` in loop.ts).
    await tryAppendEvent(db, {
      workflowId,
      eventType: reason === "answered" ? "agent_answered" : "agent_terminated",
      actor: "agent",
      turnNumber: turnsUsed,
      payload: {
        reason,
        detail: detail ?? null,
        partial: answer?.partial ?? answer === null,
        turns_used: turnsUsed,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        wall_clock_ms: Date.now() - startedAt,
        recommendations: recommendations.length,
        ...(answer ? { citations: answer.citations.length, figures: answer.figures.length } : {}),
      },
    });
    return { status, reason, answer, turnsUsed, tokensIn, tokensOut, recommendations, error: detail };
  };

  /* ---- 0. Can we start at all? (D-G16) ---------------------------------- */
  // Before turn 1, not after twenty. A model that cannot call a tool produces one clear message
  // naming it, rather than a budget's worth of prose and an empty answer.
  const resolution = await resolveInvestigatorModel(db, {
    orgId,
    workflowType: INVESTIGATION_TYPE,
  });
  if (!resolution.ok) {
    return finish("failed", "no_tool_support", null, resolution.reason);
  }
  const { capabilities } = resolution;

  /* ---- 1. Load the org's data once -------------------------------------- */
  let datasets: OrgDatasets;
  try {
    datasets = args.datasets ?? (await loadOrgDatasets(db, orgId));
  } catch (err) {
    return finish(
      "failed",
      "error",
      null,
      `Could not load the organization's data: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const toolCtx: ToolContext = {
    db,
    orgId,
    workflowId,
    workflowType: INVESTIGATION_TYPE,
    datasets,
    rows: datasets.rows,
    recommendations,
    turn: 0,
  };

  const tools = toolDefinitionsForRole("investigator");
  const systemPrompt = buildSystemPrompt({
    question,
    budget,
    datasetCount: datasets.summaries.length,
    parallelToolCalls: capabilities.parallelToolCalls,
  });

  let messages: CanonicalMessage[] = [userMessage(question)];

  // (toolName + canonical args) → how many times it has been called. Canonical JSON so argument
  // key order cannot disguise a repeat.
  const callCounts = new Map<string, number>();
  let consecutiveLoopWarnings = 0;

  /* ---- 2. Turns ---------------------------------------------------------- */
  for (let turn = 1; turn <= budget.maxTurns; turn++) {
    // Bounds are checked at the TOP of the turn, so an over-budget run never issues one more
    // request "just to finish" — which is how a hard ceiling turns into a soft one.
    if (Date.now() - startedAt > budget.maxWallClockMs) {
      return finish("terminated", "max_wall_clock", await bestEffortAnswer(), wallClockDetail(budget));
    }
    if (tokensIn + tokensOut > budget.maxTokens) {
      return finish("terminated", "max_tokens", await bestEffortAnswer(), tokenDetail(budget, tokensIn + tokensOut));
    }

    turnsUsed = turn;
    // Tools stamp their own events with this (see ToolContext.turn).
    toolCtx.turn = turn;

    /* ---- 2a. Compaction, if the window demands it (D-G22) ---------------- */
    if (shouldCompact(messages, systemPrompt, capabilities.contextWindow)) {
      const result = await compact(messages, systemPrompt, (toSummarize) =>
        summarizeForDigest(db, orgId, toSummarize),
      );
      if (result.compacted) {
        messages = result.messages;
        await appendEvent(db, {
          workflowId,
          eventType: "context_compacted",
          actor: "system",
          turnNumber: turn,
          payload: {
            dropped_messages: result.droppedMessages,
            estimated_tokens_before: result.estimatedTokensBefore,
            estimated_tokens_after: result.estimatedTokensAfter,
            // The rule that keeps a compacted answer provable (D-G22).
            preserved_source_ids: result.preservedSourceIds.length,
            context_window: capabilities.contextWindow,
          },
        });
      }
    }

    const turnEvent = await appendEvent(db, {
      workflowId,
      eventType: "agent_turn_started",
      actor: "agent",
      turnNumber: turn,
      payload: {
        turn,
        max_turns: budget.maxTurns,
        messages_in_context: messages.length,
        tokens_so_far: tokensIn + tokensOut,
      },
    });

    /* ---- 2b. Ask the model ------------------------------------------------ */
    let response;
    try {
      response = await dispatchTools(db, {
        orgId,
        workflowType: INVESTIGATION_TYPE,
        role: "investigator",
        stepKey: "investigate",
        system: systemPrompt,
        conversation: messages,
        tools,
        // Serialized when the model cannot do parallel calls (D-G16): letting it return several
        // would mean executing calls it could not have reasoned about together.
        toolChoice: "auto",
      });
    } catch (err) {
      return finish(
        "failed",
        "provider_error",
        await bestEffortAnswer(),
        err instanceof Error ? err.message : String(err),
      );
    }

    tokensIn += response.meta.tokensIn;
    tokensOut += response.meta.tokensOut;

    // Provider reasoning state that could not travel (D-G13). Said out loud, never swallowed.
    for (const dropped of response.droppedSidecars) {
      await appendEvent(db, {
        workflowId,
        eventType: "provider_state_dropped",
        actor: "system",
        turnNumber: turn,
        causedBy: turnEvent.id,
        payload: {
          from_provider: dropped.providerId,
          to_provider: response.meta.providerId,
          messages_affected: dropped.count,
          note:
            "Provider-specific reasoning state cannot be replayed across providers. The " +
            "conversation continues correctly without it.",
        },
      });
    }

    if (response.content.trim().length > 0) {
      await appendEvent(db, {
        workflowId,
        eventType: "agent_reasoning",
        actor: "agent",
        turnNumber: turn,
        causedBy: turnEvent.id,
        payload: { text: response.content },
        providerUsed: response.meta.providerId,
        modelUsed: response.meta.modelUsed,
      });
    }

    /* ---- 2c. No tool calls means the model is ready to answer ------------- */
    if (response.toolCalls.length === 0) {
      const answered = await requestFinalAnswer({
        db,
        workflowId,
        orgId,
        turn,
        messages,
        systemPrompt,
        tools,
        rows: datasets.rows,
        partial: false,
        onTokens: (i, o) => {
          tokensIn += i;
          tokensOut += o;
        },
      });
      if (answered.ok) {
        return finish("answered", "answered", answered.answer, undefined);
      }
      // The model could not produce a citable answer even after one correction. Terminating with
      // its prose as a partial is more useful than nothing, and honest about what it is.
      return finish("terminated", "error", answered.fallback, answered.detail);
    }

    /* ---- 2d. Execute the calls -------------------------------------------- */
    const calls = response.toolCalls.slice(0, budget.maxToolCallsPerTurn);
    const dropped = response.toolCalls.length - calls.length;

    const results: ToolResult[] = [];
    let loopBroken = false;

    for (const call of calls) {
      const signature = `${call.name}:${canonicalJson(call.arguments)}`;
      const seen = (callCounts.get(signature) ?? 0) + 1;
      callCounts.set(signature, seen);

      // Loop detection: refuse the third identical call and TELL the model why, so it can
      // correct. A silent break would look to the model like a tool that stopped working.
      if (seen >= REPEAT_LIMIT) {
        loopBroken = true;
        results.push({
          toolCallId: call.id,
          name: call.name,
          isError: true,
          content: JSON.stringify({
            ok: false,
            summary: `Refused: you have already called ${call.name} with these exact arguments ${
              seen - 1
            } times.`,
            hint:
              "Repeating a call cannot produce a different result. Change the arguments, use a " +
              "different tool, or answer with what you have.",
          }),
        });
        await recordToolCall(db, workflowId, turn, turnEvent.id, call, response.meta, {
          refused: "repeated_call",
          repeat_count: seen,
        });
        continue;
      }

      const calledEvent = await recordToolCall(
        db,
        workflowId,
        turn,
        turnEvent.id,
        call,
        response.meta,
        {},
      );

      // The recommendation cap (D-G22). Enforced HERE, not in the prompt: the real run that
      // motivated it had a prompt telling the agent to recommend only when confident, and it
      // queued fifteen anyway. A bound a model can talk itself past is not a bound.
      if (call.name === "recommend_action" && recommendations.length >= budget.maxRecommendations) {
        const payload = {
          ok: false,
          summary:
            `Refused: this investigation has already queued its limit of ` +
            `${budget.maxRecommendations} recommendations.`,
          hint:
            "A reviewer can only give real attention to a handful of proposals. Describe any " +
            "further candidates in your final answer as things worth looking at, rather than " +
            "queueing them.",
        };
        results.push({
          toolCallId: call.id,
          name: call.name,
          isError: true,
          content: JSON.stringify(payload),
        });
        await recordToolCall(db, workflowId, turn, turnEvent.id, call, response.meta, {
          refused: "recommendation_limit",
          limit: budget.maxRecommendations,
        });
        continue;
      }

      const tool = lookupTool("investigator", call.name);
      if (!tool) {
        // Not reachable through a well-behaved provider — we only declare tools from this list —
        // but a salvaged call could name anything, so it is handled rather than assumed away.
        const payload = {
          ok: false,
          summary: `No such tool: "${call.name}".`,
          hint: `Available tools: ${tools.map((t) => t.name).join(", ")}.`,
        };
        results.push({
          toolCallId: call.id,
          name: call.name,
          isError: true,
          content: JSON.stringify(payload),
        });
        await recordToolReturn(db, workflowId, turn, calledEvent.id, call, payload, 0);
        continue;
      }

      const toolStarted = Date.now();
      let payload: unknown;
      try {
        payload = await tool.run(call.arguments, toolCtx);
      } catch (err) {
        // A tool that throws is a bug in the tool, but the loop must not die of it — the agent
        // gets a correctable message and the trail gets the error.
        payload = {
          ok: false,
          summary: `The ${call.name} tool failed: ${err instanceof Error ? err.message : String(err)}`,
          hint: "Try a different tool, or answer with what you already have.",
        };
      }
      const durationMs = Date.now() - toolStarted;

      const full = JSON.stringify(payload);
      // The trail keeps everything; the model gets a bounded excerpt (D-G22).
      await recordToolReturn(db, workflowId, turn, calledEvent.id, call, payload, durationMs);
      results.push({ toolCallId: call.id, name: call.name, content: trimToolResult(full) });
    }

    if (dropped > 0) {
      // Every call must be answered or the next request is malformed, so the over-cap ones get
      // an explicit refusal rather than being silently omitted.
      for (const call of response.toolCalls.slice(budget.maxToolCallsPerTurn)) {
        results.push({
          toolCallId: call.id,
          name: call.name,
          isError: true,
          content: JSON.stringify({
            ok: false,
            summary: `Not run: this turn exceeded the limit of ${budget.maxToolCallsPerTurn} tool calls.`,
            hint: "Call it on the next turn if you still need it.",
          }),
        });
      }
    }

    consecutiveLoopWarnings = loopBroken ? consecutiveLoopWarnings + 1 : 0;
    if (consecutiveLoopWarnings >= CONSECUTIVE_LOOP_LIMIT) {
      return finish(
        "terminated",
        "loop_detected",
        await bestEffortAnswer(),
        `The agent repeated identical tool calls across ${CONSECUTIVE_LOOP_LIMIT} consecutive ` +
          `turns after being told why they were refused.`,
      );
    }

    messages = [
      ...messages,
      assistantMessage(response.content, response.toolCalls, response.sidecar),
      toolResultMessage(results),
    ];
  }

  /* ---- 3. Out of turns --------------------------------------------------- */
  return finish(
    "terminated",
    "max_turns",
    await bestEffortAnswer(),
    `Reached the ${budget.maxTurns}-turn limit.`,
  );

  /* ---- Helpers that close over the run ----------------------------------- */

  /**
   * Ask for an answer even though the budget is spent.
   *
   * A partial answer that says it is partial beats a silent stop: the user asked a question, and
   * "here is what I found before running out of turns" is a real result. One extra model call is
   * a deliberate, bounded overshoot of the turn budget — the token and wall-clock bounds still
   * apply, and it is far cheaper than the run so far.
   */
  async function bestEffortAnswer(): Promise<InvestigationAnswer | null> {
    if (messages.length <= 1) return null;
    try {
      const answered = await requestFinalAnswer({
        db,
        workflowId,
        orgId,
        turn: turnsUsed,
        messages,
        systemPrompt,
        tools,
        rows: datasets.rows,
        partial: true,
        onTokens: (i, o) => {
          tokensIn += i;
          tokensOut += o;
        },
      });
      return answered.ok ? answered.answer : answered.fallback;
    } catch {
      // Already terminating; a failure here must not mask the reason we are here.
      return null;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* The final answer                                                            */
/* -------------------------------------------------------------------------- */

interface FinalAnswerArgs {
  db: SupabaseClient;
  workflowId: string;
  orgId: string;
  turn: number;
  messages: CanonicalMessage[];
  systemPrompt: string;
  tools: ReturnType<typeof toolDefinitionsForRole>;
  rows: Parameters<typeof validateAnswer>[1];
  partial: boolean;
  onTokens: (tokensIn: number, tokensOut: number) => void;
}

type FinalAnswerResult =
  | { ok: true; answer: InvestigationAnswer }
  | { ok: false; fallback: InvestigationAnswer | null; detail: string };

/**
 * Ask for the structured answer, validate it, and allow ONE correction.
 *
 * The same shape as `callWithPostValidation` in reconciliation.ts, and for the same reason: a
 * model that still cannot cite correctly after being told exactly what was wrong will not
 * succeed on a third attempt, and each attempt is a full generation.
 */
async function requestFinalAnswer(args: FinalAnswerArgs): Promise<FinalAnswerResult> {
  const { db, orgId, rows, partial } = args;
  let conversation: CanonicalMessage[] = [
    ...args.messages,
    userMessage(FINAL_ANSWER_INSTRUCTION(partial)),
  ];
  let lastProse = "";

  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await dispatchTools(db, {
      orgId,
      workflowType: INVESTIGATION_TYPE,
      role: "investigator",
      stepKey: "investigate_answer",
      system: args.systemPrompt,
      conversation,
      // No tools on the answering turn: the model has had its investigation and this is the
      // write-up. Offering tools here invites another round of exploration past the budget.
      tools: [],
      toolChoice: "none",
    });
    args.onTokens(response.meta.tokensIn, response.meta.tokensOut);
    lastProse = response.content || lastProse;

    const parsed = parseAnswer(response.content);
    if (!parsed) {
      conversation = [
        ...conversation,
        assistantMessage(response.content),
        userMessage(
          "That was not valid JSON matching the required answer shape. Return ONLY a JSON " +
            "object with keys: prose, findings, figures, citations.",
        ),
      ];
      continue;
    }

    const validation = validateAnswer(parsed, rows, { partial });
    if (validation.ok) return { ok: true, answer: validation.answer };

    if (attempt === 1) {
      return {
        ok: false,
        fallback: unvalidatedFallback(lastProse),
        detail: `The answer failed citation validation twice: ${validation.problems.join("; ")}`,
      };
    }
    conversation = [
      ...conversation,
      assistantMessage(response.content),
      userMessage(correctionMessage(validation.problems)),
    ];
  }

  return {
    ok: false,
    fallback: unvalidatedFallback(lastProse),
    detail: "Exhausted answer attempts.",
  };
}

/**
 * What we return when validation could not be satisfied.
 *
 * Deliberately marked `partial` and carrying NO figures or citations, whatever the model wrote.
 * Surfacing unvalidated numbers as though they were checked would be the exact failure D-G14
 * exists to prevent — so the prose is shown as the agent's unverified narrative and nothing in
 * it is presented as a FinFlow figure.
 */
function unvalidatedFallback(prose: string): InvestigationAnswer | null {
  const text = prose.trim();
  if (text.length === 0) return null;
  return {
    prose:
      "[UNVERIFIED — this answer could not be validated against source data, so any figures in " +
      "it have NOT been recomputed by FinFlow and should not be relied on.]\n\n" +
      text,
    proseTemplate: text,
    findings: [],
    figures: [],
    citations: [],
    // Always partial, regardless of why we got here: an answer that failed validation is by
    // definition not the complete, verified answer the product promises.
    partial: true,
  };
}

/** Pull the answer object out of a response that may be fenced or surrounded by prose. */
function parseAnswer(content: string): RawAnswer | null {
  const candidates: string[] = [];
  const trimmed = content.trim();
  candidates.push(trimmed);

  const fence = /```(?:json)?\s*\n?([\s\S]*?)```/i.exec(content);
  if (fence) candidates.push(fence[1].trim());

  const first = content.indexOf("{");
  const last = content.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(content.slice(first, last + 1));

  for (const candidate of candidates) {
    try {
      const parsed = answerSchema.safeParse(JSON.parse(candidate));
      if (parsed.success) return parsed.data;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Compaction's summarizer                                                     */
/* -------------------------------------------------------------------------- */

const digestSchema = z.object({
  findings: z.array(z.string()),
  ruledOut: z.array(z.string()),
  keyFigures: z.array(
    z.object({
      label: z.string(),
      valueCents: z.number().nullable(),
      sourceIds: z.array(z.string()),
    }),
  ),
  openQuestions: z.array(z.string()),
});

/** The digest call. Same router, same role, so it is attributed and budgeted like any other. */
async function summarizeForDigest(
  db: SupabaseClient,
  orgId: string,
  toSummarize: CanonicalMessage[],
): Promise<ContextDigest> {
  const transcript = toSummarize
    .map((m) => {
      if (m.role === "tool") {
        return (m.toolResults ?? [])
          .map((r) => `TOOL ${r.name} →\n${r.content.slice(0, 2000)}`)
          .join("\n");
      }
      const calls = (m.toolCalls ?? [])
        .map((c) => `CALL ${c.name}(${JSON.stringify(c.arguments)})`)
        .join("\n");
      return [m.role.toUpperCase(), m.content, calls].filter(Boolean).join("\n");
    })
    .join("\n\n");

  const response = await dispatchTools(db, {
    orgId,
    workflowType: INVESTIGATION_TYPE,
    role: "investigator",
    stepKey: "investigate_compact",
    system: DIGEST_SYSTEM,
    conversation: [userMessage(transcript)],
    tools: [],
    toolChoice: "none",
  });

  try {
    const first = response.content.indexOf("{");
    const last = response.content.lastIndexOf("}");
    const json = first >= 0 && last > first ? response.content.slice(first, last + 1) : response.content;
    const parsed = digestSchema.safeParse(JSON.parse(json));
    if (parsed.success) return parsed.data;
  } catch {
    // fall through
  }
  // A digest we cannot parse must not lose the turns silently. An empty structured digest still
  // carries the preserved source ids (added by `renderDigest`), which is the part that matters.
  return { findings: [], ruledOut: [], keyFigures: [], openQuestions: [] };
}

/* -------------------------------------------------------------------------- */
/* Event helpers                                                               */
/* -------------------------------------------------------------------------- */

async function recordToolCall(
  db: SupabaseClient,
  workflowId: string,
  turn: number,
  causedBy: string,
  call: ToolCall,
  meta: { providerId: string; modelUsed: string },
  extra: Record<string, unknown>,
) {
  return appendEvent(db, {
    workflowId,
    eventType: "tool_called",
    actor: "agent",
    turnNumber: turn,
    causedBy,
    payload: {
      tool: call.name,
      tool_call_id: call.id,
      arguments: call.arguments,
      // Never silent (D-G17): a rising salvage rate is the signal that a local model is unfit,
      // and it can only be a signal if it is on the event.
      salvaged: call.salvaged ?? false,
      ...(call.salvageStrategy ? { salvage_strategy: call.salvageStrategy } : {}),
      ...extra,
    },
    providerUsed: meta.providerId,
    modelUsed: meta.modelUsed,
    inputForHash: { tool: call.name, arguments: call.arguments },
  });
}

async function recordToolReturn(
  db: SupabaseClient,
  workflowId: string,
  turn: number,
  causedBy: string,
  call: ToolCall,
  payload: unknown,
  durationMs: number,
) {
  const envelope = payload as { ok?: boolean; summary?: string; truncated?: boolean; total?: number };
  return appendEvent(db, {
    workflowId,
    eventType: "tool_returned",
    actor: "system",
    turnNumber: turn,
    // The OpenHands cause linkage (D-G9): this observation answers THAT action, which is the
    // only way to pair them when a turn issues several calls in parallel.
    causedBy,
    payload: {
      tool: call.name,
      tool_call_id: call.id,
      ok: envelope?.ok ?? false,
      summary: envelope?.summary ?? null,
      duration_ms: durationMs,
      truncated_for_model: envelope?.truncated ?? false,
      total_rows: envelope?.total ?? null,
      // The FULL result — the trail's job, distinct from the model's excerpt (D-G22).
      result: payload,
    },
  });
}

/* -------------------------------------------------------------------------- */

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

function wallClockDetail(budget: InvestigationBudget): string {
  return `Reached the ${Math.round(budget.maxWallClockMs / 1000)}s wall-clock limit.`;
}

function tokenDetail(budget: InvestigationBudget, spent: number): string {
  return `Reached the ${budget.maxTokens.toLocaleString()}-token limit (spent ${spent.toLocaleString()}).`;
}
