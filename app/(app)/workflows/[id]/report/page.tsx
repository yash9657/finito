import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { Download, ArrowLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import OutputPanel from "@/components/workflow/OutputPanel";
import AuditTrail from "@/components/workflow/AuditTrail";
import PrintButton from "@/components/workflow/PrintButton";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/format";
import type {
  Workflow,
  WorkflowStep,
  WorkflowFile,
  ReviewDecision,
  Profile,
  WorkflowRow,
  StepRow,
} from "@/lib/types";

/**
 * Report page (PLAN §11.6) — Server Component.
 *
 * Requires the workflow to be `approved` (otherwise redirects back to the live
 * view). Loads workflow + steps + files + latest review decision + reviewer via
 * the RLS-scoped server client (org-scoped reads), then renders the final
 * deliverable (reusing OutputPanel) followed by the on-page Audit Certificate.
 * The `@media print` block in globals.css turns this page white-on-black-text
 * for "Print / Save as PDF".
 */
export default async function ReportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: workflow } = await supabase
    .from("workflows")
    .select("*")
    .eq("id", id)
    .maybeSingle<Workflow>();

  if (!workflow) notFound();
  if (workflow.status !== "approved") redirect(`/workflows/${id}`);

  const [{ data: stepsData }, { data: filesData }, { data: decision }] =
    await Promise.all([
      supabase
        .from("workflow_steps")
        .select("*")
        .eq("workflow_id", id)
        .order("step_number", { ascending: true }),
      supabase
        .from("workflow_files")
        .select("*")
        .eq("workflow_id", id)
        .order("uploaded_at", { ascending: true }),
      supabase
        .from("review_decisions")
        .select("*")
        .eq("workflow_id", id)
        .order("decided_at", { ascending: false })
        .limit(1)
        .maybeSingle<ReviewDecision>(),
    ]);

  const steps = (stepsData ?? []) as WorkflowStep[];
  const files = (filesData ?? []) as WorkflowFile[];

  let reviewer: Profile | null = null;
  if (decision) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", decision.reviewer_id)
      .maybeSingle<Profile>();
    reviewer = profile ?? null;
  }

  // Project the DB rows into the /status shapes OutputPanel consumes.
  const workflowRow: WorkflowRow = {
    id: workflow.id,
    name: workflow.name,
    type: workflow.type,
    status: workflow.status,
    error_message: workflow.error_message,
    created_at: workflow.created_at,
    completed_at: workflow.completed_at,
  };
  const stepRows: StepRow[] = steps.map((s) => ({
    id: s.id,
    step_number: s.step_number,
    track: s.track,
    name: s.name,
    status: s.status,
    agent_reasoning: s.agent_reasoning,
    input_snapshot: s.input_snapshot,
    output: s.output,
    sources: s.sources,
    model: s.model,
    input_hash: s.input_hash,
    started_at: s.started_at,
    completed_at: s.completed_at,
  }));

  return (
    <div className="report-print mx-auto flex max-w-5xl flex-col gap-8 p-6 md:p-10">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Link
            href={`/workflows/${id}`}
            className="no-print inline-flex w-fit items-center gap-1.5 text-xs text-muted transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to workflow
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">
            {workflow.name}
          </h1>
          <div className="flex items-center gap-3 font-mono text-xs text-muted">
            <span>{workflow.type}</span>
            <Badge variant="accent">Approved</Badge>
            {workflow.completed_at && (
              <span>Completed {formatDateTime(workflow.completed_at)}</span>
            )}
          </div>
        </div>

        <div className="no-print flex items-center gap-2">
          <a
            href={`/api/workflows/${id}/report?format=xlsx`}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-background transition-opacity hover:opacity-90"
          >
            <Download className="h-4 w-4" />
            Download Excel
          </a>
          <PrintButton />
        </div>
      </header>

      <section>
        <OutputPanel workflow={workflowRow} steps={stepRows} />
      </section>

      <AuditTrail
        workflow={workflow}
        steps={steps}
        files={files}
        decision={decision ?? null}
        reviewer={reviewer}
      />
    </div>
  );
}
