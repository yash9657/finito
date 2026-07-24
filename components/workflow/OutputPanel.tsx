"use client";

import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  CheckCircle2,
  AlertTriangle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCents, formatPercent } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type {
  ApApprovalQueue,
  ApFlag,
  ApFlagCategory,
  ExceptionCategory,
  ExceptionFlags,
  ExceptionSource,
  FpaLine,
  FpaOutput,
  ReconMatchResult,
  ReconReportSummary,
  StepRow,
  WorkflowRow,
} from "@/lib/types";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** Output of the completed step with this step_number, or null. */
function completedOutput(steps: StepRow[], stepNumber: number): unknown | null {
  const s = steps.find(
    (row) => row.step_number === stepNumber && row.status === "complete",
  );
  return s?.output ?? null;
}

function num(className?: string) {
  return cn("font-mono tabular-nums", className);
}

/* -------------------------------------------------------------------------- */
/* Flag chips                                                                   */
/* -------------------------------------------------------------------------- */

const RECON_FLAG_LABELS: Record<ExceptionCategory, string> = {
  timing_difference: "Timing",
  amount_mismatch: "Amount mismatch",
  missing_from_erp: "Missing from ERP",
  missing_from_bank: "Missing from bank",
  duplicate: "Duplicate",
};

const RECON_FLAG_VARIANTS: Record<
  ExceptionCategory,
  "warning" | "error" | "muted"
> = {
  timing_difference: "warning",
  amount_mismatch: "error",
  missing_from_erp: "error",
  missing_from_bank: "error",
  duplicate: "warning",
};

const AP_FLAG_LABELS: Record<ApFlagCategory, string> = {
  no_matching_po: "No matching PO",
  amount_variance: "Amount variance",
  duplicate_invoice: "Duplicate invoice",
  past_due: "Past due",
};

const AP_FLAG_VARIANTS: Record<ApFlagCategory, "warning" | "error"> = {
  no_matching_po: "error",
  amount_variance: "warning",
  duplicate_invoice: "error",
  past_due: "warning",
};

function ReconFlagChip({ category }: { category: ExceptionCategory }) {
  return (
    <Badge variant={RECON_FLAG_VARIANTS[category]}>
      {RECON_FLAG_LABELS[category]}
    </Badge>
  );
}

function ApFlagChip({ category }: { category: ApFlagCategory }) {
  return (
    <Badge variant={AP_FLAG_VARIANTS[category]}>{AP_FLAG_LABELS[category]}</Badge>
  );
}

/* -------------------------------------------------------------------------- */
/* Section shell + collapsible                                                 */
/* -------------------------------------------------------------------------- */

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2 p-3">
        <CardTitle className="text-sm">{title}</CardTitle>
        {count !== undefined && (
          <Badge variant="muted">{count}</Badge>
        )}
      </CardHeader>
      <CardContent className="p-0">{children}</CardContent>
    </Card>
  );
}

function CollapsibleSection({
  title,
  count,
  defaultOpen = false,
  children,
}: {
  title: string;
  count?: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Card>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 p-3 text-left"
      >
        <span className="flex items-center gap-2">
          {open ? (
            <ChevronDown className="h-4 w-4 text-muted" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted" />
          )}
          <span className="text-sm font-semibold">{title}</span>
        </span>
        {count !== undefined && <Badge variant="muted">{count}</Badge>}
      </button>
      {open && <CardContent className="p-0">{children}</CardContent>}
    </Card>
  );
}

function EmptyRow({ span, label }: { span: number; label: string }) {
  return (
    <TableRow>
      <TableCell colSpan={span} className="py-4 text-center text-xs text-muted">
        {label}
      </TableCell>
    </TableRow>
  );
}

