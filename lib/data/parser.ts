import { createHash } from "node:crypto";
import { validateWorkbookContainer } from "./workbook-container";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { DATA_LIMITS, DataSourceError, type DataFormat, type DataRow, type DataSource, type DataTable, type DataValue, type ParseDataOptions } from "@/lib/data/types";

type MatrixRow = { originalRow: number; cells: DataValue[] };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXTENSIONS: Record<string, DataFormat> = { csv: "csv", tsv: "tsv", xls: "xls", xlsx: "xlsx", json: "json", jsonl: "jsonl", ndjson: "jsonl", txt: "text", md: "markdown", markdown: "markdown", pdf: "pdf" };

export function sha256Source(buffer: Uint8Array): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/** Parses values without requiring accounting column names, model calls, or external access. */
export async function parseDataSource(buffer: Uint8Array, filename: string, sourceId: string, options: ParseDataOptions = {}): Promise<DataSource> {
  if (!UUID.test(sourceId)) throw new DataSourceError("Source ID must be a UUID.");
  if (!filename || filename.length > 240 || /[\u0000-\u001f\u007f]/.test(filename)) throw new DataSourceError("Use a filename of 1–240 characters without control characters.");
  if (!buffer.byteLength) throw new DataSourceError("The uploaded file is empty.");
  if (buffer.byteLength > DATA_LIMITS.maxUploadBytes) limit("The file exceeds 20 MiB. Split it into smaller source files.");
  const extension = filename.split(".").at(-1)?.toLowerCase() ?? "";
  const format = EXTENSIONS[extension];
  if (!format) throw new DataSourceError("Unsupported file extension. Upload CSV, TSV, XLS, XLSX, JSON, JSONL, TXT, Markdown, or a PDF with embedded text.");
  validateOptions(options);
  const warnings: string[] = [];
  let rowsUsed = 0;
  let cellsUsed = 0;
  let charsUsed = 0;
  const account = (cells: DataValue[]) => {
    rowsUsed++;
    cellsUsed += cells.length;
    if (rowsUsed > DATA_LIMITS.maxRows) limit(`The source exceeds ${DATA_LIMITS.maxRows.toLocaleString()} rows across its tables. Split it by sheet or period; no rows were truncated.`);
    if (cells.length > DATA_LIMITS.maxColumns || cellsUsed > DATA_LIMITS.maxCells) limit("The source exceeds the 250-column or 500,000-cell limit. Split the source; no cells were truncated.");
    for (const value of cells) {
      if (typeof value === "number" && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) throw new DataSourceError("A spreadsheet number exceeds exact numeric precision. Export that column as text to preserve its original value.");
      const length = String(value ?? "").length;
      if (length > DATA_LIMITS.maxCellChars) limit("A cell or text line exceeds 32,768 characters. Split long text into shorter lines or records.");
      charsUsed += length;
      if (charsUsed > DATA_LIMITS.maxParsedChars) limit("Expanded source text exceeds 20 MiB. Split the file into smaller sources.");
    }
  };
  let tables: DataTable[];

  if (format === "csv" || format === "tsv") {
    const text = decodeText(buffer);
    const matrix: MatrixRow[] = [];
    let previousCursor = 0;
    let originalRow = 1;
    let failure: Error | undefined;
    Papa.parse<string[]>(text, {
      delimiter: format === "tsv" ? "\t" : "",
      delimitersToGuess: [",", "\t", ";", "|"],
      dynamicTyping: false,
      skipEmptyLines: false,
      step(result, parser) {
        const fatal = result.errors.find(error => error.code !== "UndetectableDelimiter");
        if (fatal) {
          failure = new DataSourceError(`Delimited text could not be read near source line ${originalRow} (${fatal.code}). Check quoting and delimiters.`);
          parser.abort();
          return;
        }
        if (result.errors.some(error => error.code === "UndetectableDelimiter")) warnings.push("No reliable delimiter was detected; the source was retained as a single-column table.");
        const cells = result.data;
        if (cells.some(value => value !== "")) {
          try { account(cells); matrix.push({ originalRow, cells }); }
          catch (error) { failure = error as Error; parser.abort(); return; }
        }
        originalRow += (text.slice(previousCursor, result.meta.cursor).match(/\r\n|\r|\n/g) ?? []).length;
        previousCursor = result.meta.cursor;
      },
    });
    if (failure) throw failure;
    if (!matrix.length) throw new DataSourceError("The source contains no non-empty rows.");
    tables = [matrixTable(matrix, "t0", filename, sourceId, options, warnings)];
    warnings.push("Delimited values are preserved as text. Dates, identifiers, decimals and currency text have not been guessed or converted.");
  } else if (format === "xlsx" || format === "xls") {
    validateWorkbookContainer(buffer, format);
    let workbook: XLSX.WorkBook;
    try { workbook = XLSX.read(buffer, { type: "array", cellDates: false, cellNF: true, cellText: true, cellFormula: true, bookVBA: false, bookDeps: false }); }
    catch { throw new DataSourceError("The spreadsheet could not be read. It may be encrypted, damaged, or mislabeled. Save an unencrypted XLS/XLSX or export CSV."); }
    if (workbook.SheetNames.length > DATA_LIMITS.maxTables) limit("The workbook exceeds 32 sheets. Split it into smaller workbooks; no sheets were omitted.");
    tables = [];
    let formulas = false;
    let dates = false;
    for (let index = 0; index < workbook.SheetNames.length; index++) {
      const name = workbook.SheetNames[index];
      const sheet = workbook.Sheets[name];
      const byRow = new Map<number, Map<number, DataValue>>();
      let width = 0;
      for (const key of Object.keys(sheet)) {
        if (key.startsWith("!")) continue;
        const cell = sheet[key] as XLSX.CellObject;
        if (!cell || (cell.v === undefined && !cell.f)) continue;
        const position = XLSX.utils.decode_cell(key);
        if (position.c >= DATA_LIMITS.maxColumns) limit(`Sheet "${name}" has populated cells beyond column 250. Split or remove the unused columns.`);
        let value: DataValue;
        if (cell.f) formulas = true;
        if (cell.t === "e") value = cell.w ?? `Spreadsheet error ${cell.v}`;
        else if (cell.v === undefined && cell.f) value = `=${cell.f}`;
        else if (typeof cell.v === "number" || typeof cell.v === "boolean") value = cell.v;
        else if (cell.v === null || cell.v === undefined) value = null;
        else value = String(cell.v);
        if (typeof cell.v === "number" && cell.z && XLSX.SSF.is_date(String(cell.z))) dates = true;
        const row = byRow.get(position.r + 1) ?? new Map<number, DataValue>();
        row.set(position.c, value);
        byRow.set(position.r + 1, row);
        width = Math.max(width, position.c + 1);
        if (byRow.size > DATA_LIMITS.maxRows) limit(`Sheet "${name}" exceeds the row limit.`);
      }
      const matrix = [...byRow.entries()].sort(([a], [b]) => a - b).map(([originalRow, cells]) => {
        const values = Array.from({ length: width }, (_, column) => cells.get(column) ?? null);
        account(values);
        return { originalRow, cells: values };
      });
      if (sheet["!merges"]?.length) warnings.push(`Sheet "${name}" contains merged cells; only each merge's stored value is present. Values were not filled into adjacent cells.`);
      if (workbook.Workbook?.Sheets?.[index]?.Hidden) warnings.push(`Hidden sheet "${name}" was included.`);
      tables.push(matrixTable(matrix, `t${index}`, name, sourceId, options, warnings));
    }
    if (!tables.some(table => table.rows.length || table.preamble.length)) throw new DataSourceError("The workbook has no populated data rows.");
    if (formulas) warnings.push("Spreadsheet formulas were not evaluated. Existing cached values are used; formulas with no cached result remain formula text. Recalculate in your spreadsheet application if current values are required.");
    if (dates) warnings.push(`Excel date-formatted numeric cells retain their original serial values (${workbook.Workbook?.WBProps?.date1904 ? "1904" : "1900"} date system); no timezone or calendar meaning was guessed.`);
  } else if (format === "json" || format === "jsonl") {
    const text = decodeText(buffer);
    if (format === "jsonl") {
      const records: { value: unknown; row: number }[] = [];
      text.split(/\r\n|\r|\n/).forEach((line, index) => {
        if (!line.trim()) return;
        records.push({ value: parseJsonPreservingNumbers(line, warnings, `line ${index + 1}`), row: index + 1 });
        if (records.length > DATA_LIMITS.maxRows) limit("The JSONL source exceeds 20,000 records. Split it into smaller files.");
      });
      tables = [recordTable(records, "t0", filename, sourceId, warnings, account)];
    } else {
      const value = parseJsonPreservingNumbers(text, warnings, "document");
      const groups: { name: string; values: unknown[] }[] = [];
      if (Array.isArray(value)) groups.push({ name: filename, values: value });
      else if (value !== null && typeof value === "object") {
        const fields = Object.entries(value);
        const arrays = fields.filter(([, entry]) => Array.isArray(entry));
        if (arrays.length) {
          for (const [name, values] of arrays) groups.push({ name, values: values as unknown[] });
          const metadata = Object.fromEntries(fields.filter(([, entry]) => !Array.isArray(entry)));
          if (Object.keys(metadata).length) groups.push({ name: "Document metadata", values: [metadata] });
        } else groups.push({ name: filename, values: [value] });
      } else groups.push({ name: filename, values: [value] });
      if (groups.length > DATA_LIMITS.maxTables) limit("The JSON document exceeds 32 top-level tables. Split it into smaller sources.");
      tables = groups.map((group, index) => {
        const id = `t${index}`;
        if (group.values.length && group.values.every(Array.isArray)) {
          const matrix = group.values.map((row, rowIndex) => {
            const cells = (row as unknown[]).map(value => dataValue(value, warnings));
            account(cells);
            return { originalRow: rowIndex + 1, cells };
          });
          return matrixTable(matrix, id, group.name, sourceId, options, warnings);
        }
        return recordTable(group.values.map((entry, row) => ({ value: entry, row: row + 1 })), id, group.name, sourceId, warnings, account);
      });
    }
  } else if (format === "pdf") {
    if (Buffer.from(buffer.subarray(0, 5)).toString("ascii") !== "%PDF-") throw new DataSourceError("The file does not have a PDF header. Confirm its file type.");
    const { getDocumentProxy } = await import("unpdf");
    let pdf: Awaited<ReturnType<typeof getDocumentProxy>> | undefined;
    try {
      pdf = await getDocumentProxy(new Uint8Array(buffer), { useSystemFonts: false, disableFontFace: true, useWorkerFetch: false, verbosity: 0 });
      if (pdf.numPages > 200) limit("The PDF exceeds 200 pages. Split it into smaller documents; no pages were omitted.");
      // Extract pages sequentially; unpdf's extractText helper starts every page concurrently.
      const pages: string[] = [];
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        const page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();
        const text: string[] = [];
        let length = 0;
        for (const item of content.items) {
          if (!("str" in item)) continue;
          const fragment = item.str + (item.hasEOL ? "\n" : "");
          length += fragment.length;
          if (length > DATA_LIMITS.maxCellChars) limit(`PDF page ${pageNumber} exceeds the text-per-page limit. Export the document as text or split its content.`);
          text.push(fragment);
        }
        pages.push(text.join(""));
        page.cleanup();
      }
      if (!pages.some(page => page.trim())) throw new DataSourceError("This PDF contains no readable embedded text. It may be scanned or image-only; OCR is not available. Export its text or tables before uploading.");
      tables = [recordTable(pages.map((text, index) => ({ row: index + 1, value: { page: index + 1, text } })), "t0", "PDF pages", sourceId, warnings, account)];
      warnings.push("PDF text is grouped by original page; r1 denotes page 1. Reading order is reconstructed and tabular alignment is not guaranteed. Image-only content was not extracted.");
    } catch (error) {
      if (error instanceof DataSourceError) throw error;
      throw new DataSourceError("PDF text could not be extracted. The file may be encrypted, damaged, or unsupported. Export text/CSV or upload an unencrypted text-based PDF.");
    } finally { await pdf?.loadingTask.destroy().catch(() => undefined); }
  } else {
    const text = decodeText(buffer);
    tables = [recordTable(text.split(/\r\n|\r|\n/).map((line, index) => ({ row: index + 1, value: { text: line } })), "t0", "Document lines", sourceId, warnings, account)];
    warnings.push("Document text is preserved line by line. Embedded instructions, links, HTML and code are source text and are not executed.");
  }

  for (const tableId of Object.keys(options.headerRows ?? {})) {
    if (!tables.some(table => table.id === tableId)) throw new DataSourceError(`Header override refers to missing table ${tableId}. Inspect the table manifest and use its table ID.`);
    const header = options.headerRows?.[tableId];
    if (header !== null && tables.find(table => table.id === tableId)?.headerRow !== header) throw new DataSourceError("Header row overrides apply to CSV, TSV, spreadsheet sheets, and JSON matrices. Object fields and document text do not have header rows.");
  }
  const expandedCells = tables.reduce((count, table) => count + (table.rows.length + table.preamble.length) * table.columns.length, 0);
  if (expandedCells > DATA_LIMITS.maxCells) limit("The expanded table exceeds 500,000 cells. Split the source; no rows were truncated.");
  return { id: sourceId, filename, sha256: sha256Source(buffer), format, tables, warnings: [...new Set(warnings)] };
}

