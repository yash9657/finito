"use client";

/**
 * ApprovalPanel (Plan 3 §6) — the per-action authorization surface.
 *
 * This is what replaces the single end-of-run approve/reject for consequential work: one
 * row per action, each showing what would happen (action type + target + amount), *why*
 * a human is being asked (the engine's reason — no rule covers it, or a rule does but the
 * org's auto-approve ceiling is lower), and what authorizing it is bound to. A denied row
 * has no approve control at all: structural ceilings are not overridable in-band (D-A4).
 *
 * Approving can optionally mint a tiered grant (D-A6/D-A7) — once / this run / standing —
 * pre-bound to that action's counterparty and amount, which is how an org gets from
 * "approve every payment by hand" to "auto-approve this vendor under $X, always ask for
 * new payees" without ever granting an unbounded permission.
 */

import * as React from "react";
import {
  Check,
  ChevronDown,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  paymentReviewEvidence,
  approvalScopeTotal,
} from "@/lib/approvals/review-evidence";
import { Textarea } from "@/components/ui/textarea";
import { formatCents, formatDateTime } from "@/lib/format";
import { RISK_CLASS_SPECS } from "@/lib/approvals/risk";
import { actionTypeLabel } from "@/lib/approvals/action-types";
import type {
  ActionRequestRow,
  ActionStatus,
  RuleScope,
  WorkflowRow,
  StepRow,
} from "@/lib/types";

interface ApprovalPanelProps {
  workflow: WorkflowRow;
  actions: ActionRequestRow[];
  onDecided: () => void;
  canReview?: boolean;
  steps?: StepRow[];
}

const STATUS_META: Record<
  ActionStatus,
  { label: string; variant: "muted" | "accent" | "warning" | "error" }
> = {
  pending: { label: "awaiting approval", variant: "warning" },
  auto_approved: { label: "auto-approved", variant: "accent" },
  approved: { label: "approved", variant: "accent" },
  rejected: { label: "rejected", variant: "error" },
  denied: { label: "denied by policy", variant: "error" },
};

const SCOPE_LABEL: Record<RuleScope, string> = {
  once: "Just this one",
  run: "This run",
  standing: "Standing rule (until revoked)",
};

function amount(cents: number | null): string {
  return cents === null ? "—" : formatCents(cents);
}

/* -------------------------------------------------------------------------- */
/* Grant form — the tiered, target-bound part (D-A6).                          */
/* -------------------------------------------------------------------------- */

interface GrantDraft {
  scope: RuleScope;
  counterparty: string;
  maxAmountDollars: string;
  note: string;
}

