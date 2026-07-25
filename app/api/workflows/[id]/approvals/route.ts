/**
 * Per-action authorization decisions (Plan 3 §5, D-A8/D-A9/D-A10).
 *
 * `GET  /api/workflows/[id]/approvals` — the run's actions + the policy in force.
 * `POST /api/workflows/[id]/approvals` — body
 *   `{ actionIds: string[], decision: 'approve'|'reject', comment?, grant? }`.
 *
 * The POST does four things, in order:
 *  1. **Authorizes the approver** — role ∈ {admin, reviewer}, and under
 *     `require_separate_approver` the workflow's creator may not decide its own run
 *     (four-eyes, D-A8).
 *  2. **Resolves each action exactly once** (D-A9). A concurrent responder or a retried
 *     request gets that action reported back as already resolved instead of an
 *     overwrite; a ceiling-denied action is reported as not overridable and left alone
 *     (D-A4).
 *  3. **Mints the optional grant** — a separate, deliberate, audited act (D-A7), then
 *     re-evaluates the run's remaining pending actions so a "this vendor up to $X" rule
 *     immediately clears everything it covers.
 *  4. **Auto-resumes** (D-A10): when the last pending action of a suspended run clears,
 *     flip it to `running` and fire the same idempotent `runWorkflow` the launch path
 *     uses. Nothing was held open while it waited.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { jsonError, requireWorkflowAccess } from "@/lib/api/guard";
import { writeAudit } from "@/lib/audit";
import { runWorkflow } from "@/lib/agents/orchestrator";
import { validateRuleInput } from "@/lib/approvals/engine";
import {
  listActions,
  loadPolicy,
  reevaluatePending,
  resolveAction,
  ruleSummary,
} from "@/lib/approvals/service";
import { ruleScopeEnum, type ApprovalRule, type ApprovalRuleInput } from "@/lib/types";

// Resuming the DAG happens inside this request via waitUntil, same budget as /run (D2).
export const maxDuration = 300;

/** Roles allowed to authorize a consequential action (D-A8). */
const APPROVER_ROLES = new Set(["admin", "reviewer"]);

const grantSchema = z.object({
  scope: ruleScopeEnum,
  counterparty: z.string().trim().min(1).optional().nullable(),
  max_amount_cents: z.number().int().positive().optional().nullable(),
  target_id: z.string().trim().min(1).optional().nullable(),
  expires_at: z.string().optional().nullable(),
  note: z.string().trim().optional().nullable(),
});

