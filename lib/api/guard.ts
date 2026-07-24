import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Profile, Workflow } from "@/lib/types";

/**
 * Tiny helper: a JSON error response with the FinFlow `{ error }` shape (§10).
 */
export function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Result of the workflow access guard.
 * On success the caller gets the admin client (service-role, RLS-bypassing) plus
 * the resolved profile + workflow. Every route handler MUST call this first and,
 * on `ok === false`, immediately `return g.response`.
 */
export type WorkflowAccess =
  | {
      ok: true;
      admin: SupabaseClient;
      profile: Profile;
      workflow: Workflow;
    }
  | { ok: false; response: NextResponse };

/**
 * Auth + org-scope gate for `/api/workflows/[id]/*` routes (§10, D5).
 *
 * 1. Resolve the signed-in user via the cookie-scoped server client. None → 401.
 * 2. Load the caller's profile (org_id) via the admin client. Missing → 401.
 * 3. Load the workflow by id via the admin client. Missing → 404.
 * 4. Enforce `workflow.org_id === profile.org_id`. Mismatch → 403.
 */
export async function requireWorkflowAccess(
  workflowId: string,
): Promise<WorkflowAccess> {
  const supabase = await createClient();

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return { ok: false, response: jsonError("Not authenticated", 401) };
  }

  const admin = createAdminClient();

  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle<Profile>();

  if (profileError || !profile) {
    return { ok: false, response: jsonError("Profile not found", 401) };
  }

  const { data: workflow, error: workflowError } = await admin
    .from("workflows")
    .select("*")
    .eq("id", workflowId)
    .maybeSingle<Workflow>();

  if (workflowError || !workflow) {
    return { ok: false, response: jsonError("Workflow not found", 404) };
  }

  if (workflow.org_id !== profile.org_id) {
    return { ok: false, response: jsonError("Forbidden", 403) };
  }

  return { ok: true, admin, profile, workflow };
}
