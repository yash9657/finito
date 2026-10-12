import Link from "next/link";
import { redirect } from "next/navigation";
import { LogOut, Cpu, ShieldCheck, BookOpen, ChevronRight } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Organization, Profile, ProfileRole } from "@/lib/types";

async function signOut() {
  "use server";
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

const ROLE_VARIANT: Record<ProfileRole, "accent" | "warning" | "muted"> = {
  admin: "accent",
  reviewer: "warning",
  analyst: "muted",
};

export default async function SettingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // RLS scopes both reads to the caller's org.
  const [
    { data: orgData, error: orgError },
    { data: membersData, error: membersError },
  ] = await Promise.all([
    supabase
      .from("organizations")
      .select("id, name, created_at")
      .limit(1)
      .maybeSingle<Organization>(),
    supabase
      .from("profiles")
      .select("id, email, org_id, role, created_at")
      .order("created_at", { ascending: true }),
  ]);

  const members = (membersData ?? []) as Profile[];

  return (
    <div className="page-container min-w-0">
      <header className="mb-10">
        <h1 className="page-title">Workspace settings</h1>
        <p className="page-description">
          Your organization, its members, and the controls behind every
          workflow.
        </p>
      </header>

      <section className="mb-10 border-y border-border py-6">
        <h2 className="mb-2 text-sm text-muted">Organization</h2>
        {orgError ? (
          <p role="alert" className="text-sm text-error">
            Unable to load organization details. Refresh this page to try again.
          </p>
        ) : (
          <p className="break-words text-xl font-medium">
            {orgData?.name ?? "No organization found"}
          </p>
        )}
      </section>

      <nav
        aria-label="Workspace configuration"
        className="mb-10 divide-y divide-border border-b border-border"
      >
        <Link
          href="/settings/models"
          className="group flex min-w-0 items-start gap-4 py-5 transition-colors hover:text-accent"
        >
          <Cpu
            aria-hidden="true"
            className="mt-1 h-5 w-5 shrink-0 text-muted"
            strokeWidth={1.75}
          />
          <div className="min-w-0 flex-1">
            <h2 className="font-medium">Models & usage</h2>
            <p className="mt-1 text-sm leading-6 text-muted">
              Connect providers, choose workflow models, and review model usage.
            </p>
          </div>
          <ChevronRight
            aria-hidden="true"
            className="mt-1 h-5 w-5 shrink-0 text-muted"
          />
        </Link>
        <Link
          href="/settings/approvals"
          className="group flex min-w-0 items-start gap-4 py-5 transition-colors hover:text-accent"
        >
          <ShieldCheck
            aria-hidden="true"
            className="mt-1 h-5 w-5 shrink-0 text-muted"
            strokeWidth={1.75}
          />
          <div className="min-w-0 flex-1">
            <h2 className="font-medium">Approval controls</h2>
            <p className="mt-1 text-sm leading-6 text-muted">
              Set amount limits, approved counterparties, reviewer requirements,
              and standing rules.
            </p>
          </div>
          <ChevronRight
            aria-hidden="true"
            className="mt-1 h-5 w-5 shrink-0 text-muted"
          />
        </Link>
        <Link
          href="/settings/memory"
          className="group flex min-w-0 items-start gap-4 py-5 transition-colors hover:text-accent"
        >
          <BookOpen
            aria-hidden="true"
            className="mt-1 h-5 w-5 shrink-0 text-muted"
            strokeWidth={1.75}
          />
          <div className="min-w-0 flex-1">
            <h2 className="font-medium">Memory & history</h2>
            <p className="mt-1 text-sm leading-6 text-muted">
              Manage your saved preferences and find previous questions and
              files.
            </p>
          </div>
          <ChevronRight
            aria-hidden="true"
            className="mt-1 h-5 w-5 shrink-0 text-muted"
          />
        </Link>
      </nav>

      <section className="mb-10">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-medium">Members</h2>
          <span className="text-sm text-muted">
            {members.length} {members.length === 1 ? "member" : "members"}
          </span>
        </div>
        {membersError ? (
          <p role="alert" className="py-5 text-sm text-error">
            Unable to load members. Refresh this page to try again.
          </p>
        ) : members.length === 0 ? (
          <p className="py-5 text-sm text-muted">No members found.</p>
        ) : (
          <ul className="divide-y divide-border border-y border-border">
            {members.map((m) => (
              <li
                key={m.id}
                className="flex min-w-0 flex-col gap-2 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
              >
                <p className="min-w-0 break-all text-sm">
                  {m.email}
                  {m.id === user?.id && (
                    <span className="ml-2 text-muted">(you)</span>
                  )}
                </p>
                <Badge
                  className="w-fit shrink-0"
                  variant={ROLE_VARIANT[m.role]}
                >
                  {m.role}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </section>

      <form action={signOut}>
        <Button type="submit" variant="outline">
          <LogOut aria-hidden="true" className="h-4 w-4" />
          Sign out
        </Button>
      </form>
    </div>
  );
}