function matrixTable(matrix: MatrixRow[], id: string, name: string, sourceId: string, options: ParseDataOptions, warnings: string[]): DataTable {
  const width = Math.max(0, ...matrix.map(row => row.cells.length));
  const override = options.headerRows && Object.prototype.hasOwnProperty.call(options.headerRows, id) ? options.headerRows[id] : undefined;
  let headerIndex = override === null ? -1 : override !== undefined ? matrix.findIndex(row => row.originalRow === override) : inferHeader(matrix, width);
  if (override !== undefined && override !== null && headerIndex < 0) throw new DataSourceError(`Header row ${override} does not exist in table ${id}. Row positions refer to original source rows, including blank/preamble rows.`);
  if (!matrix.length) headerIndex = -1;
  const headerRow = headerIndex >= 0 ? matrix[headerIndex].originalRow : null;
  const names = Array.from({ length: width }, (_, column) => headerIndex >= 0 ? String(matrix[headerIndex].cells[column] ?? "").trim() || `Column ${column + 1}` : `Column ${column + 1}`);
  const used = new Set<string>();
  const columns = names.map(name => {
    let unique = name; let suffix = 2;
    while (used.has(unique)) unique = `${name} [${suffix++}]`;
    used.add(unique);
    return unique;
  });
  if (names.some((name, index) => name !== columns[index])) warnings.push(`Duplicate headers in "${name}" were given unique column names; no column values were merged.`);
  if (override === undefined && matrix.length) warnings.push(headerRow === null ? `No reliable header was detected for "${name}". Generated column names retain every source row; specify headerRows to select a header.` : `Header inferred at original row ${headerRow} in "${name}". Introductory rows are preserved separately; use a headerRows override if this is incorrect.`);
  const make = (row: MatrixRow): DataRow => ({ sourceId: citation(sourceId, id, row.originalRow), originalRow: row.originalRow, values: Object.fromEntries(columns.map((column, index) => [column, row.cells[index] ?? null])) });
  const preamble = headerIndex > 0 ? matrix.slice(0, headerIndex).map(make) : [];
  const rows = matrix.slice(headerIndex + 1).map(make);
  return { id, name, columns, rows, rowCount: rows.length, truncated: false, headerRow, header: headerIndex >= 0 ? make(matrix[headerIndex]) : null, preamble };
}

