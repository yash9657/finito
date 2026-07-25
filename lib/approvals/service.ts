/**
 * The authorization service (Plan 3 §3.2) — everything DB-facing about actions.
 *
 * The engine (`engine.ts`) decides; this module persists, and the persistence rules are
 * what make the gate operationally trustworthy:
 *
 *  - **Idempotent by `(workflow_id, action_key)`** (D-A1). Re-proposing an action after a
 *    suspend/resume, a crash, or a redeploy finds its existing row and its existing
 *    decision. The gate can be entered any number of times and never duplicates a
 *    pending item or re-asks a resolved one.
 *  - **Resolve-exactly-once, first-responder-wins** (D-A9). A decision is a conditional
 *    single-row UPDATE filtered on `status = 'pending'`; a loser gets a clear "already
 *    resolved by …" instead of silently overwriting a colleague's decision.
 *  - **Denied is terminal** (D-A4). `resolveAction` refuses to touch a `denied` row, so
 *    no in-band click anywhere can override a structural ceiling.
 *
 * Every write is service-role (D5) and every stage is audited (D-A15).
 */

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { writeAudit } from "@/lib/audit";
import { evaluateAction, ruleSummary } from "@/lib/approvals/engine";
import type {
  ActionDecision,
  ActionDecisionMap,
  ActionRequest,
  ApprovalPolicy,
  ApprovalRule,
  ProposedAction,
} from "@/lib/types";

/* -------------------------------------------------------------------------- */
/* Policy + rules                                                              */
/* -------------------------------------------------------------------------- */

/** The all-permissive-ceilings / no-rules default (D-A4): everything needs a human. */
export function defaultPolicy(orgId: string): ApprovalPolicy {
  return {
    org_id: orgId,
    hard_deny_above_cents: null,
    auto_approve_max_cents: null,
    require_known_counterparty: false,
    approved_counterparties: [],
    require_separate_approver: false,
    updated_by: null,
    updated_at: null,
  };
}

export async function loadPolicy(db: SupabaseClient, orgId: string): Promise<ApprovalPolicy> {
  const { data, error } = await db
    .from("org_approval_policies")
    .select("*")
    .eq("org_id", orgId)
    .maybeSingle<ApprovalPolicy>();
  if (error) throw new Error(`Failed to load approval policy: ${error.message}`);
  if (!data) return defaultPolicy(orgId);
  return {
    ...defaultPolicy(orgId),
    ...data,
    approved_counterparties: data.approved_counterparties ?? [],
  };
}

/**
 * All of the org's grants. Scope, expiry, revocation and consumption are filtered by the
 * engine (`ruleMatches`), not by SQL — one query, one place where the semantics live.
 */
export async function loadRules(db: SupabaseClient, orgId: string): Promise<ApprovalRule[]> {
  const { data, error } = await db.from("approval_rules").select("*").eq("org_id", orgId);
  if (error) throw new Error(`Failed to load approval rules: ${error.message}`);
  return (data ?? []) as ApprovalRule[];
}

/* -------------------------------------------------------------------------- */
/* Reading actions                                                             */
/* -------------------------------------------------------------------------- */

export async function listActions(
  db: SupabaseClient,
  workflowId: string,
): Promise<ActionRequest[]> {
  const { data, error } = await db
    .from("action_requests")
    .select("*")
    .eq("workflow_id", workflowId);
  if (error) throw new Error(`Failed to load actions: ${error.message}`);
  const rows = (data ?? []) as ActionRequest[];
  return rows.sort((a, b) => a.proposed_at.localeCompare(b.proposed_at) || a.action_key.localeCompare(b.action_key));
}

export async function pendingActions(
  db: SupabaseClient,
  workflowId: string,
): Promise<ActionRequest[]> {
  const rows = await listActions(db, workflowId);
  return rows.filter((r) => r.status === "pending");
}

export function isAuthorized(status: ActionRequest["status"]): boolean {
  return status === "auto_approved" || status === "approved";
}

