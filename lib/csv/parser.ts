/**
 * CSV / Excel parser (PLAN §6).
 *
 * Papa Parse (`header: true, skipEmptyLines: true`) for CSV and SheetJS for
 * `.xlsx/.xls`, feeding a single shared normalizer that:
 *   - normalizes headers (lowercase / trim / collapse whitespace → `_`) and resolves
 *     the §6 aliases (`amount|amt|value`, `date|txn_date|transaction_date`,
 *     `description|desc|memo|details`, plus per-field aliases below),
 *   - parses dates (`YYYY-MM-DD`, `MM/DD/YYYY`, `M/D/YY`, `DD-Mon-YYYY`) → ISO
 *     `YYYY-MM-DD` (unparseable → row-level error),
 *   - parses amounts (strip `$`, `,`, whitespace; `(x)` → negative) → integer cents (D7),
 *   - maps columns per workflow file type into the typed rows from `@/lib/types`,
 *   - assigns stable synthetic row IDs (`erp-001`, `bank-001`, … in file order — D8).
 *
 * Returns `{ rows, errors, meta }` (ParsedFile). Dirty rows are collected in `errors`
 * and skipped; the parse step still succeeds. `rows.length === 0` is the caller's cue
 * to error.
 */

import { createHash } from "node:crypto";
import Papa from "papaparse";
import * as XLSX from "xlsx";

import type {
  FileType,
  ParsedFile,
  ParsedRow,
  ParseError,
} from "@/lib/types";

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

export interface ParseOptions {
  /** Original filename (stored in meta; also used to detect `.xlsx/.xls`). */
  filename?: string;
  /** Force the input format; otherwise inferred from filename/magic bytes. */
  format?: "csv" | "xlsx";
}

/**
 * Parse a CSV/Excel buffer (or CSV string) into typed, cents-based rows with stable
 * synthetic IDs. `rows` is `ParsedRow[]` (the shared row shapes are structurally the
 * ErpTxn/BankTxn/Invoice/PurchaseOrder/BudgetLine/ActualsLine for the given fileType);
 * callers narrow it per fileType.
 */
export function parseFile(
  input: Buffer | string,
  fileType: FileType,
  options: ParseOptions = {},
): ParsedFile {
  const sha256 = sha256Hex(input);
  const isExcel = detectExcel(input, options);

  // Raw records keyed by their (still-original) header strings, in file order.
  const rawRecords = isExcel ? readExcel(input) : readCsv(input);

  const spec = FIELD_SPECS[fileType];
  const rows: ParsedRow[] = [];
  const errors: ParseError[] = [];
  let idCounter = 0;

  rawRecords.forEach((raw, i) => {
    // Source-file line: header is line 1, so the first data record is line 2.
    const sourceRow = i + 2;
    const normalized = normalizeRecord(raw);

    // Wholly-empty records can survive skipEmptyLines when a stray delimiter is
    // present; treat them as blank and skip silently (not an error).
    if (isBlankRecord(normalized)) return;

    const mapped = mapRecord(normalized, spec);
    if (!mapped.ok) {
      errors.push({ row: sourceRow, message: mapped.message, raw });
      return;
    }

    idCounter += 1;
    const id = `${spec.idPrefix}-${String(idCounter).padStart(3, "0")}`;
    rows.push({ id, ...mapped.row });
  });

  return {
    rows,
    errors,
    meta: {
      filename: options.filename ?? "",
      fileType,
      sha256,
      rowCount: rows.length,
      skippedCount: errors.length,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Readers                                                                     */
/* -------------------------------------------------------------------------- */

function readCsv(input: Buffer | string): Record<string, unknown>[] {
  const text = typeof input === "string" ? input : input.toString("utf8");
  const result = Papa.parse<Record<string, unknown>>(text, {
    header: true,
    skipEmptyLines: true,
  });
  return Array.isArray(result.data) ? result.data : [];
}

function readExcel(input: Buffer | string): Record<string, unknown>[] {
  const wb =
    typeof input === "string"
      ? XLSX.read(input, { type: "string" })
      : XLSX.read(input, { type: "buffer" });
  const firstSheetName = wb.SheetNames[0];
  if (!firstSheetName) return [];
  const sheet = wb.Sheets[firstSheetName];
  // `raw: false` yields formatted strings (dates/amounts) so the shared string
  // normalizer handles them identically to CSV cells.
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: "",
    raw: false,
  });
}

/**
 * Excel detection: explicit option wins, else filename extension, else sniff the
 * buffer's magic bytes (ZIP `PK\x03\x04` for .xlsx, OLE `\xD0\xCF\x11\xE0` for .xls).
 * A plain string is always treated as CSV text.
 */
function detectExcel(input: Buffer | string, options: ParseOptions): boolean {
  if (options.format) return options.format === "xlsx";
  if (options.filename && /\.xlsx?$/i.test(options.filename)) return true;
  if (typeof input === "string") return false;
  if (input.length >= 4) {
    const isZip =
      input[0] === 0x50 && input[1] === 0x4b && input[2] === 0x03 && input[3] === 0x04;
    const isOle =
      input[0] === 0xd0 && input[1] === 0xcf && input[2] === 0x11 && input[3] === 0xe0;
    return isZip || isOle;
  }
  return false;
}

function sha256Hex(input: Buffer | string): string {
  return createHash("sha256").update(input).digest("hex");
}

/* -------------------------------------------------------------------------- */
/* Header + record normalization                                              */
/* -------------------------------------------------------------------------- */

/** lowercase, strip BOM, trim, collapse internal whitespace → `_`. */
export function normalizeHeader(header: string): string {
  return header
    .replace(/^﻿/, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "_");
}

function normalizeRecord(raw: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const nk = normalizeHeader(key);
    if (!nk) continue;
    // First wins if two source headers collapse to the same normalized key.
    if (!(nk in out)) out[nk] = value == null ? "" : String(value).trim();
  }
  return out;
}

