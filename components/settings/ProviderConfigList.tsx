"use client";

import * as React from "react";
import { Loader2, Check, X, KeyRound, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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

export default function ProviderConfigList({
  configs,
  isAdmin,
  onEdit,
  onChanged,
}: Props) {
  const [status, setStatus] = React.useState<Record<string, TestStatus>>({});
  const [deactivating, setDeactivating] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function test(id: string) {
    if (status[id]?.kind === "testing") return;
    setStatus((s) => ({ ...s, [id]: { kind: "testing" } }));
    try {
      const res = await fetch(`/api/llm/configs/${id}/test`, {
        method: "POST",
        signal: AbortSignal.timeout(45_000),
      });
      const body = (await res.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
      } | null;
      setStatus((s) => ({
        ...s,
        [id]:
          res.ok && body?.ok
            ? { kind: "ok" }
            : { kind: "fail", error: body?.error },
      }));
    } catch {
      setStatus((s) => ({
        ...s,
        [id]: {
          kind: "fail",
          error: "Could not reach the server. Try the connection test again.",
        },
      }));
    }
  }

  async function deactivate(config: OrgModelConfigPublic) {
    if (
      deactivating ||
      !confirm(
        `Deactivate ${config.display_name}? This erases its saved API key and clears its workflow assignments. Workflows using it will need another provider.`,
      )
    )
      return;
    setDeactivating(config.id);
    setError(null);
    try {
      const res = await fetch(`/api/llm/configs/${config.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(
          body?.error ?? "Could not deactivate this provider. Try again.",
        );
      }
      onChanged();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not deactivate this provider. Try again.",
      );
    } finally {
      setDeactivating(null);
    }
  }

  const active = configs.filter((c) => c.is_active);
  if (active.length === 0)
    return (
      <p className="py-6 text-sm leading-6 text-muted">
        No saved providers. Add a provider to choose the models available to
        your organization.
      </p>
    );

  return (
    <div>
      {error && (
        <p role="alert" className="mb-4 text-sm text-error">
          {error}
        </p>
      )}
      <ul className="divide-y divide-border border-y border-border">
        {active.map((c) => {
          const st = status[c.id] ?? { kind: "untested" };
          return (
            <li key={c.id} className="py-5">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="break-words font-medium">
                      {c.display_name}
                    </h3>
                    {c.is_default && (
                      <Badge variant="accent">Organization default</Badge>
                    )}
                  </div>
                  <p className="mt-1 text-sm text-muted">
                    {PROVIDER_META[c.provider]?.label ?? c.provider}
                  </p>
                  <dl className="mt-4 space-y-2 text-sm">
                    <div className="flex flex-col gap-1 sm:flex-row sm:gap-3">
                      <dt className="shrink-0 text-muted sm:w-20">Model</dt>
                      <dd className="min-w-0 break-all font-mono">
                        {c.default_model}
                      </dd>
                    </div>
                    <div className="flex flex-col gap-1 sm:flex-row sm:gap-3">
                      <dt className="shrink-0 text-muted sm:w-20">
                        Connection
                      </dt>
                      <dd className="flex min-w-0 items-start gap-2 break-all text-muted">
                        {c.base_url ? (
                          <>
                            <Server
                              aria-hidden="true"
                              className="mt-0.5 h-4 w-4 shrink-0"
                            />
                            {c.base_url}
                          </>
                        ) : c.key_last4 ? (
                          <>
                            <KeyRound
                              aria-hidden="true"
                              className="mt-0.5 h-4 w-4 shrink-0"
                            />
                            API key ending in {c.key_last4}
                          </>
                        ) : (
                          "No saved API key"
                        )}
                      </dd>
                    </div>
                  </dl>
                </div>
                {isAdmin && (
                  <div className="flex flex-wrap gap-2 lg:justify-end">
                    <Button
                      variant="outline"
                      onClick={() => test(c.id)}
                      disabled={st.kind === "testing" || deactivating !== null}
                      aria-label={`Test ${c.display_name} connection`}
                    >
                      {st.kind === "testing" && (
                        <Loader2
                          aria-hidden="true"
                          className="h-4 w-4 animate-spin"
                        />
                      )}
                      {st.kind === "testing" ? "Testing…" : "Test connection"}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => onEdit(c)}
                      disabled={deactivating !== null || st.kind === "testing"}
                      aria-label={`Edit ${c.display_name}`}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => deactivate(c)}
                      disabled={deactivating !== null || st.kind === "testing"}
                      aria-label={`Deactivate ${c.display_name}`}
                    >
                      {deactivating === c.id ? "Deactivating…" : "Deactivate"}
                    </Button>
                  </div>
                )}
              </div>
              <div role="status" className="mt-3">
                <StatusChip status={st} />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function StatusChip({ status }: { status: TestStatus }) {
  if (status.kind === "ok")
    return (
      <span className="inline-flex items-center gap-2 text-sm text-accent">
        <Check aria-hidden="true" className="h-4 w-4 shrink-0" />
        Connection verified this session
      </span>
    );
  if (status.kind === "fail")
    return (
      <span className="inline-flex items-start gap-2 break-words text-sm text-error">
        <X aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
        {status.error ??
          "Connection failed. Check the provider settings and try again."}
      </span>
    );
  if (status.kind === "testing")
    return (
      <span className="text-sm text-muted">Checking provider access…</span>
    );
  return (
    <span className="text-sm text-muted">
      Connection has not been tested this session.
    </span>
  );
}
