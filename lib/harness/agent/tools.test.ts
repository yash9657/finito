/**
 * Tool surface tests (Plan 5, D-G19/D-G20/D-G21).
 *
 * Run against the REAL demo data through the REAL parser, so the tools are exercised on the row
 * shapes they will actually see. The properties under test are the ACI ones: a compact action, an
 * informative empty result, an explicit truncation, a correctable argument error — and, for
 * `recommend_action`, that it queues rather than executes.
 */

import { describe, expect, it } from "vitest";
import { loadFixtureDatasets, makeFakeDb, FIXTURE_WORKFLOW_ID } from "@/lib/harness/agent/fixtures";
import {
  comparePeriods,
  findAnomalies,
  getTransactions,
  listDatasets,
  queryLedger,
} from "@/lib/harness/agent/tools/read-tools";
import { recommendAction } from "@/lib/harness/agent/tools/recommend-action";
import { lookupTool, ROLE_TOOLS, toolDefinitionsForRole } from "@/lib/harness/agent/tools";
import type { ToolContext } from "@/lib/harness/agent/tools/types";

const datasets = loadFixtureDatasets();

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  const { db } = makeFakeDb();
  return {
    db,
    orgId: "org-1",
    workflowId: FIXTURE_WORKFLOW_ID,
    workflowType: "investigation",
    datasets,
    rows: datasets.rows,
    recommendations: [],
    turn: 1,
    ...overrides,
  };
}

describe("the registry (D-G20)", () => {
  it("gives the investigator seven tools and every other role none", () => {
    expect(toolDefinitionsForRole("investigator")).toHaveLength(7);
    for (const role of ["parser", "matcher", "classifier", "writer"] as const) {
      expect(ROLE_TOOLS[role]).toEqual([]);
      expect(toolDefinitionsForRole(role)).toEqual([]);
    }
  });

  it("refuses a tool the role may not reach, and an unknown one, identically", () => {
    // The distinction is meaningless to the model, and revealing it would describe a capability
    // it cannot have.
    expect(lookupTool("parser", "query_ledger")).toBeNull();
    expect(lookupTool("investigator", "drop_table")).toBeNull();
    expect(lookupTool("investigator", "query_ledger")).not.toBeNull();
  });

  it("declares parameters as plain JSON Schema objects with additionalProperties false", () => {
    for (const tool of toolDefinitionsForRole("investigator")) {
      expect(tool.parameters.type).toBe("object");
      expect(tool.parameters.additionalProperties).toBe(false);
      expect(tool.description.length).toBeGreaterThan(40);
    }
  });
});

