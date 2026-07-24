import { describe, expect, it } from "vitest";

import type { BankTxn, ErpTxn, Invoice } from "@/lib/types";

import { parseAmountCents, parseDate, parseFile } from "@/lib/csv/parser";

describe("parseAmountCents — money → integer cents (D7)", () => {
  it("strips commas", () => {
    expect(parseAmountCents("1,234.50")).toBe(123450);
  });
  it("strips currency symbols and pads implicit cents", () => {
    expect(parseAmountCents("$1234.5")).toBe(123450);
  });
  it("treats parenthesized values as negative", () => {
    expect(parseAmountCents("(500.00)")).toBe(-50000);
  });
  it("handles leading minus and whitespace", () => {
    expect(parseAmountCents("  -$2,000  ")).toBe(-200000);
  });
  it("handles a bare integer", () => {
    expect(parseAmountCents("42")).toBe(4200);
  });
  it("returns null for empty or non-numeric input", () => {
    expect(parseAmountCents("")).toBeNull();
    expect(parseAmountCents("N/A")).toBeNull();
  });
});

describe("parseDate — all four accepted formats → ISO YYYY-MM-DD", () => {
  it("passes through ISO", () => {
    expect(parseDate("2026-06-15")).toBe("2026-06-15");
  });
  it("parses MM/DD/YYYY", () => {
    expect(parseDate("06/15/2026")).toBe("2026-06-15");
  });
  it("parses M/D/YY (2-digit year → 20YY)", () => {
    expect(parseDate("6/5/26")).toBe("2026-06-05");
  });
  it("parses DD-Mon-YYYY", () => {
    expect(parseDate("15-Jun-2026")).toBe("2026-06-15");
  });
  it("rejects unparseable and calendar-invalid dates", () => {
    expect(parseDate("not-a-date")).toBeNull();
    expect(parseDate("2026-02-30")).toBeNull();
    expect(parseDate("13/40/2026")).toBeNull();
  });
});

describe("parseFile — ERP export", () => {
  it("assigns stable erp-00N ids in file order and maps columns", () => {
    const csv = [
      "date,description,amount,reference_number",
      "2026-06-01,Payroll run,12500.00,REF-1",
      "06/02/2026,SaaS subscription,\"1,299.00\",REF-2",
      "3-Jun-2026,Wire transfer,(500.00),REF-3",
    ].join("\n");

    const result = parseFile(csv, "erp_export");
    const rows = result.rows as unknown as ErpTxn[];

    expect(result.errors).toHaveLength(0);
    expect(result.meta.rowCount).toBe(3);
    expect(result.meta.skippedCount).toBe(0);
    expect(rows.map((r) => r.id)).toEqual(["erp-001", "erp-002", "erp-003"]);

    expect(rows[0]).toMatchObject({
      id: "erp-001",
      date: "2026-06-01",
      description: "Payroll run",
      amountCents: 1250000,
      referenceNumber: "REF-1",
    });
    expect(rows[1].date).toBe("2026-06-02");
    expect(rows[1].amountCents).toBe(129900);
    expect(rows[2].date).toBe("2026-06-03");
    expect(rows[2].amountCents).toBe(-50000);
  });
});

describe("parseFile — header aliasing (§6)", () => {
  it("resolves amt|value, txn_date, and memo aliases; case/whitespace-insensitive", () => {
    const csv = [
      "Txn Date,MEMO,Amt,Transaction ID",
      "2026-06-10,Coffee vendor ACH,55.25,TXN-9",
    ].join("\n");

    const result = parseFile(csv, "bank_statement");
    const rows = result.rows as unknown as BankTxn[];

    expect(result.errors).toHaveLength(0);
    expect(rows[0]).toMatchObject({
      id: "bank-001",
      date: "2026-06-10",
      description: "Coffee vendor ACH",
      amountCents: 5525,
      transactionId: "TXN-9",
    });
  });
});

describe("parseFile — dirty rows (step still returns rows, skips lists)", () => {
  it("skips unparseable rows, keeps good ones, and renumbers ids over survivors", () => {
    const csv = [
      "date,description,amount,reference_number",
      "2026-06-01,Good row A,100.00,R1", // ok → erp-001
      "2026-13-45,Bad date,200.00,R2", // skipped
      "2026-06-03,Bad amount,not-money,R3", // skipped
      "06/04/2026,Good row B,300.00,R4", // ok → erp-002
    ].join("\n");

    const result = parseFile(csv, "erp_export");
    const rows = result.rows as unknown as ErpTxn[];

    // Parse step "succeeds": it returns the good rows.
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id)).toEqual(["erp-001", "erp-002"]);
    expect(rows[1].description).toBe("Good row B");

    // …and lists the skipped rows with 1-based source-file line numbers.
    expect(result.errors).toHaveLength(2);
    expect(result.meta.skippedCount).toBe(2);
    expect(result.errors.map((e) => e.row)).toEqual([3, 4]);
    expect(result.errors[0].message).toMatch(/date/i);
    expect(result.errors[1].message).toMatch(/amount/i);
  });

  it("returns zero rows when every row is invalid (caller's cue to error)", () => {
    const csv = ["date,description,amount,reference_number", ",,,"].join("\n");
    const result = parseFile(csv, "erp_export");
    expect(result.rows).toHaveLength(0);
  });
});

describe("parseFile — invoice mapping + meta", () => {
  it("maps invoice columns, both date fields, and populates meta", () => {
    const csv = [
      "invoice_no,vendor,line_item,amount,invoice_date,due_date",
      "INV-100,Meridian Supply Co,Widgets,\"$4,200.00\",06/01/2026,01-Jul-2026",
    ].join("\n");

    const result = parseFile(csv, "invoice", { filename: "invoices.csv" });
    const rows = result.rows as unknown as Invoice[];

    expect(rows[0]).toMatchObject({
      id: "inv-001",
      invoiceNumber: "INV-100",
      vendorName: "Meridian Supply Co",
      lineItem: "Widgets",
      amountCents: 420000,
      invoiceDate: "2026-06-01",
      dueDate: "2026-07-01",
    });
    expect(result.meta.filename).toBe("invoices.csv");
    expect(result.meta.fileType).toBe("invoice");
    expect(result.meta.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.meta.rowCount).toBe(1);
  });
});
