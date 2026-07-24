"use client";

/**
 * UsagePanel (Plan 2 §6, D-P12) — token usage grouped by provider/model/month from
 * GET /api/llm/usage. Plain table, monospace numbers, no cost math (prices vary by
 * account — show tokens, let users multiply). Shows the two most recent months.
 */

import * as React from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

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

export default function UsagePanel() {
  const [months, setMonths] = React.useState<UsageMonth[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let alive = true;
    fetch("/api/llm/usage")
      .then((r) => r.json())
      .then((body: { months?: UsageMonth[] }) => {
        if (alive) setMonths(body.months ?? []);
      })
      .catch(() => alive && setError("Failed to load usage"));
    return () => {
      alive = false;
    };
  }, []);

  if (error) return <p className="text-sm text-error">{error}</p>;
  if (months === null) return <p className="text-sm text-muted">Loading usage…</p>;
  if (months.length === 0) {
    return <p className="text-sm text-muted">No LLM usage recorded yet.</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      {months.slice(0, 2).map((m) => (
        <div key={m.month}>
          <h3 className="mb-2 text-sm font-medium">{m.month}</h3>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Provider</TableHead>
                <TableHead>Model</TableHead>
                <TableHead className="text-right">Calls</TableHead>
                <TableHead className="text-right">Tokens in</TableHead>
                <TableHead className="text-right">Tokens out</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {m.rows.map((r) => (
                <TableRow key={`${r.provider}:${r.model}`}>
                  <TableCell className="font-mono text-xs">{r.provider}</TableCell>
                  <TableCell className="font-mono text-xs">{r.model}</TableCell>
                  <TableCell className="text-right font-mono text-xs">{num(r.calls)}</TableCell>
                  <TableCell className="text-right font-mono text-xs">{num(r.tokensIn)}</TableCell>
                  <TableCell className="text-right font-mono text-xs">{num(r.tokensOut)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ))}
    </div>
  );
}
