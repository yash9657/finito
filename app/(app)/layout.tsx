import Link from "next/link";
import { redirect } from "next/navigation";
import { LayoutDashboard, Plus, Settings, Cpu, ShieldCheck, LogOut } from "lucide-react";
import { createClient } from "@/lib/supabase/server";

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

  if (!user) {
    redirect("/login");
  }

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <aside className="flex w-56 flex-col border-r border-border bg-card">
        <div className="flex h-14 items-center px-5">
          <Link
            href="/dashboard"
            className="flex items-center gap-2 text-lg font-semibold tracking-tight"
          >
            <span className="h-2 w-2 rounded-full bg-accent" />
            FinFlow
          </Link>
        </div>

        <nav className="flex flex-1 flex-col gap-1 px-3 py-2">
          <Link
            href="/dashboard"
            className="flex items-center gap-3 rounded-md px-3 py-2 text-sm text-foreground transition-colors hover:bg-border"
          >
            <LayoutDashboard className="h-4 w-4 text-muted" />
            Dashboard
          </Link>
          <Link
            href="/workflows/new"
            className="flex items-center gap-3 rounded-md px-3 py-2 text-sm text-foreground transition-colors hover:bg-border"
          >
            <Plus className="h-4 w-4 text-muted" />
            New workflow
          </Link>
          <Link
            href="/settings/models"
            className="flex items-center gap-3 rounded-md px-3 py-2 text-sm text-foreground transition-colors hover:bg-border"
          >
            <Cpu className="h-4 w-4 text-muted" />
            Models
          </Link>
          <Link
            href="/settings/approvals"
            className="flex items-center gap-3 rounded-md px-3 py-2 text-sm text-foreground transition-colors hover:bg-border"
          >
            <ShieldCheck className="h-4 w-4 text-muted" />
            Approvals
          </Link>
          <Link
            href="/settings"
            className="flex items-center gap-3 rounded-md px-3 py-2 text-sm text-foreground transition-colors hover:bg-border"
          >
            <Settings className="h-4 w-4 text-muted" />
            Settings
          </Link>
        </nav>

        <div className="border-t border-border px-3 py-3">
          <p className="truncate px-3 pb-2 font-mono text-xs text-muted">
            {user.email}
          </p>
          <form action={signOut}>
            <button
              type="submit"
              className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-foreground transition-colors hover:bg-border"
            >
              <LogOut className="h-4 w-4 text-muted" />
              Sign out
            </button>
          </form>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
