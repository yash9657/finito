import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getCurrentProfile } from "@/lib/auth";
import ApprovalsManager from "@/components/settings/ApprovalsManager";

/**
 * Settings → Approvals (Plan 3 §6) — server shell. Resolves the caller's role to gate the
 * mutating UI (the API enforces regardless); the policy and the standing grants are
 * fetched client-side from /api/approvals/*.
 */
export default async function ApprovalsSettingsPage() {
  const isAdmin = (await getCurrentProfile())?.role === "admin";

  return (
    <div className="page-container min-w-0">
      <header className="mb-8">
        <Link
          href="/settings"
          className="mb-3 inline-flex min-h-11 items-center gap-2 text-sm text-muted transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to settings
        </Link>
        <h1 className="page-title">Approval controls</h1>
        <p className="page-description max-w-3xl">
          Define who can authorize actions and which limits your organization
          enforces. These controls record authorization; they do not send
          payments.
          {!isAdmin &&
            " You have read-only access; ask an admin to make changes."}
        </p>
      </header>

      <ApprovalsManager isAdmin={isAdmin} />
    </div>
  );
}
