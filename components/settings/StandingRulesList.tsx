"use client";

/**
 * StandingRulesList (Plan 3 §6, D-A6/D-A7) — the org's standing grants.
 *
 * Every row shows what the grant is *bound to*, who minted it and when, and its live /
 * expired / consumed / revoked state. Revocation is soft on purpose: past auto-approvals
 * point at the rule that authorized them, so the row stays and the audit trail keeps its
 * authority reference.
 *
 * The mint form cannot express an unbounded standing grant — the API rejects one, and the
 * form says so before you try.
 */

import * as React from "react";
import { Loader2, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDate } from "@/lib/format";
import type { ActionTypeSpec } from "@/lib/approvals/action-types";
import type { RuleRow } from "@/components/settings/ApprovalsManager";

const STATE_VARIANT: Record<string, "accent" | "muted" | "error"> = {
  live: "accent",
  expired: "muted",
  consumed: "muted",
  revoked: "error",
};

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
    if (actionType === "" && actionTypes.length > 0) setActionType(actionTypes[0].id);
  }, [actionTypes, actionType]);

  const spec = actionTypes.find((s) => s.id === actionType);

  async function mint() {
    setError(null);
    const trimmed = maxAmount.trim().replace(/[$,]/g, "");
    const cents = trimmed.length > 0 ? Math.round(Number(trimmed) * 100) : null;
    if (cents !== null && (!Number.isFinite(cents) || cents <= 0)) {
      setError("The amount cap must be a positive dollar amount, or blank for no cap.");
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
          expires_at: expiresAt ? new Date(`${expiresAt}T23:59:59Z`).toISOString() : null,
          note: note.trim() || null,
        }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(body?.error ?? `Failed to create rule (${res.status})`);
      setAdding(false);
      setCounterparty("");
      setMaxAmount("");
      setExpiresAt("");
      setNote("");
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create rule");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/approvals/rules/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Failed to revoke (${res.status})`);
      }
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to revoke rule");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardContent className="p-0">
        {rules.length === 0 ? (
          <div className="px-5 py-6 text-sm text-muted">
            No standing rules. Every consequential action is decided by a person — which is the
            safe default. Rules are usually minted from an approval decision, where they can be
            pre-bound to that counterparty and amount.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Action</TableHead>
                <TableHead>Bound to</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Minted</TableHead>
                <TableHead>State</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-xs">{r.action_type}</TableCell>
                  <TableCell className="text-xs">{r.binding}</TableCell>
                  <TableCell className="font-mono text-xs text-muted">{r.scope}</TableCell>
                  <TableCell className="font-mono text-xs text-muted">
                    {formatDate(r.created_at)}
                    {r.expires_at ? ` · expires ${formatDate(r.expires_at)}` : ""}
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATE_VARIANT[r.state] ?? "muted"}>{r.state}</Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {isAdmin && r.state === "live" && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => revoke(r.id)}
                        title="Revoke this rule"
                      >
                        <Trash2 className="h-3.5 w-3.5 text-error" />
                        Revoke
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {isAdmin && (
          <div className="border-t border-border px-5 py-4">
            {!adding ? (
              <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
                <Plus className="h-4 w-4" />
                Add standing rule
              </Button>
            ) : (
              <div className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="flex flex-col gap-1 text-xs text-muted">
                    Action type
                    <select
                      value={actionType}
                      onChange={(e) => setActionType(e.target.value)}
                      className="h-9 rounded-md border border-border bg-card px-2 text-sm text-foreground"
                    >
                      {actionTypes.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="flex flex-col gap-1 text-xs text-muted">
                    {spec?.counterpartyLabel ?? "Counterparty"} (exact, blank = any)
                    <input
                      value={counterparty}
                      onChange={(e) => setCounterparty(e.target.value)}
                      className="h-9 rounded-md border border-border bg-card px-2 font-mono text-sm text-foreground"
                    />
                  </label>

                  <label className="flex flex-col gap-1 text-xs text-muted">
                    Up to ($, inclusive)
                    <input
                      value={maxAmount}
                      onChange={(e) => setMaxAmount(e.target.value)}
                      inputMode="decimal"
                      className="h-9 rounded-md border border-border bg-card px-2 font-mono text-sm text-foreground"
                    />
                  </label>

                  <label className="flex flex-col gap-1 text-xs text-muted">
                    Expires (optional)
                    <input
                      type="date"
                      value={expiresAt}
                      onChange={(e) => setExpiresAt(e.target.value)}
                      className="h-9 rounded-md border border-border bg-card px-2 font-mono text-sm text-foreground"
                    />
                  </label>
                </div>

                <input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Why this rule exists (recorded with your name)"
                  className="h-9 w-full rounded-md border border-border bg-card px-2 text-sm text-foreground"
                />

                <p className="text-xs text-muted">
                  A standing rule must be bound to a counterparty and/or an amount cap — an
                  unbounded grant is rejected.
                </p>

                {error && <p className="font-mono text-xs text-error">{error}</p>}

                <div className="flex gap-2">
                  <Button variant="accent" size="sm" onClick={mint} disabled={busy}>
                    {busy ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <ShieldCheck className="h-3.5 w-3.5" />
                    )}
                    Create rule
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setAdding(false)} disabled={busy}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
            {!adding && error && <p className="mt-2 font-mono text-xs text-error">{error}</p>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
