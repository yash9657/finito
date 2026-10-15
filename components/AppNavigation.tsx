"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { SignOutButton } from "@clerk/nextjs";
import { useEffect, useState } from "react";
import {
  LayoutDashboard,
  Plus,
  Settings,
  Cpu,
  ShieldCheck,
  Search,
  Menu,
  X,
  LogOut,
  ArrowUpRight,
  Files,
} from "lucide-react";
import { Brand } from "@/components/Brand";
const primary = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/workflows/new", label: "New workflow", icon: Plus },
  { href: "/investigations", label: "Ask your data", icon: Search },
  { href: "/data", label: "Your data", icon: Files },
];
const management = [
  { href: "/settings/models", label: "Models & usage", icon: Cpu },
  {
    href: "/settings/approvals",
    label: "Approval controls",
    icon: ShieldCheck,
  },
  { href: "/settings", label: "Workspace settings", icon: Settings },
];
export function AppNavigation({
  email,
  organization,
}: {
  email: string;
  organization: string;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);
  const links = (items: typeof primary) =>
    items.map(({ href, label, icon: Icon }) => {
      const active =
        href === "/settings"
          ? pathname === href
          : pathname === href ||
            (href === "/investigations" &&
              pathname.startsWith("/investigations/"));
      return (
        <Link
          key={href}
          href={href}
          onClick={() => setOpen(false)}
          aria-current={active ? "page" : undefined}
          className={`flex min-h-11 items-center gap-3 rounded-md px-3 text-[13px] transition-colors ${active ? "bg-card-hover text-foreground" : "text-muted hover:bg-card-hover hover:text-foreground"}`}
        >
          <Icon size={17} strokeWidth={1.7} />
          {label}
        </Link>
      );
    });
  return (
    <>
      <div className="no-print flex h-16 items-center justify-between border-b border-border bg-card px-5 md:hidden">
        <Brand href="/dashboard" />
        <button
          type="button"
          aria-expanded={open}
          aria-controls="workspace-nav"
          aria-label={open ? "Close navigation" : "Open navigation"}
          className="flex h-11 w-11 items-center justify-center"
          onClick={() => setOpen(!open)}
        >
          {open ? <X size={22} /> : <Menu size={22} />}
        </button>
      </div>
      <aside
        id="workspace-nav"
        className={`${open ? "flex" : "hidden"} no-print z-30 w-full flex-col border-b border-border bg-card md:fixed md:inset-y-0 md:flex md:w-[var(--sidebar-width)] md:border-b-0 md:border-r`}
      >
        <div className="hidden h-20 items-center px-6 md:flex">
          <Brand href="/dashboard" />
        </div>
        <div className="mx-4 mb-5 hidden border-b border-border px-2 pb-5 md:block">
          <span className="mb-1 block text-xs text-muted">Workspace</span>
          <span
            className="block truncate text-sm font-medium"
            title={organization}
          >
            {organization}
          </span>
        </div>
        <nav
          className="flex flex-1 flex-col px-3 py-3 md:py-0"
          aria-label="Workspace"
        >
          <div className="space-y-1">{links(primary)}</div>
          <div className="mb-2 mt-7 px-3 text-xs font-medium text-muted">
            Manage
          </div>
          <div className="space-y-1">{links(management)}</div>
          <Link
            href="/"
            className="mt-6 flex min-h-11 items-center justify-between px-3 text-xs text-muted hover:text-foreground md:mt-auto md:mb-5"
          >
            About FinFlow
            <ArrowUpRight size={14} />
          </Link>
        </nav>
        <div className="border-t border-border p-4">
          <p className="truncate px-2 text-xs text-muted" title={email}>
            {email}
          </p>
          <SignOutButton redirectUrl="/login">
            <button
              type="button"
              className="mt-2 flex min-h-11 w-full items-center gap-3 rounded-md px-2 text-xs text-muted hover:bg-card-hover hover:text-foreground"
            >
              <LogOut size={15} />
              Sign out
            </button>
          </SignOutButton>
        </div>
      </aside>
    </>
  );
}
