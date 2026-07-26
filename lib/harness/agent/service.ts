/**
 * Investigation lifecycle (Plan 5, D-G3/D-G4).
 *
 * The seam between an HTTP request and the agent loop: create the durable rows, run the loop,
 * project the outcome back onto them. Kept out of the route handler so the proof script and the
 * tests drive exactly the same path a real request does.
 *
 * The projection rule from D-G4 is enforced here rather than merely documented: `investigations`
 * is written from the loop's return value and is never read to decide anything. If it and the
 * event stream ever disagree, the stream is right.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { writeAudit } from "@/lib/audit";
import { appendEvent } from "@/lib/harness/events";
import { clampBudget, runInvestigation, type InvestigationOutcome } from "@/lib/harness/agent/loop";
import type { OrgDatasets } from "@/lib/harness/agent/datasets";
import { INVESTIGATION_TYPE, type Investigation, type InvestigationBudget } from "@/lib/types";

/** A question, shortened into a workflow row name. */
export function investigationName(question: string): string {
  const clean = question.trim().replace(/\s+/g, " ");
  return clean.length <= 70 ? clean : `${clean.slice(0, 67)}…`;
}

export interface CreateInvestigationArgs {
  db: SupabaseClient;
  orgId: string;
  createdBy: string | null;
  question: string;
  budget?: Partial<InvestigationBudget>;
}

/**
 * Create the workflow row and its investigation projection.
 *
 * Two rows rather than one because `harness_events.workflow_id` is a foreign key to `workflows`,
 * and reusing that table is what gives the agent the org-scoped RLS policy, the Realtime
 * publication, the cascade delete and the audit certificate for free (D-G3).
 */
export async function createInvestigation(
  args: CreateInvestigationArgs,
): Promise<{ workflowId: string; budget: InvestigationBudget }> {
  const { db, orgId, createdBy, question } = args;
  const budget = clampBudget(args.budget);

  const { data: workflow, error: wfError } = await db
    .from("workflows")
    .insert({
      org_id: orgId,
      created_by: createdBy,
      name: investigationName(question),
      type: INVESTIGATION_TYPE,
      status: "running",
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single<{ id: string }>();
  if (wfError || !workflow) {
    throw new Error(`Could not create investigation: ${wfError?.message ?? "no row"}`);
  }

  const { error: invError } = await db.from("investigations").insert({
    workflow_id: workflow.id,
    org_id: orgId,
    question,
    status: "running",
    budget,
    created_by: createdBy,
  });
  if (invError) {
    // Roll the workflow row back rather than leaving an investigation-typed workflow with no
    // investigation — the UI would render it as a pipeline run with no steps.
    await db.from("workflows").delete().eq("id", workflow.id);
    throw new Error(`Could not create investigation: ${invError.message}`);
  }

  await writeAudit(db, {
    workflowId: workflow.id,
    actorType: "human",
    actorId: createdBy ?? "system",
    action: "investigation_created",
    detail: { question, budget },
  });

  return { workflowId: workflow.id, budget };
}

/**
 * Run an investigation to completion and project the outcome.
 *
 * Never throws: the loop's own failure paths already produce a terminal outcome with a reason,
 * and anything that escapes them is caught here and recorded the same way. A route that got an
 * exception instead of a status would have to invent one.
 */
export async function executeInvestigation(args: {
  db: SupabaseClient;
  workflowId: string;
  orgId: string;
  question: string;
  budget?: Partial<InvestigationBudget>;
  datasets?: OrgDatasets;
}): Promise<InvestigationOutcome> {
  const { db, workflowId, orgId, question } = args;

  let outcome: InvestigationOutcome;
  try {
    outcome = await runInvestigation({
      db,
      workflowId,
      orgId,
      question,
      budget: args.budget,
      datasets: args.datasets,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    outcome = {
      status: "failed",
      reason: "error",
      answer: null,
      turnsUsed: 0,
      tokensIn: 0,
      tokensOut: 0,
      recommendations: [],
      error: message,
    };
    await appendEvent(db, {
      workflowId,
      eventType: "agent_terminated",
      actor: "system",
      payload: { reason: "error", detail: message },
    }).catch(() => undefined);
  }

  const completedAt = new Date().toISOString();

  await db
    .from("investigations")
    .update({
      status: outcome.status,
      answer: outcome.answer,
      termination_reason: outcome.reason,
      turns_used: outcome.turnsUsed,
      tokens_in: outcome.tokensIn,
      tokens_out: outcome.tokensOut,
      completed_at: completedAt,
    })
    .eq("workflow_id", workflowId);

  // The workflow row's own status, so the dashboard's existing list renders it sensibly.
  // `awaiting_review` when a recommendation is waiting on a human — which is exactly what the
  // existing approval panel is for, and why there is no parallel approval UI (D-G21).
  const pendingRecommendations = outcome.recommendations.filter(
    (r) => r.status === "pending",
  ).length;
  await db
    .from("workflows")
    .update({
      status:
        outcome.status === "failed"
          ? "error"
          : pendingRecommendations > 0
            ? "awaiting_approval"
            : "approved",
      error_message: outcome.status === "failed" ? (outcome.error ?? null) : null,
      completed_at: completedAt,
    })
    .eq("id", workflowId);

  await writeAudit(db, {
    workflowId,
    actorType: "agent",
    actorId: "investigator",
    action: "investigation_completed",
    detail: {
      status: outcome.status,
      reason: outcome.reason,
      turns: outcome.turnsUsed,
      tokens_in: outcome.tokensIn,
      tokens_out: outcome.tokensOut,
      recommendations: outcome.recommendations.length,
    },
  });

  return outcome;
}

/** Read one investigation's projection row. */
export async function loadInvestigation(
  db: SupabaseClient,
  workflowId: string,
): Promise<Investigation | null> {
  const { data, error } = await db
    .from("investigations")
    .select("*")
    .eq("workflow_id", workflowId)
    .maybeSingle<Investigation>();
  if (error) throw new Error(`Failed to load investigation: ${error.message}`);
  return data;
}

/** The org's investigations, newest first. */
export async function listInvestigations(
  db: SupabaseClient,
  orgId: string,
  limit = 50,
): Promise<Investigation[]> {
  const { data, error } = await db
    .from("investigations")
    .select("*")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Failed to list investigations: ${error.message}`);
  return (data ?? []) as Investigation[];
}