function isBlankRecord(record: Record<string, string>): boolean {
  return Object.values(record).every((v) => v === "");
}

/* -------------------------------------------------------------------------- */
/* Value parsers                                                               */
/* -------------------------------------------------------------------------- */

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/**
 * Parse `YYYY-MM-DD`, `MM/DD/YYYY`, `M/D/YY`, or `DD-Mon-YYYY` to ISO `YYYY-MM-DD`.
 * Returns `null` for anything unrecognized or calendar-invalid (e.g. Feb 30).
 */
export function parseDate(value: string): string | null {
  const v = value.trim();
  if (!v) return null;

  // YYYY-MM-DD
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v);
  if (m) return isoFromYMD(+m[1], +m[2], +m[3]);

  // MM/DD/YYYY and M/D/YY (year length disambiguates)
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(v);
  if (m) {
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return isoFromYMD(year, +m[1], +m[2]);
  }

  // DD-Mon-YYYY
  m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(v);
  if (m) {
    const month = MONTHS[m[2].toLowerCase()];
    if (!month) return null;
    return isoFromYMD(+m[3], month, +m[1]);
  }

  return null;
}

function isoFromYMD(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== month - 1 ||
    dt.getUTCDate() !== day
  ) {
    return null; // rolled over → invalid calendar date
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(
    day,
  ).padStart(2, "0")}`;
}

/**
 * Parse a money string to integer cents (D7). Strips `$`, `,`, whitespace; treats
 * a fully parenthesized value `(x)` as negative. Returns `null` if not numeric.
 */
export function parseAmountCents(value: string): number | null {
  let clean = value.trim();
  if (!clean) return null;

  let negative = false;
  if (/^\(.*\)$/.test(clean)) {
    negative = true;
    clean = clean.slice(1, -1);
  }

  clean = clean.replace(/[$,\s]/g, "");
  if (clean.startsWith("-")) {
    negative = true;
    clean = clean.slice(1);
  }
  if (clean === "" || !/^\d*\.?\d+$|^\d+\.?\d*$/.test(clean)) return null;

  const parsed = Number.parseFloat(clean);
  if (!Number.isFinite(parsed)) return null;

  const cents = Math.round(parsed * 100);
  return negative ? -cents : cents;
}

/** Normalize a period to `YYYY-MM`; lenient (period is not a hard-error field). */
function parsePeriod(value: string): string {
  const v = value.trim();
  const m = /^(\d{4})-(\d{1,2})/.exec(v);
  if (m) return `${m[1]}-${String(Number(m[2])).padStart(2, "0")}`;
  const iso = parseDate(v);
  if (iso) return iso.slice(0, 7);
  return v;
}

/* -------------------------------------------------------------------------- */
/* Per-file-type column mapping                                               */
/* -------------------------------------------------------------------------- */

type FieldKind = "text" | "date" | "amount" | "period";

interface FieldSpec {
  /** Output property name on the typed row. */
  field: string;
  /** Candidate normalized headers, in priority order. */
  aliases: string[];
  kind: FieldKind;
}

interface FileTypeSpec {
  idPrefix: string;
  fields: FieldSpec[];
}

// Shared alias groups (§6).
const AMOUNT = ["amount", "amt", "value"];
const DATE = ["date", "txn_date", "transaction_date"];
const DESCRIPTION = ["description", "desc", "memo", "details"];

const FIELD_SPECS: Record<FileType, FileTypeSpec> = {
  erp_export: {
    idPrefix: "erp",
    fields: [
      { field: "date", aliases: [...DATE, "posting_date", "entry_date"], kind: "date" },
      { field: "description", aliases: DESCRIPTION, kind: "text" },
      { field: "amountCents", aliases: AMOUNT, kind: "amount" },
      {
        field: "referenceNumber",
        aliases: ["reference_number", "reference", "reference_no", "ref", "ref_no"],
        kind: "text",
      },
    ],
  },
  bank_statement: {
    idPrefix: "bank",
    fields: [
      { field: "date", aliases: [...DATE, "posting_date", "value_date"], kind: "date" },
      { field: "description", aliases: DESCRIPTION, kind: "text" },
      { field: "amountCents", aliases: AMOUNT, kind: "amount" },
      {
        field: "transactionId",
        aliases: ["transaction_id", "txn_id", "trans_id", "bank_transaction_id"],
        kind: "text",
      },
    ],
  },
  invoice: {
    idPrefix: "inv",
    fields: [
      {
        field: "invoiceNumber",
        aliases: ["invoice_number", "invoice_no", "invoice", "inv_number", "inv_no"],
        kind: "text",
      },
      {
        field: "vendorName",
        aliases: ["vendor_name", "vendor", "supplier_name", "supplier"],
        kind: "text",
      },
      { field: "lineItem", aliases: ["line_item", "item", ...DESCRIPTION], kind: "text" },
      { field: "amountCents", aliases: AMOUNT, kind: "amount" },
      {
        field: "invoiceDate",
        aliases: ["invoice_date", "inv_date", ...DATE],
        kind: "date",
      },
      { field: "dueDate", aliases: ["due_date", "due"], kind: "date" },
    ],
  },
  po: {
    idPrefix: "po",
    fields: [
      {
        field: "poNumber",
        aliases: ["po_number", "po_no", "po", "purchase_order_number", "purchase_order"],
        kind: "text",
      },
      {
        field: "vendorName",
        aliases: ["vendor_name", "vendor", "supplier_name", "supplier"],
        kind: "text",
      },
      { field: "lineItem", aliases: ["line_item", "item", ...DESCRIPTION], kind: "text" },
      { field: "amountCents", aliases: AMOUNT, kind: "amount" },
      {
        field: "issuedDate",
        aliases: ["issued_date", "issue_date", "po_date", ...DATE],
        kind: "date",
      },
      {
        field: "approvedBy",
        aliases: ["approved_by", "approver", "approval"],
        kind: "text",
      },
    ],
  },
  budget: {
    idPrefix: "budget",
    fields: [
      { field: "department", aliases: ["department", "dept"], kind: "text" },
      { field: "category", aliases: ["category", "cat"], kind: "text" },
      {
        field: "budgetedAmountCents",
        aliases: ["budgeted_amount", "budget", "budgeted", ...AMOUNT],
        kind: "amount",
      },
      { field: "period", aliases: ["period", "month", "fiscal_period"], kind: "period" },
    ],
  },
  actuals: {
    idPrefix: "actuals",
    fields: [
      { field: "department", aliases: ["department", "dept"], kind: "text" },
      { field: "category", aliases: ["category", "cat"], kind: "text" },
      {
        field: "actualAmountCents",
        aliases: ["actual_amount", "actual", "actuals", ...AMOUNT],
        kind: "amount",
      },
      { field: "period", aliases: ["period", "month", "fiscal_period"], kind: "period" },
    ],
  },
};

type MapResult =
  | { ok: true; row: Record<string, unknown> }
  | { ok: false; message: string };

function lookup(record: Record<string, string>, aliases: string[]): string | undefined {
  for (const alias of aliases) {
    if (alias in record) return record[alias];
  }
  return undefined;
}

function mapRecord(record: Record<string, string>, spec: FileTypeSpec): MapResult {
  const row: Record<string, unknown> = {};

  for (const f of spec.fields) {
    const rawValue = lookup(record, f.aliases);
    const value = (rawValue ?? "").trim();

    switch (f.kind) {
      case "text": {
        row[f.field] = value;
        break;
      }
      case "period": {
        row[f.field] = parsePeriod(value);
        break;
      }
      case "date": {
        if (!value) {
          return { ok: false, message: `Missing required date column "${f.field}"` };
        }
        const iso = parseDate(value);
        if (iso === null) {
          return {
            ok: false,
            message: `Unparseable date in "${f.field}": "${value}"`,
          };
        }
        row[f.field] = iso;
        break;
      }
      case "amount": {
        if (!value) {
          return { ok: false, message: `Missing required amount column "${f.field}"` };
        }
        const cents = parseAmountCents(value);
        if (cents === null) {
          return {
            ok: false,
            message: `Unparseable amount in "${f.field}": "${value}"`,
          };
        }
        row[f.field] = cents;
        break;
      }
    }
  }

  return { ok: true, row };
}
