/**
 * Standing grants (Plan 3 §5, D-A6/D-A7).
 *
 * `GET  /api/approvals/rules` — the org's grants (any member), newest first, each with a
 *   human-readable binding and its live/expired/revoked/consumed state.
 * `POST /api/approvals/rules` — mint one (admin-only). `validateRuleInput` is the gate:
 *   an unbounded standing grant is rejected here, so "auto-approve this action type for
 *   anything" cannot be expressed from any surface.
 *
 * Minting from Settings is org-level, so the record of who minted it lives on the row
 * (`created_by`/`created_at`) rather than in the workflow-scoped audit log (D-A15).
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { jsonError, requireOrgAccess } from "@/lib/api/guard";
import { ruleState, validateRuleInput } from "@/lib/approvals/engine";
import { ruleSummary } from "@/lib/approvals/service";
import { ACTION_TYPE_SPECS } from "@/lib/approvals/action-types";
import { ruleScopeEnum, type ApprovalRule, type ApprovalRuleInput } from "@/lib/types";

const bodySchema = z.object({
  scope: ruleScopeEnum,
  action_type: z.string().trim().min(1),
  target_kind: z.string().trim().min(1).optional(),
  workflow_id: z.string().uuid().nullable().optional(),
  target_id: z.string().trim().min(1).nullable().optional(),
  counterparty: z.string().trim().min(1).nullable().optional(),
  max_amount_cents: z.number().int().positive().nullable().optional(),
  expires_at: z.string().nullable().optional(),
  note: z.string().trim().nullable().optional(),
});

export async function GET() {
  const g = await requireOrgAccess();
  if (!g.ok) return g.response;
  const { admin, profile } = g;

  const { data, error } = await admin
    .from("approval_rules")
    .select("*")
    .eq("org_id", profile.org_id)
    .order("created_at", { ascending: false });
  if (error) return jsonError(`Failed to load rules: ${error.message}`, 500);

  const rules = (data ?? []) as ApprovalRule[];
  const nowIso = new Date().toISOString();
  return NextResponse.json({
    rules: rules.map((r) => ({
      ...r,
      binding: ruleSummary(r),
      state: ruleState(r, nowIso),
    })),
    canEdit: profile.role === "admin",
    actionTypes: ACTION_TYPE_SPECS,
  });
}

export async function POST(req: NextRequest) {
  const g = await requireOrgAccess();
  if (!g.ok) return g.response;
  const { admin, profile } = g;
  if (profile.role !== "admin") return jsonError("Admin role required", 403);

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("Invalid rule body", 400);
  const body = parsed.data;

  // The target kind is derived from the action-type registry when not given, so a rule
  // can never be minted against a target kind that action type never produces.
  const spec = ACTION_TYPE_SPECS.find((s) => s.id === body.action_type);
  const targetKind = body.target_kind ?? spec?.targetKind;
  if (!targetKind) return jsonError("Unknown action_type — cannot infer its target kind", 400);

  const input: ApprovalRuleInput = {
    scope: body.scope,
    workflow_id: body.scope === "standing" ? null : (body.workflow_id ?? null),
    action_type: body.action_type,
    target_kind: targetKind,
    target_id: body.target_id ?? null,
    counterparty: body.counterparty ?? null,
    max_amount_cents: body.max_amount_cents ?? null,
    expires_at: body.expires_at ?? null,
    note: body.note ?? null,
  };
  const invalid = validateRuleInput(input);
  if (invalid) return jsonError(invalid, 400);

  const { data, error } = await admin
    .from("approval_rules")
    .insert({ org_id: profile.org_id, ...input, created_by: profile.id })
    .select("*")
    .single<ApprovalRule>();
  if (error || !data) return jsonError(`Failed to create rule: ${error?.message ?? "unknown"}`, 500);

  return NextResponse.json(
    { rule: { ...data, binding: ruleSummary(data), state: "live" } },
    { status: 201 },
  );
}
