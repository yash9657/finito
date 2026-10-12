/**
 * Unit tests for the deterministic matching algorithms (PLAN §7 step 3, §8 step 3).
 * All fixtures are inline synthetic data — no demo files — exercising the exact-match,
 * candidate, duplicate, Jaccard-threshold, and AP 2%-tolerance behaviors.
 */

import { describe, it, expect } from "vitest";
import type { ErpTxn, BankTxn, Invoice, PurchaseOrder } from "@/lib/types";
import {
  jaccard,
  tokenize,
  withinTolerance,
  withinPoTolerance,
  poToleranceAllowanceCents,
  reconcile,
  detectBankDuplicates,
  nearestMiss,
  normalizeVendor,
  matchAp,
  detectDuplicateInvoices,
  RECON_STOPWORDS,
  MAX_MATCH_ROW_PAIRS,
} from "@/lib/agents/matching";

/* -------------------------------------------------------------------------- */
/* Fixture builders.                                                           */
/* -------------------------------------------------------------------------- */

function erp(
  id: string,
  date: string,
  description: string,
  amountCents: number,
): ErpTxn {
  return { id, date, description, amountCents, referenceNumber: `REF-${id}` };
}

function bank(
  id: string,
  date: string,
  description: string,
  amountCents: number,
): BankTxn {
  return { id, date, description, amountCents, transactionId: `TXN-${id}` };
}

function invoice(
  id: string,
  vendorName: string,
  lineItem: string,
  amountCents: number,
  invoiceDate: string,
): Invoice {
  return {
    id,
    invoiceNumber: `INV-${id}`,
    vendorName,
    lineItem,
    amountCents,
    invoiceDate,
    dueDate: invoiceDate,
  };
}

function po(
  id: string,
  vendorName: string,
  lineItem: string,
  amountCents: number,
  issuedDate: string,
): PurchaseOrder {
  return {
    id,
    poNumber: `PO-${id}`,
    vendorName,
    lineItem,
    amountCents,
    issuedDate,
    approvedBy: "Approver",
  };
}

/* -------------------------------------------------------------------------- */
/* Jaccard + tokenization.                                                     */
/* -------------------------------------------------------------------------- */

