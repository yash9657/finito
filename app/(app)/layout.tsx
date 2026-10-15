import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { SignOutButton } from "@clerk/nextjs";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/auth";
import { AppNavigation } from "@/components/AppNavigation";
import { WorkspaceActivity } from "@/components/WorkspaceActivity";
import { Button } from "@/components/ui/button";
import { AuthProvider } from "@/components/AuthProvider";

// Per-user pages: never prerendered, and the build has no Clerk keys.
export const dynamic = "force-dynamic";
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const profile = await getCurrentProfile();
  if (!profile) {
    if (!(await auth()).userId) redirect("/login");
    // Signed in, but no workspace: a redirect to /login would bounce straight back here.
    return (
      <AuthProvider>
        <main className="page-container">
          <h1 className="page-title">We couldn&apos;t open your workspace.</h1>
          <p className="page-description">
            Your account needs a verified email address. Sign out and sign in
            again, or try again in a moment.
          </p>
          <SignOutButton redirectUrl="/login">
            <Button variant="outline" className="mt-6">
              Sign out
            </Button>
          </SignOutButton>
        </main>
      </AuthProvider>
    );
  }
  const supabase = await createClient();
  const { data: org } = await supabase
    .from("organizations")
    .select("id,name")
    .limit(1)
    .maybeSingle();
  return (
    <AuthProvider>
      <div className="min-h-dvh bg-background text-foreground">
        <WorkspaceActivity
          identity={`${org?.id ?? "workspace"}:${profile.id}`}
        />
        <a className="skip-link" href="#workspace-main">
          Skip to workspace content
        </a>
        <AppNavigation
          email={profile.email}
          organization={org?.name ?? "Finance workspace"}
        />
        <div className="md:pl-[var(--sidebar-width)]">
          <header className="no-print hidden h-16 items-center justify-between border-b border-border px-9 text-xs text-muted md:flex">
            <span>Finance workspace</span>
            <span>Source. Evidence. Decision.</span>
          </header>
          <main id="workspace-main" className="min-w-0">
            {children}
          </main>
        </div>
      </div>
    </AuthProvider>
  );
}
