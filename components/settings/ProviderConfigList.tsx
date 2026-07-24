"use client";

/**
 * ProviderConfigList (Plan 2 §6) — the org's provider configs with per-session Test
 * status chips (no background polling). Admins get Test / Edit / Deactivate; non-admins
 * see the table read-only (the API enforces regardless).
 */

import * as React from "react";
import { Loader2, Check, X, KeyRound, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PROVIDER_META } from "@/components/settings/providerMeta";
import type { OrgModelConfigPublic } from "@/lib/types";

type TestStatus =
  | { kind: "untested" }
  | { kind: "testing" }
  | { kind: "ok" }
  | { kind: "fail"; error?: string };

interface Props {
  configs: OrgModelConfigPublic[];
  isAdmin: boolean;
  onEdit: (config: OrgModelConfigPublic) => void;
  onChanged: () => void;
}

export default function ProviderConfigList({ configs, isAdmin, onEdit, onChanged }: Props) {
  const [status, setStatus] = React.useState<Record<string, TestStatus>>({});

  async function test(id: string) {
    setStatus((s) => ({ ...s, [id]: { kind: "testing" } }));
    try {
      const res = await fetch(`/api/llm/configs/${id}/test`, { method: "POST" });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      setStatus((s) => ({
        ...s,
        [id]: res.ok && body?.ok ? { kind: "ok" } : { kind: "fail", error: body?.error },
      }));
    } catch {
      setStatus((s) => ({ ...s, [id]: { kind: "fail", error: "Server unreachable" } }));
    }
  }

  async function deactivate(id: string) {
    if (!confirm("Deactivate this provider? Its key material is erased and step assignments are cleared.")) {
      return;
    }
    const res = await fetch(`/api/llm/configs/${id}`, { method: "DELETE" });
    if (res.ok) onChanged();
  }

  const active = configs.filter((c) => c.is_active);

  if (active.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted">
        No providers configured yet. Add one to run workflows.
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Provider</TableHead>
          <TableHead>Name</TableHead>
          <TableHead>Default model</TableHead>
          <TableHead>Key / URL</TableHead>
          <TableHead>Status</TableHead>
          {isAdmin && <TableHead className="text-right">Actions</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {active.map((c) => {
          const st = status[c.id] ?? { kind: "untested" };
          return (
            <TableRow key={c.id}>
              <TableCell>
                <span className="flex items-center gap-1.5">
                  {PROVIDER_META[c.provider]?.label ?? c.provider}
                  {c.is_default && <Badge variant="accent">Default</Badge>}
                </span>
              </TableCell>
              <TableCell>{c.display_name}</TableCell>
              <TableCell className="font-mono text-xs">{c.default_model}</TableCell>
              <TableCell className="font-mono text-xs text-muted">
                {c.base_url ? (
                  <span className="inline-flex items-center gap-1">
                    <Server className="h-3 w-3" />
                    {c.base_url}
                  </span>
                ) : c.key_last4 ? (
                  <span className="inline-flex items-center gap-1">
                    <KeyRound className="h-3 w-3" />
                    …{c.key_last4}
                  </span>
                ) : (
                  "—"
                )}
              </TableCell>
              <TableCell>
                <StatusChip status={st} />
              </TableCell>
              {isAdmin && (
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1.5">
                    <Button size="sm" variant="outline" onClick={() => test(c.id)} disabled={st.kind === "testing"}>
                      {st.kind === "testing" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Test"}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => onEdit(c)}>
                      Edit
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => deactivate(c.id)}>
                      Deactivate
                    </Button>
                  </div>
                </TableCell>
              )}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function StatusChip({ status }: { status: TestStatus }) {
  if (status.kind === "ok") {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-accent">
        <Check className="h-3.5 w-3.5" /> connected
      </span>
    );
  }
  if (status.kind === "fail") {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-error" title={status.error}>
        <X className="h-3.5 w-3.5" /> {status.error ?? "failed"}
      </span>
    );
  }
  if (status.kind === "testing") {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> testing…
      </span>
    );
  }
  return <span className="text-xs text-muted">untested</span>;
}