/* -------------------------------------------------------------------------- */
/* Stat row                                                                     */
/* -------------------------------------------------------------------------- */

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "accent" | "warning" | "error";
}) {
  return (
    <Card className="flex-1 min-w-[120px]">
      <CardContent className="p-3">
        <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
        <div
          className={cn(
            num("mt-1 text-lg font-semibold"),
            tone === "accent" && "text-accent",
            tone === "warning" && "text-warning",
            tone === "error" && "text-error",
          )}
        >
          {value}
        </div>
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Reconciliation — insight findings                                           */
/* -------------------------------------------------------------------------- */

interface ReconFinding {
  key: string;
  category: ExceptionCategory;
  tone: "error" | "warning";
  headline: string;
  amountCents: number;
  explanation: string;
  recommendation: string;
}

/**
 * Turn the computed exceptions (each already carrying a category, explanation and
 * recommendation from the flag step) into a prioritized, scannable list — ordered by
 * absolute amount so the most material item leads. Deterministic: built from the
 * summary, not re-derived from the narrative paragraph.
 */
function buildReconFindings(summary: ReconReportSummary): ReconFinding[] {
  const findings: ReconFinding[] = [];
  const toneOf = (c: ExceptionCategory): "error" | "warning" =>
    RECON_FLAG_VARIANTS[c] === "error" ? "error" : "warning";

  for (const t of summary.unmatchedErp) {
    findings.push({
      key: `erp-${t.id}`,
      category: t.flag.category,
      tone: toneOf(t.flag.category),
      headline: `${t.id} · ${t.description}`,
      amountCents: t.amountCents,
      explanation: t.flag.explanation,
      recommendation: t.flag.recommendation,
    });
  }
  for (const t of summary.unmatchedBank) {
    findings.push({
      key: `bank-${t.id}`,
      category: t.flag.category,
      tone: toneOf(t.flag.category),
      headline: `${t.id} · ${t.description}`,
      amountCents: t.amountCents,
      explanation: t.flag.explanation,
      recommendation: t.flag.recommendation,
    });
  }
  for (const d of summary.duplicates) {
    findings.push({
      key: `dup-${d.id}`,
      category: "duplicate",
      tone: "warning",
      headline: `${d.id} · ${d.description}`,
      amountCents: d.amountCents,
      explanation: `Duplicate of ${d.duplicateOf} — same amount, date and description.`,
      recommendation: "Remove the duplicate entry before period close.",
    });
  }

  return findings.sort((a, b) => Math.abs(b.amountCents) - Math.abs(a.amountCents));
}

function ReconStatusCallout({ summary }: { summary: ReconReportSummary }) {
  const clean = summary.status === "CLEAN";
  const exceptions =
    summary.unmatchedErp.length + summary.unmatchedBank.length + summary.duplicates.length;
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-lg border px-4 py-3 text-sm",
        clean
          ? "border-accent/40 bg-accent/10 text-accent"
          : "border-warning/40 bg-warning/10 text-warning",
      )}
    >
      {clean ? (
        <>
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>Reconciliation is clean — every transaction matched.</span>
        </>
      ) : (
        <>
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>
            {exceptions} exception{exceptions === 1 ? "" : "s"} need review · net difference{" "}
            <span className={num("font-semibold")}>
              {formatCents(summary.netDifferenceCents)}
            </span>
          </span>
        </>
      )}
    </div>
  );
}

