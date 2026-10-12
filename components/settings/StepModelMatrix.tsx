"use client";

/**
 * StepModelMatrix (Plan 2 §6) — per workflow type, pin each LLM step to a provider
 * config or leave it on the org default (D-P7). The step list is generated from dag.ts
 * (passed in as `llmSteps`), so it never drifts from the graphs. Writes via
 * PUT /api/llm/step-configs. Non-admins see the selects disabled.
 */

import * as React from "react";
import type { LlmStepInfo } from "@/lib/agents/dag";
import type { OrgModelConfigPublic, WorkflowType } from "@/lib/types";

const WORKFLOW_LABEL: Record<WorkflowType, string> = {
  reconciliation: "Reconciliation",
  ap_matching: "Invoice matching",
  fpa_commentary: "Variance analysis",
};

interface Assignment {
  workflow_type: string;
  step_key: string;
  assigned_provider_config_id: string;
}

interface Props {
  llmSteps: LlmStepInfo[];
  configs: OrgModelConfigPublic[];
  assignments: Assignment[];
  isAdmin: boolean;
  onChanged: () => void;
}

export default function StepModelMatrix({
  llmSteps,
  configs,
  assignments,
  isAdmin,
  onChanged,
}: Props) {
  const [saving, setSaving] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState<string | null>(null);
  const active = configs.filter((c) => c.is_active);
  const defaultConfig = active.find((c) => c.is_default);

  const assignmentFor = (wf: string, key: string): string =>
    assignments.find((a) => a.workflow_type === wf && a.step_key === key)
      ?.assigned_provider_config_id ?? "";

  async function assign(wf: WorkflowType, stepKey: string, configId: string) {
    if (saving || !isAdmin) return;
    setSaving(`${wf}:${stepKey}`);
    setError(null);
    setSaved(null);
    try {
      const response = await fetch("/api/llm/step-configs", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflow_type: wf,
          step_key: stepKey,
          provider_config_id: configId === "" ? null : configId,
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? "Could not save the model assignment.");
      }
      setSaved("Model assignment saved.");
      onChanged();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not save the model assignment. Try again.",
      );
    } finally {
      setSaving(null);
    }
  }

  const byWorkflow = new Map<WorkflowType, LlmStepInfo[]>();
  for (const s of llmSteps) {
    const arr = byWorkflow.get(s.workflow_type) ?? [];
    arr.push(s);
    byWorkflow.set(s.workflow_type, arr);
  }

  const defaultLabel = defaultConfig
    ? `Organization default (${defaultConfig.display_name})`
    : "Workspace default";

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <p role="alert" className="text-sm text-error">
          {error} Your previous assignment is unchanged; choose the model again
          to retry.
        </p>
      )}
      {saved && (
        <p role="status" className="text-sm text-accent">
          {saved}
        </p>
      )}
      {[...byWorkflow.entries()].map(([wf, steps]) => (
        <div key={wf}>
          <h3 className="mb-2 text-sm font-medium">{WORKFLOW_LABEL[wf]}</h3>
          <div className="flex flex-col divide-y divide-border border-y border-border">
            {steps.map((s) => {
              const current = assignmentFor(wf, s.step_key);
              return (
                <div
                  key={s.step_key}
                  className="flex flex-col items-stretch justify-between gap-3 py-3 sm:flex-row sm:items-center"
                >
                  <div className="flex min-w-0 flex-col">
                    <label
                      htmlFor={`model-${wf}-${s.step_key}`}
                      className="text-sm"
                    >
                      {s.name}
                    </label>
                  </div>
                  <select
                    id={`model-${wf}-${s.step_key}`}
                    value={current}
                    disabled={!isAdmin || saving !== null}
                    onChange={(e) => assign(wf, s.step_key, e.target.value)}
                    className="min-h-11 w-full rounded-md sm:w-64 sm:shrink-0 border border-border bg-background px-3 py-2 text-base sm:text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60"
                  >
                    <option value="">{defaultLabel}</option>
                    {active.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.display_name} ({c.default_model})
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
