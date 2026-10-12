"use client";

import * as React from "react";
import StepCard from "./StepCard";
import type { StepRow, Track } from "@/lib/types";

const PARALLEL_ORDER: Track[] = ["A", "B", "C"];

function byStepNumber(a: StepRow, b: StepRow) {
  return a.step_number - b.step_number;
}

/**
 * Groups steps by track. Parallel tracks (A/B/…) render side-by-side as mini-columns,
 * joined by a connector into the `main` column below. Pure flexbox — no graph lib.
 */
export function WorkflowTrack({ steps }: { steps: StepRow[] }) {
  const mainSteps = steps.filter((s) => s.track === "main").sort(byStepNumber);

  const parallelTracks = PARALLEL_ORDER.map((track) => ({
    track,
    steps: steps.filter((s) => s.track === track).sort(byStepNumber),
  })).filter((g) => g.steps.length > 0);

  const hasParallel = parallelTracks.length > 0;

  return (
    <div className="space-y-0">
      {hasParallel && (
        <>
          <div className="grid gap-3">
            {parallelTracks.map((g) => (
              <div key={g.track} className="min-w-0 flex-1 space-y-2">
                <div className="px-1 text-xs font-medium text-muted">
                  Source {g.track}
                </div>
                {g.steps.map((step) => (
                  <StepCard key={step.id} step={step} />
                ))}
              </div>
            ))}
          </div>

          {/* Connector: parallel columns merge into the main column below. */}
          <div
            className="flex items-stretch justify-center"
            aria-hidden
          >
            <div className="h-5 w-px bg-border" />
          </div>
        </>
      )}

      {mainSteps.length > 0 && (
        <div className="space-y-2">
          {hasParallel && (
            <div className="px-1 text-xs font-medium text-muted">
              Analysis
            </div>
          )}
          {mainSteps.map((step) => (
            <StepCard key={step.id} step={step} />
          ))}
        </div>
      )}
    </div>
  );
}
