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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  const [editing, setEditing] = React.useState<OrgModelConfigPublic | null>(null);

  const reload = React.useCallback(async () => {
    const res = await fetch("/api/llm/configs");
    if (!res.ok) return;
    const body = (await res.json()) as {
      configs: OrgModelConfigPublic[];
      stepAssignments: Assignment[];
    };
    setConfigs(body.configs);
    setAssignments(body.stepAssignments);
  }, []);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <div className="flex flex-col gap-8">
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-medium text-muted">Providers</h2>
          {isAdmin && (
            <Button
              variant="accent"
              size="sm"
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
        <Card>
          <CardContent className="p-0">
            <ProviderConfigList
              configs={configs}
              isAdmin={isAdmin}
              onEdit={(c) => {
                setEditing(c);
                setDialogOpen(true);
              }}
              onChanged={reload}
            />
          </CardContent>
        </Card>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-medium text-muted">Per-step model assignment</h2>
        <Card>
          <CardContent>
            <StepModelMatrix
              llmSteps={llmSteps}
              configs={configs}
              assignments={assignments}
              isAdmin={isAdmin}
              onChanged={reload}
            />
          </CardContent>
        </Card>
      </section>

      <section>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted">Usage</CardTitle>
          </CardHeader>
          <CardContent>
            <UsagePanel />
          </CardContent>
        </Card>
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
