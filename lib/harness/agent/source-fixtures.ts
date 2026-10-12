import type { DataSource } from "@/lib/data/types";
export const SOURCE_FIXTURE_ID = "11111111-2222-4333-8444-555555555555";
export const sourceFixture: DataSource = {
  id: SOURCE_FIXTURE_ID, filename: "regional-sales.csv", format: "csv", sha256: "a".repeat(64), warnings: [],
  tables: [{
    id: "t0", name: "Sales", columns: ["Region", "Amount", "Units"], rowCount: 3, headerRow: 1, truncated: false, preamble: [],
    rows: [
      { sourceId: `src:${SOURCE_FIXTURE_ID}/t0/r2`, originalRow: 2, values: { Region: "West", Amount: "100.15", Units: "2" } },
      { sourceId: `src:${SOURCE_FIXTURE_ID}/t0/r3`, originalRow: 3, values: { Region: "East", Amount: "25.05", Units: "1" } },
      { sourceId: `src:${SOURCE_FIXTURE_ID}/t0/r4`, originalRow: 4, values: { Region: "West", Amount: "3.25", Units: "4" } },
    ],
  }],
};