/** actionKey → decision, the shape step code sees as `ctx.approvals` (D-A3). */
export function decisionMap(rows: ActionRequest[]): ActionDecisionMap {
  const map: ActionDecisionMap = new Map();
  for (const r of rows) {
    const decision: ActionDecision = {
      actionKey: r.action_key,
      actionId: r.id,
      status: r.status,
      source: r.decision_source,
      reason: r.decision_reason,
      standingRuleId: r.standing_rule_id,
      decidedBy: r.decided_by,
      authorized: isAuthorized(r.status),
    };
    map.set(r.action_key, decision);
  }
  return map;
}

/* -------------------------------------------------------------------------- */
/* The gate                                                                    */
/* -------------------------------------------------------------------------- */

function auditDetail(row: ActionRequest): Record<string, unknown> {
  return {
    action_key: row.action_key,
    action_type: row.action_type,
    risk_class: row.risk_class,
    target_kind: row.target_kind,
    target_id: row.target_id,
    counterparty: row.counterparty,
    amount_cents: row.amount_cents,
    status: row.status,
    decision_source: row.decision_source,
    decision_reason: row.decision_reason,
    standing_rule_id: row.standing_rule_id,
  };
}

/** The audit action name for a freshly-evaluated row (D-A15). */
function outcomeAudit(row: ActionRequest): string {
  if (row.status === "pending") return "approval_requested";
  if (row.status === "auto_approved") return "action_auto_approved";
  if (row.status === "denied") return "action_denied_by_ceiling";
  return "approval_resolved";
}

/**
 * Persist + evaluate one step's proposed actions, then re-evaluate anything already
 * pending on this run (a rule minted since the last attempt must take effect without a
 * human). Returns the rows for THESE actions, in proposal order.
 */
export async function gateStepActions(
  db: SupabaseClient,
  args: {
    workflowId: string;
    orgId: string;
    stepKey: string;
    stepId: string | null;
    actions: ProposedAction[];
  },
): Promise<ActionRequest[]> {
  const { workflowId, orgId, stepKey, stepId, actions } = args;

  const existing = await listActions(db, workflowId);
  const byKey = new Map(existing.map((r) => [r.action_key, r]));

  const policy = await loadPolicy(db, orgId);
  const rules = await loadRules(db, orgId);
  const nowIso = new Date().toISOString();

  const out: ActionRequest[] = [];

  for (const action of actions) {
    const prior = byKey.get(action.actionKey);
    if (prior) {
      // Idempotent (D-A1): an existing decision — pending or resolved — is authoritative.
      out.push(prior);
      continue;
    }

    const evaluation = evaluateAction({ action, workflowId, policy, rules, nowIso });
    const resolved = evaluation.outcome !== "pending";
    const row: ActionRequest = {
      id: randomUUID(),
      workflow_id: workflowId,
      step_id: stepId,
      step_key: stepKey,
      action_key: action.actionKey,
      action_type: action.actionType,
      risk_class: action.riskClass,
      target: action.target,
      target_kind: action.target.kind,
      target_id: action.target.id,
      counterparty: action.target.counterparty,
      amount_cents: action.target.amountCents,
      summary: action.summary,
      payload: action.payload ?? null,
      status: evaluation.outcome === "pending" ? "pending" : evaluation.outcome,
      decision_source: evaluation.source,
      decision_reason: evaluation.reason,
      standing_rule_id: evaluation.ruleId,
      decided_by: null,
      comment: null,
      proposed_at: nowIso,
      decided_at: resolved ? nowIso : null,
      committed_at: null,
    };

    const { error } = await db.from("action_requests").insert(row);
    if (error) throw new Error(`Failed to record action "${action.actionKey}": ${error.message}`);

    await writeAudit(db, {
      workflowId,
      stepId,
      actorType: "system",
      actorId: "system",
      action: "action_proposed",
      detail: { ...auditDetail(row), summary: row.summary },
    });
    await writeAudit(db, {
      workflowId,
      stepId,
      actorType: "system",
      actorId: "system",
      action: outcomeAudit(row),
      detail: auditDetail(row),
    });

    if (row.status === "auto_approved" && evaluation.ruleId) {
      await consumeOnceRule(db, rules, evaluation.ruleId, nowIso);
    }

    out.push(row);
  }

  // A grant minted since the last attempt must clear matching pending items with no
  // further human involvement (D-A7). Cheap: only pending rows are touched.
  const updated = await reevaluatePending(db, { workflowId, orgId, policy, rules });
  if (updated.length > 0) {
    const updatedByKey = new Map(updated.map((r) => [r.action_key, r]));
    return out.map((r) => updatedByKey.get(r.action_key) ?? r);
  }
  return out;
}

