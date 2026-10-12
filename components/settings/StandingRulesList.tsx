"use client";

import * as React from "react";
import { Loader2, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/format";
import type { ActionTypeSpec } from "@/lib/approvals/action-types";
import type { RuleRow } from "@/components/settings/ApprovalsManager";

const STATE_VARIANT: Record<string, "accent" | "muted" | "error"> = {
  live: "accent",
  expired: "muted",
  consumed: "muted",
  revoked: "error",
};
const INPUT =
  "min-h-11 w-full rounded-md border border-border bg-background px-3 py-2 text-base text-foreground disabled:opacity-60 sm:text-sm";

export default function StandingRulesList({
  rules,
  actionTypes,
  isAdmin,
  onChanged,
}: {
  rules: RuleRow[];
  actionTypes: ActionTypeSpec[];
  isAdmin: boolean;
  onChanged: () => void;
}) {
  const [adding, setAdding] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [actionType, setActionType] = React.useState(actionTypes[0]?.id ?? "");
  const [counterparty, setCounterparty] = React.useState("");
  const [maxAmount, setMaxAmount] = React.useState("");
  const [expiresAt, setExpiresAt] = React.useState("");
  const [note, setNote] = React.useState("");
  React.useEffect(() => {
    if (actionType === "" && actionTypes.length > 0)
      setActionType(actionTypes[0].id);
  }, [actionTypes, actionType]);
  const spec = actionTypes.find((s) => s.id === actionType);

  async function mint() {
    if (busy || !isAdmin) return;
    setError(null);
    const trimmed = maxAmount.trim().replace(/[$,]/g, "");
    let cents: number | null = null;
    if (trimmed) {
      if (!/^\d+(?:\.\d{1,2})?$/.test(trimmed)) {
        setError(
          "Enter a positive USD amount with no more than two decimal places.",
        );
        return;
      }
      const [whole, fraction = ""] = trimmed.split(".");
      const value =
        BigInt(whole) * BigInt(100) + BigInt(fraction.padEnd(2, "0"));
      if (value <= BigInt(0) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
        setError("Enter a positive amount within the supported range.");
        return;
      }
      cents = Number(value);
    }
    if (!counterparty.trim() && cents === null) {
      setError(
        "Choose a counterparty or an amount limit before creating a standing rule.",
      );
      return;
    }
    if (!actionType) {
      setError("Select an action type.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/approvals/rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope: "standing",
          action_type: actionType,
          counterparty: counterparty.trim() || null,
          max_amount_cents: cents,
          expires_at: expiresAt
            ? new Date(`${expiresAt}T23:59:59Z`).toISOString()
            : null,
          note: note.trim() || null,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok)
        throw new Error(body?.error ?? "Could not create the rule. Try again.");
      setAdding(false);
      setCounterparty("");
      setMaxAmount("");
      setExpiresAt("");
      setNote("");
      onChanged();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not create the rule. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function revoke(rule: RuleRow) {
    if (
      busy ||
      !confirm(
        `Revoke this standing rule for ${rule.binding}? Future matching actions will require another authorization. Past decisions remain in the audit record.`,
      )
    )
      return;
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/approvals/rules/${rule.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? "Could not revoke the rule. Try again.");
      }
      onChanged();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not revoke the rule. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-y border-border">
      {rules.length === 0 ? (
        <p className="py-6 text-sm leading-6 text-muted">
          No standing rules. Actions that need authorization are sent to a
          reviewer. You can create a rule here or while reviewing a matching
          action.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {rules.map((r) => (
            <li
              key={r.id}
              className="flex min-w-0 flex-col gap-3 py-5 sm:flex-row sm:items-start sm:justify-between"
            >
              <div className="min-w-0 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-medium">
                    {actionTypes.find((s) => s.id === r.action_type)?.label ??
                      r.action_type.replace(/_/g, " ")}
                  </h3>
                  <Badge variant={STATE_VARIANT[r.state] ?? "muted"}>
                    {r.state === "live" ? "Active" : r.state}
                  </Badge>
                </div>
                <p className="break-words text-sm">{r.binding}</p>
                <p className="text-sm text-muted">
                  {r.scope === "standing"
                    ? "Standing authorization"
                    : r.scope.replace(/_/g, " ")}{" "}
                  · Created {formatDate(r.created_at)}
                  {r.expires_at
                    ? ` · Expires ${formatDate(r.expires_at)}`
                    : " · No expiration"}
                </p>
              </div>
              {isAdmin && r.state === "live" && (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => revoke(r)}
                  className="self-start"
                >
                  <Trash2 aria-hidden="true" className="h-4 w-4 text-error" />
                  Revoke rule
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {isAdmin && (
        <div className="border-t border-border py-5">
          {!adding ? (
            <Button
              variant="outline"
              disabled={actionTypes.length === 0 || busy}
              onClick={() => {
                setError(null);
                setAdding(true);
              }}
            >
              <Plus aria-hidden="true" className="h-4 w-4" />
              Add standing rule
            </Button>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void mint();
              }}
              className="space-y-5"
            >
              <h3 className="font-medium">New standing rule</h3>
              <fieldset
                disabled={busy}
                className="grid min-w-0 gap-5 sm:grid-cols-2"
              >
                <label className="flex min-w-0 flex-col gap-2 text-sm">
                  Action type
                  <select
                    value={actionType}
                    onChange={(e) => setActionType(e.target.value)}
                    className={INPUT}
                  >
                    {actionTypes.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex min-w-0 flex-col gap-2 text-sm">
                  {spec?.counterpartyLabel ?? "Counterparty"}
                  <input
                    value={counterparty}
                    onChange={(e) => setCounterparty(e.target.value)}
                    maxLength={500}
                    className={INPUT}
                  />
                  <span className="leading-6 text-muted">
                    Exact name. Leave blank to apply the amount limit to any
                    counterparty.
                  </span>
                </label>
                <label className="flex min-w-0 flex-col gap-2 text-sm">
                  Maximum amount (USD)
                  <input
                    value={maxAmount}
                    onChange={(e) => setMaxAmount(e.target.value)}
                    inputMode="decimal"
                    placeholder="No amount limit"
                    className={INPUT}
                  />
                  <span className="leading-6 text-muted">
                    Includes actions equal to this amount.
                  </span>
                </label>
                <label className="flex min-w-0 flex-col gap-2 text-sm">
                  Expiration date (optional)
                  <input
                    type="date"
                    value={expiresAt}
                    onChange={(e) => setExpiresAt(e.target.value)}
                    className={INPUT}
                  />
                  <span className="leading-6 text-muted">
                    Expires at the end of this date in UTC.
                  </span>
                </label>
                <label className="flex min-w-0 flex-col gap-2 text-sm sm:col-span-2">
                  Reason for this rule (optional)
                  <input
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    maxLength={2000}
                    placeholder="Describe the business reason"
                    className={INPUT}
                  />
                </label>
              </fieldset>
              <p className="text-sm leading-6 text-muted">
                Set a counterparty, an amount limit, or both. Organization
                limits still apply to every action.
              </p>
              {error && (
                <p role="alert" className="text-sm text-error">
                  {error}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button type="submit" variant="accent" disabled={busy}>
                  {busy ? (
                    <Loader2
                      aria-hidden="true"
                      className="h-4 w-4 animate-spin"
                    />
                  ) : (
                    <ShieldCheck aria-hidden="true" className="h-4 w-4" />
                  )}
                  {busy ? "Creating…" : "Create rule"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setAdding(false)}
                  disabled={busy}
                >
                  Cancel
                </Button>
              </div>
            </form>
          )}
          {!adding && error && (
            <p role="alert" className="mt-3 text-sm text-error">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