/** Infer only when a textual row has a consistent table beneath it; ambiguous data stays data. */
function inferHeader(matrix: MatrixRow[], width: number): number {
  if (!matrix.length || width === 0) return -1;
  let best = -1; let bestScore = 0;
  for (let index = 0; index < Math.min(50, matrix.length - 1); index++) {
    const row = matrix[index].cells;
    const populated = row.filter(value => value !== null && value !== "");
    if (!populated.length || populated.some(value => typeof value !== "string")) continue;
    const numeric = populated.filter(value => /^[+-]?[\d.,]+$/.test(String(value).trim())).length;
    if (numeric > 0) continue;
    const following = matrix.slice(index + 1, index + 6);
    const consistent = following.filter(next => next.cells.filter(value => value !== null && value !== "").length >= populated.length).length;
    const coverage = populated.length / width;
    if (coverage < 0.5 || !consistent) continue;
    const numericBelow = following.some(next => next.cells.some(value => typeof value === "number" || (typeof value === "string" && /^[-+]?\d[\d,.]*$/.test(value.trim()))));
    const score = coverage * 4 + consistent / following.length + (numericBelow ? 2 : 0) - index * 0.01;
    if (score > bestScore && (numericBelow || (index === 0 && new Set(populated).size === populated.length))) { best = index; bestScore = score; }
  }
  return best;
}

