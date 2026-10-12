"use client";

/**
 * ModelsManager (Plan 2 §6) — client shell for Settings → Models. Fetches configs +
 * step assignments from /api/llm/configs and composes ProviderConfigList,
 * AddProviderDialog, StepModelMatrix, and UsagePanel. The LLM step list is passed in
 * from the server (generated from dag.ts) so it never drifts from the graphs.
 */

import * as React from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import ProviderConfigList from "@/components/settings/ProviderConfigList";
import AddProviderDialog from "@/components/settings/AddProviderDialog";
import StepModelMatrix from "@/components/settings/StepModelMatrix";
import UsagePanel from "@/components/settings/UsagePanel";
import type { LlmStepInfo } from "@/lib/agents/dag";
import type { OrgModelConfigPublic } from "@/lib/types";

interface Assignment {
  workflow_type: string;
  step_key: string;
  assigned_provider_config_id: string;
}

export default function ModelsManager({
  isAdmin,
  llmSteps,
}: {
  isAdmin: boolean;
  llmSteps: LlmStepInfo[];
}) {
  const [configs, setConfigs] = React.useState<OrgModelConfigPublic[]>([]);
  const [assignments, setAssignments] = React.useState<Assignment[]>([]);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<OrgModelConfigPublic | null>(
    null,
  );

  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const reload = React.useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch("/api/llm/configs");
      if (!res.ok) throw new Error("Unable to load model settings. Try again.");
      const body = (await res.json()) as {
        configs: OrgModelConfigPublic[];
        stepAssignments: Assignment[];
      };
      setConfigs(body.configs);
      setAssignments(body.stepAssignments);
    } catch {
      setLoadError(
        "Unable to load model settings. Check your connection and try again.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <div className="flex flex-col gap-8">
      <div className="border-y border-border py-6">
        <h2 className="text-lg font-medium">
          Choose the models behind your work.
        </h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
          Connect Fireworks AI to use open-weight models for matching,
          commentary, and investigations. Test the connection, choose an
          organization default, then select a different provider for individual
          steps when needed.
        </p>
        <p className="mt-3 text-sm leading-6 text-muted">
          Changing the default does not replace existing step assignments.
          Validate a sample workflow before using a new model for a close.
        </p>
      </div>
      {loading && (
        <p role="status" className="text-sm text-muted">
          Loading model configuration…
        </p>
      )}
      {loadError && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 text-sm text-error"
        >
          {loadError}
          <Button onClick={() => void reload()}>Retry</Button>
        </div>
      )}
      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-medium">Providers</h2>
          {isAdmin && (
            <Button
              variant="accent"
              onClick={() => {
                setEditing(null);
                setDialogOpen(true);
              }}
            >
              <Plus className="h-4 w-4" />
              Add provider
            </Button>
          )}
        </div>

        <ProviderConfigList
          configs={configs}
          isAdmin={isAdmin}
          onEdit={(c) => {
            setEditing(c);
            setDialogOpen(true);
          }}
          onChanged={reload}
        />
      </section>

      <section>
        <h2 className="mb-3 text-lg font-medium">Workflow models</h2>
        <StepModelMatrix
          llmSteps={llmSteps}
          configs={configs}
          assignments={assignments}
          isAdmin={isAdmin}
          onChanged={reload}
        />
      </section>

      <section>
        <h2 className="mb-2 text-lg font-medium">Model usage</h2>
        <p className="mb-5 text-sm leading-6 text-muted">
          Calls and tokens for the two most recent months. For billing amounts,
          use your provider’s account statement.
        </p>
        <UsagePanel />
      </section>

      <AddProviderDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editing}
        onSaved={reload}
      />
    </div>
  );
}