const bodySchema = z.object({
  actionIds: z.array(z.string().min(1)).min(1),
  decision: z.enum(["approve", "reject"]),
  comment: z.string().optional(),
  grant: grantSchema.optional(),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const g = await requireWorkflowAccess(id);
  if (!g.ok) return g.response;
  const { admin, profile } = g;

  const [actions, policy] = await Promise.all([
    listActions(admin, id),
    loadPolicy(admin, profile.org_id),
  ]);
  return NextResponse.json({ actions, policy, canApprove: APPROVER_ROLES.has(profile.role) });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const g = await requireWorkflowAccess(id);
  if (!g.ok) return g.response;
  const { admin, profile, workflow } = g;

  if (!APPROVER_ROLES.has(profile.role)) {
    return jsonError("Approving a consequential action requires the admin or reviewer role", 403);
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("Invalid request body", 400);
  const { actionIds, decision, comment, grant } = parsed.data;

  // Segregation of duties (D-A8): four-eyes when the org asks for it.
  const policy = await loadPolicy(admin, profile.org_id);
  if (policy.require_separate_approver && workflow.created_by === profile.id) {
    return jsonError(
      "Your organization requires a separate approver — you cannot authorize actions on a run you launched.",
      403,
    );
  }

  const resolved: string[] = [];
  const alreadyResolved: string[] = [];
  const notOverridable: string[] = [];
  const notFound: string[] = [];

  for (const actionId of actionIds) {
    const res = await resolveAction(admin, {
      actionId,
      workflowId: id,
      decision,
      approverId: profile.id,
      comment: comment?.trim() || null,
    });
    if (res.ok) resolved.push(actionId);
    else if (res.reason === "already_resolved") alreadyResolved.push(actionId);
    else if (res.reason === "not_overridable") notOverridable.push(actionId);
    else notFound.push(actionId);
  }

  // The grant is a separate deliberate act, only meaningful alongside an approval (D-A7).
  let mintedRule: ApprovalRule | null = null;
  if (grant && decision === "approve") {
    if (profile.role !== "admin") {
      return jsonError("Minting a standing rule requires the admin role", 403);
    }
    // The grant's action_type/target_kind come from the action(s) being approved, never
    // from the client, so a caller cannot widen a grant to a different action type.
    const decidedRows = (await listActions(admin, id)).filter((a) => actionIds.includes(a.id));
    const source = decidedRows[0];
    const input: ApprovalRuleInput = {
      scope: grant.scope,
      workflow_id: grant.scope === "standing" ? null : id,
      action_type: source?.action_type ?? "",
      target_kind: source?.target_kind ?? "",
      target_id: grant.target_id ?? null,
      counterparty: grant.counterparty ?? null,
      max_amount_cents: grant.max_amount_cents ?? null,
      expires_at: grant.expires_at ?? null,
      note: grant.note ?? null,
    };
    const invalid = validateRuleInput(input);
    if (invalid) return jsonError(invalid, 400);

    const { data, error } = await admin
      .from("approval_rules")
      .insert({
        org_id: profile.org_id,
        scope: input.scope,
        workflow_id: input.workflow_id,
        action_type: input.action_type,
        target_kind: input.target_kind,
        target_id: input.target_id,
        counterparty: input.counterparty,
        max_amount_cents: input.max_amount_cents,
        expires_at: input.expires_at,
        note: input.note,
        created_by: profile.id,
      })
      .select("*")
      .single<ApprovalRule>();
    if (error || !data) {
      return jsonError(`Failed to create rule: ${error?.message ?? "unknown"}`, 500);
    }
    mintedRule = data;

    await writeAudit(admin, {
      workflowId: id,
      actorType: "human",
      actorId: profile.id,
      action: "standing_rule_minted",
      detail: {
        rule_id: data.id,
        scope: data.scope,
        action_type: data.action_type,
        counterparty: data.counterparty,
        max_amount_cents: data.max_amount_cents,
        target_id: data.target_id,
        expires_at: data.expires_at,
        binding: ruleSummary(data),
      },
    });

    // Anything the new grant covers clears without further human involvement.
    await reevaluatePending(admin, { workflowId: id, orgId: profile.org_id });
  }

  // Auto-resume when the run has nothing left to decide (D-A10).
  const remaining = (await listActions(admin, id)).filter((a) => a.status === "pending");
  let resumed = false;
  if (remaining.length === 0 && workflow.status === "awaiting_approval") {
    const { error } = await admin
      .from("workflows")
      .update({ status: "running", error_message: null })
      .eq("id", id)
      .eq("status", "awaiting_approval"); // only the responder that finds it suspended resumes it
    if (error) return jsonError(`Failed to resume workflow: ${error.message}`, 500);

    await writeAudit(admin, {
      workflowId: id,
      actorType: "human",
      actorId: profile.id,
      action: "workflow_resumed",
      detail: { from_status: "awaiting_approval", resolved: resolved.length },
    });

    try {
      const { waitUntil } = await import("@vercel/functions");
      waitUntil(runWorkflow(id));
    } catch {
      void runWorkflow(id).catch((err: unknown) => {
        console.error(`[approvals] background runWorkflow(${id}) failed:`, err);
      });
    }
    resumed = true;
  }

  return NextResponse.json({
    resolved,
    alreadyResolved,
    notOverridable,
    notFound,
    pendingRemaining: remaining.length,
    resumed,
    rule: mintedRule
      ? { id: mintedRule.id, scope: mintedRule.scope, binding: ruleSummary(mintedRule) }
      : null,
  });
}
