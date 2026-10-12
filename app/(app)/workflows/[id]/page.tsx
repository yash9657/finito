"use client";

import { use } from "react";
import { useWorkflowStatus } from "@/lib/hooks/useWorkflowStatus";
import { LiveWorkflowView } from "@/components/workflow/LiveWorkflowView";
import OutputPanel from "@/components/workflow/OutputPanel";
import ApprovalPanel from "@/components/workflow/ApprovalPanel";
import ReviewBanner from "@/components/workflow/ReviewBanner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import type { WorkflowStatus } from "@/lib/types";

/**
 * Live workflow view (PLAN §11.5) — the hero screen.
 *
 * Client component wrapping `useWorkflowStatus(id)` (2s polling while running).
 * Layout: full-height flex column — a slim header, a `grid-cols-[420px_1fr]`
 * body (left execution trace / right deliverable-so-far), and the review banner
 * pinned to the bottom (renders only when awaiting_review / approved / error).
 */

const STATUS_VARIANT: Record<
  WorkflowStatus,
  "muted" | "running" | "warning" | "accent" | "error"
> = {
  idle: "muted",
  running: "running",
  awaiting_approval: "warning",
  awaiting_review: "warning",
  approved: "accent",
  rejected: "error",
  error: "error",
};

const STATUS_LABEL: Record<WorkflowStatus, string> = {
  idle: "Idle",
  running: "Running",
  awaiting_approval: "Awaiting approval",
  awaiting_review: "Awaiting review",
  approved: "Approved",
  rejected: "Rejected",
  error: "Error",
};

function LoadingSkeleton() {
  return (
    <div className="grid min-h-[60vh] lg:grid-cols-[360px_minmax(0,1fr)]">
      <div className="flex flex-col gap-3 border-r border-border p-4">
        <Skeleton className="h-6 w-40" />
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
      <div className="flex flex-col gap-4 p-6">
        <Skeleton className="h-8 w-56" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    </div>
  );
}

export default function WorkflowPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { data, error, isLoading, refetch } = useWorkflowStatus(id);

  if (!data) {
    if (isLoading) return <LoadingSkeleton />;
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-md rounded-lg border border-error/40 bg-error/10 p-6 text-center">
          <p className="font-mono text-sm text-error">
            {error?.message ?? "Failed to load workflow."}
          </p>
          <Button variant="outline" className="mt-4" onClick={refetch}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  const { workflow, steps, review } = data;
  const actions = data.actions ?? [];

  return (
    <div className="flex min-h-[calc(100dvh_-_64px)] flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-3">
        <div className="flex flex-col">
          <h1 className="text-base font-semibold tracking-tight">
            {workflow.name}
          </h1>
          <span className="font-mono text-xs text-muted">
            {
              {
                reconciliation: "Reconciliation",
                ap_matching: "Invoice matching",
                fpa_commentary: "Variance analysis",
                investigation: "Investigation",
              }[workflow.type]
            }
          </span>
        </div>
        <Badge variant={STATUS_VARIANT[workflow.status]}>
          {workflow.status === "running" && (
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-running" />
          )}
          {STATUS_LABEL[workflow.status]}
        </Badge>
      </header>

      {/* Each panel owns its own internal scroll (overflow-hidden here bounds the row
          so an expanded StepCard scrolls inside the panel, not the whole page). */}
      {error && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 border-b border-warning/30 bg-warning/5 px-6 py-3 text-sm text-warning"
        >
          Status could not refresh. Showing the last available result.{" "}
          <Button variant="outline" size="sm" onClick={refetch}>
            Retry
          </Button>
        </div>
      )}
      {workflow.status === "awaiting_approval" && (
        <ApprovalPanel
          canReview={data.viewer?.canReview ?? false}
          workflow={workflow}
          actions={actions}
          steps={steps}
          onDecided={refetch}
        />
      )}
      {workflow.status === "awaiting_approval" ? (
        <details className="m-4 border-t border-border pt-4">
          <summary className="min-h-11 cursor-pointer text-sm text-muted">
            View completed analysis and execution details
          </summary>
          <div className="grid lg:grid-cols-[360px_minmax(0,1fr)]">
            <LiveWorkflowView steps={steps} />
            <OutputPanel workflow={workflow} steps={steps} />
          </div>
        </details>
      ) : (
        <div className="grid min-h-0 flex-1 lg:grid-cols-[360px_minmax(0,1fr)]">
          <div className="min-h-0 min-w-0 border-b border-border lg:border-b-0 lg:border-r">
            <LiveWorkflowView steps={steps} />
          </div>
          <div className="min-h-0 min-w-0 overflow-x-auto">
            <OutputPanel workflow={workflow} steps={steps} />
          </div>
        </div>
      )}
      {workflow.status !== "awaiting_approval" && (
        <ApprovalPanel
          canReview={data.viewer?.canReview ?? false}
          workflow={workflow}
          actions={actions}
          steps={steps}
          onDecided={refetch}
        />
      )}
      <ReviewBanner
        canReview={data.viewer?.canReview ?? false}
        workflow={workflow}
        review={review}
        onDecided={refetch}
      />
    </div>
  );
}