/** Stamp a `once` grant as used so it can never fire twice (D-A6). */
async function consumeOnceRule(
  db: SupabaseClient,
  rules: ApprovalRule[],
  ruleId: string,
  nowIso: string,
): Promise<void> {
  const rule = rules.find((r) => r.id === ruleId);
  if (!rule || rule.scope !== "once" || rule.consumed_at !== null) return;
  await db.from("approval_rules").update({ consumed_at: nowIso }).eq("id", ruleId);
  rule.consumed_at = nowIso; // keep the in-memory set consistent within this pass
}

/**
 * Re-evaluate every `pending` action of a run. Returns the rows whose status changed
 * (auto-approved by a new grant, or denied by a tightened ceiling — D-A4's "ceiling
 * changes mid-flight"). Already-resolved rows are never touched.
 */
export async function reevaluatePending(
  db: SupabaseClient,
  args: {
    workflowId: string;
    orgId: string;
    policy?: ApprovalPolicy;
    rules?: ApprovalRule[];
  },
): Promise<ActionRequest[]> {
  const { workflowId, orgId } = args;
  const policy = args.policy ?? (await loadPolicy(db, orgId));
  const rules = args.rules ?? (await loadRules(db, orgId));
  const nowIso = new Date().toISOString();

  const pending = (await listActions(db, workflowId)).filter((r) => r.status === "pending");
  const changed: ActionRequest[] = [];

  for (const row of pending) {
    const action: ProposedAction = {
      actionKey: row.action_key,
      actionType: row.action_type,
      riskClass: row.risk_class,
      target: row.target,
      summary: row.summary,
      payload: row.payload ?? undefined,
    };
    const evaluation = evaluateAction({ action, workflowId, policy, rules, nowIso });
    if (evaluation.outcome === "pending") {
      // Reason may have sharpened (e.g. a rule now exists but the ceiling blocks it).
      if (evaluation.reason !== row.decision_reason || evaluation.ruleId !== row.standing_rule_id) {
        await db
          .from("action_requests")
          .update({ decision_reason: evaluation.reason, standing_rule_id: evaluation.ruleId })
          .eq("id", row.id);
      }
      continue;
    }

    const patch = {
      status: evaluation.outcome,
      decision_source: evaluation.source,
      decision_reason: evaluation.reason,
      standing_rule_id: evaluation.ruleId,
      decided_at: nowIso,
    };
    const { error } = await db.from("action_requests").update(patch).eq("id", row.id).eq("status", "pending");
    if (error) throw new Error(`Failed to re-evaluate action "${row.action_key}": ${error.message}`);

    const next: ActionRequest = { ...row, ...patch, status: evaluation.outcome };
    await writeAudit(db, {
      workflowId,
      stepId: row.step_id,
      actorType: "system",
      actorId: "system",
      action: outcomeAudit(next),
      detail: auditDetail(next),
    });
    if (next.status === "auto_approved" && evaluation.ruleId) {
      await consumeOnceRule(db, rules, evaluation.ruleId, nowIso);
    }
    changed.push(next);
  }

  return changed;
}

/* -------------------------------------------------------------------------- */
/* Human resolution (D-A9)                                                     */
/* -------------------------------------------------------------------------- */

