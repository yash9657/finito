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
import { Textarea } from "@/components/ui/textarea";
import { formatCents, formatDateTime } from "@/lib/format";
import { RISK_CLASS_SPECS } from "@/lib/approvals/risk";
import { actionTypeLabel } from "@/lib/approvals/action-types";
import type { ActionRequestRow, ActionStatus, RuleScope, WorkflowRow } from "@/lib/types";

interface ApprovalPanelProps {
  workflow: WorkflowRow;
  actions: ActionRequestRow[];
  onDecided: () => void;
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
        <span className="text-foreground/80">{actionTypeLabel(action.action_type)}</span> actions
        matching it are authorized without asking. A standing rule must stay bound to a
        counterparty and/or an amount cap.
      </p>

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-xs text-muted">
          Scope
          <select
            value={draft.scope}
            onChange={(e) => setDraft({ ...draft, scope: e.target.value as RuleScope })}
            className="h-8 rounded-md border border-border bg-card px-2 text-sm text-foreground"
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
            onChange={(e) => setDraft({ ...draft, counterparty: e.target.value })}
            placeholder="any"
            className="h-8 rounded-md border border-border bg-card px-2 font-mono text-sm text-foreground"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-muted">
          Up to ($, inclusive)
          <input
            value={draft.maxAmountDollars}
            onChange={(e) => setDraft({ ...draft, maxAmountDollars: e.target.value })}
            inputMode="decimal"
            placeholder="no cap"
            className="h-8 rounded-md border border-border bg-card px-2 font-mono text-sm text-foreground"
          />
        </label>
      </div>

      <input
        value={draft.note}
        onChange={(e) => setDraft({ ...draft, note: e.target.value })}
        placeholder="Why this rule exists (recorded with your name)"
        className="h-8 w-full rounded-md border border-border bg-card px-2 text-sm text-foreground"
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */

export default function ApprovalPanel({ workflow, actions, onDecided }: ApprovalPanelProps) {
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
  if (actions.length === 0) return null;

  async function decide(
    actionIds: string[],
    decision: "approve" | "reject",
    withGrant: ActionRequestRow | null,
  ) {
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
        const cents = dollars.length > 0 ? Math.round(Number(dollars) * 100) : null;
        if (cents !== null && (!Number.isFinite(cents) || cents <= 0)) {
          throw new Error("Enter a positive amount cap, or leave it blank for no cap.");
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
      const payload = (await res.json().catch(() => null)) as
        | {
            error?: string;
            resolved?: string[];
            alreadyResolved?: string[];
            notOverridable?: string[];
            pendingRemaining?: number;
            resumed?: boolean;
            rule?: { scope: string; binding: string } | null;
          }
        | null;
      if (!res.ok) throw new Error(payload?.error ?? `Request failed (${res.status})`);

      const notices: string[] = [];
      if (payload?.rule) notices.push(`${payload.rule.scope} rule created ${payload.rule.binding}`);
      if (payload?.alreadyResolved?.length) {
        notices.push(`${payload.alreadyResolved.length} action(s) were already decided by someone else`);
      }
      if (payload?.resumed) notices.push("all actions decided — the run has resumed");
      setNotice(notices.join(" · ") || null);
      setComment("");
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
            className={pending.length > 0 ? "h-4 w-4 text-warning" : "h-4 w-4 text-muted"}
          />
          <h2 className="text-sm font-semibold text-foreground">Authorization</h2>
        </div>
        <div className="flex items-center gap-2 font-mono text-xs text-muted">
          {pending.length > 0 && <Badge variant="warning">{pending.length} awaiting approval</Badge>}
          <span>
            {resolved.filter((a) => a.status === "auto_approved" || a.status === "approved").length}{" "}
            authorized
          </span>
          <span>·</span>
          <span>
            {resolved.filter((a) => a.status === "denied" || a.status === "rejected").length} withheld
          </span>
        </div>
      </header>

      {pending.length > 0 && (
        <div className="border-b border-border px-4 py-4">
          <p className="mb-3 text-xs text-muted">
            This run is suspended until each consequential action below is decided. Nothing has
            been committed. Amount ceilings and counterparty rules set by your organization are
            enforced before this point and cannot be overridden here.
          </p>

          <div className="space-y-3">
            {pending.map((a) => {
              const spec = RISK_CLASS_SPECS[a.risk_class];
              const rowBusy = busy?.includes(a.id) ?? false;
              return (
                <div key={a.id} className="rounded-md border border-warning/30 bg-warning/[0.04] p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="mb-1 flex flex-wrap items-center gap-2">
                        <Badge variant="warning" title={spec.description}>
                          {spec.label}
                        </Badge>
                        <span className="font-mono text-xs text-muted">
                          {actionTypeLabel(a.action_type)}
                        </span>
                      </div>
                      <p className="text-sm text-foreground">{a.summary}</p>
                      <p className="mt-1 font-mono text-[11px] text-muted">
                        {a.counterparty ?? "no counterparty"} · {amount(a.amount_cents)} ·{" "}
                        {a.target_kind} {a.target_id}
                      </p>
                      {a.decision_reason && (
                        <p className="mt-1.5 text-xs text-warning/90">{a.decision_reason}</p>
                      )}
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        variant="accent"
                        size="sm"
                        disabled={rowBusy}
                        onClick={() => decide([a.id], "approve", grantFor === a.id ? a : null)}
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
                        disabled={rowBusy}
                        onClick={() => decide([a.id], "reject", null)}
                      >
                        <XCircle className="h-3.5 w-3.5" />
                        Reject
                      </Button>
                    </div>
                  </div>

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
                          a.amount_cents === null ? "" : (a.amount_cents / 100).toFixed(2),
                        note: "",
                      });
                    }}
                    className="mt-2 inline-flex items-center gap-1 text-xs text-muted transition-colors hover:text-foreground"
                  >
                    <ChevronDown
                      className={`h-3.5 w-3.5 transition-transform ${grantFor === a.id ? "rotate-180" : ""}`}
                    />
                    {grantFor === a.id ? "Approve without a rule" : "Approve and create a rule…"}
                  </button>

                  {grantFor === a.id && <GrantForm action={a} draft={draft} setDraft={setDraft} />}
                </div>
              );
            })}
          </div>

          <Textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Add a note recorded with your decision (optional)…"
            className="mt-3"
          />

          {error && <p className="mt-2 font-mono text-xs text-error">{error}</p>}
          {notice && <p className="mt-2 font-mono text-xs text-accent">{notice}</p>}

          {pending.length > 1 && (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                variant="accent"
                size="sm"
                disabled={busy !== null}
                onClick={() => decide(pending.map((a) => a.id), "approve", null)}
              >
                {busy !== null ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ShieldCheck className="h-3.5 w-3.5" />
                )}
                Approve all {pending.length}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onClick={() => decide(pending.map((a) => a.id), "reject", null)}
              >
                <ShieldX className="h-3.5 w-3.5" />
                Reject all {pending.length}
              </Button>
            </div>
          )}
        </div>
      )}

      {resolved.length > 0 && (
        <div className="px-4 py-3">
          <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted">
            Decision record
          </h3>
          <ul className="space-y-1.5">
            {resolved.map((a) => {
              const meta = STATUS_META[a.status];
              return (
                <li key={a.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
                  <Badge variant={meta.variant}>{meta.label}</Badge>
                  <span className="font-mono text-muted">
                    {a.counterparty ?? "—"} · {amount(a.amount_cents)} · {a.target_id}
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
                    <span className="font-mono text-muted">{formatDateTime(a.decided_at)}</span>
                  )}
                  {a.committed_at && <span className="text-accent">committed</span>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
