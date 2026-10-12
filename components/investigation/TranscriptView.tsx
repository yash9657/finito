"use client";

/**
 * The investigation transcript (Plan 5 §9, G7).
 *
 * The coding-agent terminal-trace analogue, and the thing that makes the feature feel like work
 * being done rather than magic being performed. Three deliberate choices:
 *
 *   1. **Grouped by turn.** `turn_number` exists for this (D-G10). A flat list of forty events is
 *      unreadable; turns are the unit a person actually reasons about.
 *   2. **Tool results collapsed by default.** The full result is on the trail and available on
 *      click, but a 4,000-row payload expanded inline buries the reasoning that surrounds it.
 *   3. **Parallel calls shown as parallel.** `caused_by` pairs each result with its call
 *      (D-G9), so two calls in one turn render side by side rather than as a misleading
 *      sequence. That is the whole reason the column exists.
 */

import { useId, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Layers,
  Loader2,
  Radio,
  Scissors,
  Terminal,
  Wrench,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { HarnessEvent } from "@/lib/types";

interface Props {
  events: HarnessEvent[];
  live: boolean;
  subscribed: boolean;
}

interface Turn {
  number: number;
  events: HarnessEvent[];
}

/** Group into turns, keeping anything without a turn number in a leading turn 0. */
function toTurns(events: HarnessEvent[]): Turn[] {
  const byTurn = new Map<number, HarnessEvent[]>();
  for (const event of events) {
    const turn = event.turn_number ?? 0;
    const list = byTurn.get(turn);
    if (list) list.push(event);
    else byTurn.set(turn, [event]);
  }
  return [...byTurn.entries()]
    .sort(([a], [b]) => a - b)
    .map(([number, list]) => ({
      number,
      events: list.sort((a, b) => a.sequence_number - b.sequence_number),
    }));
}

export function TranscriptView({ events, live, subscribed }: Props) {
  const turns = toTurns(events);
  const returnsByCause = new Map<string, HarnessEvent>();
  for (const event of events) {
    if (event.event_type === "tool_returned" && event.caused_by)
      returnsByCause.set(event.caused_by, event);
  }

  return (
    <div className="min-w-0 space-y-6">
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
        <Radio
          className={cn(
            "h-3.5 w-3.5",
            subscribed ? "text-accent" : "text-muted",
          )}
        />
        {/* Said out loud rather than left to guess: a transcript that has quietly stopped
            updating looks identical to one whose run has stalled. */}
        {live
          ? subscribed
            ? "Live updates connected"
            : "Reconnecting. Checking for updates every 10 seconds."
          : "Saved activity record"}
        <span className="ml-auto shrink-0">{events.length} events</span>
      </div>

      {turns.map((turn) => (
        <TurnBlock
          key={turn.number}
          turn={turn}
          returnsByCause={returnsByCause}
        />
      ))}

      {live && (
        <div className="flex items-center gap-2 px-3 py-2 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          Working…
        </div>
      )}
    </div>
  );
}

function TurnBlock({
  turn,
  returnsByCause,
}: {
  turn: Turn;
  returnsByCause: Map<string, HarnessEvent>;
}) {
  const calls = turn.events.filter((e) => e.event_type === "tool_called");
  const reasoning = turn.events.filter(
    (e) => e.event_type === "agent_reasoning",
  );
  const other = turn.events.filter(
    (e) =>
      e.event_type !== "tool_called" &&
      e.event_type !== "tool_returned" &&
      e.event_type !== "agent_reasoning" &&
      e.event_type !== "agent_turn_started",
  );

  if (turn.events.length === 0) return null;

  return (
    <div className="min-w-0 border-t border-border">
      <div className="flex flex-wrap items-center gap-3 py-3">
        <span className="text-sm font-medium">
          {turn.number === 0 ? "Preparation" : `Step ${turn.number}`}
        </span>
        {calls.length > 1 && (
          <span className="flex items-center gap-2 text-sm text-muted">
            <Layers className="h-3 w-3" />
            {calls.length} tools used together
          </span>
        )}
        <span className="min-w-0 break-all text-sm text-muted sm:ml-auto">
          {providerOf(turn.events) ?? ""}
        </span>
      </div>

      <div className="min-w-0 space-y-3 pb-4">
        {reasoning.map((event) => (
          <p
            key={event.id}
            className="whitespace-pre-wrap break-words text-sm leading-7"
          >
            {String((event.payload as { text?: string })?.text ?? "")}
          </p>
        ))}

        {calls.length > 0 && (
          <div className="min-w-0 divide-y divide-border">
            {calls.map((call) => (
              <ToolCallCard
                key={call.id}
                call={call}
                result={returnsByCause.get(call.id) ?? null}
              />
            ))}
          </div>
        )}

        {other.map((event) => (
          <SpecialEvent key={event.id} event={event} />
        ))}
      </div>
    </div>
  );
}

function ToolCallCard({
  call,
  result,
}: {
  call: HarnessEvent;
  result: HarnessEvent | null;
}) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const payload = (call.payload ?? {}) as {
    tool?: string;
    arguments?: Record<string, unknown>;
    salvaged?: boolean;
    salvage_strategy?: string;
    refused?: string;
  };
  const resultPayload = (result?.payload ?? {}) as {
    ok?: boolean;
    summary?: string;
    duration_ms?: number;
    truncated_for_model?: boolean;
    total_rows?: number | null;
    result?: unknown;
  };

  const failed = result !== null && resultPayload.ok === false;

  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={detailId}
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-11 w-full items-start gap-2 rounded-md py-3 text-left transition-colors hover:bg-card"
      >
        {open ? (
          <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" />
        ) : (
          <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" />
        )}
        <Wrench className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="break-words text-sm font-medium">
              {payload.tool
                ?.replace(/_/g, " ")
                .replace(/^./, (c) => c.toUpperCase()) ?? "Tool request"}
            </span>
            {payload.salvaged && (
              /* Never silent (D-G17): a rising salvage rate is the signal a local model is
                 not fit for purpose, and a user should be able to see it here. */
              <span
                className="rounded bg-warning/10 px-2 py-1 text-sm text-warning"
                title={`Recovered from malformed model output (${payload.salvage_strategy})`}
              >
                Request repaired
              </span>
            )}
            {payload.refused && (
              <span className="rounded bg-warning/10 px-2 py-1 text-sm text-warning">
                Not run: {payload.refused.replace(/_/g, " ")}
              </span>
            )}
            {result === null && (
              <Loader2 className="h-3 w-3 animate-spin text-muted" />
            )}
          </span>
          {result !== null && (
            <span
              className={cn(
                "mt-1 block break-words text-sm leading-6",
                failed ? "text-warning" : "text-muted",
              )}
            >
              {resultPayload.summary}
            </span>
          )}
        </span>
        {result !== null && (
          <span className="shrink-0 font-mono text-xs text-muted">
            {resultPayload.duration_ms}ms
          </span>
        )}
      </button>

      {open && (
        <div id={detailId} className="min-w-0 space-y-4 pb-4">
          <div>
            <p className="mb-2 text-sm text-muted">Tool inputs</p>
            <pre className="max-h-72 max-w-full overflow-auto rounded-md bg-card p-3 font-mono text-sm leading-6">
              {JSON.stringify(payload.arguments ?? {}, null, 2)}
            </pre>
          </div>
          {result !== null && (
            <div>
              <p className="mb-2 text-sm text-muted">
                Result
                {resultPayload.truncated_for_model && (
                  // The trail keeps the full result; the model saw an excerpt (D-G22). Worth
                  // saying, because the two differ and the difference matters when debugging.
                  <span className="ml-2 text-warning">
                    the model saw a truncated excerpt of this
                    {resultPayload.total_rows
                      ? ` (${resultPayload.total_rows} rows)`
                      : ""}
                  </span>
                )}
              </p>
              <pre className="max-h-72 max-w-full overflow-auto rounded-md bg-card p-3 font-mono text-sm leading-6">
                {JSON.stringify(resultPayload.result ?? {}, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SpecialEvent({ event }: { event: HarnessEvent }) {
  const payload = (event.payload ?? {}) as Record<string, unknown>;

  if (event.event_type === "context_compacted") {
    return (
      <Row icon={<Scissors className="h-3.5 w-3.5" />} tone="muted">
        Summarized {String(payload.dropped_messages)} earlier messages (
        {String(payload.estimated_tokens_before)} →{" "}
        {String(payload.estimated_tokens_after)} estimated tokens).{" "}
        {String(payload.preserved_source_ids)} source citations carried forward.
      </Row>
    );
  }

  if (event.event_type === "provider_state_dropped") {
    return (
      <Row icon={<AlertTriangle className="h-3.5 w-3.5" />} tone="warn">
        Switched from {String(payload.from_provider)} to{" "}
        {String(payload.to_provider)} — {String(payload.messages_affected)}{" "}
        message(s) lost provider-specific reasoning state. The next steps use
        the saved conversation and source records.
      </Row>
    );
  }

  if (event.event_type === "action_proposed") {
    return (
      <Row icon={<Check className="h-3.5 w-3.5" />} tone="accent">
        Recommended{" "}
        <code className="font-mono">{String(payload.action_type)}</code> —{" "}
        {String(payload.queued_status)}
        {payload.mandatory_human_review ? " (human review is mandatory)" : ""}.
        Review it in the approval panel below.
      </Row>
    );
  }

  if (event.event_type === "action_failed_verification") {
    return (
      <Row icon={<AlertTriangle className="h-3.5 w-3.5" />} tone="warn">
        A recommendation was rejected before anyone was asked:{" "}
        {String(payload.reason)}
      </Row>
    );
  }

  if (event.event_type === "agent_terminated") {
    return (
      <Row icon={<AlertTriangle className="h-3.5 w-3.5" />} tone="warn">
        Stopped: {String(payload.reason).replace(/_/g, " ")}
        {payload.detail ? ` — ${String(payload.detail)}` : ""}
      </Row>
    );
  }

  if (event.event_type === "agent_answered") {
    return (
      <Row icon={<Check className="h-3.5 w-3.5" />} tone="accent">
        Answered after {String(payload.turns_used)} steps —{" "}
        {String(payload.citations)} citations, {String(payload.figures)}{" "}
        recomputed figures.
      </Row>
    );
  }

  return (
    <Row icon={<Terminal className="h-3.5 w-3.5" />} tone="muted">
      {event.event_type.replace(/_/g, " ")}
    </Row>
  );
}

function Row({
  icon,
  tone,
  children,
}: {
  icon: React.ReactNode;
  tone: "muted" | "warn" | "accent";
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 py-2 text-sm leading-6",
        tone === "muted" && "text-muted",
        tone === "warn" && "text-warning",
        tone === "accent" && "text-foreground",
      )}
    >
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

function providerOf(events: HarnessEvent[]): string | null {
  const attributed = events.find((e) => Boolean(e.provider_used));
  if (!attributed) return null;
  return [attributed.provider_used, attributed.model_used]
    .filter(Boolean)
    .join(" · ");
}
