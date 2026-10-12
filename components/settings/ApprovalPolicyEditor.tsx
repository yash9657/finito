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
import { formatCents, formatDateTime } from "@/lib/format";
import type { ApprovalPolicy } from "@/lib/types";

function centsToInput(cents: number | null): string {
  if (cents === null) return "";
  const value = BigInt(cents);
  return `${value / BigInt(100)}.${String(value % BigInt(100)).padStart(2, "0")}`;
}

function inputToCents(value: string): number | null | "invalid" {
  const trimmed = value.trim().replace(/[$,]/g, "");
  if (trimmed.length === 0) return null;
  if (!/^\d+(?:\.\d{1,2})?$/.test(trimmed)) return "invalid";
  const [whole, fraction = ""] = trimmed.split(".");
  const cents = BigInt(whole) * BigInt(100) + BigInt(fraction.padEnd(2, "0"));
  if (cents <= BigInt(0) || cents > BigInt(Number.MAX_SAFE_INTEGER))
    return "invalid";
  return Number(cents);
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
  const [hardDeny, setHardDeny] = React.useState(
    centsToInput(policy.hard_deny_above_cents),
  );
  const [autoMax, setAutoMax] = React.useState(
    centsToInput(policy.auto_approve_max_cents),
  );
  const [requireKnown, setRequireKnown] = React.useState(
    policy.require_known_counterparty,
  );
  const [counterparties, setCounterparties] = React.useState(
    policy.approved_counterparties.join("\n"),
  );
  const [separateApprover, setSeparateApprover] = React.useState(
    policy.require_separate_approver,
  );
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

  async function save() {
    if (saving || !isAdmin) return;
    setError(null);
    setSaved(false);

    const hard = inputToCents(hardDeny);
    const auto = inputToCents(autoMax);
    if (hard === "invalid" || auto === "invalid") {
      setError(
        "Enter positive USD amounts with no more than two decimal places. Leave a field blank for no limit.",
      );
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
      const body = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!res.ok)
        throw new Error(body?.error ?? `Save failed (${res.status})`);
      setSaved(true);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save policy");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      className="flex flex-col gap-6 border-y border-border py-6"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Block actions above (USD)</span>
          <input
            value={hardDeny}
            onChange={(e) => setHardDeny(e.target.value)}
            disabled={!isAdmin || saving}
            inputMode="decimal"
            placeholder="No limit"
            className="min-h-11 w-full rounded-md border border-border bg-background px-3 font-mono text-base text-foreground disabled:opacity-60 sm:text-sm"
          />
          <span className="text-sm leading-6 text-muted">
            Actions above this amount are blocked, including actions reviewed by
            an administrator.
          </span>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">
            Standing rules apply up to (USD)
          </span>
          <input
            value={autoMax}
            onChange={(e) => setAutoMax(e.target.value)}
            disabled={!isAdmin || saving}
            inputMode="decimal"
            placeholder="No limit"
            className="min-h-11 w-full rounded-md border border-border bg-background px-3 font-mono text-base text-foreground disabled:opacity-60 sm:text-sm"
          />
          <span className="text-sm leading-6 text-muted">
            Above this amount, a person must review each action even when a
            standing rule matches.
          </span>
        </label>
      </div>

      <div className="flex flex-col gap-2">
        <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm font-medium">
          <input
            type="checkbox"
            checked={requireKnown}
            disabled={!isAdmin || saving}
            onChange={(e) => setRequireKnown(e.target.checked)}
            className="h-5 w-5 shrink-0 accent-[var(--accent)]"
          />
          Only allow approved counterparties
        </label>
        <label htmlFor="approved-counterparties" className="text-sm text-muted">
          Approved names, one per line
        </label>
        <textarea
          id="approved-counterparties"
          value={counterparties}
          onChange={(e) => setCounterparties(e.target.value)}
          disabled={!isAdmin || saving}
          rows={4}
          placeholder={"One name per line\nAcme Supplies\nGlobex"}
          className="w-full rounded-md border border-border bg-background px-3 py-3 text-base text-foreground disabled:opacity-60 sm:text-sm"
        />
        <span className="text-sm leading-6 text-muted">
          When on, an action to a name that is not on this list is denied — not
          queued for approval. Names match exactly, ignoring capitalization and
          extra spaces.
        </span>
      </div>

      <label className="flex min-h-11 cursor-pointer flex-col gap-1.5">
        <span className="flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            checked={separateApprover}
            disabled={!isAdmin || saving}
            onChange={(e) => setSeparateApprover(e.target.checked)}
            className="h-5 w-5 shrink-0 accent-[var(--accent)]"
          />
          Require a separate approver
        </span>
        <span className="text-sm leading-6 text-muted">
          The person who launched a workflow cannot authorize its actions.
        </span>
      </label>

      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {isAdmin && (
          <Button type="submit" variant="accent" disabled={saving}>
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            {saving ? "Saving…" : "Save organization limits"}
          </Button>
        )}
        {saved && (
          <span role="status" className="text-sm text-accent">
            Organization limits saved.
          </span>
        )}
        <span className="text-sm leading-6 text-muted">
          {policy.hard_deny_above_cents !== null
            ? `Current limit: ${formatCents(policy.hard_deny_above_cents)}`
            : "No blocking amount limit is set"}
          {policy.updated_at
            ? ` · updated ${formatDateTime(policy.updated_at)}`
            : ""}
        </span>
      </div>
    </form>
  );
}
