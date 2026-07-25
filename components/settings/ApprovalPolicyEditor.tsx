"use client";

/**
 * ApprovalPolicyEditor (Plan 3 §6, D-A4/D-A8) — the structural ceilings.
 *
 * These are the only controls in the product that an in-band approval click cannot
 * override, so the copy is explicit about which is which: the hard ceiling *denies*, the
 * auto-approve ceiling only stops a standing rule from firing, and the counterparty
 * allowlist denies unknown payees outright. Amounts are entered in dollars and stored as
 * integer cents (D7/D-A16).
 */

import * as React from "react";
import { Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatCents, formatDateTime } from "@/lib/format";
import type { ApprovalPolicy } from "@/lib/types";

function centsToInput(cents: number | null): string {
  return cents === null ? "" : (cents / 100).toFixed(2);
}

function inputToCents(value: string): number | null | "invalid" {
  const trimmed = value.trim().replace(/[$,]/g, "");
  if (trimmed.length === 0) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return "invalid";
  return Math.round(n * 100);
}

export default function ApprovalPolicyEditor({
  policy,
  isAdmin,
  onSaved,
}: {
  policy: ApprovalPolicy;
  isAdmin: boolean;
  onSaved: () => void;
}) {
  const [hardDeny, setHardDeny] = React.useState(centsToInput(policy.hard_deny_above_cents));
  const [autoMax, setAutoMax] = React.useState(centsToInput(policy.auto_approve_max_cents));
  const [requireKnown, setRequireKnown] = React.useState(policy.require_known_counterparty);
  const [counterparties, setCounterparties] = React.useState(
    policy.approved_counterparties.join("\n"),
  );
  const [separateApprover, setSeparateApprover] = React.useState(policy.require_separate_approver);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

  async function save() {
    setError(null);
    setSaved(false);

    const hard = inputToCents(hardDeny);
    const auto = inputToCents(autoMax);
    if (hard === "invalid" || auto === "invalid") {
      setError("Ceilings must be positive dollar amounts, or blank for no ceiling.");
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/approvals/policy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hard_deny_above_cents: hard,
          auto_approve_max_cents: auto,
          require_known_counterparty: requireKnown,
          approved_counterparties: counterparties
            .split("\n")
            .map((s) => s.trim())
            .filter((s) => s.length > 0),
          require_separate_approver: separateApprover,
        }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(body?.error ?? `Save failed (${res.status})`);
      setSaved(true);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save policy");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-5 p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Hard deny above</span>
            <input
              value={hardDeny}
              onChange={(e) => setHardDeny(e.target.value)}
              disabled={!isAdmin}
              inputMode="decimal"
              placeholder="no ceiling"
              className="h-9 rounded-md border border-border bg-card px-3 font-mono text-sm text-foreground disabled:opacity-60"
            />
            <span className="text-xs text-muted">
              Actions above this are denied outright. No approval anywhere in the product can
              release them.
            </span>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Auto-approve only up to</span>
            <input
              value={autoMax}
              onChange={(e) => setAutoMax(e.target.value)}
              disabled={!isAdmin}
              inputMode="decimal"
              placeholder="no ceiling"
              className="h-9 rounded-md border border-border bg-card px-3 font-mono text-sm text-foreground disabled:opacity-60"
            />
            <span className="text-xs text-muted">
              A standing rule never fires above this — those actions still reach a person.
            </span>
          </label>
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={requireKnown}
              disabled={!isAdmin}
              onChange={(e) => setRequireKnown(e.target.checked)}
              className="h-3.5 w-3.5 accent-[var(--accent)]"
            />
            Only allow approved counterparties
          </span>
          <textarea
            value={counterparties}
            onChange={(e) => setCounterparties(e.target.value)}
            disabled={!isAdmin}
            rows={4}
            placeholder={"One name per line\nAcme Supplies\nGlobex"}
            className="rounded-md border border-border bg-card px-3 py-2 font-mono text-sm text-foreground disabled:opacity-60"
          />
          <span className="text-xs text-muted">
            When on, an action to a name that is not on this list is denied — not queued for
            approval. Matching ignores case and extra spaces, nothing more.
          </span>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={separateApprover}
              disabled={!isAdmin}
              onChange={(e) => setSeparateApprover(e.target.checked)}
              className="h-3.5 w-3.5 accent-[var(--accent)]"
            />
            Require a separate approver
          </span>
          <span className="text-xs text-muted">
            Four eyes: whoever launched a run cannot authorize its actions.
          </span>
        </label>

        {error && <p className="font-mono text-xs text-error">{error}</p>}

        <div className="flex flex-wrap items-center gap-3">
          {isAdmin && (
            <Button variant="accent" onClick={save} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save ceilings
            </Button>
          )}
          {saved && <span className="font-mono text-xs text-accent">saved</span>}
          <span className="font-mono text-xs text-muted">
            {policy.hard_deny_above_cents !== null
              ? `denying above ${formatCents(policy.hard_deny_above_cents)}`
              : "no hard ceiling set"}
            {policy.updated_at ? ` · updated ${formatDateTime(policy.updated_at)}` : ""}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
