import Link from "next/link";
import {
  ArrowUpRight,
  ArrowRight,
  Search,
  Plus,
  Scale,
  FileCheck2,
  ChartNoAxesCombined,
} from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDate, formatTime } from "@/lib/format";
import type { WorkflowStatus, WorkflowType } from "@/lib/types";
const TYPES: Record<
  WorkflowType,
  { name: string; description: string; icon: typeof Scale }
> = {
  reconciliation: {
    name: "Reconciliation",
    description: "ERP export & bank statement",
    icon: Scale,
  },
  ap_matching: {
    name: "Invoice matching",
    description: "Invoices & purchase orders",
    icon: FileCheck2,
  },
  fpa_commentary: {
    name: "Variance analysis",
    description: "Budget & actuals",
    icon: ChartNoAxesCombined,
  },
};
const STATUSES: Record<
  WorkflowStatus,
  {
    label: string;
    variant: "muted" | "running" | "warning" | "accent" | "error";
  }
> = {
  idle: { label: "Ready to run", variant: "muted" },
  running: { label: "In progress", variant: "running" },
  awaiting_approval: { label: "Needs authorization", variant: "warning" },
  awaiting_review: { label: "Ready for review", variant: "warning" },
  approved: { label: "Approved", variant: "accent" },
  rejected: { label: "Rejected", variant: "error" },
  error: { label: "Needs attention", variant: "error" },
};
interface WorkflowListRow {
  id: string;
  name: string;
  type: WorkflowType;
  status: WorkflowStatus;
  created_at: string;
}
interface FeedRow {
  id: number;
  actor_type: string;
  action: string;
  created_at: string;
  workflow: { name: string } | null;
}
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const params = await searchParams;
  const q = (params.q ?? "").trim().slice(0, 100);
  const parsedPage = Number(params.page);
  const page =
    Number.isSafeInteger(parsedPage) && parsedPage > 0
      ? Math.min(parsedPage, 10000)
      : 1;
  const pageSize = 20;
  const db = await createClient();
  let query = db
    .from("workflows")
    .select("id,name,type,status,created_at", { count: "exact" })
    .neq("type", "investigation")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range((page - 1) * pageSize, page * pageSize - 1);
  if (q) query = query.ilike("name", `%${q.replace(/[\\%_]/g, "\\$&")}%`);
  const [list, activity, review, running, approved] = await Promise.all([
    query,
    db
      .from("audit_log")
      .select("id,actor_type,action,created_at,workflow:workflows(name)")
      .order("created_at", { ascending: false })
      .limit(8),
    db
      .from("workflows")
      .select("id", { count: "exact", head: true })
      .neq("type", "investigation")
      .in("status", ["awaiting_approval", "awaiting_review"]),
    db
      .from("workflows")
      .select("id", { count: "exact", head: true })
      .neq("type", "investigation")
      .eq("status", "running"),
    db
      .from("workflows")
      .select("id", { count: "exact", head: true })
      .neq("type", "investigation")
      .eq("status", "approved"),
  ]);
  if (
    list.error ||
    activity.error ||
    review.error ||
    running.error ||
    approved.error
  )
    throw new Error("Workspace data unavailable");
  const workflows = (list.data ?? []) as WorkflowListRow[];
  const feed = (activity.data ?? []) as unknown as FeedRow[];
  const total = list.count ?? 0;
  const pageLink = (p: number) =>
    `/dashboard?${new URLSearchParams({ ...(q ? { q } : {}), page: String(p) })}`;
  return (
    <div className="page-container">
      <header className="mb-9 flex flex-wrap items-start justify-between gap-5">
        <div>
          <h1 className="page-title">Your close, in view.</h1>
          <p className="mt-2 text-sm text-muted">
            The work in motion. The decisions that need you.
          </p>
        </div>
        <Link href="/workflows/new" className="cta">
          <Plus size={16} />
          New workflow
        </Link>
      </header>
      <dl className="mb-10 grid grid-cols-3 border-y border-border py-6">
        {[
          [review.count ?? 0, "Awaiting your review"],
          [running.count ?? 0, "In progress"],
          [approved.count ?? 0, "Approved workflows"],
        ].map(([value, label]) => (
          <div
            key={label}
            className="border-r border-border px-4 first:pl-0 last:border-0 sm:px-7"
          >
            <dt className="text-xs text-muted">{label}</dt>
            <dd className="mt-3 text-3xl font-light tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      <section className="mb-10">
        <h2 className="section-label mb-4">Start from your source files</h2>
        <div className="grid gap-x-6 md:grid-cols-3">
          {Object.entries(TYPES).map(
            ([type, { name, description, icon: Icon }]) => (
              <Link
                href={`/workflows/new?type=${type}`}
                key={type}
                className="group flex items-center gap-3 border-b border-border py-5 transition-colors hover:text-accent"
              >
                <Icon className="text-muted" size={20} strokeWidth={1.5} />
                <div className="flex-1">
                  <h3 className="text-sm font-medium tracking-normal">
                    {name}
                  </h3>
                  <p className="mt-1 text-xs text-muted">{description}</p>
                </div>
                <ArrowUpRight
                  size={16}
                  className="text-muted group-hover:text-accent"
                />
              </Link>
            ),
          )}
        </div>
      </section>
      <section>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
          <h2 className="text-lg font-medium">
            Workflows{" "}
            <span className="ml-1 text-sm font-normal text-muted">{total}</span>
          </h2>
          <form
            action="/dashboard"
            className="flex items-center gap-2 rounded-md border border-border bg-card px-3"
          >
            <Search size={15} className="text-muted" />
            <input
              aria-label="Search workflows by name"
              name="q"
              defaultValue={q}
              placeholder="Find a workflow…"
              className="h-10 w-44 bg-transparent text-sm outline-none"
            />
            <button
              type="submit"
              aria-label="Search workflows"
              className="flex h-10 w-8 items-center justify-center text-muted hover:text-foreground"
            >
              <ArrowRight size={16} />
            </button>
          </form>
        </div>
        <Card className="overflow-hidden">
          {!workflows.length ? (
            <div className="px-6 py-14 text-center">
              <h3 className="text-lg">
                {q
                  ? "No workflows match your search."
                  : "Your next close starts here."}
              </h3>
              <p className="mx-auto mb-6 mt-2 max-w-md text-sm leading-6 text-muted">
                {q
                  ? "Try a different name, or clear the search to see all workflows."
                  : "Choose a workflow and upload your source files. FinFlow will prepare the analysis for your review."}
              </p>
              <Link
                className="inline-flex min-h-11 items-center gap-2 text-sm text-accent"
                href={q ? "/dashboard" : "/workflows/new"}
              >
                {q ? "Clear search" : "Create your first workflow"}
                <ArrowRight size={16} />
              </Link>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Workflow</TableHead>
                  <TableHead className="hidden sm:table-cell">Process</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden text-right lg:table-cell">Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {workflows.map((w) => (
                  <TableRow key={w.id}>
                    <TableCell className="sm:min-w-48">
                      <Link
                        href={`/workflows/${w.id}`}
                        className="block py-2 font-medium hover:text-accent"
                      >
                        {w.name}
                      </Link>
                    </TableCell>
                    <TableCell className="hidden text-muted sm:table-cell">
                      {TYPES[w.type]?.name ?? w.type}
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUSES[w.status].variant}>
                        {STATUSES[w.status].label}
                      </Badge>
                    </TableCell>
                    <TableCell className="hidden whitespace-nowrap text-right font-mono text-xs text-muted lg:table-cell">
                      {formatDate(w.created_at)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
        {(total > pageSize || page > 1) && (
          <div className="mt-4 flex items-center justify-between text-sm text-muted">
            <span>
              Page {page} · {total} workflows
            </span>
            <div className="flex gap-5">
              {page > 1 && (
                <Link
                  href={pageLink(page - 1)}
                  className="py-2 hover:text-foreground"
                >
                  Previous
                </Link>
              )}
              {page * pageSize < total && (
                <Link
                  href={pageLink(page + 1)}
                  className="py-2 hover:text-foreground"
                >
                  Next
                </Link>
              )}
            </div>
          </div>
        )}
      </section>
      <section className="mt-10">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-medium">Recent activity</h2>
          <span className="text-xs text-muted">Latest 8 events</span>
        </div>
        {feed.length ? (
          <div className="divide-y divide-border border-y border-border">
            {feed.map((r) => (
              <div
                key={r.id}
                className="grid grid-cols-[64px_1fr] items-center gap-x-4 gap-y-2 py-4 text-xs sm:flex sm:flex-wrap"
              >
                <span className="min-w-16 font-mono text-muted">
                  {formatTime(r.created_at)}
                </span>
                <span className="min-w-36 capitalize">
                  {r.action.replaceAll("_", " ")}
                </span>
                <span className="col-span-2 min-w-0 flex-1 text-muted">
                  {r.workflow?.name}
                </span>
                <span className="text-muted">
                  {r.actor_type === "agent"
                    ? "Agent"
                    : r.actor_type === "human"
                      ? "Team member"
                      : "System"}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="border-t border-border py-6 text-sm text-muted">
            Workflow activity and review decisions will appear here.
          </p>
        )}
      </section>
    </div>
  );
}
