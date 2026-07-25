import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import ApprovalsManager from "@/components/settings/ApprovalsManager";
import type { Profile } from "@/lib/types";

/**
 * Settings → Approvals (Plan 3 §6) — server shell. Resolves the caller's role to gate the
 * mutating UI (the API enforces regardless); the policy and the standing grants are
 * fetched client-side from /api/approvals/*.
 */
export default async function ApprovalsSettingsPage() {
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
        <h1 className="text-2xl font-semibold tracking-tight">Approvals</h1>
        <p className="mt-1 text-sm text-muted">
          Ceilings your organization enforces before any human is asked, and the standing
          rules that let routine actions proceed without one. With no policy and no rules,
          every consequential action is decided by a person.
          {!isAdmin && " You have read-only access; ask an admin to make changes."}
        </p>
      </header>

      <ApprovalsManager isAdmin={isAdmin} />
    </div>
  );
}