describe("list_datasets — the orientation step", () => {
  it("reports every dataset with counts, ranges and which fields are populated", async () => {
    const result = await listDatasets.run({}, ctx());
    expect(result.ok).toBe(true);
    const data = result.data as { datasets: Record<string, unknown>[] };
    expect(data.datasets.length).toBe(6);
    const erp = data.datasets.find((d) => d.dataset === "erp_export")!;
    expect(erp.rows).toBeGreaterThan(0);
    expect(erp.dateFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The agent learns the shape from the tool, not from the prompt.
    expect(erp.populatedFields).toContain("date");
  });

  it("says so plainly when there is no data, rather than returning an empty object", async () => {
    const result = await listDatasets.run(
      {},
      ctx({ datasets: { rows: [], summaries: [], unreadable: [] }, rows: [] }),
    );
    expect(result.data).toEqual([]);
    expect(result.hint).toContain("nothing to investigate");
  });

  it("surfaces unreadable files so an empty result is never mistaken for no data", async () => {
    const result = await listDatasets.run(
      {},
      ctx({
        datasets: {
          rows: [],
          summaries: [],
          unreadable: [{ workflowId: "w", filename: "june.csv", reason: "404" }],
        },
        rows: [],
      }),
    );
    expect(result.hint).toContain("june.csv");
  });
});

describe("query_ledger — the compact action", () => {
  it("filters, groups and totals in one call", async () => {
    const result = await queryLedger.run(
      { datasets: ["erp_export"], groupBy: "period" },
      ctx(),
    );
    expect(result.ok).toBe(true);
    const data = result.data as { totalCents: number; groups: { key: string }[] };
    expect(data.totalCents).not.toBe(0);
    expect(data.groups[0].key).toMatch(/^\d{4}-\d{2}$/);
  });

  it("computes totals over ALL matching rows even when the sample is truncated", async () => {
    // The failure this prevents: an agent shown 25 of 247 rows computing a total from 25.
    const all = await queryLedger.run({}, ctx());
    const data = all.data as { totalCents: number; sampleRows: unknown[] };
    const expected = datasets.rows.reduce((s, r) => s + r.amountCents, 0);
    expect(data.totalCents).toBe(expected);
    expect(data.sampleRows.length).toBeLessThan(datasets.rows.length);
    expect(all.truncated).toBe(true);
    expect(all.hint).toContain("computed over ALL matching rows");
  });

  it("returns a correctable message for a malformed date, not a throw", async () => {
    const result = await queryLedger.run({ dateFrom: "June 1st" }, ctx());
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("YYYY-MM-DD");
    expect(result.hint).toContain("June 1st");
  });

  it("rejects an impossible range instead of silently returning nothing", async () => {
    const result = await queryLedger.run({ dateFrom: "2026-06-30", dateTo: "2026-06-01" }, ctx());
    expect(result.ok).toBe(false);
    expect(result.hint).toContain("Swap them");
  });

  it("names the valid datasets when given an unknown one", async () => {
    const result = await queryLedger.run({ datasets: ["general_ledger"] }, ctx());
    expect(result.ok).toBe(false);
    expect(result.hint).toContain("erp_export");
  });

  it("tells the agent what range DOES exist when a filter matches nothing", async () => {
    // Without this the agent tries 2025-04, then 2025-05, burning its budget on guesses.
    const result = await queryLedger.run({ dateFrom: "2025-01-01", dateTo: "2025-01-31" }, ctx());
    expect(result.data).toEqual([]);
    expect(result.hint).toMatch(/the data covers 2026-/);
  });

  it("reminds the agent that amounts are cents when the bounds are inverted", async () => {
    const result = await queryLedger.run({ minAmountCents: 500, maxAmountCents: 100 }, ctx());
    expect(result.hint).toContain("CENTS");
  });
});

describe("get_transactions — drilling in", () => {
  it("pages, and says how many remain", async () => {
    const page1 = await getTransactions.run({ datasets: ["erp_export"], limit: 5 }, ctx());
    expect((page1.data as { rows: unknown[] }).rows).toHaveLength(5);
    expect(page1.truncated).toBe(true);
    expect(page1.hint).toContain("offset=5");

    const page2 = await getTransactions.run(
      { datasets: ["erp_export"], limit: 5, offset: 5 },
      ctx(),
    );
    const first1 = (page1.data as { rows: { sourceId: string }[] }).rows[0].sourceId;
    const first2 = (page2.data as { rows: { sourceId: string }[] }).rows[0].sourceId;
    expect(first1).not.toBe(first2);
  });

  it("sorts by absolute amount by default — a large credit is as interesting as a debit", async () => {
    const result = await getTransactions.run({ datasets: ["erp_export"], limit: 10 }, ctx());
    const rows = (result.data as { rows: { amountCents: number }[] }).rows;
    for (let i = 1; i < rows.length; i++) {
      expect(Math.abs(rows[i - 1].amountCents)).toBeGreaterThanOrEqual(Math.abs(rows[i].amountCents));
    }
  });

  it("explains an offset past the end rather than returning a bare empty list", async () => {
    const result = await getTransactions.run({ datasets: ["erp_export"], offset: 99999 }, ctx());
    expect(result.hint).toContain("in total");
  });

  it("every returned row carries a resolvable source id", async () => {
    const result = await getTransactions.run({ limit: 20 }, ctx());
    const rows = (result.data as { rows: { sourceId: string }[] }).rows;
    const known = new Set(datasets.rows.map((r) => r.sourceId));
    for (const row of rows) expect(known.has(row.sourceId)).toBe(true);
  });
});

describe("compare_periods — variances in code", () => {
  it("computes the variance between two periods", async () => {
    const periods = [...new Set(datasets.rows.map((r) => r.period).filter(Boolean))].sort();
    const result = await comparePeriods.run(
      { periodA: periods[0]!, periodB: periods[0]!.replace(/(\d{2})$/, "12") },
      ctx(),
    );
    // Either it found both periods or it explained which exist — never a silent empty.
    expect(result.summary.length).toBeGreaterThan(0);
  });

  it("rejects a malformed period with the valid form", async () => {
    const result = await comparePeriods.run({ periodA: "June", periodB: "2026-06" }, ctx());
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("YYYY-MM");
  });

  it("rejects comparing a period with itself", async () => {
    const result = await comparePeriods.run({ periodA: "2026-06", periodB: "2026-06" }, ctx());
    expect(result.ok).toBe(false);
  });

  it("lists the periods that exist when neither is found", async () => {
    const result = await comparePeriods.run({ periodA: "1999-01", periodB: "1999-02" }, ctx());
    expect(result.hint).toContain("2026-06");
  });

  it("returns null rather than Infinity for a percentage off a zero base", async () => {
    // An Infinity here could reach the answer as a figure.
    const result = await comparePeriods.run(
      { periodA: "2026-06", periodB: "2026-07", groupBy: "category" },
      ctx(),
    );
    const data = result.data as { variances?: { variancePct: number | null }[] };
    for (const v of data.variances ?? []) {
      if (v.variancePct !== null) expect(Number.isFinite(v.variancePct)).toBe(true);
    }
  });
});

describe("find_anomalies — the existing detectors", () => {
  it("runs the real reconciliation detectors and cites full source ids", async () => {
    const result = await findAnomalies.run({}, ctx());
    expect(result.ok).toBe(true);
    const data = result.data as {
      reconciliation?: { unmatchedErp: { sourceId: string }[] };
    };
    const known = new Set(datasets.rows.map((r) => r.sourceId));
    // Detector ids are per-file (`erp-001`); a citation the agent cannot resolve is worse
    // than none, so they are mapped back before they leave the tool.
    for (const row of data.reconciliation?.unmatchedErp ?? []) {
      expect(known.has(row.sourceId)).toBe(true);
    }
  });

  it("skips a detector whose data is absent, and says which", async () => {
    const bankOnly = loadFixtureDatasets(["bank_statement"]);
    const result = await findAnomalies.run({}, ctx({ datasets: bankOnly, rows: bankOnly.rows }));
    expect(result.hint).toContain("reconciliation");
  });

  it("reports honestly when nothing can run at all", async () => {
    const result = await findAnomalies.run(
      {},
      ctx({ datasets: { rows: [], summaries: [], unreadable: [] }, rows: [] }),
    );
    expect(result.data).toEqual([]);
    expect(result.hint).toContain("list_datasets");
  });
});

describe("recommend_action — queues, never executes (D-G21)", () => {
  it("refuses a source id that does not exist", async () => {
    const result = await recommendAction.run(
      {
        actionType: "approve_invoice_payment",
        sourceId: "wf:deadbeef/invoice/inv-999",
        summary: "Pay it",
        rationale: "Because",
      },
      ctx(),
    );
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("does not exist");
  });

  it("refuses a source id that is not an invoice", async () => {
    const erpRow = datasets.rows.find((r) => r.dataset === "erp_export")!;
    const result = await recommendAction.run(
      {
        actionType: "approve_invoice_payment",
        sourceId: erpRow.sourceId,
        summary: "Pay it",
        rationale: "Because",
      },
      ctx(),
    );
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("erp_export");
  });

  it("refuses an empty rationale — a reviewer sees only these fields", async () => {
    const invoice = datasets.rows.find((r) => r.dataset === "invoice")!;
    const result = await recommendAction.run(
      {
        actionType: "approve_invoice_payment",
        sourceId: invoice.sourceId,
        summary: "Pay it",
        rationale: "   ",
      },
      ctx(),
    );
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("rationale");
  });

  it("refuses an action type the tool does not offer, explaining why", async () => {
    const invoice = datasets.rows.find((r) => r.dataset === "invoice")!;
    const result = await recommendAction.run(
      {
        actionType: "book_journal_entry",
        sourceId: invoice.sourceId,
        summary: "Post a correction",
        rationale: "The entry is misclassified",
      },
      ctx(),
    );
    expect(result.ok).toBe(false);
    // The role permits it; the deployment cannot verify it. The message says which.
    expect(result.hint).toContain("cannot be verified in this deployment");
  });

  it("queues a verified recommendation and reports it as a PROPOSAL", async () => {
    const { db, state } = makeFakeDb();
    // An invoice the deterministic matcher pairs with a PO — the pairing is what the verifier
    // needs, and it comes from code, not from the model.
    const invoice = datasets.rows.find(
      (r) => r.dataset === "invoice" && r.counterparty?.includes("Meridian"),
    )!;

    const result = await recommendAction.run(
      {
        actionType: "approve_invoice_payment",
        sourceId: invoice.sourceId,
        summary: `Approve ${invoice.reference}`,
        rationale: "Matches its PO exactly and the vendor is established.",
      },
      ctx({ db, rows: datasets.rows }),
    );

    expect(result.ok).toBe(true);
    expect(result.hint).toContain("PROPOSAL, not an executed action");
    // It went through the real approvals path.
    expect(state.inserted.action_requests?.length).toBe(1);
    const queued = state.inserted.action_requests[0];
    // Amount read from the row, never from the model.
    expect(queued.amount_cents).toBe(invoice.amountCents);
    expect(queued.status).toBe("pending");
    // And it is on the trail as a proposal by the investigator role.
    const proposed = state.events.find((e) => e.eventType === "action_proposed");
    expect(proposed?.payload.proposed_by_role).toBe("investigator");
  });

  it("records a verifier rejection on the trail and queues NOTHING", async () => {
    const { db, state } = makeFakeDb();
    // An invoice with no purchase order at all: the verifier's "nothing to match against" case.
    const invoiceOnly = loadFixtureDatasets(["invoice"]);
    const invoice = invoiceOnly.rows[0];

    const result = await recommendAction.run(
      {
        actionType: "approve_invoice_payment",
        sourceId: invoice.sourceId,
        summary: "Pay it",
        rationale: "Looks fine",
      },
      ctx({ db, datasets: invoiceOnly, rows: invoiceOnly.rows }),
    );

    expect(result.ok).toBe(false);
    // No reviewer is ever shown a machine-rejectable action (D-H9).
    expect(state.inserted.action_requests).toBeUndefined();
  });
});
