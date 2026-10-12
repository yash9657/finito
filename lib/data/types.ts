/** Immutable source values. CSV text is preserved; spreadsheets retain primitive cell values. */
export type DataValue = string | number | boolean | null;
export type DataFormat = "csv" | "tsv" | "xlsx" | "xls" | "json" | "jsonl" | "text" | "markdown" | "pdf";

export interface DataRow {
  /** src:<source UUID>/t<zero-based table index>/r<one-based original row or line> */
  sourceId: string;
  originalRow: number;
  values: Record<string, DataValue>;
}

export interface DataTable {
  /** Stable within a source, e.g. t0, t1. */
  id: string;
  name: string;
  columns: string[];
  rows: DataRow[];
  rowCount: number;
  truncated: boolean;
  /** One-based original header row; null means generated column names. */
  headerRow: number | null;
  /** Original header values, retained for inspection and stable citations. */
  header?: DataRow | null;
  /** Preserved introductory rows preceding an inferred or selected header. */
  preamble: DataRow[];
}

export interface DataSource {
  id: string;
  filename: string;
  sha256: string;
  format: DataFormat;
  tables: DataTable[];
  warnings: string[];
}

export interface DataTableManifest {
  id: string;
  name: string;
  columns: string[];
  rowCount: number;
  truncated: boolean;
  headerRow: number | null;
  preambleRowCount: number;
}

export interface DataSourceMetadata {
  id: string;
  createdBy?: string | null;
  searchIndexStatus?: "pending" | "indexed" | "failed";
  searchIndexError?: string | null;
  filename: string;
  sha256: string;
  format: DataFormat;
  byteSize: number;
  createdAt: string;
  tables: DataTableManifest[];
  warnings: string[];
}

export interface ParseDataOptions {
  /** Per-table header override: one-based original row, or null for no header. */
  headerRows?: Record<string, number | null>;
}

export const DATA_LIMITS = {
  maxUploadBytes: 20 * 1024 * 1024,
  maxLoadedBytes: 40 * 1024 * 1024,
  maxSourcesPerLoad: 10,
  maxTables: 32,
  maxRows: 20_000,
  maxColumns: 250,
  maxCells: 500_000,
  maxCellChars: 32_768,
  maxParsedChars: 20 * 1024 * 1024,
} as const;

export class DataSourceError extends Error {
  constructor(message: string, readonly code: "invalid_format" | "limit_exceeded" | "not_found" | "integrity_error" | "storage_error" = "invalid_format") {
    super(message);
    this.name = "DataSourceError";
  }
}