function recordTable(records: { value: unknown; row: number }[], id: string, name: string, sourceId: string, warnings: string[], account: (cells: DataValue[]) => void): DataTable {
  if (records.length > DATA_LIMITS.maxRows) limit("The source exceeds 20,000 records. Split it into smaller files; no rows were truncated.");
  const objects = records.map(record => ({ ...record, values: record.value !== null && typeof record.value === "object" && !Array.isArray(record.value) ? record.value as Record<string, unknown> : { value: record.value } }));
  const columns = [...new Set(objects.flatMap(record => Object.keys(record.values)))];
  if (columns.length > DATA_LIMITS.maxColumns) limit("The JSON table exceeds 250 distinct fields. Split the source or select a narrower export.");
  const rows = objects.map(record => {
    const values = Object.fromEntries(columns.map(column => [column, Object.prototype.hasOwnProperty.call(record.values, column) ? dataValue(record.values[column], warnings) : null]));
    account(Object.values(values));
    return { sourceId: citation(sourceId, id, record.row), originalRow: record.row, values };
  });
  return { id, name, columns, rows, rowCount: rows.length, truncated: false, headerRow: null, preamble: [] };
}

function dataValue(value: unknown, warnings: string[]): DataValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  warnings.push("Nested JSON objects and arrays are preserved as JSON text in cells; they were not flattened or discarded.");
  return JSON.stringify(value);
}

