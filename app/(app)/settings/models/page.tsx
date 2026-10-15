import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getCurrentProfile } from "@/lib/auth";
import ModelsManager from "@/components/settings/ModelsManager";
import { llmStepsForMatrix } from "@/lib/agents/dag";

/**
 * Settings → Models (Plan 2 §6) — server shell. Resolves the caller's role (to gate the
 * mutating UI; the API enforces regardless) and hands the client manager the LLM step
 * list generated from dag.ts. All config data is fetched client-side from /api/llm/*.
 */
export default async function ModelsSettingsPage() {
  const isAdmin = (await getCurrentProfile())?.role === "admin";

  const llmSteps = llmStepsForMatrix();

  return (
    <div className="page-container min-w-0">
      <header className="mb-8">
        <Link
          href="/settings"
          className="mb-3 inline-flex min-h-11 items-center gap-2 text-sm text-muted transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to settings
        </Link>
        <h1 className="page-title">Models & usage</h1>
        <p className="page-description max-w-3xl">
          Connect model providers, choose which models run your workflows, and
          review usage. API keys are encrypted at rest.
          {!isAdmin &&
            " You have read-only access; ask an admin to make changes."}
        </p>
      </header>

      <ModelsManager isAdmin={isAdmin} llmSteps={llmSteps} />
    </div>
  );
}
