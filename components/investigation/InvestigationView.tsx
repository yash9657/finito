"use client";
import Link from "next/link";
import { ArrowLeft, RefreshCw, ExternalLink, Download } from "lucide-react";
import ApprovalPanel from "@/components/workflow/ApprovalPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TranscriptView } from "@/components/investigation/TranscriptView";
import { QuestionComposer } from "@/components/investigation/QuestionComposer";
import { useInvestigation } from "@/lib/hooks/useInvestigation";
import { formatCents } from "@/lib/format";
import type { InvestigationAnswer, WorkflowRow } from "@/lib/types";

export function InvestigationView({ id }: { id: string }) {
  const { data, error, isLoading, subscribed, refetch } = useInvestigation(id);
  if (isLoading && !data)
    return (
      <div className="page-container" role="status">
        <h1 className="page-title">Loading conversation…</h1>
        <p className="page-description">
          Retrieving the answer and its evidence.
        </p>
      </div>
    );
  if (!data)
    return (
      <div className="page-container space-y-5">
        <h1 className="page-title">Conversation unavailable</h1>
        <p role="alert" className="text-sm text-error">
          {error?.message ?? "This question could not be found."}
        </p>
        <Button onClick={refetch}>Try again</Button>
        <Link
          className="ml-4 text-sm text-muted underline"
          href="/investigations"
        >
          Back to your questions
        </Link>
      </div>
    );
  const { investigation, workflow, events, actions } = data;
  const live = investigation.status === "running";
  const visibleTurns = Math.max(
    investigation.turns_used,
    ...events.map((e) => e.turn_number ?? 0),
  );
  const all = new Map(
    (data.conversation ?? []).map((item) => [item.workflow_id, item]),
  );
  const previous: NonNullable<typeof data.conversation> = [];
  const seen = new Set<string>();
  let cursor = investigation.parent_workflow_id;
  while (cursor && !seen.has(cursor) && previous.length < 30) {
    seen.add(cursor);
    const item = all.get(cursor);
    if (!item) break;
    previous.unshift(item);
    cursor = item.parent_workflow_id;
  }
  const workflowRow: WorkflowRow = {
    ...workflow,
    type: "reconciliation",
    status: workflow.status as WorkflowRow["status"],
    error_message: null,
  };
  return (
    <div className="page-container space-y-8">
      <header>
        <Link
          href="/investigations"
          className="mb-3 inline-flex min-h-11 items-center gap-2 text-sm text-muted hover:text-foreground"
        >
          <ArrowLeft size={16} />
          All conversations
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="page-title">Follow the evidence</h1>
          <Badge
            variant={
              live
                ? "running"
                : investigation.status === "answered"
                  ? "accent"
                  : investigation.status === "failed"
                    ? "error"
                    : "warning"
            }
          >
            {live
              ? "Analysing"
              : investigation.status === "answered"
                ? "Answered"
                : investigation.status === "failed"
                  ? "Needs attention"
                  : "Partial answer"}
          </Badge>
        </div>
      </header>
      {error && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 text-sm text-warning"
        >
          <span>Updates interrupted. {error.message}</span>
          <Button variant="ghost" onClick={refetch}>
            Retry
          </Button>
        </div>
      )}
      <div className="conversation-layout">
        <section className="min-w-0 space-y-8" aria-label="Conversation">
          {previous.map((item) => (
            <section key={item.workflow_id} className="conversation-turn">
              <p className="mb-4 whitespace-pre-wrap break-words text-lg font-medium leading-relaxed">
                {item.question}
              </p>
              {item.answer ? (
                <AnswerContent answer={item.answer} />
              ) : (
                <p className="text-sm text-muted">
                  This earlier question ended without an answer.
                </p>
              )}
              <Link
                href={`/investigations/${item.workflow_id}`}
                className="mt-4 inline-flex min-h-11 items-center gap-2 text-xs text-muted"
              >
                View this question’s activity <ExternalLink size={13} />
              </Link>
            </section>
          ))}
          <section className="conversation-turn" aria-label="Current question">
            <h2 className="mb-5 whitespace-pre-wrap break-words text-xl font-medium leading-relaxed">
              {investigation.question}
            </h2>
            {live && !investigation.answer && (
              <div role="status" className="py-5">
                <div className="flex items-center gap-3 text-sm">
                  <span className="size-2 rounded-full bg-running motion-safe:animate-pulse" />
                  Inspecting sources and testing the analysis
                </div>
                <p className="mt-3 text-sm text-muted">
                  {visibleTurns > 0 ? `${visibleTurns} steps recorded. ` : ""}
                  You can inspect the activity as it runs.
                </p>
              </div>
            )}
            {investigation.answer ? (
              <AnswerContent answer={investigation.answer} />
            ) : (
              !live && (
                <div className="space-y-3">
                  <p className="text-sm text-warning">
                    No answer was produced.{" "}
                    {investigation.termination_reason?.replace(/_/g, " ")}
                  </p>
                  <p className="text-sm text-muted">
                    Check the activity for the failure, then ask a more specific
                    question below or review your model settings.
                  </p>
                  <Link
                    href="/settings/models"
                    className="inline-flex min-h-11 items-center text-sm text-accent"
                  >
                    Models & usage
                  </Link>
                </div>
              )
            )}
          </section>
          {actions.length > 0 && (
            <ApprovalPanel
              workflow={workflowRow}
              actions={actions}
              canReview={data.viewer?.canReview ?? false}
              onDecided={refetch}
            />
          )}
          <QuestionComposer
            key={id}
            parentId={id}
            sourceIds={investigation.source_ids}
            disabled={live}
          />
        </section>
        <aside className="min-w-0 space-y-6">
          <section className="border-y border-border py-5">
            <h2 className="text-base font-medium">Analysis record</h2>
            <dl className="mt-4 space-y-3 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="text-muted">Steps</dt>
                <dd className="font-mono">{visibleTurns}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted">Tokens used</dt>
                <dd className="font-mono">
                  {(
                    investigation.tokens_in + investigation.tokens_out
                  ).toLocaleString()}
                </dd>
              </div>
            </dl>
            <p className="mt-5 text-xs leading-relaxed text-muted">
              {live
                ? subscribed
                  ? "Activity updates live."
                  : "Checking for updates periodically."
                : "Sources, tool results, and calculations are recorded with this question."}
            </p>
            <Button variant="ghost" className="mt-2" onClick={refetch}>
              <RefreshCw size={14} className="mr-2" />
              Refresh record
            </Button>
          </section>
          <details className="activity-disclosure" open={live || undefined}>
            <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium">
              Agent activity{" "}
              <span className="ml-2 text-xs text-muted">
                {events.length} events
              </span>
            </summary>
            <TranscriptView
              events={events}
              live={live}
              subscribed={subscribed}
            />
          </details>
        </aside>
      </div>
    </div>
  );
}

