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
  ap_matching: "AP Matching",
  fpa_commentary: "FP&A Commentary",
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

export default function StepModelMatrix({ llmSteps, configs, assignments, isAdmin, onChanged }: Props) {
  const [saving, setSaving] = React.useState<string | null>(null);
  const active = configs.filter((c) => c.is_active);
  const defaultConfig = active.find((c) => c.is_default);

  const assignmentFor = (wf: string, key: string): string =>
    assignments.find((a) => a.workflow_type === wf && a.step_key === key)?.assigned_provider_config_id ?? "";

  async function assign(wf: WorkflowType, stepKey: string, configId: string) {
    setSaving(`${wf}:${stepKey}`);
    try {
      await fetch("/api/llm/step-configs", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflow_type: wf,
          step_key: stepKey,
          provider_config_id: configId === "" ? null : configId,
        }),
      });
      onChanged();
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
    ? `Org default (${defaultConfig.display_name})`
    : "Org default (env / none)";

  return (
    <div className="flex flex-col gap-6">
      {[...byWorkflow.entries()].map(([wf, steps]) => (
        <div key={wf}>
          <h3 className="mb-2 text-sm font-medium">{WORKFLOW_LABEL[wf]}</h3>
          <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
            {steps.map((s) => {
              const current = assignmentFor(wf, s.step_key);
              return (
                <div key={s.step_key} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-sm">{s.name}</span>
                    <span className="font-mono text-[11px] text-muted">
                      {s.step_key} · {s.role}
                    </span>
                  </div>
                  <select
                    value={current}
                    disabled={!isAdmin || saving === `${wf}:${s.step_key}`}
                    onChange={(e) => assign(wf, s.step_key, e.target.value)}
                    className="w-56 shrink-0 rounded-md border border-border bg-transparent px-2 py-1.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60"
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
