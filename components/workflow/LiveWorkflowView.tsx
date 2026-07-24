"use client";

import * as React from "react";
import { WorkflowTrack } from "./WorkflowTrack";
import type { StepRow } from "@/lib/types";

/**
 * Left-panel execution trace. Renders the grouped, track-aware step list
 * (§11.5). Composes WorkflowTrack; the parent grid owns width/scroll.
 */
export function LiveWorkflowView({ steps }: { steps: StepRow[] }) {
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-foreground">Execution trace</h2>
        <p className="text-xs text-muted">
          {steps.length} {steps.length === 1 ? "step" : "steps"}
        </p>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {steps.length === 0 ? (
          <p className="text-sm text-muted">No steps yet.</p>
        ) : (
          <WorkflowTrack steps={steps} />
        )}
      </div>
    </div>
  );
}