function FindingCard({ f }: { f: ReconFinding }) {
  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-card p-3",
        f.tone === "error" ? "border-l-2 border-l-error" : "border-l-2 border-l-warning",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <ReconFlagChip category={f.category} />
          <span className="truncate text-sm font-medium">{f.headline}</span>
        </div>
        <span className={num("shrink-0 text-sm font-semibold")}>
          {formatCents(f.amountCents)}
        </span>
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-foreground/80">{f.explanation}</p>
      <p className="mt-1 text-xs leading-relaxed">
        <span className="font-medium text-accent">Recommended: </span>
        <span className="text-foreground/80">{f.recommendation}</span>
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Reconciliation                                                              */
/* -------------------------------------------------------------------------- */

function ReconciliationOutput({ steps }: { steps: StepRow[] }) {
  const summary = completedOutput(steps, 5) as ReconReportSummary | null;
  const match = completedOutput(steps, 3) as ReconMatchResult | null;
  const flagsOut = completedOutput(steps, 4) as ExceptionFlags | null;

  if (!summary && !match) return null;

  // Flag lookup from step 4 (used when only step 3 is available).
  const flagFor = (source: ExceptionSource, id: string) =>
    flagsOut?.flags.find((f) => f.source === source && f.id === id) ?? null;

  const matchedPairs = summary?.matchedPairs ?? match?.matchedPairs ?? [];
  const duplicates = summary?.duplicates ?? match?.duplicates ?? [];
  const findings = summary ? buildReconFindings(summary) : [];

  return (
    <div className="flex flex-col gap-4">
      {summary && (
        <>
          <div className="flex flex-wrap gap-3">
            <Stat
              label="ERP total"
              value={formatCents(summary.totals.erpAmountCents)}
            />
            <Stat
              label="Bank total"
              value={formatCents(summary.totals.bankAmountCents)}
            />
            <Stat
              label="Matched"
              value={formatCents(summary.matched.amountCents)}
              tone="accent"
            />
            <Stat
              label="Net difference"
              value={formatCents(summary.netDifferenceCents)}
              tone={summary.netDifferenceCents === 0 ? "accent" : "error"}
            />
          </div>

          <ReconStatusCallout summary={summary} />

          {findings.length > 0 && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold">Priority exceptions</h3>
                <Badge variant="muted">{findings.length}</Badge>
                <span className="text-xs text-muted">most material first</span>
              </div>
              {findings.map((f) => (
                <FindingCard key={f.key} f={f} />
              ))}
            </div>
          )}

          {summary.narrative && (
            <CollapsibleSection title="Analyst narrative">
              <p className="p-3 text-sm leading-relaxed text-foreground/90">
                {summary.narrative}
              </p>
            </CollapsibleSection>
          )}
        </>
      )}

      {/* Matched — collapsed by default */}
      <CollapsibleSection title="Matched" count={matchedPairs.length}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ERP</TableHead>
              <TableHead>Bank</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Confidence</TableHead>
              <TableHead>Reason</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {matchedPairs.length === 0 ? (
              <EmptyRow span={5} label="No matched pairs" />
            ) : (
              matchedPairs.map((p) => (
                <TableRow key={`${p.erpId}-${p.bankId}`}>
                  <TableCell className={num()}>{p.erpId}</TableCell>
                  <TableCell className={num()}>{p.bankId}</TableCell>
                  <TableCell className={num("text-right")}>
                    {formatCents(p.amountCents)}
                  </TableCell>
                  <TableCell>
                    <Badge variant="muted">{p.confidence}</Badge>
                  </TableCell>
                  <TableCell className="max-w-[200px] text-xs text-muted">
                    {p.matchReason}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CollapsibleSection>

      {/* Unmatched ERP */}
      <Section
        title="Unmatched ERP"
        count={
          summary
            ? summary.unmatchedErp.length
            : (match?.unmatchedErp.length ?? 0)
        }
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Description</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Flag</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(summary?.unmatchedErp ?? match?.unmatchedErp ?? []).length === 0 ? (
              <EmptyRow span={5} label="None" />
            ) : summary ? (
              summary.unmatchedErp.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className={num()}>{t.id}</TableCell>
                  <TableCell className={num()}>{t.date}</TableCell>
                  <TableCell className="max-w-[180px] truncate text-xs">
                    {t.description}
                  </TableCell>
                  <TableCell className={num("text-right")}>
                    {formatCents(t.amountCents)}
                  </TableCell>
                  <TableCell>
                    <ReconFlagChip category={t.flag.category} />
                  </TableCell>
                </TableRow>
              ))
            ) : (
              match!.unmatchedErp.map((t) => {
                const f = flagFor("erp", t.id);
                return (
                  <TableRow key={t.id}>
                    <TableCell className={num()}>{t.id}</TableCell>
                    <TableCell className={num()}>{t.date}</TableCell>
                    <TableCell className="max-w-[180px] truncate text-xs">
                      {t.description}
                    </TableCell>
                    <TableCell className={num("text-right")}>
                      {formatCents(t.amountCents)}
                    </TableCell>
                    <TableCell>
                      {f ? (
                        <ReconFlagChip category={f.category} />
                      ) : (
                        <span className="text-xs text-muted">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </Section>

      {/* Unmatched Bank */}
      <Section
        title="Unmatched bank"
        count={
          summary
            ? summary.unmatchedBank.length
            : (match?.unmatchedBank.length ?? 0)
        }
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Description</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Flag</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(summary?.unmatchedBank ?? match?.unmatchedBank ?? []).length ===
            0 ? (
              <EmptyRow span={5} label="None" />
            ) : summary ? (
              summary.unmatchedBank.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className={num()}>{t.id}</TableCell>
                  <TableCell className={num()}>{t.date}</TableCell>
                  <TableCell className="max-w-[180px] truncate text-xs">
                    {t.description}
                  </TableCell>
                  <TableCell className={num("text-right")}>
                    {formatCents(t.amountCents)}
                  </TableCell>
                  <TableCell>
                    <ReconFlagChip category={t.flag.category} />
                  </TableCell>
                </TableRow>
              ))
            ) : (
              match!.unmatchedBank.map((t) => {
                const f = flagFor("bank", t.id);
                return (
                  <TableRow key={t.id}>
                    <TableCell className={num()}>{t.id}</TableCell>
                    <TableCell className={num()}>{t.date}</TableCell>
                    <TableCell className="max-w-[180px] truncate text-xs">
                      {t.description}
                    </TableCell>
                    <TableCell className={num("text-right")}>
                      {formatCents(t.amountCents)}
                    </TableCell>
                    <TableCell>
                      {f ? (
                        <ReconFlagChip category={f.category} />
                      ) : (
                        <span className="text-xs text-muted">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </Section>

      {/* Duplicates */}
      <Section title="Duplicates" count={duplicates.length}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Description</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Duplicate of</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {duplicates.length === 0 ? (
              <EmptyRow span={5} label="None" />
            ) : (
              duplicates.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className={num()}>{t.id}</TableCell>
                  <TableCell className={num()}>{t.date}</TableCell>
                  <TableCell className="max-w-[180px] truncate text-xs">
                    {t.description}
                  </TableCell>
                  <TableCell className={num("text-right")}>
                    {formatCents(t.amountCents)}
                  </TableCell>
                  <TableCell className={num()}>{t.duplicateOf}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Section>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* AP Matching                                                                 */
/* -------------------------------------------------------------------------- */

function ApMatchingOutput({ steps }: { steps: StepRow[] }) {
  const queue = completedOutput(steps, 5) as ApApprovalQueue | null;
  if (!queue) return null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-3">
        <Stat
          label="Auto-approve"
          value={`${queue.stats.autoApproveCount}`}
          tone="accent"
        />
        <Stat
          label="Auto-approve total"
          value={formatCents(queue.stats.autoApproveAmountCents)}
        />
        <Stat
          label="Hold for review"
          value={`${queue.stats.holdCount}`}
          tone="warning"
        />
        <Stat
          label="Hold total"
          value={formatCents(queue.stats.holdAmountCents)}
        />
      </div>

      {queue.narrative && (
        <Card>
          <CardContent className="p-3 text-sm leading-relaxed text-foreground/90">
            {queue.narrative}
          </CardContent>
        </Card>
      )}

      <Section title="Auto-approve" count={queue.autoApprove.length}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Invoice</TableHead>
              <TableHead>PO</TableHead>
              <TableHead>Vendor</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {queue.autoApprove.length === 0 ? (
              <EmptyRow span={5} label="None" />
            ) : (
              queue.autoApprove.map((item) => (
                <TableRow key={item.invoiceId}>
                  <TableCell className={num()}>{item.invoiceId}</TableCell>
                  <TableCell className={num()}>{item.poId}</TableCell>
                  <TableCell className="text-xs">{item.vendor}</TableCell>
                  <TableCell className={num("text-right")}>
                    {formatCents(item.amountCents)}
                  </TableCell>
                  <TableCell>
                    <Badge variant="accent">approve</Badge>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Section>

      <Section title="Hold for review" count={queue.holdForReview.length}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Invoice</TableHead>
              <TableHead>Vendor</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>PO</TableHead>
              <TableHead>Flags</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {queue.holdForReview.length === 0 ? (
              <EmptyRow span={5} label="None" />
            ) : (
              queue.holdForReview.map((item) => (
                <TableRow key={item.invoice.id}>
                  <TableCell className={num()}>
                    {item.invoice.invoiceNumber}
                  </TableCell>
                  <TableCell className="text-xs">
                    {item.invoice.vendorName}
                  </TableCell>
                  <TableCell className={num("text-right")}>
                    {formatCents(item.invoice.amountCents)}
                  </TableCell>
                  <TableCell className={num()}>
                    {item.poId ?? "—"}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {item.flags.length === 0 ? (
                        <span className="text-xs text-muted">—</span>
                      ) : (
                        item.flags.map((f: ApFlag, i) => (
                          <ApFlagChip key={i} category={f.category} />
                        ))
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Section>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* FP&A Commentary                                                             */
/* -------------------------------------------------------------------------- */

function VarianceRow({ line }: { line: FpaLine }) {
  const tone =
    line.variancePct === null
      ? undefined
      : line.variancePct > 0
        ? "text-error"
        : line.variancePct < 0
          ? "text-accent"
          : undefined;
  return (
    <TableRow>
      <TableCell className="text-xs">{line.department}</TableCell>
      <TableCell className="text-xs">{line.category}</TableCell>
      <TableCell className={num("text-right")}>
        {formatCents(line.budgetedAmountCents)}
      </TableCell>
      <TableCell className={num("text-right")}>
        {formatCents(line.actualAmountCents)}
      </TableCell>
      <TableCell className={num("text-right")}>
        {formatCents(line.varianceCents)}
      </TableCell>
      <TableCell className={num(cn("text-right", tone))}>
        {formatPercent(line.variancePct)}
      </TableCell>
    </TableRow>
  );
}

function FpaOutputView({ steps }: { steps: StepRow[] }) {
  const full = completedOutput(steps, 5) as FpaOutput | null;
  const ranked = completedOutput(steps, 3) as {
    variances: FpaLine[];
    materialVariances: FpaLine[];
  } | null;

  const materialVariances =
    full?.materialVariances ?? ranked?.materialVariances ?? null;
  if (!full && !materialVariances) return null;

  const top10 = (materialVariances ?? []).slice(0, 10);

  return (
    <div className="flex flex-col gap-4">
      {full?.executiveSummary && (
        <Card>
          <CardHeader className="p-3">
            <CardTitle className="text-sm">Executive summary</CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-0 text-sm leading-relaxed text-foreground/90">
            {full.executiveSummary}
          </CardContent>
        </Card>
      )}

      <Section title="Material variances (top 10)" count={top10.length}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Department</TableHead>
              <TableHead>Category</TableHead>
              <TableHead className="text-right">Budget</TableHead>
              <TableHead className="text-right">Actual</TableHead>
              <TableHead className="text-right">Variance</TableHead>
              <TableHead className="text-right">%</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {top10.length === 0 ? (
              <EmptyRow span={6} label="No material variances" />
            ) : (
              top10.map((line) => <VarianceRow key={line.id} line={line} />)
            )}
          </TableBody>
        </Table>
      </Section>

      {full && full.departmentSummaries.length > 0 && (
        <Section
          title="Department summaries"
          count={full.departmentSummaries.length}
        >
          <div className="flex flex-col divide-y divide-border">
            {full.departmentSummaries.map((d) => (
              <div key={d.department} className="p-3">
                <div className="text-sm font-semibold">{d.department}</div>
                <p className="mt-1 text-sm leading-relaxed text-foreground/90">
                  {d.summary}
                </p>
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Skeleton / empty                                                            */
/* -------------------------------------------------------------------------- */

function OutputSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-3">
        {[0, 1, 2, 3].map((i) => (
          <Card key={i} className="flex-1 min-w-[120px]">
            <CardContent className="p-3">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="mt-2 h-5 w-24" />
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardContent className="flex flex-col gap-2 p-3">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-6 w-full" />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 py-16 text-center text-muted">
      <FileText className="h-8 w-8" />
      <p className="text-sm">The deliverable will build up here as steps complete.</p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* OutputPanel                                                                 */
/* -------------------------------------------------------------------------- */

export default function OutputPanel({
  workflow,
  steps,
}: {
  workflow: WorkflowRow;
  steps: StepRow[];
}) {
  let body: React.ReactNode = null;

  if (workflow.type === "reconciliation") {
    body = <ReconciliationOutput steps={steps} />;
  } else if (workflow.type === "ap_matching") {
    body = <ApMatchingOutput steps={steps} />;
  } else if (workflow.type === "fpa_commentary") {
    body = <FpaOutputView steps={steps} />;
  }

  if (!body) {
    body = workflow.status === "running" ? <OutputSkeleton /> : <EmptyState />;
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto p-4">
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-muted">
        Deliverable
      </h2>
      {body}
    </div>
  );
}
