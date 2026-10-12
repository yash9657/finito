import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { Download, ArrowLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import OutputPanel from "@/components/workflow/OutputPanel";
import AuditTrail from "@/components/workflow/AuditTrail";
import PrintButton from "@/components/workflow/PrintButton";
import { Badge } from "@/components/ui/badge";
import type {
  ActionRequest,
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

  // The run's authorization chain (Plan 3, D-A15). Read under RLS like everything else on
  // this page; `approverEmails` lets the certificate name who authorized each action.
  const { data: actionsData } = await supabase
    .from("action_requests")
    .select("*")
    .eq("workflow_id", id)
    .order("proposed_at", { ascending: true });
  const actions = (actionsData ?? []) as ActionRequest[];

  const approverEmails: Record<string, string> = {};
  const approverIds = [
    ...new Set(
      actions.map((a) => a.decided_by).filter((x): x is string => !!x),
    ),
  ];
  if (approverIds.length > 0) {
    const { data: approvers } = await supabase
      .from("profiles")
      .select("id, email")
      .in("id", approverIds);
    for (const p of (approvers ?? []) as Pick<Profile, "id" | "email">[]) {
      approverEmails[p.id] = p.email;
    }
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
    step_key: s.step_key,
    track: s.track,
    name: s.name,
    status: s.status,
    agent_reasoning: s.agent_reasoning,
    input_snapshot: s.input_snapshot,
    output: s.output,
    sources: s.sources,
    model: s.model,
    provider_used: s.provider_used,
    tokens_in: s.tokens_in,
    tokens_out: s.tokens_out,
    latency_ms: s.latency_ms,
    input_hash: s.input_hash,
    started_at: s.started_at,
    completed_at: s.completed_at,
  }));

  return (
    <div className="report-print page-container flex min-w-0 flex-col gap-10">
      <header className="flex min-w-0 flex-wrap items-start justify-between gap-5">
        <div className="min-w-0 flex-1">
          <Link
            href={`/workflows/${id}`}
            className="no-print mb-3 inline-flex min-h-11 w-fit items-center gap-2 text-sm text-muted transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to workflow
          </Link>
          <h1 className="page-title break-words">{workflow.name}</h1>
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted">
            <span>
              {
                {
                  reconciliation: "Reconciliation",
                  ap_matching: "Invoice matching",
                  fpa_commentary: "Variance analysis",
                  investigation: "Investigation",
                }[workflow.type]
              }
            </span>
            <Badge variant="accent">Approved</Badge>
            {workflow.completed_at && (
              <span>
                Completed{" "}
                {new Intl.DateTimeFormat("en-US", {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                  timeZone: "UTC",
                  timeZoneName: "short",
                }).format(new Date(workflow.completed_at))}
              </span>
            )}
          </div>
        </div>

        <div className="no-print flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <a
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-on-accent transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            href={`/api/workflows/${id}/report?format=xlsx`}
          >
            <Download className="h-4 w-4" />
            Download Excel
          </a>
          <PrintButton />
        </div>
      </header>

      <section className="min-w-0">
        <OutputPanel workflow={workflowRow} steps={stepRows} report />
      </section>

      <AuditTrail
        workflow={workflow}
        steps={steps}
        files={files}
        decision={decision ?? null}
        reviewer={reviewer}
        actions={actions}
        approverEmails={approverEmails}
      />
    </div>
  );
}
