import type { DataRow, DataSource, DataTable } from "@/lib/data/types";
import { clipUtf8 } from "./memory-context";

// The complete tool response must fit the loop's 6,000-character observation limit.
// Count encoded UTF-8 bytes conservatively, including escaped cell contents. Never
// shorten individual values: a row is either present exactly or explicitly omitted.
export const SOURCE_PREVIEW_BYTES = 5_000;

interface TablePreview {
  tableId: string;
  name: string;
  nameTruncated: boolean;
  rowCount: number;
  truncated: boolean;
  headerRow: number | null;
  columns: string[];
  omittedColumns: number;
  preamble: DataRow[];
  omittedPreambleRows: number;
  sample: DataRow[];
  omittedRows: number;
}

function label(value: string, bytes: number): string {
  let result = clipUtf8(value, bytes);
  while (Buffer.byteLength(JSON.stringify(result), "utf8") > bytes) {
    result = clipUtf8(result, Math.max(0, Buffer.byteLength(result, "utf8") - 8));
  }
  return result;
}

export function sourcePreviews(sources: DataSource[]) {
  const data = { sources: sources.map(source => ({
    sourceId: source.id, filename: label(source.filename, 160), filenameTruncated: label(source.filename, 160) !== source.filename, sha256: source.sha256,
    tables: [] as TablePreview[], omittedTables: source.tables.length,
    warnings: [] as string[], omittedWarnings: source.warnings.length,
  })) };
  const fits = () => Buffer.byteLength(JSON.stringify(data), "utf8") <= SOURCE_PREVIEW_BYTES;
  const included: { original: DataTable; preview: TablePreview }[] = [];

  // Identify tables before spending the budget on samples. A wide first sheet must
  // not hide every subsequent sheet or source. The loader already caps source count.
  const maxTables = Math.max(0, ...sources.map(source => source.tables.length));
  for (let i = 0; i < maxTables; i++) for (let s = 0; s < sources.length; s++) {
    const table = sources[s].tables[i];
    if (!table) continue;
    const target = data.sources[s];
    const preview: TablePreview = {
      tableId: table.id, name: label(table.name, 100), nameTruncated: label(table.name, 100) !== table.name, rowCount: table.rowCount,
      truncated: table.truncated, headerRow: table.headerRow,
      columns: [], omittedColumns: table.columns.length,
      preamble: [], omittedPreambleRows: table.preamble.length,
      sample: [], omittedRows: table.rows.length,
    };
    target.tables.push(preview); target.omittedTables--;
    if (!fits()) { target.tables.pop(); target.omittedTables++; continue; }
    included.push({ original: table, preview });
  }
  // Warnings and exact schemas take priority over example records.
  for (let s = 0; s < sources.length; s++) for (const warning of sources[s].warnings) {
    const target = data.sources[s];
    target.warnings.push(warning); target.omittedWarnings--;
    if (!fits()) { target.warnings.pop(); target.omittedWarnings++; }
  }
  for (const { original, preview } of included) {
    preview.columns = original.columns; preview.omittedColumns = 0;
    if (!fits()) { preview.columns = []; preview.omittedColumns = original.columns.length; }
  }
  // Two small rounds preserve evidence from each table rather than filling the
  // observation with the first file. Omitted cells are available through row reads.
  for (let i = 0; i < 2; i++) for (const { original, preview } of included) {
    for (const section of ["preamble", "sample"] as const) {
      const rows = section === "sample" ? original.rows : original.preamble;
      const omitted = section === "sample" ? "omittedRows" : "omittedPreambleRows";
      if (!rows[i]) continue;
      preview[section].push(rows[i]); preview[omitted]--;
      if (!fits()) { preview[section].pop(); preview[omitted]++; }
    }
  }
  return data;
}
