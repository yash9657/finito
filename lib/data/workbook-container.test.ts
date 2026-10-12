import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { parseFile } from "@/lib/csv/parser";
import { parseDataSource } from "./parser";
import { validateWorkbookContainer } from "./workbook-container";

function workbook() {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["date", "description", "amount", "reference"], ["2026-05-01", "Statement", 10.49, "R1"]]), "ERP");
  return XLSX.write(book, { type: "buffer", bookType: "xlsx", compression: true }) as Buffer;
}
const ID = "aaaaaaaa-1111-4111-8111-111111111111";

describe("shared workbook expansion preflight", () => {
  it("accepts a real compressed workbook through both ingestion paths", async () => {
    const buffer = workbook();
    expect(() => validateWorkbookContainer(buffer, "xlsx")).not.toThrow();
    expect(parseFile(buffer, "erp_export", { filename: "erp.xlsx" }).rows).toHaveLength(1);
    expect((await parseDataSource(buffer, "erp.xlsx", ID)).tables[0].rows).toHaveLength(1);
  });

  it.each([1, 41 * 1024 * 1024])("rejects forged expanded size %i before either parser runs", async size => {
    const buffer = workbook();
    const directory = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(directory).toBeGreaterThan(0);
    buffer.writeUInt32LE(size, directory + 24);
    expect(() => parseFile(buffer, "erp_export", { filename: "erp.xlsx" })).toThrow(/expanded|expands/);
    await expect(parseDataSource(buffer, "erp.xlsx", ID)).rejects.toThrow(/expanded|expands/);
  });

  it("rejects renamed text rather than passing an unchecked pseudo-workbook to SheetJS", () => {
    expect(() => parseFile("date,description,amount\n2026-05-01,row,2", "erp_export", { filename: "renamed.xlsx" })).toThrow(/XLSX/);
  });
});
