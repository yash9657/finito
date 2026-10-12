"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Scale,
  Receipt,
  TrendingUp,
  Check,
  ArrowRight,
  ArrowLeft,
  Loader2,
  FileText,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import Link from "next/link";
import FileDropzone from "@/components/workflow/FileDropzone";
import { WORKFLOW_TYPES, type FileType, type WorkflowType } from "@/lib/types";

/* -------------------------------------------------------------------------- */
/* Static per-type config (§11.4). Required files + demo filenames for hints.  */
/* -------------------------------------------------------------------------- */

interface RequiredFile {
  fileType: FileType;
  label: string;
  demoFilename: string; // referenced in the empty-state hint (§13)
}

interface TypeConfig {
  type: WorkflowType;
  title: string;
  icon: LucideIcon;
  blurb: string;
  files: RequiredFile[];
}

const TYPE_CONFIG: Record<WorkflowType, TypeConfig> = {
  reconciliation: {
    type: "reconciliation",
    title: "Reconciliation",
    icon: Scale,
    blurb:
      "Match your ERP ledger against the bank statement and flag exceptions.",
    files: [
      {
        fileType: "erp_export",
        label: "ERP Export",
        demoFilename: "erp_export_demo.csv",
      },
      {
        fileType: "bank_statement",
        label: "Bank Statement",
        demoFilename: "bank_statement_demo.csv",
      },
    ],
  },
  ap_matching: {
    type: "ap_matching",
    title: "Invoice matching",
    icon: Receipt,
    blurb: "Match invoices to purchase orders and build the approval queue.",
    files: [
      {
        fileType: "po",
        label: "Purchase Orders",
        demoFilename: "purchase_orders_demo.csv",
      },
      {
        fileType: "invoice",
        label: "Invoices",
        demoFilename: "invoices_demo.csv",
      },
    ],
  },
  fpa_commentary: {
    type: "fpa_commentary",
    title: "Variance analysis",
    icon: TrendingUp,
    blurb:
      "Calculate budget-versus-actual differences and prepare commentary for review.",
    files: [
      { fileType: "budget", label: "Budget", demoFilename: "budget_demo.csv" },
      {
        fileType: "actuals",
        label: "Actuals",
        demoFilename: "actuals_demo.csv",
      },
    ],
  },
};

function isWorkflowType(v: string | null): v is WorkflowType {
  return v !== null && (WORKFLOW_TYPES as readonly string[]).includes(v);
}

type Stage = 1 | 2 | 3;

/** Info captured when a FileDropzone reports a successful upload (best-effort). */
interface UploadedInfo {
  filename?: string;
  size?: number;
  sha256?: string;
}

