"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { PROVIDER_META } from "@/components/settings/providerMeta";
import type { ProviderIdValue } from "@/lib/types";

interface UsageRow {
  provider: string;
  model: string;
  calls: number;
  tokensIn: number;
  tokensOut: number;
}
interface UsageMonth {
  month: string;
  rows: UsageRow[];
}
const num = (n: number) => n.toLocaleString("en-US");
function monthLabel(month: string) {
  const date = new Date(`${month}-01T00:00:00Z`);
  return Number.isNaN(date.getTime())
    ? month
    : new Intl.DateTimeFormat("en-US", {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      }).format(date);
}

export default function UsagePanel() {
  const [months, setMonths] = React.useState<UsageMonth[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    setError(null);
    const controller = new AbortController();
    fetch("/api/llm/usage", { signal: controller.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error("Usage unavailable");
        return r.json();
      })
      .then((body: { months?: UsageMonth[] }) => {
        if (!controller.signal.aborted) setMonths(body.months ?? []);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError(
            "Unable to load model usage. Check your connection and try again.",
          );
      });
    return () => controller.abort();
  }, [attempt]);
  if (error)
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center gap-3 text-sm text-error"
      >
        {error}
        <Button variant="outline" onClick={() => setAttempt((a) => a + 1)}>
          Try again
        </Button>
      </div>
    );
  if (months === null)
    return (
      <p role="status" className="text-sm text-muted">
        Loading model usage…
      </p>
    );
  if (months.length === 0)
    return (
      <p className="py-4 text-sm leading-6 text-muted">
        No model calls recorded yet. Usage appears here after a workflow or
        investigation uses a model.
      </p>
    );
  return (
    <div className="space-y-8">
      {months.slice(0, 2).map((m) => (
        <section key={m.month}>
          <h3 className="mb-3 font-medium">{monthLabel(m.month)}</h3>
          <ul className="divide-y divide-border border-y border-border">
            {m.rows.map((r) => (
              <li
                key={`${r.provider}:${r.model}`}
                className="grid min-w-0 gap-4 py-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center"
              >
                <div className="min-w-0">
                  <p className="text-sm text-muted">
                    {PROVIDER_META[r.provider as ProviderIdValue]?.label ??
                      r.provider}
                  </p>
                  <p className="mt-1 break-all font-mono text-sm">{r.model}</p>
                </div>
                <dl className="grid grid-cols-3 gap-3 text-sm lg:gap-6">
                  {[
                    ["Calls", r.calls],
                    ["Input tokens", r.tokensIn],
                    ["Output tokens", r.tokensOut],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <dt className="text-muted">{label}</dt>
                      <dd className="mt-1 break-all font-mono tabular-nums">
                        {num(value as number)}
                      </dd>
                    </div>
                  ))}
                </dl>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
