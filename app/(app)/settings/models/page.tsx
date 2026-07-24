import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import ModelsManager from "@/components/settings/ModelsManager";
import { llmStepsForMatrix } from "@/lib/agents/dag";
import type { Profile } from "@/lib/types";

/**
 * Settings → Models (Plan 2 §6) — server shell. Resolves the caller's role (to gate the
 * mutating UI; the API enforces regardless) and hands the client manager the LLM step
 * list generated from dag.ts. All config data is fetched client-side from /api/llm/*.
 */
export default async function ModelsSettingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let isAdmin = false;
  if (user) {
    const admin = createAdminClient();
    const { data: profile } = await admin
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .maybeSingle<Pick<Profile, "role">>();
    isAdmin = profile?.role === "admin";
  }

  const llmSteps = llmStepsForMatrix();

  return (
    <div className="mx-auto max-w-4xl px-8 py-8">
      <header className="mb-8">
        <Link
          href="/settings"
          className="mb-2 inline-flex items-center gap-1.5 text-xs text-muted transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to settings
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Models</h1>
        <p className="mt-1 text-sm text-muted">
          Configure LLM providers, pin workflow steps to specific models, and review token
          usage. Keys are encrypted at rest and never returned to the browser.
          {!isAdmin && " You have read-only access; ask an admin to make changes."}
        </p>
      </header>

      <ModelsManager isAdmin={isAdmin} llmSteps={llmSteps} />
    </div>
  );
}