export type ResolveResult =
  | { ok: true; row: ActionRequest }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "already_resolved"; row: ActionRequest }
  | { ok: false; reason: "not_overridable"; row: ActionRequest };

/**
 * Resolve one pending action, exactly once. The UPDATE is filtered on
 * `status = 'pending'`: if a concurrent responder won, zero rows come back and the caller
 * is told who resolved it. A `denied` row is never resolvable (D-A4).
 */
export async function resolveAction(
  db: SupabaseClient,
  args: {
    actionId: string;
    workflowId: string;
    decision: "approve" | "reject";
    approverId: string;
    comment?: string | null;
  },
): Promise<ResolveResult> {
  const { data: current, error: loadError } = await db
    .from("action_requests")
    .select("*")
    .eq("id", args.actionId)
    .eq("workflow_id", args.workflowId)
    .maybeSingle<ActionRequest>();
  if (loadError) throw new Error(`Failed to load action: ${loadError.message}`);
  if (!current) return { ok: false, reason: "not_found" };
  if (current.status === "denied") return { ok: false, reason: "not_overridable", row: current };
  if (current.status !== "pending") return { ok: false, reason: "already_resolved", row: current };

  const nowIso = new Date().toISOString();
  const patch = {
    status: args.decision === "approve" ? ("approved" as const) : ("rejected" as const),
    decision_source: "human" as const,
    decision_reason:
      args.decision === "approve"
        ? `Approved by reviewer${args.comment ? `: ${args.comment}` : ""}`
        : `Rejected by reviewer${args.comment ? `: ${args.comment}` : ""}`,
    decided_by: args.approverId,
    comment: args.comment ?? null,
    decided_at: nowIso,
  };

  // Conditional single-row update: the `status = 'pending'` filter is the lock.
  const { data: updated, error } = await db
    .from("action_requests")
    .update(patch)
    .eq("id", args.actionId)
    .eq("status", "pending")
    .select("*")
    .maybeSingle<ActionRequest>();
  if (error) throw new Error(`Failed to resolve action: ${error.message}`);
  if (!updated) {
    // Someone else got there first; report their decision, never overwrite it.
    const { data: winner } = await db
      .from("action_requests")
      .select("*")
      .eq("id", args.actionId)
      .maybeSingle<ActionRequest>();
    return { ok: false, reason: "already_resolved", row: (winner ?? current) as ActionRequest };
  }

  await writeAudit(db, {
    workflowId: args.workflowId,
    stepId: updated.step_id,
    actorType: "human",
    actorId: args.approverId,
    action: "approval_resolved",
    detail: { ...auditDetail(updated), approver: args.approverId, comment: args.comment ?? null },
  });

  return { ok: true, row: updated };
}

/* -------------------------------------------------------------------------- */
/* Commit bookkeeping (D-A15)                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Called by the orchestrator once the gated step has persisted its output: stamp
 * `committed_at` on the actions that were authorized and audit the end of each chain —
 * `action_committed` for the ones that happened, `action_withheld` for the ones the step
 * had to leave out (rejected by a human or denied by a ceiling, D-A5).
 */
export async function markCommitted(
  db: SupabaseClient,
  args: { workflowId: string; stepId: string | null; rows: ActionRequest[] },
): Promise<void> {
  const nowIso = new Date().toISOString();
  for (const row of args.rows) {
    if (isAuthorized(row.status)) {
      await db.from("action_requests").update({ committed_at: nowIso }).eq("id", row.id);
      await writeAudit(db, {
        workflowId: args.workflowId,
        stepId: args.stepId,
        actorType: "system",
        actorId: "system",
        action: "action_committed",
        detail: auditDetail(row),
      });
    } else {
      await writeAudit(db, {
        workflowId: args.workflowId,
        stepId: args.stepId,
        actorType: "system",
        actorId: "system",
        action: "action_withheld",
        detail: auditDetail(row),
      });
    }
  }
}

/** Compact one-line description of a grant, for API responses and audit details. */
export { ruleSummary };