describe("tokenize / jaccard", () => {
  it("removes stopwords and punctuation", () => {
    const t = tokenize("Payment to Acme, Inc.", RECON_STOPWORDS);
    expect([...t].sort()).toEqual(["acme"]);
  });

  it("identical token sets score 1.0", () => {
    expect(jaccard(tokenize("acme cloud services"), tokenize("acme cloud services"))).toBe(1);
  });

  it("disjoint token sets score 0", () => {
    expect(jaccard(tokenize("alpha beta"), tokenize("gamma delta"))).toBe(0);
  });

  it("crosses the 0.5 threshold as overlap grows", () => {
    // {a,b,c} vs {a,b,d}: intersection 2, union 4 → 0.5
    expect(jaccard(tokenize("a b c"), tokenize("a b d"))).toBe(0.5);
    // {a,b,c} vs {a,d,e}: intersection 1, union 5 → 0.2
    expect(jaccard(tokenize("a b c"), tokenize("a d e"))).toBeCloseTo(0.2, 5);
  });

  it("two empty sets score 0 (no similarity evidence)", () => {
    expect(jaccard(new Set(), new Set())).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Reconciliation — exact match.                                               */
/* -------------------------------------------------------------------------- */

describe("reconcile — exact match", () => {
  it("matches an exact pair (same amount, date within 3 days, description overlap)", () => {
    const erpRows = [erp("erp-001", "2026-06-10", "Payment to Acme Cloud", 125_000)];
    const bankRows = [bank("bank-001", "2026-06-12", "Acme Cloud Services", 125_000)];

    const res = reconcile(erpRows, bankRows);

    expect(res.matchedPairs).toHaveLength(1);
    expect(res.matchedPairs[0]).toMatchObject({
      erpId: "erp-001",
      bankId: "bank-001",
      amountCents: 125_000,
      confidence: "exact",
    });
    expect(res.unmatchedErp).toHaveLength(0);
    expect(res.unmatchedBank).toHaveLength(0);
    expect(res.candidatePairs).toHaveLength(0);
  });

  it("does NOT exact-match beyond the ±3 day window; still a candidate on same amount", () => {
    const erpRows = [erp("erp-001", "2026-06-10", "Acme Cloud Services", 125_000)];
    const bankRows = [bank("bank-001", "2026-06-20", "Acme Cloud Services", 125_000)];

    const res = reconcile(erpRows, bankRows);

    expect(res.matchedPairs).toHaveLength(0);
    expect(res.candidatePairs).toHaveLength(1);
    expect(res.candidatePairs[0]).toMatchObject({ erpId: "erp-001", bankId: "bank-001" });
  });

  it("does NOT exact-match when description Jaccard is below 0.5", () => {
    // {acme,cloud,services} vs {globex,hosting,platform} → 0 overlap
    const erpRows = [erp("erp-001", "2026-06-10", "Acme Cloud Services", 125_000)];
    const bankRows = [bank("bank-001", "2026-06-11", "Globex Hosting Platform", 125_000)];

    const res = reconcile(erpRows, bankRows);

    expect(res.matchedPairs).toHaveLength(0);
    // same amount → still surfaced as a candidate for Claude
    expect(res.candidatePairs).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Reconciliation — same-amount-different-payment becomes a candidate.         */
/* -------------------------------------------------------------------------- */

describe("reconcile — coincidental same amount", () => {
  it("two clearly-different payments sharing an amount are a candidate, not an auto-match", () => {
    // Different descriptions (0 overlap) so exact match cannot fire, but equal amounts.
    const erpRows = [erp("erp-001", "2026-06-10", "Rent March Office", 500_000)];
    const bankRows = [bank("bank-001", "2026-06-10", "Payroll Batch Weekly", 500_000)];

    const res = reconcile(erpRows, bankRows);

    expect(res.matchedPairs).toHaveLength(0);
    expect(res.candidatePairs).toHaveLength(1);
    expect(res.candidatePairs[0].reason).toContain("same amount");
    // These stay in the residual sets for the LLM to adjudicate.
    expect(res.unmatchedErp.map((e) => e.id)).toEqual(["erp-001"]);
    expect(res.unmatchedBank.map((b) => b.id)).toEqual(["bank-001"]);
  });
});

/* -------------------------------------------------------------------------- */
/* Reconciliation — duplicate detection + exclusion.                           */
/* -------------------------------------------------------------------------- */

describe("reconcile — bank duplicate detection", () => {
  it("detects a duplicate bank row, excludes it from matching, and matches only once", () => {
    const erpRows = [erp("erp-001", "2026-06-10", "Acme Cloud Services", 125_000)];
    const bankRows = [
      bank("bank-001", "2026-06-11", "Acme Cloud Services", 125_000),
      { ...bank("bank-002", "2026-06-11", "Acme Cloud Services", 125_000), transactionId: "TXN-bank-001" }, // repeated source transaction
    ];

    const res = reconcile(erpRows, bankRows);

    expect(res.duplicates).toHaveLength(1);
    expect(res.duplicates[0]).toMatchObject({ id: "bank-002", duplicateOf: "bank-001" });

    // Exactly one match; the duplicate never appears in matchedPairs or unmatchedBank.
    expect(res.matchedPairs).toHaveLength(1);
    expect(res.matchedPairs[0].bankId).toBe("bank-001");
    expect(res.matchedPairs.some((m) => m.bankId === "bank-002")).toBe(false);
    expect(res.unmatchedBank.some((b) => b.id === "bank-002")).toBe(false);
  });

  it("detectBankDuplicates keeps the first occurrence unique", () => {
    const { duplicates, unique } = detectBankDuplicates([
      bank("bank-001", "2026-06-01", "Vendor A", 10_000),
      { ...bank("bank-002", "2026-06-01", "Vendor A", 10_000), transactionId: "TXN-bank-001" },
      bank("bank-003", "2026-06-02", "Vendor B", 20_000),
    ]);
    expect(unique.map((b) => b.id)).toEqual(["bank-001", "bank-003"]);
    expect(duplicates.map((d) => d.id)).toEqual(["bank-002"]);
  });

  it("does not erase legitimate identical payments with distinct or missing source IDs", () => {
    const rows = [bank("a", "2026-06-01", "Vendor A", 10000), bank("b", "2026-06-01", "Vendor A", 10000)];
    expect(detectBankDuplicates(rows).unique).toHaveLength(2);
    expect(detectBankDuplicates(rows.map((row) => ({ ...row, transactionId: "" }))).duplicates).toHaveLength(0);
    const result = reconcile([erp("e", "2026-06-01", "Vendor A", 10000)], rows);
    expect(result.unmatchedBank).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Reconciliation — fuzzy candidate (Jaccard ≥ 0.4 and amount within 5%).      */
/* -------------------------------------------------------------------------- */

describe("reconcile — fuzzy candidate", () => {
  it("surfaces a near-amount, similar-description pair as a candidate", () => {
    // amounts 12_500_00 vs 12_485_00 → 0.12% apart (within 5%); descriptions overlap.
    const erpRows = [erp("erp-001", "2026-06-10", "Wire Meridian Supply", 1_250_000)];
    const bankRows = [bank("bank-001", "2026-06-10", "Wire Meridian Supply", 1_248_500)];

    const res = reconcile(erpRows, bankRows);

    expect(res.matchedPairs).toHaveLength(0); // amounts differ → no exact match
    expect(res.candidatePairs).toHaveLength(1);
    expect(res.candidatePairs[0].amountDiffCents).toBe(1_500);
  });

  it("does not surface a candidate when amount is >5% off and descriptions differ", () => {
    const erpRows = [erp("erp-001", "2026-06-10", "Alpha Consulting", 100_000)];
    const bankRows = [bank("bank-001", "2026-06-10", "Beta Logistics", 200_000)];

    const res = reconcile(erpRows, bankRows);
    expect(res.candidatePairs).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Nearest-miss helper.                                                        */
/* -------------------------------------------------------------------------- */

describe("nearestMiss", () => {
  it("picks the closest counterpart by amount", () => {
    const target = { id: "erp-001", amountCents: 100_000, description: "Acme Cloud", date: "2026-06-10" };
    const pool = [
      { id: "bank-001", amountCents: 130_000, description: "Something Else", date: "2026-06-10" },
      { id: "bank-002", amountCents: 100_500, description: "Acme Cloud", date: "2026-06-12" },
    ];
    const miss = nearestMiss(target, pool);
    expect(miss?.id).toBe("bank-002");
    expect(miss?.amountDiffCents).toBe(-500);
  });

  it("returns null for an empty pool", () => {
    const target = { id: "erp-001", amountCents: 100_000, description: "x", date: "2026-06-10" };
    expect(nearestMiss(target, [])).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* AP — vendor normalization.                                                  */
/* -------------------------------------------------------------------------- */

describe("normalizeVendor", () => {
  it("lowercases, strips punctuation, and drops entity suffixes", () => {
    expect(normalizeVendor("Acme Cloud Services, Inc.")).toBe("acme cloud services");
    expect(normalizeVendor("Globex LLC")).toBe("globex");
    expect(normalizeVendor("Meridian Supply Co.")).toBe("meridian supply");
  });
});

/* -------------------------------------------------------------------------- */
/* AP — 2% tolerance boundary.                                                 */
/* -------------------------------------------------------------------------- */

describe("withinTolerance — 2% boundary", () => {
  it("accepts exactly 2% and rejects just over", () => {
    expect(withinTolerance(980_000, 1_000_000, 0.02)).toBe(true); // exactly 2%
    expect(withinTolerance(979_900, 1_000_000, 0.02)).toBe(false); // just over 2%
  });
});

describe("matchAp — 2% tolerance in the matcher", () => {
  const pos = [po("po-001", "Acme Cloud Services Inc", "cloud hosting subscription", 1_000_000, "2026-06-01")];

  it("uses the PO base for overages and never rounds a fractional cent upward", () => {
    expect(withinPoTolerance(10200, 10000, 0.02)).toBe(true);
    expect(withinPoTolerance(10201, 10000, 0.02)).toBe(false);
    expect(withinPoTolerance(10204, 10000, 0.02)).toBe(false);
    expect(poToleranceAllowanceCents(99, 0.02)).toBe(1);
    expect(withinPoTolerance(101, 99, 0.02)).toBe(false);
    expect(poToleranceAllowanceCents(100000000, 1e-8)).toBe(1);
    expect(withinPoTolerance(0, 100, 0.02)).toBe(false);
    expect(withinPoTolerance(-100, 100, 0.02)).toBe(false);
    expect(poToleranceAllowanceCents(100, Number.NaN)).toBeNull();
  });

  it("matches an invoice at exactly 2% variance (with line-item overlap)", () => {
    const invoices = [
      invoice("inv-001", "Acme Cloud Services, Inc.", "cloud hosting subscription", 980_000, "2026-06-05"),
    ];
    const res = matchAp(invoices, pos);
    expect(res.matchedPairs).toHaveLength(1);
    expect(res.matchedPairs[0]).toMatchObject({ invoiceId: "inv-001", poId: "po-001" });
    expect(res.unmatchedInvoices).toHaveLength(0);
  });

  it("does NOT match an invoice at 8% variance; it becomes a candidate", () => {
    const invoices = [
      invoice("inv-001", "Acme Cloud Services, Inc.", "cloud hosting subscription", 1_080_000, "2026-06-05"),
    ];
    const res = matchAp(invoices, pos);
    expect(res.matchedPairs).toHaveLength(0);
    // vendor Jaccard is high (≥0.6) → surfaced as a candidate for Claude.
    expect(res.candidatePairs).toHaveLength(1);
    expect(res.candidatePairs[0].amountWithinTolerance).toBe(false);
    expect(res.unmatchedInvoices.map((i) => i.id)).toEqual(["inv-001"]);
  });

  it("does not match when line-item Jaccard is below 0.3 despite vendor+amount agreement", () => {
    const invoices = [
      invoice("inv-001", "Acme Cloud Services, Inc.", "office furniture delivery", 1_000_000, "2026-06-05"),
    ];
    const res = matchAp(invoices, pos);
    expect(res.matchedPairs).toHaveLength(0);
    // amount within 2% → still a candidate.
    expect(res.candidatePairs).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* AP — duplicate invoice detection.                                           */
/* -------------------------------------------------------------------------- */

describe("detectDuplicateInvoices", () => {
  it("keeps the first source occurrence when dates are out of order", () => {
    const invoices = [
      invoice("a", "Acme", "Services", 100, "2026-02-01"),
      invoice("b", "Acme", "Services", 100, "2026-01-05"),
      invoice("c", "Acme", "Services", 100, "2026-01-20"),
    ];
    expect(detectDuplicateInvoices(invoices)).toEqual([{ id: "b", duplicateOf: "a" }, { id: "c", duplicateOf: "a" }]);
  });
  it("flags same-vendor invoice-number resubmissions across different dates and amounts", () => {
    const original = invoice("inv-001", "Acme Inc", "cloud hosting", 500000, "2026-01-01");
    original.invoiceNumber = "INV-100";
    const repeated = { ...original, id: "inv-002", invoiceNumber: " inv 100 ", invoiceDate: "2026-06-01", amountCents: 700000 };
    expect(detectDuplicateInvoices([original, repeated])).toEqual([{ id: "inv-002", duplicateOf: "inv-001" }]);
    expect(detectDuplicateInvoices([original, { ...repeated, vendorName: "Different vendor" }])).toEqual([]);
  });
  it("flags same vendor+amount within 30 days as a duplicate of the first", () => {
    const invoices = [
      invoice("inv-001", "Acme Inc", "cloud hosting", 500_000, "2026-06-01"),
      invoice("inv-002", "Acme, Inc.", "cloud hosting", 500_000, "2026-06-13"), // 12 days later
    ];
    const dups = detectDuplicateInvoices(invoices);
    expect(dups).toEqual([{ id: "inv-002", duplicateOf: "inv-001" }]);
  });

  it("does not flag same vendor+amount more than 30 days apart", () => {
    const invoices = [
      invoice("inv-001", "Acme Inc", "cloud hosting", 500_000, "2026-06-01"),
      invoice("inv-002", "Acme Inc", "cloud hosting", 500_000, "2026-08-01"), // 61 days later
    ];
    expect(detectDuplicateInvoices(invoices)).toEqual([]);
  });

  it("does not flag different amounts as duplicates", () => {
    const invoices = [
      invoice("inv-001", "Acme Inc", "cloud hosting", 500_000, "2026-06-01"),
      invoice("inv-002", "Acme Inc", "cloud hosting", 500_100, "2026-06-05"),
    ];
    expect(detectDuplicateInvoices(invoices)).toEqual([]);
  });
});

describe("bounded matching workload", () => {
  it("rejects oversized jobs before enumerating candidate pairs", () => {
    const size = Math.ceil(Math.sqrt(MAX_MATCH_ROW_PAIRS)) + 1;
    expect(() => reconcile(new Array(size), new Array(size))).toThrow(/row-pair limit/);
    expect(() => matchAp(new Array(size), new Array(size))).toThrow(/row-pair limit/);
  });
});
