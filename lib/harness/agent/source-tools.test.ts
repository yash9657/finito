import { describe, expect, it } from "vitest";
import { inspectSource, listSources, readSourceRows, runAnalysis } from "./tools/source-tools";
import { sourceFixture, SOURCE_FIXTURE_ID } from "./source-fixtures";
import { makeFakeDb, FIXTURE_WORKFLOW_ID } from "./fixtures";
import type { ToolContext } from "./tools/types";

function context(): ToolContext {
  return { db: makeFakeDb().db, orgId: "org-1", workflowId: FIXTURE_WORKFLOW_ID, workflowType: "investigation", turn: 1, rows: [], datasets: { rows: [], summaries: [], unreadable: [] }, recommendations: [], dataSources: [structuredClone(sourceFixture)], analyses: [] };
}
const selection = { sourceId: SOURCE_FIXTURE_ID, tableId: "t0" };

describe("schema-independent source tools", () => {
  it("exposes actual metadata and explicit samples, and refuses another source", async () => {
    expect((await listSources.run({}, context())).summary).toContain("1 general");
    expect((await inspectSource.run(selection, context())).data).toMatchObject({ columns: ["Region", "Amount", "Units"], headerRow: 1 });
    expect((await inspectSource.run({ ...selection, sourceId: "other-tenant" }, context())).ok).toBe(false);
  });
  it("searches literal text and pages without silently dropping rows", async () => {
    const first = await readSourceRows.run({ ...selection, textContains: "WEST", limit: 1 }, context());
    expect(first).toMatchObject({ ok: true, total: 2, showing: 1, truncated: true, data: { nextOffset: 1 } });
    const next = await readSourceRows.run({ ...selection, textContains: "west", limit: 1, offset: 1 }, context());
    expect(next).toMatchObject({ total: 2, truncated: false, data: { nextOffset: null } });
    expect((await readSourceRows.run({ ...selection, textContains: ".*" }, context())).total).toBe(0);
    expect((await readSourceRows.run({ ...selection, limit: -1 }, context())).ok).toBe(false);
  });
  it("runs a new computation and retains reproducible inputs and real row citations", async () => {
    const ctx = context();
    const result = await runAnalysis.run({ title: "West sales", tables: [selection], code: "const rows=tables[0].rows.filter(r=>r.values.Region==='West'); return {result:{total:decimal.sum(rows.map(r=>r.values.Amount)),units:decimal.sum(rows.map(r=>r.values.Units))},sourceIds:rows.map(r=>r.sourceId)};" }, ctx);
    expect(result.ok).toBe(true);
    expect(ctx.analyses).toHaveLength(1);
    expect(ctx.analyses![0]).toMatchObject({ output: { total: "103.4", units: "6" }, inputs: [{ rowCount: 3, totalRows: 3, sha256: sourceFixture.sha256 }] });
    expect(ctx.analyses![0].sourceIds).toEqual([sourceFixture.tables[0].rows[0].sourceId, sourceFixture.tables[0].rows[2].sourceId]);
    expect(ctx.analyses![0].codeHash).toMatch(/^[a-f0-9]{64}$/);
  });
  it("rejects fabricated citations and partial-input citations outside the selected range", async () => {
    const ctx = context();
    for (const id of ["src:invented/t0/r1", sourceFixture.tables[0].rows[2].sourceId]) {
      const result = await runAnalysis.run({ title: "Invalid citation", tables: [{ ...selection, limit: 1 }], code: `return {result:1,sourceIds:[${JSON.stringify(id)}]};` }, ctx);
      expect(result.ok).toBe(false);
    }
    const nested = await runAnalysis.run({ title: "Invalid nested citation", tables: [selection], code: "return {result:{evidence:{sourceId:'src:invented/t0/r1'}},sourceIds:[tables[0].rows[0].sourceId]};" }, ctx);
    expect(nested.ok).toBe(false);
    expect(ctx.analyses).toHaveLength(0);
  });
  it("states partial input explicitly and does not select duplicated tables", async () => {
    const ctx = context();
    const result = await runAnalysis.run({ title: "One row", tables: [{ ...selection, limit: 1 }], code: "return {result:tables[0].rows.length,sourceIds:[tables[0].rows[0].sourceId]};" }, ctx);
    expect(result.ok).toBe(true);
    expect(ctx.analyses![0].warnings.join(" ")).toContain("only 1 of 3");
    expect((await runAnalysis.run({ title: "Duplicate", tables: [selection, selection], code: "return 1" }, ctx)).ok).toBe(false);
  });
  it("preserves and cites introductory source rows during custom statement interpretation", async () => {
    const ctx = context();
    const row = { sourceId: `src:${SOURCE_FIXTURE_ID}/t0/r1`, originalRow: 1, values: { column_1: "Amounts in thousands, EUR" } };
    ctx.dataSources![0].tables[0].preamble = [row];
    const result = await runAnalysis.run({ title: "Reporting basis", tables: [selection], code: "return {result:tables[0].preamble[0].values,sourceIds:[tables[0].preamble[0].sourceId]};" }, ctx);
    expect(result.ok).toBe(true);
    expect(ctx.analyses![0]).toMatchObject({ output: { column_1: "Amounts in thousands, EUR" }, sourceIds: [row.sourceId], inputs: [{ preambleRows: 1 }] });
  });
});