function GrantForm({
  action,
  draft,
  setDraft,
}: {
  action: ActionRequestRow;
  draft: GrantDraft;
  setDraft: (d: GrantDraft) => void;
}) {
  return (
    <div className="mt-3 space-y-3 rounded-md border border-border bg-background/50 p-3">
      <p className="text-xs text-muted">
        Also create a rule so future{" "}
        <span className="text-foreground/80">
          {actionTypeLabel(action.action_type)}
        </span>{" "}
        actions matching it are authorized without asking. A standing rule must
        stay bound to a counterparty and/or an amount cap.
      </p>

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-xs text-muted">
          Scope
          <select
            value={draft.scope}
            onChange={(e) =>
              setDraft({ ...draft, scope: e.target.value as RuleScope })
            }
            className="min-h-11 rounded-md border border-border bg-card px-2 text-sm text-foreground"
          >
            {(["once", "run", "standing"] as RuleScope[]).map((s) => (
              <option key={s} value={s}>
                {SCOPE_LABEL[s]}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-muted">
          Counterparty (exact)
          <input
            value={draft.counterparty}
            onChange={(e) =>
              setDraft({ ...draft, counterparty: e.target.value })
            }
            placeholder="any"
            className="min-h-11 rounded-md border border-border bg-card px-2 font-mono text-sm text-foreground"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-muted">
          Up to ($, inclusive)
          <input
            value={draft.maxAmountDollars}
            onChange={(e) =>
              setDraft({ ...draft, maxAmountDollars: e.target.value })
            }
            inputMode="decimal"
            placeholder="no cap"
            className="min-h-11 rounded-md border border-border bg-card px-2 font-mono text-sm text-foreground"
          />
        </label>
      </div>

      <input
        aria-label="Rule reason"
        value={draft.note}
        onChange={(e) => setDraft({ ...draft, note: e.target.value })}
        placeholder="Why this rule exists (recorded with your name)"
        className="min-h-11 w-full rounded-md border border-border bg-card px-2 text-sm text-foreground"
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */

export default function ApprovalPanel({
  workflow,
  actions,
  onDecided,
  steps = [],
  canReview = false,
}: ApprovalPanelProps) {
  const [bulkDecision, setBulkDecision] = React.useState<
    "approve" | "reject" | null
  >(null);
  const [visibleCount, setVisibleCount] = React.useState(5);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [comment, setComment] = React.useState("");
  const [grantFor, setGrantFor] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState<GrantDraft>({
    scope: "standing",
    counterparty: "",
    maxAmountDollars: "",
    note: "",
  });

  const pending = actions.filter((a) => a.status === "pending");
  const resolved = actions.filter((a) => a.status !== "pending");
  const scopeTotal = approvalScopeTotal(pending);
  const evidenceReady = (a: ActionRequestRow) =>
    a.action_type !== "approve_invoice_payment" ||
    paymentReviewEvidence(a, steps).ready;
  const bulkReady = pending.every(evidenceReady) && scopeTotal !== null;
  if (actions.length === 0) return null;

  async function decide(
    actionIds: string[],
    decision: "approve" | "reject",
    withGrant: ActionRequestRow | null,
  ) {
    if (busy || !canReview) return;
    if (
      decision === "approve" &&
      pending.some((a) => actionIds.includes(a.id) && !evidenceReady(a))
    ) {
      setError(
        "Source evidence is incomplete. Review the analysis or rerun this workflow before authorizing.",
      );
      return;
    }
    setError(null);
    setNotice(null);
    setBusy(actionIds.join(","));
    try {
      const body: Record<string, unknown> = {
        actionIds,
        decision,
        comment: comment.trim() || undefined,
      };
      if (withGrant) {
        const dollars = draft.maxAmountDollars.trim().replace(/[$,]/g, "");
        const cents =
          dollars.length > 0 ? Math.round(Number(dollars) * 100) : null;
        if (cents !== null && (!Number.isFinite(cents) || cents <= 0)) {
          throw new Error(
            "Enter a positive amount cap, or leave it blank for no cap.",
          );
        }
        body.grant = {
          scope: draft.scope,
          counterparty: draft.counterparty.trim() || null,
          max_amount_cents: cents,
          target_id: draft.scope === "once" ? withGrant.target_id : null,
          note: draft.note.trim() || null,
        };
      }

      const res = await fetch(`/api/workflows/${workflow.id}/approvals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await res.json().catch(() => null)) as {
        error?: string;
        resolved?: string[];
        alreadyResolved?: string[];
        notOverridable?: string[];
        pendingRemaining?: number;
        resumed?: boolean;
        rule?: { scope: string; binding: string } | null;
      } | null;
      if (!res.ok)
        throw new Error(payload?.error ?? `Request failed (${res.status})`);

      const notices: string[] = [];
      if (payload?.rule)
        notices.push(
          `${payload.rule.scope} rule created ${payload.rule.binding}`,
        );
      if (payload?.alreadyResolved?.length) {
        notices.push(
          `${payload.alreadyResolved.length} action(s) were already decided by someone else`,
        );
      }
      if (payload?.resumed)
        notices.push("all actions decided — the run has resumed");
      setNotice(notices.join(" · ") || null);
      setComment("");
      setBulkDecision(null);
      setGrantFor(null);
      onDecided();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to submit decision");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="m-3 rounded-lg border border-border bg-card">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <ShieldAlert
            className={
              pending.length > 0 ? "h-4 w-4 text-warning" : "h-4 w-4 text-muted"
            }
          />
          <h2 className="text-sm font-semibold text-foreground">
            Authorization
          </h2>
        </div>
        <div className="flex items-center gap-2 font-mono text-xs text-muted">
          {pending.length > 0 && (
            <Badge variant="warning">{pending.length} awaiting approval</Badge>
          )}
          <span>
            {
              resolved.filter(
                (a) => a.status === "auto_approved" || a.status === "approved",
              ).length
            }{" "}
            authorized
          </span>
          <span>·</span>
          <span>
            {
              resolved.filter(
                (a) => a.status === "denied" || a.status === "rejected",
              ).length
            }{" "}
            withheld
          </span>
        </div>
      </header>

      {pending.length > 0 && (
        <div className="border-b border-border px-4 py-4">
          <p className="mb-3 text-xs text-muted">
            This run is suspended until each consequential action below is
            decided. For invoices, approval records authorization and does not
            send a payment. Amount ceilings and counterparty rules set by your
            organization are enforced before this point and cannot be overridden
            here.
          </p>

          {!canReview && (
            <p className="mb-3 text-sm text-warning">
              A reviewer or administrator must authorize these actions.
            </p>
          )}
          <p className="mb-4 text-sm">
            {pending.length} actions ·{" "}
            {scopeTotal === null
              ? "Total unavailable"
              : `${amount(scopeTotal)} in proposed authorizations`}{" "}
            · Showing {Math.min(visibleCount, pending.length)} of{" "}
            {pending.length}
          </p>
          <div className="divide-y divide-border border-y border-border">
            {pending.slice(0, visibleCount).map((a) => {
              const evidence =
                a.action_type === "approve_invoice_payment"
                  ? paymentReviewEvidence(a, steps)
                  : null;
              const spec = RISK_CLASS_SPECS[a.risk_class];
              const rowBusy = busy?.includes(a.id) ?? false;
              return (
                <div key={a.id} className="py-5">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="mb-1 flex flex-wrap items-center gap-2">
                        <Badge variant="warning" title={spec.description}>
                          {a.action_type === "approve_invoice_payment"
                            ? "Payment authorization"
                            : spec.label}
                        </Badge>
                        <span className="font-mono text-xs text-muted">
                          {actionTypeLabel(a.action_type)}
                        </span>
                      </div>
                      <p className="text-sm text-foreground">{a.summary}</p>
                      <p className="mt-1 font-mono text-xs text-muted">
                        {a.counterparty ?? "no counterparty"} ·{" "}
                        {amount(a.amount_cents)} · {a.target_kind} {a.target_id}
                      </p>
                      {a.decision_reason && (
                        <p className="mt-1.5 text-xs text-warning/90">
                          {a.decision_reason}
                        </p>
                      )}
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        variant="accent"
                        size="sm"
                        disabled={
                          busy !== null || !canReview || !evidenceReady(a)
                        }
                        onClick={() =>
                          decide(
                            [a.id],
                            "approve",
                            grantFor === a.id ? a : null,
                          )
                        }
                      >
                        {rowBusy ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Check className="h-3.5 w-3.5" />
                        )}
                        Approve
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={busy !== null || !canReview}
                        onClick={() => decide([a.id], "reject", null)}
                      >
                        <XCircle className="h-3.5 w-3.5" />
                        Reject
                      </Button>
                    </div>
                  </div>

                  {evidence && (
                    <div className="mt-4 space-y-3 text-sm">
                      <div className="grid gap-4 sm:grid-cols-2">
                        <div>
                          <p className="text-xs text-muted">
                            Invoice ·{" "}
                            {String(
                              evidence.invoice?.invoiceNumber ??
                                a.payload?.invoiceNumber ??
                                "Unknown",
                            )}
                          </p>
                          <p className="mt-1 font-mono">
                            {Number.isSafeInteger(evidence.invoice?.amountCents)
                              ? amount(evidence.invoice!.amountCents as number)
                              : "Amount unavailable"}
                          </p>
                          <p className="mt-1 text-xs text-muted">
                            {String(
                              evidence.invoice?.lineItem ??
                                "Source record unavailable",
                            )}
                          </p>
                        </div>
                        <div>
                          <p className="text-xs text-muted">
                            Purchase order ·{" "}
                            {String(
                              evidence.po?.poNumber ??
                                a.payload?.poId ??
                                "Unknown",
                            )}
                          </p>
                          <p className="mt-1 font-mono">
                            {Number.isSafeInteger(evidence.po?.amountCents)
                              ? amount(evidence.po!.amountCents as number)
                              : "Amount unavailable"}
                          </p>
                          <p className="mt-1 text-xs text-muted">
                            {String(
                              evidence.po?.lineItem ??
                                "Source record unavailable",
                            )}
                          </p>
                        </div>
                      </div>
                      <p className="text-xs text-muted">
                        Match basis:{" "}
                        {String(evidence.match?.matchReason ?? "Not recorded")}{" "}
                        · Confidence:{" "}
                        {String(evidence.match?.confidence ?? "Unknown")} · PO
                        approved by:{" "}
                        {String(evidence.po?.approvedBy || "Not recorded")}
                      </p>
                      <p className="text-xs text-muted">
                        Recorded flags:{" "}
                        {evidence.flags.length
                          ? evidence.flags
                              .map((f) =>
                                String(f.category).replaceAll("_", " "),
                              )
                              .join(", ")
                          : "None"}
                      </p>
                      <details>
                        <summary className="min-h-11 cursor-pointer text-xs text-muted">
                          Source references
                        </summary>
                        <ul className="space-y-2 break-all text-xs text-muted">
                          {evidence.sources.map((source, i) => (
                            <li key={i}>
                              {source.file} · {source.note}
                            </li>
                          ))}
                        </ul>
                      </details>
                      {!evidence.ready && (
                        <p className="text-sm text-warning">
                          Approval is unavailable: source evidence is
                          incomplete, inconsistent, or carries unresolved flags.
                          Review the completed analysis or create a new workflow
                          from verified source files.
                        </p>
                      )}
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      if (grantFor === a.id) {
                        setGrantFor(null);
                        return;
                      }
                      setGrantFor(a.id);
                      setDraft({
                        scope: "standing",
                        counterparty: a.counterparty ?? "",
                        maxAmountDollars:
                          a.amount_cents === null
                            ? ""
                            : (a.amount_cents / 100).toFixed(2),
                        note: "",
                      });
                    }}
                    disabled={!canReview || busy !== null}
                    className="mt-2 inline-flex min-h-11 items-center gap-1 text-xs text-muted transition-colors hover:text-foreground"
                  >
                    <ChevronDown
                      className={`h-3.5 w-3.5 transition-transform ${grantFor === a.id ? "rotate-180" : ""}`}
                    />
                    {grantFor === a.id
                      ? "Approve without a rule"
                      : "Approve and create a rule…"}
                  </button>

                  {grantFor === a.id && (
                    <GrantForm action={a} draft={draft} setDraft={setDraft} />
                  )}
                </div>
              );
            })}
          </div>

          {visibleCount < pending.length && (
            <Button
              variant="outline"
              className="mt-4"
              onClick={() => setVisibleCount((n) => n + 5)}
            >
              Show next {Math.min(5, pending.length - visibleCount)} actions (
              {pending.length - visibleCount} remaining)
            </Button>
          )}
          <Textarea
            aria-label="Authorization comment"
            maxLength={5000}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Add a note recorded with your decision (optional)…"
            className="mt-3"
          />

          {error && (
            <p className="mt-2 font-mono text-xs text-error">{error}</p>
          )}
          {notice && (
            <p className="mt-2 font-mono text-xs text-accent">{notice}</p>
          )}

          {pending.length > 1 && (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                variant="accent"
                size="sm"
                disabled={busy !== null || !canReview}
                onClick={() => setBulkDecision("approve")}
              >
                {busy !== null ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ShieldCheck className="h-3.5 w-3.5" />
                )}
                Review approval of all {pending.length}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy !== null || !canReview}
                onClick={() => setBulkDecision("reject")}
              >
                <ShieldX className="h-3.5 w-3.5" />
                Review rejection of all {pending.length}
              </Button>
            </div>
          )}
        </div>
      )}

      {resolved.length > 0 && (
        <div className="px-4 py-3">
          <h3 className="mb-2 text-xs font-medium text-muted">
            Decision record
          </h3>
          <ul className="space-y-1.5">
            {resolved.map((a) => {
              const meta = STATUS_META[a.status];
              return (
                <li
                  key={a.id}
                  className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs"
                >
                  <Badge variant={meta.variant}>{meta.label}</Badge>
                  <span className="font-mono text-muted">
                    {a.counterparty ?? "—"} · {amount(a.amount_cents)} ·{" "}
                    {a.target_id}
                  </span>
                  <span className="text-foreground/70">
                    {a.decision_source === "standing_rule"
                      ? "under a standing rule"
                      : a.decision_source === "human"
                        ? "by a reviewer"
                        : a.decision_source === "ceiling"
                          ? "by the org amount ceiling"
                          : a.decision_source === "policy"
                            ? "by org policy"
                            : ""}
                  </span>
                  {a.decided_at && (
                    <span className="font-mono text-muted">
                      {formatDateTime(a.decided_at)}
                    </span>
                  )}
                  {a.committed_at && (
                    <span className="text-accent">committed</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <Dialog
        open={bulkDecision !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setBulkDecision(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {bulkDecision === "approve"
                ? "Review bulk authorization"
                : "Review bulk rejection"}
            </DialogTitle>
            <DialogDescription>
              This decision covers every action listed below, including those
              outside the current page. Invoice authorization does not send a
              payment.
            </DialogDescription>
          </DialogHeader>
          <p className="my-4 font-medium">
            {pending.length} actions ·{" "}
            {scopeTotal === null ? "Total unavailable" : amount(scopeTotal)}
          </p>
          <ul className="max-h-64 space-y-3 overflow-y-auto border-y border-border py-3">
            {pending.map((a) => (
              <li key={a.id} className="flex justify-between gap-4 text-sm">
                <span>
                  {String(a.payload?.invoiceNumber ?? a.target_id)} ·{" "}
                  {a.counterparty ?? a.summary}
                </span>
                <span className="shrink-0 font-mono">
                  {amount(a.amount_cents)}
                </span>
              </li>
            ))}
          </ul>
          {bulkDecision === "approve" && !bulkReady && (
            <p role="alert" className="mt-4 text-sm text-warning">
              Approval is unavailable until source evidence and amounts are
              complete for every included action.
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setBulkDecision(null)}
              disabled={busy !== null}
            >
              Cancel
            </Button>
            <Button
              variant={bulkDecision === "approve" ? "accent" : "destructive"}
              disabled={
                busy !== null ||
                !canReview ||
                pending.length === 0 ||
                (bulkDecision === "approve" && !bulkReady)
              }
              onClick={() =>
                bulkDecision &&
                decide(
                  pending.map((a) => a.id),
                  bulkDecision,
                  null,
                )
              }
            >
              {busy
                ? "Recording…"
                : `Confirm ${bulkDecision === "approve" ? "authorization" : "rejection"} of ${pending.length}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
