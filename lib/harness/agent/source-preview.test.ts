import { describe, expect, it } from "vitest";
import { sourceFixture } from "./source-fixtures";
import { SOURCE_PREVIEW_BYTES, sourcePreviews } from "./source-preview";

describe("bounded exact source previews", () => {
  it("preserves decimal strings and original citations, with explicit sample coverage", () => {
    const data = sourcePreviews([sourceFixture]);
    expect(data.sources[0].tables[0]).toMatchObject({
      columns: sourceFixture.tables[0].columns, omittedColumns: 0,
      sample: sourceFixture.tables[0].rows.slice(0, 2), omittedRows: 1,
    });
    expect(data.sources[0].tables[0].sample[0].values.Amount).toBe("100.15");
  });
  it("keeps encoded Unicode and escaped-content observations within budget without clipping numeric or text cells", () => {
    const sources = Array.from({ length: 10 }, (_, index) => ({
      ...structuredClone(sourceFixture), id: `dddddddd-4444-4444-8444-${String(index).padStart(12, "0")}`,
      filename: "\u0000💶".repeat(300), warnings: ["A".repeat(6000)],
      tables: Array.from({ length: 32 }, (_, i) => ({ ...structuredClone(sourceFixture.tables[0]),
        id: `t${i}`, name: "\u0000決算".repeat(300), columns: ["\u0000".repeat(6000)],
        rows: [{ sourceId: `src:${sourceFixture.id}/t${i}/r2`, originalRow: 2, values: { Note: "\u0000💶".repeat(4000), Amount: "100.150000000001" } }], rowCount: 1,
      })),
    }));
    const data = sourcePreviews(sources);
    expect(Buffer.byteLength(JSON.stringify(data), "utf8")).toBeLessThanOrEqual(SOURCE_PREVIEW_BYTES);
    expect(data.sources).toHaveLength(10);
    for (const source of data.sources) {
      expect(source.filenameTruncated).toBe(true);
      expect(source.omittedTables + source.tables.length).toBe(32);
      expect(source.omittedWarnings).toBe(1);
      for (const table of source.tables) {
        expect(table.omittedColumns).toBe(1); expect(table.columns).toEqual([]);
        expect(table.omittedRows).toBe(1); expect(table.sample).toEqual([]);
      }
    }
  });
  it("exposes all small sheet identities and reporting-basis preambles before further inspection", () => {
    const source = structuredClone(sourceFixture);
    const preamble = { sourceId: `src:${source.id}/t0/r0`, originalRow: 1, values: { Note: "Amounts in thousands, EUR" } };
    source.tables[0].preamble = [preamble];
    source.tables.push({ ...structuredClone(source.tables[0]), id: "t1", name: "Budget" });
    const data = sourcePreviews([source]);
    expect(data.sources[0].omittedTables).toBe(0);
    expect(data.sources[0].tables.map(table => table.tableId)).toEqual(["t0", "t1"]);
    expect(data.sources[0].tables[0]).toMatchObject({ preamble: [preamble], omittedPreambleRows: 0 });
    expect(source.tables[0].rows).toHaveLength(3);
  });
});