function sourceLink(id: string) {
  const raw = /^src:([^/]+)\/(t\d+)\/r(\d+)$/.exec(id);
  if (raw)
    return `/data?source=${encodeURIComponent(raw[1])}&table=${raw[2]}&row=${raw[3]}`;
  const wf = /^wf:([^/]+)\//.exec(id);
  return wf ? `/workflows/${encodeURIComponent(wf[1])}` : null;
}
function sourceLabel(id: string) {
  const raw = /^src:([^/]+)\/(t\d+)\/r(\d+)$/.exec(id);
  return raw
    ? `Source ${raw[1].slice(0, 8)} · table ${Number(raw[2].slice(1)) + 1} · row ${raw[3]}`
    : id;
}
function AnswerContent({ answer }: { answer: InvestigationAnswer }) {
  return (
    <div className="space-y-6">
      {answer.partial && (
        <p className="text-sm text-warning">
          Partial answer. The analysis reached a limit; review what remains
          unanswered.
        </p>
      )}
      <p className="max-w-[72ch] whitespace-pre-wrap break-words text-base leading-7">
        {answer.prose}
      </p>
      {answer.figures.length > 0 && (
        <section>
          <h3 className="mb-3 text-sm font-medium">
            Figures recomputed from source rows
          </h3>
          <dl className="divide-y divide-border border-y border-border">
            {answer.figures.map((figure) => (
              <div
                key={figure.ref}
                className="flex flex-col justify-between gap-2 py-3 sm:flex-row"
              >
                <dt className="text-sm">
                  {figure.label}
                  <span className="mt-1 block text-xs text-muted">
                    {figure.operation} · {figure.sourceIds.length} source rows
                    {figure.column ? ` · ${figure.column}` : ""}
                  </span>
                </dt>
                <dd className="break-words font-mono text-base">
                  {figure.decimalValue !== undefined
                    ? figure.decimalValue
                    : figure.operation === "count"
                      ? figure.value
                      : formatCents(figure.valueCents ?? 0)}
                  {figure.decimalValue !== undefined && (
                    <span className="ml-2 font-sans text-xs text-muted">
                      source units
                    </span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      {(answer.analyses ?? []).map((analysis) => (
        <section key={analysis.id} className="border-y border-border py-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-base font-medium">{analysis.title}</h3>
            <Button
              variant="ghost"
              aria-label={`Download ${analysis.title} as JSON`}
              onClick={() => {
                const url = URL.createObjectURL(
                  new Blob([JSON.stringify(analysis, null, 2)], {
                    type: "application/json",
                  }),
                );
                const a = document.createElement("a");
                a.href = url;
                a.download = "finflow-analysis.json";
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              }}
            >
              <Download size={15} className="mr-2" />
              JSON
            </Button>
          </div>
          <p className="mb-4 text-xs leading-relaxed text-muted">
            Computed with agent-written code. Check the method, source coverage,
            and units before relying on the result.
          </p>
          <AnalysisOutput value={analysis.output} />
          {analysis.warnings.length > 0 && (
            <ul className="mt-4 space-y-2 text-sm text-warning">
              {analysis.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
          <details className="mt-4">
            <summary className="min-h-11 cursor-pointer py-3 text-sm text-muted">
              Method and source coverage
            </summary>
            <ul className="mb-4 space-y-2 text-xs text-muted">
              {analysis.inputs.map((input, i) => (
                <li key={i} className="break-words">
                  {input.filename} · {input.tableId} · {input.rowCount} of{" "}
                  {input.totalRows} rows · starts at offset {input.offset}
                </li>
              ))}
            </ul>
            <pre className="code-evidence">
              <code>{analysis.code}</code>
            </pre>
            <p className="mt-2 break-all font-mono text-xs text-muted">
              SHA-256 {analysis.codeHash}
            </p>
          </details>
        </section>
      ))}
      {answer.citations.length > 0 && (
        <details>
          <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium">
            Sources{" "}
            <span className="ml-2 text-muted">{answer.citations.length}</span>
          </summary>
          <ul className="divide-y divide-border">
            {answer.citations.map((citation, i) => (
              <li key={`${citation.sourceId}-${i}`} className="py-3 text-sm">
                <p className="mb-2 leading-relaxed text-muted">
                  {citation.note}
                </p>
                {sourceLink(citation.sourceId) ? (
                  <Link
                    href={sourceLink(citation.sourceId)!}
                    className="inline-flex min-h-11 items-center break-all text-xs text-accent underline"
                  >
                    {sourceLabel(citation.sourceId)}
                  </Link>
                ) : (
                  <span className="break-all font-mono text-xs">
                    {citation.sourceId}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
function AnalysisOutput({
  value,
  depth = 0,
}: {
  value: unknown;
  depth?: number;
}) {
  const cell = (entry: unknown) => {
    if (typeof entry === "string" && sourceLink(entry))
      return (
        <Link
          href={sourceLink(entry)!}
          className="inline-flex min-h-11 items-center text-accent underline underline-offset-4"
        >
          {sourceLabel(entry)}
        </Link>
      );
    if (entry !== null && typeof entry === "object")
      return (
        <details>
          <summary className="cursor-pointer py-2 text-muted">
            View details
          </summary>
          <pre className="code-evidence">{JSON.stringify(entry, null, 2)}</pre>
        </details>
      );
    return String(entry ?? "—");
  };
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((v) => v && typeof v === "object" && !Array.isArray(v))
  ) {
    const columns = Array.from(new Set(value.flatMap((v) => Object.keys(v))));
    return (
      <>
        <div
          className="data-scroll"
          tabIndex={0}
          role="region"
          aria-label="Computed analysis"
        >
          <table className="data-table">
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {value.slice(0, 50).map((row, i) => (
                <tr key={i}>
                  {columns.map((c) => (
                    <td key={c}>{cell(row[c])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {value.length > 50 && (
          <p className="mt-2 text-xs text-muted">
            Showing 50 of {value.length} result rows. Download JSON for the full
            result.
          </p>
        )}
      </>
    );
  }
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    depth < 2
  ) {
    return (
      <dl className="divide-y divide-border">
        {Object.entries(value).map(([key, v]) => (
          <div
            key={key}
            className={`flex min-w-0 flex-col gap-2 py-3 ${v === null || typeof v !== "object" ? "sm:flex-row sm:justify-between" : ""}`}
          >
            <dt className="break-words text-sm text-muted">{key}</dt>
            <dd className="min-w-0 break-words text-sm">
              {v !== null && typeof v === "object" ? (
                <AnalysisOutput value={v} depth={depth + 1} />
              ) : (
                cell(v)
              )}
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  if (Array.isArray(value) && value.length === 0)
    return <p className="py-3 text-sm text-muted">No result rows.</p>;
  if (value === null || typeof value !== "object")
    return <p className="break-words py-3 text-sm">{cell(value)}</p>;
  return (
    <details>
      <summary className="min-h-11 cursor-pointer py-3 text-sm text-muted">
        View structured result
      </summary>
      <pre className="code-evidence">{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}
