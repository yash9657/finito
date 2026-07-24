"use client";

import * as React from "react";
import { ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatTime, shortHash } from "@/lib/format";
import type { StepRow, StepStatus, Track } from "@/lib/types";

/* Status glyph — pending hollow circle · running ping dot · complete check · error ✕. */
function StatusGlyph({ status }: { status: StepStatus }) {
  if (status === "running") {
    return (
      <span className="relative flex h-3.5 w-3.5 items-center justify-center">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-running opacity-75" />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-running" />
      </span>
    );
  }
  if (status === "complete") {
    return (
      <svg
        viewBox="0 0 16 16"
        className="h-3.5 w-3.5 text-accent"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.25"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M3 8.5l3.2 3.2L13 4.5" />
      </svg>
    );
  }
  if (status === "error") {
    return (
      <svg
        viewBox="0 0 16 16"
        className="h-3.5 w-3.5 text-error"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.25"
        strokeLinecap="round"
        aria-hidden
      >
        <path d="M4 4l8 8M12 4l-8 8" />
      </svg>
    );
  }
  // pending — hollow gray circle
  return (
    <span className="inline-flex h-3.5 w-3.5 rounded-full border-2 border-muted/60" />
  );
}

function trackVariant(track: Track): "muted" | "running" | "accent" {
  if (track === "main") return "muted";
  return track === "A" ? "running" : "accent";
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">
        {label}
      </div>
      {children}
    </div>
  );
}

function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export default function StepCard({ step }: { step: StepRow }) {
  const [open, setOpen] = React.useState(step.status === "running");
  const prevStatus = React.useRef<StepStatus>(step.status);

  // Auto-expand when a step transitions into `running` across polls.
  React.useEffect(() => {
    if (step.status === "running" && prevStatus.current !== "running") {
      setOpen(true);
    }
    prevStatus.current = step.status;
  }, [step.status]);

  // A provenance footer shows once a provider actually ran (D-P14). Deterministic steps
  // and the skip-adjudication path leave provider_used null.
  const hasProvenance = step.provider_used !== null && step.provider_used !== undefined;
  const hasInput = step.input_snapshot !== null && step.input_snapshot !== undefined;
  const hasOutput = step.output !== null && step.output !== undefined;
  const hasSources = Array.isArray(step.sources) && step.sources.length > 0;
  const hasReasoning = !!step.agent_reasoning;

  return (
    <div
      className={cn(
        "rounded-lg border bg-card transition-colors",
        step.status === "running" ? "border-running/50" : "border-border",
      )}
    >
      {/* Fade + slide-in keyed on status change. */}
      <style>{ffStepAnimCss}</style>

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left"
      >
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted transition-transform",
            open && "rotate-90",
          )}
        />
        <span
          key={step.status}
          className="ff-step-anim flex shrink-0 items-center justify-center"
        >
          <StatusGlyph status={step.status} />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">
          <span className="mr-1.5 font-mono text-xs text-muted">
            {String(step.step_number).padStart(2, "0")}
          </span>
          {step.name}
        </span>
        <Badge variant={trackVariant(step.track)} className="shrink-0">
          {step.track}
        </Badge>
        {step.status === "complete" && step.completed_at && (
          <span className="shrink-0 font-mono text-[11px] text-muted">
            {formatTime(step.completed_at)}
          </span>
        )}
      </button>

      {open && (
        <div className="ff-step-anim space-y-3 border-t border-border px-3 py-3 font-mono text-xs leading-relaxed">
          {hasReasoning && (
            <Section label="Reasoning">
              <p className="whitespace-pre-wrap text-foreground/90">
                {step.agent_reasoning}
              </p>
            </Section>
          )}

          {hasInput && (
            <Section label="Input">
              <pre className="max-h-48 overflow-auto rounded border border-border bg-background/60 p-2 text-[11px] text-foreground/80">
                {pretty(step.input_snapshot)}
              </pre>
            </Section>
          )}

          {hasOutput && (
            <Section label="Output">
              <pre className="max-h-64 overflow-auto rounded border border-border bg-background/60 p-2 text-[11px] text-foreground/80">
                {pretty(step.output)}
              </pre>
            </Section>
          )}

          {hasSources && (
            <Section label="Sources">
              <ul className="space-y-0.5">
                {step.sources!.map((s, i) => (
                  <li key={i} className="text-foreground/80">
                    <span className="text-accent">{s.file}</span>
                    <span className="text-muted"> — {s.note}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {!hasReasoning && !hasInput && !hasOutput && !hasSources && (
            <p className="text-muted">No details recorded for this step.</p>
          )}

          {hasProvenance && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border pt-2 text-[10px] text-muted">
              <span className="text-foreground/70">
                {step.provider_used}:{step.model}
              </span>
              {step.tokens_in !== null && step.tokens_out !== null && (
                <span>
                  {step.tokens_in.toLocaleString("en-US")}→
                  {step.tokens_out.toLocaleString("en-US")} tok
                </span>
              )}
              {step.latency_ms !== null && <span>{(step.latency_ms / 1000).toFixed(1)}s</span>}
              {step.input_hash && <span>hash {shortHash(step.input_hash)}</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const ffStepAnimCss = `
@keyframes ffStepIn {
  from { opacity: 0; transform: translateY(-3px); }
  to { opacity: 1; transform: translateY(0); }
}
.ff-step-anim { animation: ffStepIn 0.25s ease-out; }
`;
