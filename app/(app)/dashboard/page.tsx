import Link from "next/link";
import { Scale, FileCheck2, LineChart, ArrowRight } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDate, formatTime } from "@/lib/format";
import type {
  ActorType,
  FileType,
  WorkflowStatus,
  WorkflowType,
} from "@/lib/types";

/* ---- static type / file metadata (mirrors §7/§8/§9 + create route labels) ---- */

const TYPE_LABELS: Record<WorkflowType, string> = {
  reconciliation: "Reconciliation",
  ap_matching: "AP Matching",
  fpa_commentary: "FP&A Commentary",
};

const TYPE_DESCRIPTIONS: Record<WorkflowType, string> = {
  reconciliation: "Match ERP transactions against the bank statement and flag exceptions.",
  ap_matching: "Match invoices to purchase orders and build an approval queue.",
  fpa_commentary: "Compute budget-vs-actual variances with CFO-level commentary.",
};

const TYPE_ICONS: Record<WorkflowType, typeof Scale> = {
  reconciliation: Scale,
  ap_matching: FileCheck2,
  fpa_commentary: LineChart,
};

const REQUIRED_FILES: Record<WorkflowType, FileType[]> = {
  reconciliation: ["erp_export", "bank_statement"],
  ap_matching: ["po", "invoice"],
  fpa_commentary: ["budget", "actuals"],
};

const FILE_LABELS: Record<FileType, string> = {
  erp_export: "ERP Export",
  bank_statement: "Bank Statement",
  po: "Purchase Orders",
  invoice: "Invoices",
  budget: "Budget",
  actuals: "Actuals",
};

const QUICK_LAUNCH: WorkflowType[] = [
  "reconciliation",
  "ap_matching",
  "fpa_commentary",
];

/* ---- status badge (§11.3 colors) ---- */

function StatusBadge({ status }: { status: WorkflowStatus }) {
  if (status === "running") {
    return (
      <Badge variant="running">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-running opacity-75" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-running" />
        </span>
        running
      </Badge>
    );
  }
  const variant: Record<
    Exclude<WorkflowStatus, "running">,
    "muted" | "warning" | "accent" | "error"
  > = {
    idle: "muted",
    awaiting_review: "warning",
    approved: "accent",
    rejected: "error",
    error: "error",
  };
  return <Badge variant={variant[status]}>{status}</Badge>;
}

/* ---- activity feed row shapes (RLS-scoped join) ---- */

interface WorkflowListRow {
  id: string;
  name: string;
  type: WorkflowType;
  status: WorkflowStatus;
  created_at: string;
}

interface FeedRow {
  id: number;
  actor_type: ActorType;
  action: string;
  created_at: string;
  workflow: { name: string } | null;
  step: { name: string } | null;
}

const ACTOR_COLOR: Record<ActorType, string> = {
  agent: "text-accent",
  human: "text-running",
  system: "text-muted",
};

export default async function DashboardPage() {
  const supabase = await createClient();

  // RLS scopes both reads to the caller's org.
  const [{ data: workflowsData }, { data: feedData }] = await Promise.all([
    supabase
      .from("workflows")
      .select("id, name, type, status, created_at")
      .order("created_at", { ascending: false }),
    supabase
      .from("audit_log")
      .select(
        "id, actor_type, action, created_at, workflow:workflows(name), step:workflow_steps(name)",
      )
      .order("created_at", { ascending: false })
      .limit(15),
  ]);

  const workflows = (workflowsData ?? []) as WorkflowListRow[];
  const feed = (feedData ?? []) as unknown as FeedRow[];

  return (
    <div className="mx-auto max-w-6xl px-8 py-8">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="mt-1 text-sm text-muted">
          Launch a workflow, then watch the agents work.
        </p>
      </header>

      {/* Quick-launch cards */}
      <section className="mb-10 grid grid-cols-1 gap-4 md:grid-cols-3">
        {QUICK_LAUNCH.map((type) => {
          const Icon = TYPE_ICONS[type];
          return (
            <Link
              key={type}
              href={`/workflows/new?type=${type}`}
              className="group rounded-lg border border-border bg-card text-foreground transition-colors hover:border-accent/60"
            >
              <div className="flex h-full flex-col p-5">
                <div className="mb-3 flex items-center justify-between">
                  <span className="flex h-9 w-9 items-center justify-center rounded-md border border-border bg-background">
                    <Icon className="h-4 w-4 text-accent" />
                  </span>
                  <ArrowRight className="h-4 w-4 text-muted transition-transform group-hover:translate-x-0.5 group-hover:text-accent" />
                </div>
                <h3 className="font-semibold tracking-tight">
                  {TYPE_LABELS[type]}
                </h3>
                <p className="mt-1 text-sm text-muted">
                  {TYPE_DESCRIPTIONS[type]}
                </p>
                <div className="mt-4 flex flex-wrap gap-1.5">
                  {REQUIRED_FILES[type].map((ft) => (
                    <span
                      key={ft}
                      className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[11px] text-muted"
                    >
                      {FILE_LABELS[ft]}
                    </span>
                  ))}
                </div>
              </div>
            </Link>
          );
        })}
      </section>

      {/* Workflows table */}
      <section className="mb-10">
        <h2 className="mb-3 text-sm font-medium text-muted">Workflows</h2>
        <Card>
          {workflows.length === 0 ? (
            <CardContent className="p-8 text-center text-sm text-muted">
              No workflows yet. Launch one from a card above.
            </CardContent>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {workflows.map((w) => (
                  <TableRow key={w.id}>
                    <TableCell className="font-medium">
                      <Link
                        href={`/workflows/${w.id}`}
                        className="hover:text-accent hover:underline"
                      >
                        {w.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant="muted">{TYPE_LABELS[w.type]}</Badge>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={w.status} />
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted">
                      {formatDate(w.created_at)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
      </section>

      {/* Recent activity feed */}
      <section>
        <h2 className="mb-3 text-sm font-medium text-muted">Recent activity</h2>
        <Card>
          <CardHeader className="border-b border-border">
            <CardTitle className="text-sm font-medium text-muted">
              Last 15 audit events
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {feed.length === 0 ? (
              <div className="p-8 text-center text-sm text-muted">
                No activity yet.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <div className="min-w-max divide-y divide-border font-mono text-xs">
                  {feed.map((r) => (
                    <div
                      key={r.id}
                      className="grid grid-cols-[auto_4.5rem_10rem_1fr_auto] items-baseline gap-4 px-4 py-1.5"
                    >
                      <span className="text-muted">
                        {formatTime(r.created_at)}
                      </span>
                      <span className={ACTOR_COLOR[r.actor_type]}>
                        {r.actor_type}
                      </span>
                      <span className="text-foreground">{r.action}</span>
                      <span className="truncate text-muted">
                        {r.step?.name ?? ""}
                      </span>
                      <span className="truncate text-right text-muted">
                        {r.workflow?.name ?? ""}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
