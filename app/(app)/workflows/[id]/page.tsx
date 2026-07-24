"use client";

import { use } from "react";
import { useWorkflowStatus } from "@/lib/hooks/useWorkflowStatus";
import { LiveWorkflowView } from "@/components/workflow/LiveWorkflowView";
import OutputPanel from "@/components/workflow/OutputPanel";
import ReviewBanner from "@/components/workflow/ReviewBanner";
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
  awaiting_review: "warning",
  approved: "accent",
  rejected: "error",
  error: "error",
};

const STATUS_LABEL: Record<WorkflowStatus, string> = {
  idle: "Idle",
  running: "Running",
  awaiting_review: "Awaiting review",
  approved: "Approved",
  rejected: "Rejected",
  error: "Error",
};

function LoadingSkeleton() {
  return (
    <div className="grid h-full grid-cols-[420px_1fr]">
      <div className="flex flex-col gap-3 border-r border-border p-4">
        <Skeleton className="h-6 w-40" />
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
      <div className="flex flex-col gap-4 p-6">
        <Skeleton className="h-8 w-56" />
        <div className="grid grid-cols-4 gap-3">
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
        </div>
      </div>
    );
  }

  const { workflow, steps, review } = data;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border px-6 py-3">
        <div className="flex flex-col">
          <h1 className="text-base font-semibold tracking-tight">
            {workflow.name}
          </h1>
          <span className="font-mono text-xs text-muted">{workflow.type}</span>
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
      <div className="grid min-h-0 flex-1 grid-cols-[420px_1fr]">
        <div className="min-h-0 overflow-hidden border-r border-border">
          <LiveWorkflowView steps={steps} />
        </div>
        <div className="min-h-0 overflow-hidden">
          <OutputPanel workflow={workflow} steps={steps} />
        </div>
      </div>

      <ReviewBanner workflow={workflow} review={review} onDecided={refetch} />
    </div>
  );
}
