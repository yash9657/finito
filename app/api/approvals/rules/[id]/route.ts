/**
 * `DELETE /api/approvals/rules/[id]` — revoke a grant (Plan 3 §5, D-A6/D-A7).
 *
 * Soft, always: `revoked_at` + `revoked_by` are stamped and the row stays, because past
 * auto-approvals point at the rule that authorized them and an audit trail that loses its
 * authority reference is worthless. Revocation takes effect immediately — the engine skips
 * revoked rules — but it never retroactively un-approves an action that already cleared.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { jsonError, requireOrgAccess } from "@/lib/api/guard";
import type { ApprovalRule } from "@/lib/types";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const g = await requireOrgAccess();
  if (!g.ok) return g.response;
  const { admin, profile } = g;
  if (profile.role !== "admin") return jsonError("Admin role required", 403);

  const { data: rule } = await admin
    .from("approval_rules")
    .select("*")
    .eq("id", id)
    .eq("org_id", profile.org_id)
    .maybeSingle<ApprovalRule>();
  if (!rule) return jsonError("Rule not found", 404);
  if (rule.revoked_at !== null) {
    return NextResponse.json({ ok: true, alreadyRevoked: true });
  }

  const { error } = await admin
    .from("approval_rules")
    .update({ revoked_at: new Date().toISOString(), revoked_by: profile.id })
    .eq("id", id)
    .eq("org_id", profile.org_id);
  if (error) return jsonError(`Failed to revoke rule: ${error.message}`, 500);

  return NextResponse.json({ ok: true });
}
