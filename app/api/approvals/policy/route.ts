/**
 * The org's authorization policy — the structural ceilings (Plan 3 §5, D-A4/D-A8).
 *
 * `GET /api/approvals/policy` — any org member (nothing secret here; the settings page
 *   also reads it under RLS).
 * `PUT /api/approvals/policy` — admin-only. Upserts the single row and stamps
 *   `updated_by` / `updated_at`, which is what the settings UI shows as the change record
 *   (audit_log is workflow-scoped, D-A15).
 *
 * These ceilings are the one thing in the product that an in-band approval click cannot
 * override, so they are deliberately admin-only and validated: an auto-approve ceiling
 * above the hard deny ceiling would be incoherent and is rejected.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { jsonError, requireOrgAccess } from "@/lib/api/guard";
import { loadPolicy } from "@/lib/approvals/service";

const centsSchema = z.number().int().positive().nullable().optional();

const bodySchema = z.object({
  hard_deny_above_cents: centsSchema,
  auto_approve_max_cents: centsSchema,
  require_known_counterparty: z.boolean().optional(),
  approved_counterparties: z.array(z.string().trim().min(1)).max(500).optional(),
  require_separate_approver: z.boolean().optional(),
});

export async function GET() {
  const g = await requireOrgAccess();
  if (!g.ok) return g.response;
  const { admin, profile } = g;

  const policy = await loadPolicy(admin, profile.org_id);
  return NextResponse.json({ policy, canEdit: profile.role === "admin" });
}

export async function PUT(req: NextRequest) {
  const g = await requireOrgAccess();
  if (!g.ok) return g.response;
  const { admin, profile } = g;
  if (profile.role !== "admin") return jsonError("Admin role required", 403);

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("Invalid policy body", 400);
  const input = parsed.data;

  const current = await loadPolicy(admin, profile.org_id);
  const next = {
    hard_deny_above_cents:
      input.hard_deny_above_cents !== undefined ? input.hard_deny_above_cents : current.hard_deny_above_cents,
    auto_approve_max_cents:
      input.auto_approve_max_cents !== undefined ? input.auto_approve_max_cents : current.auto_approve_max_cents,
    require_known_counterparty:
      input.require_known_counterparty ?? current.require_known_counterparty,
    approved_counterparties: dedupe(input.approved_counterparties ?? current.approved_counterparties),
    require_separate_approver: input.require_separate_approver ?? current.require_separate_approver,
  };

  if (
    next.hard_deny_above_cents !== null &&
    next.auto_approve_max_cents !== null &&
    next.auto_approve_max_cents > next.hard_deny_above_cents
  ) {
    return jsonError(
      "The auto-approve ceiling cannot exceed the hard deny ceiling — actions above the hard ceiling can never be authorized.",
      400,
    );
  }
  if (next.require_known_counterparty && next.approved_counterparties.length === 0) {
    return jsonError(
      "Add at least one approved counterparty before requiring the allowlist — otherwise every action would be denied.",
      400,
    );
  }

  const { error } = await admin.from("org_approval_policies").upsert(
    {
      org_id: profile.org_id,
      ...next,
      updated_by: profile.id,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "org_id" },
  );
  if (error) return jsonError(`Failed to save policy: ${error.message}`, 500);

  return NextResponse.json({ policy: await loadPolicy(admin, profile.org_id) });
}

/** Case-insensitive de-dupe, preserving the first spelling the admin typed. */
function dedupe(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (name.length === 0) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}
