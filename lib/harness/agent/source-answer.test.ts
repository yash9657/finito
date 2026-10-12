import { describe, expect, it } from "vitest";
import { validateAnswer, type RawAnswer } from "./answer";
import { sourceFixture } from "./source-fixtures";
import { loadFixtureDatasets } from "./fixtures";

const ids = sourceFixture.tables[0].rows.map((row) => row.sourceId);
function answer(): RawAnswer {
  return { prose: "The selected source total is {{amount}}.", findings: [{ statement: "Three source records support this total.", sourceIds: [...ids] }], figures: [{ ref: "amount", label: "Source amount", operation: "sum", sourceIds: [...ids], column: "Amount" }], citations: ids.map((sourceId) => ({ sourceId, note: "Original record" })) };
}
describe("generic source answer validation", () => {
  it("recomputes an exact decimal from one real field without inventing currency", () => {
    const result = validateAnswer(answer(), [], { partial: false, dataSources: [sourceFixture] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.answer.prose).toContain("128.45 (source units)");
      expect(result.answer.figures[0]).toMatchObject({ decimalValue: "128.45", column: "Amount" });
      expect(result.answer.figures[0].valueCents).toBeUndefined();
    }
  });
  it("refuses unknown, duplicate and ambiguous column values", () => {
    const missing = answer(); missing.citations.push({ sourceId: "src:unknown/t0/r1", note: "fake" });
    expect(validateAnswer(missing, [], { partial: false, dataSources: [sourceFixture] }).ok).toBe(false);
    const duplicate = answer(); duplicate.figures[0].sourceIds.push(ids[0]);
    expect(validateAnswer(duplicate, [], { partial: false, dataSources: [sourceFixture] }).ok).toBe(false);
    const noColumn = answer(); delete noColumn.figures[0].column;
    expect(validateAnswer(noColumn, [], { partial: false, dataSources: [sourceFixture] }).ok).toBe(false);
    const source = structuredClone(sourceFixture); source.tables[0].rows[0].values.Amount = "1,200.50";
    expect(validateAnswer(answer(), [], { partial: false, dataSources: [source] }).ok).toBe(false);
  });
  it("does not weaken ledger computation or allow mixed source bases", () => {
    const ledger = loadFixtureDatasets(["erp_export"]).rows;
    const mixed = answer(); mixed.figures[0].sourceIds = [ids[0], ledger[0].sourceId];
    expect(validateAnswer(mixed, ledger, { partial: false, dataSources: [sourceFixture] }).ok).toBe(false);
    const second = structuredClone(sourceFixture); second.id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    second.tables[0].rows = second.tables[0].rows.map((row) => ({ ...row, sourceId: row.sourceId.replace(sourceFixture.id, second.id) }));
    mixed.figures[0].sourceIds = [ids[0], second.tables[0].rows[0].sourceId];
    expect(validateAnswer(mixed, [], { partial: false, dataSources: [sourceFixture, second] }).ok).toBe(false);
    const literal = answer(); literal.prose = "Total is $128.45";
    expect(validateAnswer(literal, [], { partial: false, dataSources: [sourceFixture] }).ok).toBe(false);
  });
  it("allows original header citations but refuses counting or summing headers as data", () => {
    const source = structuredClone(sourceFixture);
    source.tables[0].header = { sourceId: `src:${source.id}/t0/r1`, originalRow: 1, values: { column_1: "Region", column_2: "Amount" } };
    const raw = answer(); raw.citations.push({ sourceId: source.tables[0].header.sourceId, note: "Original column labels" });
    expect(validateAnswer(raw, [], { partial: false, dataSources: [source] }).ok).toBe(true);
    raw.figures[0] = { ref: "amount", label: "Count", operation: "count", sourceIds: [source.tables[0].header.sourceId] };
    expect(validateAnswer(raw, [], { partial: false, dataSources: [source] }).ok).toBe(false);
  });
  it("rejects invented placeholder syntax and substitutes source figures in all narrative fields", () => {
    const raw = answer();
    raw.prose = `Amount {{${ids[0]}|Amount}}`;
    expect(validateAnswer(raw, [], { partial: false, dataSources: [sourceFixture] }).ok).toBe(false);
    const proper = answer(); proper.findings[0].statement = "The selected total is {{amount}}.";
    proper.citations[0].note = "Supports {{amount}}.";
    const result = validateAnswer(proper, [], { partial: false, dataSources: [sourceFixture] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.answer.findings[0].statement).toContain("128.45 (source units)");
      expect(result.answer.citations[0].note).not.toContain("{{");
    }
  });
});
