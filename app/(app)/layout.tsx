import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AppNavigation } from "@/components/AppNavigation";
import { WorkspaceActivity } from "@/components/WorkspaceActivity";
async function signOut() {
  "use server";
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const { data: org } = await supabase
    .from("organizations")
    .select("id,name")
    .limit(1)
    .maybeSingle();
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <WorkspaceActivity identity={`${org?.id ?? "workspace"}:${user.id}`} />
      <a className="skip-link" href="#workspace-main">
        Skip to workspace content
      </a>
      <AppNavigation
        email={user.email ?? ""}
        organization={org?.name ?? "Finance workspace"}
        signOut={signOut}
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
  );
}