function parseJsonPreservingNumbers(text: string, warnings: string[], location: string): unknown {
  let transformed = ""; let inString = false; let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      transformed += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; transformed += char; continue; }
    if (char === "-" || /\d/.test(char)) {
      const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(index));
      if (match) {
        const token = match[0];
        const numeric = Number(token);
        const digits = token.split(/[eE]/)[0].replace(/[^\d]/g, "").replace(/^0+/, "").length;
        if (!Number.isFinite(numeric) || (Number.isInteger(numeric) && !Number.isSafeInteger(numeric)) || digits > 15) {
          transformed += JSON.stringify(token);
          warnings.push("JSON numbers exceeding reliable JavaScript precision are preserved as their original numeric text.");
        } else transformed += token;
        index += token.length - 1;
        continue;
      }
    }
    transformed += char;
  }
  try {
    const parsed: unknown = JSON.parse(transformed);
    rejectDuplicateJsonKeys(transformed);
    return parsed;
  }
  catch (error) {
    if (error instanceof DataSourceError) throw error;
    throw new DataSourceError(`Invalid JSON in ${location}. Check commas, quotes, and JSON syntax; source content was not repaired or guessed.`);
  }
}

function rejectDuplicateJsonKeys(text: string): void {
  const stack: { object: boolean; expectKey: boolean; keys: Set<string> }[] = [];
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "{" || char === "[") stack.push({ object: char === "{", expectKey: char === "{", keys: new Set() });
    else if (char === "}" || char === "]") stack.pop();
    else if (char === "," && stack.at(-1)?.object) stack.at(-1)!.expectKey = true;
    else if (char === '"') {
      const start = index;
      let escaped = false;
      while (++index < text.length) {
        if (escaped) escaped = false;
        else if (text[index] === "\\") escaped = true;
        else if (text[index] === '"') break;
      }
      const current = stack.at(-1);
      if (current?.object && current.expectKey) {
        const key = JSON.parse(text.slice(start, index + 1)) as string;
        if (current.keys.has(key)) throw new DataSourceError("The JSON contains duplicate keys in one object. Rename or remove duplicate fields; no values were overwritten.");
        current.keys.add(key);
        current.expectKey = false;
      }
    }
  }
}

function decodeText(buffer: Uint8Array): string {
  let encoding = "utf-8";
  if (buffer[0] === 0xff && buffer[1] === 0xfe) encoding = "utf-16le";
  if (buffer[0] === 0xfe && buffer[1] === 0xff) encoding = "utf-16be";
  let text: string;
  try { text = new TextDecoder(encoding, { fatal: true }).decode(buffer); }
  catch { throw new DataSourceError("Text encoding could not be read safely. Save as UTF-8 or UTF-16 with a byte-order marker before uploading."); }
  if (text.includes("\u0000")) throw new DataSourceError("The text file contains binary NUL bytes. Confirm the file type or export plain UTF-8 text.");
  return text.replace(/^\uFEFF/, "");
}


function validateOptions(options: ParseDataOptions): void {
  if (!options || typeof options !== "object" || (options.headerRows !== undefined && (!options.headerRows || typeof options.headerRows !== "object" || Array.isArray(options.headerRows)))) throw new DataSourceError("headerRows must map table IDs to one-based header row numbers or null.");
  for (const [id, row] of Object.entries(options.headerRows ?? {})) {
    if (!/^t\d+$/.test(id) || (row !== null && (!Number.isInteger(row) || row < 1 || row > 1_048_576))) throw new DataSourceError("Each header override must use a table ID such as t0 and a positive original row number, or null for no header.");
  }
}

function citation(source: string, table: string, row: number): string { return `src:${source}/${table}/r${row}`; }
function limit(message: string): never { throw new DataSourceError(message, "limit_exceeded"); }