export default function NewWorkflowPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const preselected = searchParams.get("type");

  const [stage, setStage] = React.useState<Stage>(1);
  const [selectedType, setSelectedType] = React.useState<WorkflowType>(
    isWorkflowType(preselected) ? preselected : "reconciliation",
  );
  const [workflowId, setWorkflowId] = React.useState<string | null>(null);
  const [uploaded, setUploaded] = React.useState<
    Partial<Record<FileType, UploadedInfo>>
  >({});

  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Set when /run returns "No LLM provider configured" so we can link to Settings → Models.
  const [needsProvider, setNeedsProvider] = React.useState(false);

  const config = TYPE_CONFIG[selectedType];
  const requiredTypes = config.files.map((f) => f.fileType);
  const allUploaded = requiredTypes.every((ft) => uploaded[ft] !== undefined);

  /* --- Stage 1 → 2: create the workflow row so uploads have an id (§11.4). --- */
  async function enterUploads() {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: selectedType }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? "Failed to create workflow");
      }
      const { id } = (await res.json()) as { id: string };
      setWorkflowId(id);
      setUploaded({});
      setStage(2);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create workflow");
    } finally {
      setBusy(false);
    }
  }

  /* --- Stage 3: launch the run, then jump to the live view (§11.4). --- */
  async function launch() {
    if (!workflowId || busy) return;
    setNeedsProvider(false);
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/workflows/${workflowId}/run`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        const message = body?.error ?? "Failed to launch workflow";
        // The run route returns 400 with this message when no provider resolves (D-P4).
        if (res.status === 400 && /provider configured/i.test(message)) {
          setNeedsProvider(true);
          setBusy(false);
          return;
        }
        throw new Error(message);
      }
      router.push(`/workflows/${workflowId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to launch workflow");
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-6 py-10">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">New workflow</h1>
        <StageIndicator stage={stage} />
      </div>

      {error && (
        <div className="rounded-md border border-error/50 bg-error/10 px-4 py-3 text-sm text-error">
          {error}
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* Stage 1 — type picker                                            */}
      {/* ---------------------------------------------------------------- */}
      {stage === 1 && (
        <div className="flex flex-col gap-6">
          <div className="grid gap-3">
            {WORKFLOW_TYPES.map((t) => {
              const c = TYPE_CONFIG[t];
              const Icon = c.icon;
              const active = selectedType === t;
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => setSelectedType(t)}
                  className={cn(
                    "grid gap-4 rounded-lg border bg-card p-6 sm:grid-cols-[44px_1fr_180px] text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                    active
                      ? "border-accent bg-accent/[0.04]"
                      : "border-border hover:border-muted",
                  )}
                  aria-pressed={active}
                >
                  <div className="flex items-start justify-between">
                    <Icon
                      className={cn(
                        "h-6 w-6",
                        active ? "text-accent" : "text-muted",
                      )}
                      strokeWidth={1.75}
                    />
                    {active && <Check className="h-4 w-4 text-accent" />}
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="font-medium">{c.title}</span>
                    <span className="text-sm leading-relaxed text-muted">
                      {c.blurb}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1 border-t border-border pt-3 sm:border-t-0 sm:border-l sm:pl-5 sm:pt-0">
                    <span className="text-xs font-medium text-muted">
                      Required files
                    </span>
                    {c.files.map((f) => (
                      <span
                        key={f.fileType}
                        className="flex items-center gap-1.5 text-xs text-foreground/80"
                      >
                        <FileText className="h-3 w-3 text-muted" />
                        {f.label}
                      </span>
                    ))}
                  </div>
                </button>
              );
            })}
          </div>

          <div className="flex justify-end">
            <Button variant="accent" onClick={enterUploads} disabled={busy}>
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  Continue
                  <ArrowRight className="h-4 w-4" />
                </>
              )}
            </Button>
          </div>
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* Stage 2 — uploads                                                */}
      {/* ---------------------------------------------------------------- */}
      {stage === 2 && workflowId && (
        <div className="flex flex-col gap-6">
          <p className="rounded-md border border-border bg-card px-4 py-3 text-sm leading-relaxed text-muted">
            Use exports for the same entity, currency, and period. FinFlow
            validates the file structure before processing; review source totals
            before approving a result.
          </p>

          <div className="grid gap-4">
            {config.files.map((f) => (
              <div key={f.fileType} className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">{f.label}</span>
                <FileDropzone
                  fileType={f.fileType}
                  label={f.label}
                  workflowId={workflowId}
                  onUploaded={(info?: UploadedInfo) =>
                    setUploaded((prev) => ({
                      ...prev,
                      [f.fileType]: info ?? {},
                    }))
                  }
                />
              </div>
            ))}
          </div>

          <div className="flex justify-between">
            <Button variant="ghost" onClick={() => setStage(1)} disabled={busy}>
              <ArrowLeft className="h-4 w-4" />
              Back
            </Button>
            <Button
              variant="accent"
              onClick={() => setStage(3)}
              disabled={!allUploaded}
            >
              Continue
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* Stage 3 — confirm & launch                                       */}
      {/* ---------------------------------------------------------------- */}
      {stage === 3 && workflowId && (
        <div className="flex flex-col gap-6">
          <Card className="flex flex-col divide-y divide-border">
            <div className="flex items-center gap-3 p-4">
              <config.icon className="h-5 w-5 text-accent" strokeWidth={1.75} />
              <div className="flex flex-col">
                <span className="font-medium">{config.title}</span>
                <span className="text-xs text-muted">
                  {config.files.length} files ready to process
                </span>
              </div>
            </div>
            {config.files.map((f) => {
              const info = uploaded[f.fileType];
              return (
                <div key={f.fileType} className="flex items-center gap-3 p-4">
                  <Check className="h-4 w-4 shrink-0 text-accent" />
                  <div className="flex min-w-0 flex-col">
                    <span className="text-sm font-medium">{f.label}</span>
                    <span className="truncate font-mono text-xs text-muted">
                      {info?.filename ?? "uploaded"}
                      {typeof info?.size === "number" && (
                        <> · {(info.size / 1024).toFixed(1)} KB</>
                      )}
                      {info?.sha256 && <> · {info.sha256.slice(0, 12)}</>}
                    </span>
                  </div>
                </div>
              );
            })}
          </Card>

          {needsProvider && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-warning/50 bg-warning/10 px-4 py-3 text-sm text-warning">
              <span>No LLM provider configured for your organization.</span>
              <Link
                href="/settings/models"
                className="font-medium underline underline-offset-4 hover:opacity-80"
              >
                Configure one in Settings → Models →
              </Link>
            </div>
          )}

          <div className="flex justify-between">
            <Button variant="ghost" onClick={() => setStage(2)} disabled={busy}>
              <ArrowLeft className="h-4 w-4" />
              Back
            </Button>
            <Button variant="accent" onClick={launch} disabled={busy}>
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  <ArrowRight className="h-4 w-4" />
                  Run workflow
                </>
              )}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Stage indicator — three labelled steps.                                     */
/* -------------------------------------------------------------------------- */

const STAGE_LABELS: Record<Stage, string> = {
  1: "Choose type",
  2: "Upload files",
  3: "Review & run",
};

function StageIndicator({ stage }: { stage: Stage }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs sm:text-sm">
      {([1, 2, 3] as Stage[]).map((s, i) => {
        const done = s < stage;
        const active = s === stage;
        return (
          <React.Fragment key={s}>
            {i > 0 && <span className="h-px w-6 bg-border" />}
            <span
              className={cn(
                "flex items-center gap-1.5",
                active
                  ? "text-foreground"
                  : done
                    ? "text-accent"
                    : "text-muted",
              )}
            >
              <span
                className={cn(
                  "flex h-5 w-5 items-center justify-center rounded-full border text-xs font-medium",
                  active
                    ? "border-accent text-accent"
                    : done
                      ? "border-accent bg-accent text-background"
                      : "border-border text-muted",
                )}
              >
                {done ? <Check className="h-3 w-3" /> : s}
              </span>
              {STAGE_LABELS[s]}
            </span>
          </React.Fragment>
        );
      })}
    </div>
  );
}
