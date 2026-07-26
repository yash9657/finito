/**
 * Shared test fixtures for the agent (Plan 5).
 *
 * Real demo data, parsed by the real parser, normalized by the real projection — so the tools
 * are exercised against the shapes they will actually see rather than against hand-written rows
 * that happen to match what the code expects.
 *
 * Not a `.test.ts` file because the proof script imports it too: a proof running against
 * different data than the tests would be proving something else.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseFile } from "@/lib/csv/parser";
import { normalizeParsedFile, type LedgerRow, type OrgDatasets } from "@/lib/harness/agent/datasets";
import type { FileType, ParsedFile } from "@/lib/types";

export const FIXTURE_WORKFLOW_ID = "1a2b3c4d-0000-0000-0000-000000000001";
export const FIXTURE_WORKFLOW_NAME = "June 2026 close";

const DEMO_FILES: { file: string; type: FileType }[] = [
  { file: "erp_export_demo.csv", type: "erp_export" },
  { file: "bank_statement_demo.csv", type: "bank_statement" },
  { file: "invoices_demo.csv", type: "invoice" },
  { file: "purchase_orders_demo.csv", type: "po" },
  { file: "budget_demo.csv", type: "budget" },
  { file: "actuals_demo.csv", type: "actuals" },
];

/** Load the demo data from disk and normalize it exactly as `loadOrgDatasets` would. */
export function loadFixtureDatasets(only?: FileType[]): OrgDatasets {
  const rows: LedgerRow[] = [];
  const summaries: OrgDatasets["summaries"] = [];

  for (const { file, type } of DEMO_FILES) {
    if (only && !only.includes(type)) continue;
    const parsed: ParsedFile = parseFile(
      readFileSync(resolve(process.cwd(), "demo-data", file)),
      type,
      { filename: file },
    );
    const normalized = normalizeParsedFile(parsed, FIXTURE_WORKFLOW_ID, FIXTURE_WORKFLOW_NAME);
    rows.push(...normalized);

    const dates = normalized.map((r) => r.date).filter((d): d is string => d !== null).sort();
    const populated = new Set<string>();
    for (const row of normalized) {
      if (row.date) populated.add("date");
      if (row.period) populated.add("period");
      if (row.counterparty) populated.add("counterparty");
      if (row.department) populated.add("department");
      if (row.category) populated.add("category");
      if (row.reference) populated.add("reference");
    }

    summaries.push({
      dataset: type,
      workflowId: FIXTURE_WORKFLOW_ID,
      workflowName: FIXTURE_WORKFLOW_NAME,
      filename: file,
      rowCount: normalized.length,
      skippedCount: parsed.meta.skippedCount,
      dateFrom: dates[0] ?? null,
      dateTo: dates[dates.length - 1] ?? null,
      totalCents: normalized.reduce((s, r) => s + r.amountCents, 0),
      populatedFields: [...populated].sort(),
    });
  }

  return { rows, summaries, unreadable: [] };
}

/**
 * A Supabase-admin stand-in that records appends and answers the queries the tools make.
 *
 * Deliberately records rather than no-ops: several of the agent's guarantees ARE the events, so a
 * test that could not inspect them would be checking the wrong thing.
 */
export interface FakeDb {
  client: never;
  events: {
    eventType: string;
    payload: Record<string, unknown>;
    causedBy: string | null;
    turnNumber: number | null;
    providerUsed: string | null;
  }[];
  inserted: Record<string, Record<string, unknown>[]>;
}

export function makeFakeDb(
  tables: Record<string, Record<string, unknown>[]> = {},
): { db: never; state: FakeDb } {
  const state: FakeDb = { client: null as never, events: [], inserted: {} };
  let sequence = 0;

  const queryBuilder = (table: string) => {
    let rows = [...(tables[table] ?? [])];
    const chain: Record<string, unknown> = {};
    const self = () => chain;

    Object.assign(chain, {
      select: self,
      eq: (col: string, value: unknown) => {
        rows = rows.filter((r) => r[col] === value);
        return chain;
      },
      neq: (col: string, value: unknown) => {
        rows = rows.filter((r) => r[col] !== value);
        return chain;
      },
      in: (col: string, values: unknown[]) => {
        rows = rows.filter((r) => values.includes(r[col]));
        return chain;
      },
      order: () => chain,
      limit: (n: number) => {
        rows = rows.slice(0, n);
        return chain;
      },
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      single: async () => ({ data: rows[0] ?? null, error: null }),
      insert: async (row: Record<string, unknown>) => {
        state.inserted[table] = [...(state.inserted[table] ?? []), row];
        return { data: null, error: null };
      },
      update: () => ({
        eq: () => ({
          eq: () => ({ select: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
          select: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
        }),
      }),
      // `await db.from(x).select()...` with no terminal resolves to the row list.
      then: (resolve: (v: { data: unknown; error: null }) => unknown) =>
        resolve({ data: rows, error: null }),
    });
    return chain;
  };

  const db = {
    from: queryBuilder,
    rpc: (fn: string, params: Record<string, unknown>) => ({
      single: async () => {
        if (fn !== "append_harness_event") return { data: null, error: null };
        sequence += 1;
        const id = `evt-${sequence}`;
        state.events.push({
          eventType: params.p_event_type as string,
          payload: (params.p_payload ?? {}) as Record<string, unknown>,
          causedBy: (params.p_caused_by as string | null) ?? null,
          turnNumber: (params.p_turn_number as number | null) ?? null,
          providerUsed: (params.p_provider_used as string | null) ?? null,
        });
        return {
          data: {
            id,
            workflow_id: params.p_workflow_id,
            sequence_number: sequence,
            event_type: params.p_event_type,
          },
          error: null,
        };
      },
    }),
  };

  return { db: db as never, state };
}
