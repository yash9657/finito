"use client";

/**
 * The investigation detail view (Plan 5 §9, G7).
 *
 * Three parts, in the order a reader wants them: the answer (what you asked for), the
 * recommendations (what needs you), and the transcript (how it got there).
 *
 * The answer leads even while the run is in progress, where it renders as "working" — putting
 * the transcript first would make the feature look like a log viewer rather than something that
 * answers a question.
 *
 * Recommendations render in the EXISTING `ApprovalPanel` (D-G21). Building a second approval
 * surface for agent-proposed actions would mean two places to review money movement, two sets of
 * grant semantics, and two chances to get four-eyes wrong.
 */

import Link from "next/link";
import { AlertTriangle, ArrowLeft, Coins, FileText, Quote } from "lucide-react";
import ApprovalPanel from "@/components/workflow/ApprovalPanel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { TranscriptView } from "@/components/investigation/TranscriptView";
import { useInvestigation } from "@/lib/hooks/useInvestigation";
import type { WorkflowRow } from "@/lib/types";

export function InvestigationView({ id }: { id: string }) {
  const { data, error, isLoading, subscribed, refetch } = useInvestigation(id);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <Card>
        <CardContent className="flex items-start gap-3 py-6 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 text-amber-500" />
          <span>{error?.message ?? "Investigation not found."}</span>
        </CardContent>
      </Card>
    );
  }

  const { investigation, workflow, events, actions } = data;
  const live = investigation.status === "running";
  const answer = investigation.answer;

  const workflowRow: WorkflowRow = {
    id: workflow.id,
    name: workflow.name,
    // The approval panel is typed for pipeline runs; an investigation reuses its rows verbatim.
    type: "reconciliation",
    status: workflow.status as WorkflowRow["status"],
    error_message: null,
    created_at: workflow.created_at,
    completed_at: workflow.completed_at,
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div>
        <Link
          href="/investigations"
          className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Investigations
        </Link>
        <h1 className="text-xl font-semibold leading-snug">{investigation.question}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
          <StatusBadge status={investigation.status} reason={investigation.termination_reason} />
          <span className="font-mono">
            {investigation.turns_used} turn{investigation.turns_used === 1 ? "" : "s"}
          </span>
          <span className="flex items-center gap-1 font-mono">
            <Coins className="h-3 w-3" />
            {(investigation.tokens_in + investigation.tokens_out).toLocaleString()} tokens
          </span>
        </div>
      </div>

      {/* ---- The answer ---- */}
      <Card>
        <CardHeader className="flex-row items-center gap-2 space-y-0">
          <FileText className="h-4 w-4 text-muted" />
          <CardTitle className="text-sm">Answer</CardTitle>
          {answer?.partial && (
            <Badge variant="warning" className="ml-auto">
              Partial
            </Badge>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          {live && !answer && (
            <p className="text-sm text-muted">Investigating…</p>
          )}
          {!live && !answer && (
            <p className="text-sm text-muted">
              No answer was produced.
              {investigation.termination_reason
                ? ` The run stopped: ${investigation.termination_reason.replace(/_/g, " ")}.`
                : ""}
            </p>
          )}
          {answer && (
            <>
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{answer.prose}</p>

              {answer.figures.length > 0 && (
                <div>
                  <p className="mb-1.5 text-[10px] uppercase tracking-wide text-muted">
                    Figures — recomputed from source rows, not written by the model
                  </p>
                  <div className="space-y-1">
                    {answer.figures.map((figure) => (
                      <div
                        key={figure.ref}
                        className="flex items-baseline gap-2 rounded-md bg-background px-2 py-1.5 text-xs"
                      >
                        <span className="font-medium">{figure.label}</span>
                        <span className="font-mono">
                          {figure.operation === "count"
                            ? figure.value
                            : formatCents(figure.valueCents ?? 0)}
                        </span>
                        <span className="ml-auto font-mono text-[10px] text-muted">
                          {figure.operation} over {figure.sourceIds.length} row
                          {figure.sourceIds.length === 1 ? "" : "s"}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {answer.citations.length > 0 && (
                <div>
                  <p className="mb-1.5 flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted">
                    <Quote className="h-3 w-3" />
                    Sources
                  </p>
                  <ul className="space-y-1">
                    {answer.citations.map((citation) => (
                      <li key={citation.sourceId} className="flex gap-2 text-xs">
                        <code className="shrink-0 font-mono text-[10px] text-muted">
                          {citation.sourceId}
                        </code>
                        <span>{citation.note}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* ---- Recommendations, in the EXISTING panel (D-G21) ---- */}
      {actions.length > 0 && (
        <ApprovalPanel workflow={workflowRow} actions={actions} onDecided={refetch} />
      )}

      {/* ---- How it got there ---- */}
      <div>
        <h2 className="mb-3 text-sm font-medium">Transcript</h2>
        <TranscriptView events={events} live={live} subscribed={subscribed} />
      </div>
    </div>
  );
}

function StatusBadge({
  status,
  reason,
}: {
  status: string;
  reason: string | null;
}) {
  if (status === "running") return <Badge variant="running">Running</Badge>;
  if (status === "answered") return <Badge variant="accent">Answered</Badge>;
  if (status === "failed") return <Badge variant="error">Failed</Badge>;
  return <Badge variant="warning">{reason ? reason.replace(/_/g, " ") : "Stopped"}</Badge>;
}

function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
