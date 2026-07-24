/**
 * Deterministic demo-data generator (PLAN §13).
 *
 * Writes the six source CSVs plus `demo-data/expected-results.json` (the acceptance
 * oracle) into `demo-data/`. Fully deterministic: a fixed-seed mulberry32 PRNG only
 * decorates values (amounts, vendor choices, small date offsets) — the *planted
 * anomalies* are fixed by construction. The script recomputes and ASSERTS every planted
 * expectation before writing a single file, so if the data ever drifts it fails loudly.
 *
 * Money is integer cents everywhere internally (D7); CSVs hold dollar strings, which the
 * parser will convert back to cents. Row IDs (`erp-001…`) are assigned in file order
 * (D8) for internal assertion clarity — they mirror what the parser will produce.
 *
 * Run: `npm run demo-data` (tsx scripts/generate-demo-data.ts)
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ActualsLine,
  BankTxn,
  BudgetLine,
  ErpTxn,
  Invoice,
  PurchaseOrder,
} from "@/lib/types";

/* -------------------------------------------------------------------------- */
/* Deterministic PRNG — mulberry32 (no unseeded Math.random anywhere).        */
/* -------------------------------------------------------------------------- */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 0x5eed_c0de;
const rng = mulberry32(SEED);

/** Integer in [min, max]. */
function randInt(min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}
/** Pick one element deterministically. */
function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

/* -------------------------------------------------------------------------- */
/* Date helpers — everything anchored in June 2026 (UTC).                     */
/* -------------------------------------------------------------------------- */

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function juneDay(day: number): Date {
  // day may exceed 30; JS normalizes into July.
  return new Date(Date.UTC(2026, 5, day));
}
function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}
function daysBetween(a: string, b: string): number {
  return Math.round(
    (new Date(b + "T00:00:00Z").getTime() - new Date(a + "T00:00:00Z").getTime()) /
      86_400_000,
  );
}

/* -------------------------------------------------------------------------- */
/* Money helpers (cents ↔ dollar strings).                                    */
/* -------------------------------------------------------------------------- */

function dollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** A pool guaranteeing globally-unique amounts where the recon/AP logic needs them. */
const usedAmounts = new Set<number>();
function uniqueAmountCents(minDollars: number, maxDollars: number): number {
  for (;;) {
    // land on a "cents-y" value (…99, …00, …50) for realism, then jitter.
    const whole = randInt(minDollars, maxDollars);
    const frac = pick([0, 25, 50, 75, 99]);
    const cents = whole * 100 + frac;
    if (!usedAmounts.has(cents)) {
      usedAmounts.add(cents);
      return cents;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Description normalization (mirrors §7 matcher tokenization) — used only to  */
/* ASSERT that clean pairs will exact-match (Jaccard ≥ 0.5).                    */
/* -------------------------------------------------------------------------- */

const STOPWORDS = new Set(["payment", "to", "from", "the", "inc", "llc", "corp", "co"]);
function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 0 && !STOPWORDS.has(t)),
  );
}
function jaccard(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = new Set([...ta, ...tb]).size;
  return union === 0 ? 1 : inter / union;
}

/* -------------------------------------------------------------------------- */
/* Vocab.                                                                     */
/* -------------------------------------------------------------------------- */

const VENDORS = [
  "Meridian Supply Co",
  "Acme Industrial LLC",
  "Blue Ridge Logistics Inc",
  "Cardinal Office Supplies",
  "Northwind Traders LLC",
  "Summit Consulting Group",
  "Vertex Materials Inc",
  "Pioneer Freight Corp",
  "Evergreen Facilities Co",
  "Cascade Print Services",
  "Ironclad Security LLC",
  "Harbor Point Catering",
  "Redwood Analytics Inc",
  "Granite Peak Hardware",
  "Silverline Telecom Corp",
  "Copperfield Legal LLP",
  "Tidewater Shipping Co",
  "Lakeside Maintenance LLC",
  "Brightway Marketing Inc",
  "Stonebridge Insurance Co",
] as const;

const SAAS = [
  "AWS",
  "GitHub",
  "Slack",
  "Datadog",
  "Figma",
  "Notion",
  "Salesforce",
  "Zoom",
  "Adobe Creative Cloud",
  "Atlassian",
  "Snowflake",
  "Twilio",
] as const;

/* -------------------------------------------------------------------------- */
/* CSV writer.                                                                */
/* -------------------------------------------------------------------------- */

function csvField(v: string): string {
  if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}
function toCsv(headers: string[], rows: Record<string, string>[]): string {
  const lines = [headers.join(",")];
  for (const r of rows) lines.push(headers.map((h) => csvField(r[h] ?? "")).join(","));
  return lines.join("\n") + "\n";
}

/* ========================================================================== */
/* RECONCILIATION                                                             */
/* ========================================================================== */

interface ErpInternal extends ErpTxn {}
interface BankInternal extends BankTxn {}

const erp: ErpInternal[] = [];
const bank: BankInternal[] = [];

let erpRef = 4000;
let bankTxnSeq = 80000;
function nextErpRef(): string {
  return `ERP-2026-${(++erpRef).toString().padStart(5, "0")}`;
}
function nextBankTxnId(): string {
  return `TXN${(++bankTxnSeq).toString()}`;
}

/** Build an ERP description + a near-identical bank counterpart description. */
function reconDescPair(): { erpDesc: string; bankDesc: string } {
  const kind = randInt(0, 2);
  if (kind === 0) {
    const v = pick(VENDORS);
    const erpDesc = `Vendor payment - ${v}`;
    // bank often prefixes the clearing rail; keeps Jaccard high.
    const bankDesc = rng() < 0.5 ? `ACH Vendor payment ${v}` : `Vendor payment ${v}`;
    return { erpDesc, bankDesc };
  }
  if (kind === 1) {
    const cycle = pick([1, 2]);
    const erpDesc = `Payroll - June 2026 Cycle ${cycle}`;
    const bankDesc = `ACH Payroll June 2026 Cycle ${cycle}`;
    return { erpDesc, bankDesc };
  }
  const s = pick(SAAS);
  const erpDesc = `${s} subscription`;
  const bankDesc = rng() < 0.5 ? `${s} Inc subscription` : `${s} subscription renewal`;
  return { erpDesc, bankDesc };
}

// Collect (erp,bank) pairs before sorting into file order.
interface Pair {
  erp: ErpInternal;
  bank: BankInternal | null; // null => ERP-only
}
const pairs: Pair[] = [];
const extraBank: BankInternal[] = []; // duplicate + bank-only

// Fee-mismatch amounts are fixed by spec; reserve them up front so no random draw
// (clean/timing/only) can collide with them and break amount-uniqueness invariants.
const FEE_ERP_CENTS = 1_250_000; // $12,500.00
const FEE_BANK_CENTS = 1_248_500; // $12,485.00
usedAmounts.add(FEE_ERP_CENTS);
usedAmounts.add(FEE_BANK_CENTS);

// --- 44 clean pairs: identical amount, bank date = erp +0..2, near-identical desc.
for (let i = 0; i < 44; i++) {
  const amount = uniqueAmountCents(500, 85_000);
  const eDate = juneDay(randInt(1, 26));
  const bDate = addDays(eDate, randInt(0, 2));
  const { erpDesc, bankDesc } = reconDescPair();
  const e: ErpInternal = {
    id: "",
    date: iso(eDate),
    description: erpDesc,
    amountCents: amount,
    referenceNumber: nextErpRef(),
  };
  const b: BankInternal = {
    id: "",
    date: iso(bDate),
    description: bankDesc,
    amountCents: amount,
    transactionId: nextBankTxnId(),
  };
  pairs.push({ erp: e, bank: b });
}

// --- 2 timing differences: identical amount + description, bank date = erp +5..6.
for (let i = 0; i < 2; i++) {
  const amount = uniqueAmountCents(3_000, 40_000);
  const eDate = juneDay(randInt(1, 20));
  const bDate = addDays(eDate, randInt(5, 6));
  const v = pick(VENDORS);
  const desc = `Vendor payment - ${v}`;
  pairs.push({
    erp: {
      id: "",
      date: iso(eDate),
      description: desc,
      amountCents: amount,
      referenceNumber: nextErpRef(),
    },
    bank: {
      id: "",
      date: iso(bDate),
      description: desc,
      amountCents: amount,
      transactionId: nextBankTxnId(),
    },
  });
}

// --- 1 fee mismatch: Meridian Supply Co, same date, ERP $12,500.00 vs bank $12,485.00.
{
  const d = iso(juneDay(randInt(1, 26)));
  const desc = "Wire transfer — Meridian Supply Co";
  pairs.push({
    erp: {
      id: "",
      date: d,
      description: desc,
      amountCents: FEE_ERP_CENTS,
      referenceNumber: nextErpRef(),
    },
    bank: {
      id: "",
      date: d,
      description: desc,
      amountCents: FEE_BANK_CENTS,
      transactionId: nextBankTxnId(),
    },
  });
}

// --- 3 ERP-only rows (missing from bank). Unique amounts → never match.
const erpOnlyCents: number[] = [];
for (let i = 0; i < 3; i++) {
  const amount = uniqueAmountCents(1_000, 60_000);
  erpOnlyCents.push(amount);
  const v = pick(VENDORS);
  pairs.push({
    erp: {
      id: "",
      date: iso(juneDay(randInt(20, 28))),
      description: `Vendor payment - ${v}`,
      amountCents: amount,
      referenceNumber: nextErpRef(),
    },
    bank: null,
  });
}

// --- Bank side extras: 1 exact duplicate of a clean bank row + 2 bank-only rows.
// choose a clean pair whose bank row we duplicate exactly (same amount+date+desc+txn id).
const dupSource = pairs[7].bank!;
const duplicateBank: BankInternal = {
  id: "",
  date: dupSource.date,
  description: dupSource.description,
  amountCents: dupSource.amountCents,
  transactionId: dupSource.transactionId,
};
extraBank.push(duplicateBank);

const bankOnlyCents: number[] = [];
for (let i = 0; i < 2; i++) {
  const amount = uniqueAmountCents(1_000, 55_000);
  bankOnlyCents.push(amount);
  const v = pick(VENDORS);
  extraBank.push({
    id: "",
    date: iso(juneDay(randInt(2, 27))),
    description: rng() < 0.5 ? `ACH ${v} refund` : `POS ${v} adjustment`,
    amountCents: amount,
    transactionId: nextBankTxnId(),
  });
}

// Assemble ERP file (all erp rows) and bank file (counterparts + extras), date-sorted.
for (const p of pairs) erp.push(p.erp);
for (const p of pairs) if (p.bank) bank.push(p.bank);
for (const b of extraBank) bank.push(b);

function byDate<T extends { date: string; description: string }>(a: T, b: T): number {
  return a.date < b.date ? -1 : a.date > b.date ? 1 : a.description < b.description ? -1 : 1;
}
erp.sort(byDate);
bank.sort(byDate);

// Assign file-order synthetic IDs (D8).
erp.forEach((r, i) => (r.id = `erp-${(i + 1).toString().padStart(3, "0")}`));
bank.forEach((r, i) => (r.id = `bank-${(i + 1).toString().padStart(3, "0")}`));

/* ========================================================================== */
/* AP MATCHING                                                                */
/* ========================================================================== */

const AP_VENDOR_SUFFIX_ALT: Record<string, string> = {
  Inc: "LLC",
  LLC: "Inc",
  Corp: "Co",
  Co: "Corp",
};
function altVendor(v: string): string {
  // swap a trailing legal suffix so the parser/normalizer must strip it to match.
  const m = v.match(/^(.*?)[\s]+(Inc|LLC|Corp|Co)$/);
  if (m && AP_VENDOR_SUFFIX_ALT[m[2]]) return `${m[1]} ${AP_VENDOR_SUFFIX_ALT[m[2]]}`;
  return v;
}

const LINE_ITEMS = [
  { po: "Q2 raw materials restock", inv: "Raw materials Q2 restock order" },
  { po: "Office furniture — workstations", inv: "Workstations office furniture" },
  { po: "Managed cloud hosting", inv: "Cloud hosting managed services" },
  { po: "Consulting services engagement", inv: "Engagement consulting services" },
  { po: "Freight and logistics", inv: "Logistics and freight charges" },
  { po: "Marketing campaign production", inv: "Campaign production marketing" },
  { po: "Facility maintenance contract", inv: "Maintenance facility contract" },
  { po: "Security services monthly", inv: "Monthly security services" },
  { po: "Legal advisory retainer", inv: "Retainer legal advisory" },
  { po: "Telecom circuits", inv: "Circuits telecom services" },
  { po: "Printing and binding", inv: "Binding and printing job" },
  { po: "Catering — quarterly offsite", inv: "Quarterly offsite catering" },
  { po: "Analytics platform license", inv: "License analytics platform" },
  { po: "Hardware tools bulk order", inv: "Bulk hardware tools order" },
  { po: "Insurance premium — property", inv: "Property insurance premium" },
] as const;

const APPROVERS = ["M. Chen", "S. Patel", "J. Okafor", "R. Alvarez", "T. Nguyen"] as const;

const pos: PurchaseOrder[] = [];
const invoices: Invoice[] = [];

let poSeq = 5100;
let invSeq = 9200;
function nextPoNumber() {
  return `PO-2026-${(++poSeq).toString()}`;
}
function nextInvNumber() {
  return `INV-2026-${(++invSeq).toString()}`;
}

// 15 clean matched pairs (invoice within 2% of PO). #15 is exactly 1.9%. #1 is the
// "original" of the duplicate pair. All auto-approve (no other flags).
interface CleanSpec {
  vendor: string;
  li: (typeof LINE_ITEMS)[number];
  poCents: number;
  invCents: number;
}
const cleanSpecs: CleanSpec[] = [];
for (let i = 0; i < 15; i++) {
  const vendor = VENDORS[i];
  const li = LINE_ITEMS[i];
  let poCents: number;
  let invCents: number;
  if (i === 14) {
    // exactly 1.9% variance.
    poCents = 5_000_000;
    invCents = 5_095_000; // diff 95,000 / 5,000,000 = 0.019 exactly
  } else {
    poCents = uniqueAmountCents(6_000, 120_000);
    invCents = poCents; // exact match, 0% variance
  }
  cleanSpecs.push({ vendor, li, poCents, invCents });
}

// Build the 15 clean POs + invoices.
const poIssueBase = juneDay(2);
cleanSpecs.forEach((spec, i) => {
  const issued = iso(addDays(poIssueBase, i));
  const invDate = juneDay(randInt(6, 24));
  pos.push({
    id: "",
    poNumber: nextPoNumber(),
    vendorName: spec.vendor,
    lineItem: spec.li.po,
    amountCents: spec.poCents,
    issuedDate: issued,
    approvedBy: pick(APPROVERS),
  });
  invoices.push({
    id: "",
    invoiceNumber: nextInvNumber(),
    vendorName: altVendor(spec.vendor), // suffix swap to exercise normalization
    lineItem: spec.li.inv,
    amountCents: spec.invCents,
    invoiceDate: iso(invDate),
    dueDate: iso(addDays(invDate, 60)), // net-60 → never past due vs 2026-07-23
  });
});

// Duplicate invoice: same vendor + amount as clean #1, invoice_date 12 days later.
const dupOriginal = invoices[0];
const dupOriginalDate = new Date(dupOriginal.invoiceDate + "T00:00:00Z");
const dupInvDate = iso(addDays(dupOriginalDate, 12));
invoices.push({
  id: "",
  invoiceNumber: nextInvNumber(),
  vendorName: dupOriginal.vendorName,
  lineItem: dupOriginal.lineItem,
  amountCents: dupOriginal.amountCents,
  invoiceDate: dupInvDate,
  dueDate: iso(addDays(new Date(dupInvDate + "T00:00:00Z"), 60)),
});

// 1 matched invoice at exactly 8% variance (has PO; amount_variance → hold).
{
  const vendor = VENDORS[15];
  const li = LINE_ITEMS[0];
  const poCents = 4_000_000;
  const invCents = 4_320_000; // 320,000 / 4,000,000 = 0.08 exactly
  usedAmounts.add(poCents);
  usedAmounts.add(invCents);
  const invDate = juneDay(randInt(6, 24));
  pos.push({
    id: "",
    poNumber: nextPoNumber(),
    vendorName: vendor,
    lineItem: li.po,
    amountCents: poCents,
    issuedDate: iso(addDays(poIssueBase, 15)),
    approvedBy: pick(APPROVERS),
  });
  invoices.push({
    id: "",
    invoiceNumber: nextInvNumber(),
    vendorName: altVendor(vendor),
    lineItem: li.inv,
    amountCents: invCents,
    invoiceDate: iso(invDate),
    dueDate: iso(addDays(invDate, 60)),
  });
}

// 3 invoices with no PO (vendors absent from the PO set → no_matching_po → hold).
const NO_PO_VENDORS = ["Quantum Robotics Inc", "Halcyon Media LLC", "Titan Steelworks Co"];
for (let i = 0; i < 3; i++) {
  const invDate = juneDay(randInt(6, 24));
  invoices.push({
    id: "",
    invoiceNumber: nextInvNumber(),
    vendorName: NO_PO_VENDORS[i],
    lineItem: pick(LINE_ITEMS).inv,
    amountCents: uniqueAmountCents(7_000, 90_000),
    invoiceDate: iso(invDate),
    dueDate: iso(addDays(invDate, 60)),
  });
}

// 2 extra open POs (no invoice) → 16 matched POs + 2 open = 18.
for (let i = 0; i < 2; i++) {
  const vendor = VENDORS[16 + i];
  pos.push({
    id: "",
    poNumber: nextPoNumber(),
    vendorName: vendor,
    lineItem: pick(LINE_ITEMS).po,
    amountCents: uniqueAmountCents(8_000, 110_000),
    issuedDate: iso(addDays(poIssueBase, 16 + i)),
    approvedBy: pick(APPROVERS),
  });
}

// File-order IDs (D8).
pos.sort((a, b) => (a.issuedDate < b.issuedDate ? -1 : a.issuedDate > b.issuedDate ? 1 : 0));
invoices.sort((a, b) =>
  a.invoiceDate < b.invoiceDate ? -1 : a.invoiceDate > b.invoiceDate ? 1 : 0,
);
pos.forEach((r, i) => (r.id = `po-${(i + 1).toString().padStart(3, "0")}`));
invoices.forEach((r, i) => (r.id = `inv-${(i + 1).toString().padStart(3, "0")}`));

/* ========================================================================== */
/* FP&A                                                                       */
/* ========================================================================== */

const DEPARTMENTS = [
  "R&D",
  "Marketing",
  "Operations",
  "Sales",
  "Finance",
  "Human Resources",
  "Customer Success",
  "IT",
] as const;
const CATEGORIES = [
  "Payroll",
  "Advertising",
  "Cloud Infrastructure",
  "Travel",
  "Software Licenses",
  "Professional Services",
] as const;
const PERIOD = "2026-06";

// Material variances (dept, category) → varianceCents (actual − budget).
const MATERIAL: Record<string, number> = {
  "R&D|Payroll": +15_000_000, // +$150,000 over
  "Marketing|Advertising": -8_000_000, // −$80,000 under
  "Operations|Cloud Infrastructure": +4_500_000, // +$45,000 over
};
// Fixed, realistic budgets for the material lines (so the under-budget case never
// drives actuals to zero, and the over cases read as sensible % swings).
const MATERIAL_BUDGET: Record<string, number> = {
  "R&D|Payroll": 60_000_000, // $600,000 budget → $750,000 actual (+25%)
  "Marketing|Advertising": 50_000_000, // $500,000 budget → $420,000 actual (−16%)
  "Operations|Cloud Infrastructure": 25_000_000, // $250,000 → $295,000 (+18%)
};

const budget: BudgetLine[] = [];
const actuals: ActualsLine[] = [];

for (const dept of DEPARTMENTS) {
  for (const cat of CATEGORIES) {
    const key = `${dept}|${cat}`;
    const budgetedCents =
      key in MATERIAL_BUDGET ? MATERIAL_BUDGET[key] : randInt(80_000, 550_000) * 100; // $80k–$550k
    let actualCents: number;
    if (key in MATERIAL) {
      actualCents = budgetedCents + MATERIAL[key];
    } else {
      // within ±4%; cap absolute so |variance| stays well under the smallest material.
      const pct = (rng() * 2 - 1) * 0.04; // [-0.04, 0.04]
      let delta = Math.round(budgetedCents * pct);
      const cap = 2_000_000; // $20k — comfortably below $45k
      if (delta > cap) delta = cap;
      if (delta < -cap) delta = -cap;
      actualCents = budgetedCents + delta;
    }
    budget.push({
      id: "",
      department: dept,
      category: cat,
      budgetedAmountCents: budgetedCents,
      period: PERIOD,
    });
    actuals.push({
      id: "",
      department: dept,
      category: cat,
      actualAmountCents: actualCents,
      period: PERIOD,
    });
  }
}

/* ========================================================================== */
/* SELF-ASSERTIONS — fail loudly if any planted anomaly has drifted.          */
/* ========================================================================== */

const failures: string[] = [];
function check(cond: boolean, msg: string): void {
  if (!cond) failures.push(msg);
}

// ---- Reconciliation ----
check(erp.length === 50, `ERP rows = ${erp.length}, expected 50`);
check(bank.length === 50, `bank rows = ${bank.length}, expected 50`);

// exact-match candidates: same amount, |dateDiff| ≤ 3, Jaccard ≥ 0.5.
const bankByAmount = new Map<number, BankInternal[]>();
for (const b of bank) {
  const l = bankByAmount.get(b.amountCents) ?? [];
  l.push(b);
  bankByAmount.set(b.amountCents, l);
}
let cleanCount = 0;
let timingCount = 0;
for (const p of pairs) {
  if (!p.bank) continue;
  if (p.erp.amountCents === FEE_ERP_CENTS) continue; // fee handled separately
  const dd = Math.abs(daysBetween(p.erp.date, p.bank.date));
  const jac = jaccard(p.erp.description, p.bank.description);
  if (dd <= 2) {
    check(
      jac >= 0.5,
      `clean pair ${p.erp.referenceNumber} desc Jaccard ${jac.toFixed(2)} < 0.5 (would not exact-match)`,
    );
    cleanCount++;
  } else if (dd >= 5 && dd <= 6) {
    check(jac >= 0.5, `timing pair desc Jaccard ${jac.toFixed(2)} < 0.5`);
    timingCount++;
  } else {
    failures.push(`recon pair ${p.erp.referenceNumber} has unexpected date diff ${dd}`);
  }
}
check(cleanCount === 44, `clean pairs = ${cleanCount}, expected 44`);
check(timingCount === 2, `timing pairs = ${timingCount}, expected 2`);

// fee mismatch
const feeErp = erp.find((e) => e.amountCents === FEE_ERP_CENTS);
const feeBank = bank.find((b) => b.amountCents === FEE_BANK_CENTS);
check(!!feeErp && !!feeBank, "fee-mismatch rows present");
check(
  !!feeErp && feeErp.description === "Wire transfer — Meridian Supply Co",
  "fee ERP description = Wire transfer — Meridian Supply Co",
);
check(FEE_ERP_CENTS - FEE_BANK_CENTS === 1500, "fee difference = 1500 cents ($15.00)");
check(
  !!feeErp && !!feeBank && feeErp.date === feeBank.date,
  "fee mismatch rows share the same date",
);

// ERP-only: 3 ERP rows whose amount appears on no bank row (excluding the fee ERP row,
// whose bank counterpart exists at a fee-adjusted amount).
const erpOnly = erp.filter(
  (e) => e.amountCents !== FEE_ERP_CENTS && !bankByAmount.has(e.amountCents),
);
check(erpOnly.length === 3, `ERP-only rows = ${erpOnly.length}, expected 3`);

// bank-only: 2 bank rows whose amount appears on no ERP row (excluding the fee bank row).
const erpAmounts = new Set(erp.map((e) => e.amountCents));
const bankOnly = bank.filter(
  (b) => b.amountCents !== FEE_BANK_CENTS && !erpAmounts.has(b.amountCents),
);
check(bankOnly.length === 2, `bank-only rows = ${bankOnly.length}, expected 2`);

// duplicate: exactly one (amount+date+description) triple appears twice in the bank set.
const bankTriples = new Map<string, number>();
for (const b of bank) {
  const k = `${b.amountCents}|${b.date}|${b.description}`;
  bankTriples.set(k, (bankTriples.get(k) ?? 0) + 1);
}
const dupGroups = [...bankTriples.values()].filter((n) => n > 1);
check(
  dupGroups.length === 1 && dupGroups[0] === 2,
  `bank duplicate groups = ${JSON.stringify(dupGroups)}, expected exactly one pair`,
);

// net difference (erp total − bank total, excluding the one duplicated bank row).
const erpTotal = erp.reduce((s, e) => s + e.amountCents, 0);
const dupAmount = duplicateBank.amountCents;
const bankTotalExclDup = bank.reduce((s, b) => s + b.amountCents, 0) - dupAmount;
const netDifferenceCents = erpTotal - bankTotalExclDup;
const expectedNet =
  1500 + erpOnlyCents.reduce((a, b) => a + b, 0) - bankOnlyCents.reduce((a, b) => a + b, 0);
check(
  netDifferenceCents === expectedNet,
  `net difference ${netDifferenceCents} ≠ expected ${expectedNet}`,
);

// ---- AP ----
check(pos.length === 18, `PO rows = ${pos.length}, expected 18`);
check(invoices.length === 20, `invoice rows = ${invoices.length}, expected 20`);

function normVendor(v: string): string {
  return v
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\b(inc|llc|corp|co|ltd)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
function jac(a: string, b: string): number {
  return jaccard(a, b);
}

// classify each invoice: matched-within-2% / matched-8% / no-PO / duplicate.
let within2 = 0;
let variance8 = 0;
let noPo = 0;
let dupInvoices = 0;
let edge19 = 0;

// duplicate detection (same normalized vendor + amount, invoice_date within 30 days).
for (let i = 0; i < invoices.length; i++) {
  const inv = invoices[i];
  const isDup = invoices.some(
    (o, j) =>
      j !== i &&
      normVendor(o.vendorName) === normVendor(inv.vendorName) &&
      o.amountCents === inv.amountCents &&
      Math.abs(daysBetween(o.invoiceDate, inv.invoiceDate)) <= 30 &&
      j < i, // count only the later occurrence as the duplicate
  );
  if (isDup) dupInvoices++;
}

for (const inv of invoices) {
  // find a PO with matching normalized vendor + line-item Jaccard ≥ 0.3.
  const candidatePos = pos.filter(
    (p) =>
      normVendor(p.vendorName) === normVendor(inv.vendorName) && jac(p.lineItem, inv.lineItem) >= 0.3,
  );
  if (candidatePos.length === 0) {
    noPo++;
    continue;
  }
  const po = candidatePos[0];
  const pct = Math.abs(inv.amountCents - po.amountCents) / po.amountCents;
  if (pct <= 0.02) {
    within2++;
    if (Math.abs(pct - 0.019) < 1e-9) edge19++;
  } else if (Math.abs(pct - 0.08) < 1e-9) {
    variance8++;
  } else {
    failures.push(`invoice ${inv.invoiceNumber} unexpected variance ${(pct * 100).toFixed(2)}%`);
  }
}

// The duplicate shares vendor+amount with clean #1, so it also matches within 2%; it is
// held for the duplicate flag, not the variance. Net auto-approve = within2 − dupInvoices.
check(within2 === 16, `invoices matched within 2% = ${within2}, expected 16 (15 clean + duplicate)`);
check(dupInvoices === 1, `duplicate invoices = ${dupInvoices}, expected 1`);
check(edge19 === 1, `1.9% edge-case invoices = ${edge19}, expected 1`);
check(variance8 === 1, `8% variance invoices = ${variance8}, expected 1`);
check(noPo === 3, `no-PO invoices = ${noPo}, expected 3`);

const apAutoApprove = within2 - dupInvoices; // 15
const apHold = invoices.length - apAutoApprove; // 5
check(apAutoApprove === 15, `AP auto-approve = ${apAutoApprove}, expected 15`);
check(apHold === 5, `AP hold = ${apHold}, expected 5`);

// no invoice should be past due relative to today (keeps the hold set = exactly 5).
const TODAY = "2026-07-23";
for (const inv of invoices) {
  check(inv.dueDate >= TODAY, `invoice ${inv.invoiceNumber} due ${inv.dueDate} is past due`);
}

// ---- FP&A ----
check(budget.length === 48, `budget rows = ${budget.length}, expected 48`);
check(actuals.length === 48, `actuals rows = ${actuals.length}, expected 48`);

const fpaLines = budget.map((b, i) => {
  const a = actuals[i];
  const variance = a.actualAmountCents - b.budgetedAmountCents;
  return { department: b.department, category: b.category, variance, absVariance: Math.abs(variance) };
});
const ranked = [...fpaLines].sort((x, y) => y.absVariance - x.absVariance);
const top3 = ranked.slice(0, 3).map((l) => `${l.department}|${l.category}`);
check(
  top3.includes("R&D|Payroll") &&
    top3.includes("Marketing|Advertising") &&
    top3.includes("Operations|Cloud Infrastructure"),
  `top-3 |variance| = ${JSON.stringify(top3)}, expected the 3 planted materials`,
);
// each planted material has the exact planted variance
for (const [key, expected] of Object.entries(MATERIAL)) {
  const line = fpaLines.find((l) => `${l.department}|${l.category}` === key);
  check(!!line && line.variance === expected, `${key} variance ${line?.variance} ≠ ${expected}`);
}
// every non-material line strictly smaller than the smallest material (guarantees ranks)
const smallestMaterial = Math.min(...Object.values(MATERIAL).map(Math.abs));
for (const l of fpaLines) {
  const key = `${l.department}|${l.category}`;
  if (!(key in MATERIAL)) {
    check(
      l.absVariance < smallestMaterial,
      `non-material ${key} |variance| ${l.absVariance} ≥ smallest material ${smallestMaterial}`,
    );
  }
}
const netFpaVariance = fpaLines.reduce((s, l) => s + l.variance, 0);
check(netFpaVariance > 0, `FP&A net variance ${netFpaVariance} not > 0 (should be unfavorable)`);

if (failures.length > 0) {
  console.error("Demo-data assertions FAILED:");
  for (const f of failures) console.error("  ✗ " + f);
  process.exit(1);
}

/* ========================================================================== */
/* WRITE FILES                                                                */
/* ========================================================================== */

const OUT_DIR = join(process.cwd(), "demo-data");
mkdirSync(OUT_DIR, { recursive: true });

function write(name: string, content: string): void {
  writeFileSync(join(OUT_DIR, name), content, "utf8");
}

write(
  "erp_export_demo.csv",
  toCsv(
    ["date", "description", "amount", "reference_number"],
    erp.map((e) => ({
      date: e.date,
      description: e.description,
      amount: dollars(e.amountCents),
      reference_number: e.referenceNumber,
    })),
  ),
);

write(
  "bank_statement_demo.csv",
  toCsv(
    ["date", "description", "amount", "transaction_id"],
    bank.map((b) => ({
      date: b.date,
      description: b.description,
      amount: dollars(b.amountCents),
      transaction_id: b.transactionId,
    })),
  ),
);

write(
  "purchase_orders_demo.csv",
  toCsv(
    ["po_number", "vendor_name", "line_item", "amount", "issued_date", "approved_by"],
    pos.map((p) => ({
      po_number: p.poNumber,
      vendor_name: p.vendorName,
      line_item: p.lineItem,
      amount: dollars(p.amountCents),
      issued_date: p.issuedDate,
      approved_by: p.approvedBy,
    })),
  ),
);

write(
  "invoices_demo.csv",
  toCsv(
    ["invoice_number", "vendor_name", "line_item", "amount", "invoice_date", "due_date"],
    invoices.map((inv) => ({
      invoice_number: inv.invoiceNumber,
      vendor_name: inv.vendorName,
      line_item: inv.lineItem,
      amount: dollars(inv.amountCents),
      invoice_date: inv.invoiceDate,
      due_date: inv.dueDate,
    })),
  ),
);

write(
  "budget_demo.csv",
  toCsv(
    ["department", "category", "budgeted_amount", "period"],
    budget.map((b) => ({
      department: b.department,
      category: b.category,
      budgeted_amount: dollars(b.budgetedAmountCents),
      period: b.period,
    })),
  ),
);

write(
  "actuals_demo.csv",
  toCsv(
    ["department", "category", "actual_amount", "period"],
    actuals.map((a) => ({
      department: a.department,
      category: a.category,
      actual_amount: dollars(a.actualAmountCents),
      period: a.period,
    })),
  ),
);

/* expected-results.json — the acceptance oracle (§13 counts). */
const expected = {
  generatedBy: "scripts/generate-demo-data.ts",
  seed: SEED,
  reconciliation: {
    files: { erp_export_demo: 50, bank_statement_demo: 50 },
    exactMatches: 44,
    flags: {
      timing_difference: 2,
      amount_mismatch: 1,
      missing_from_bank: 3,
      missing_from_erp: 2,
      duplicate: 1,
    },
    feeMismatch: {
      description: "Wire transfer — Meridian Supply Co",
      erpCents: FEE_ERP_CENTS,
      bankCents: FEE_BANK_CENTS,
      differenceCents: FEE_ERP_CENTS - FEE_BANK_CENTS,
    },
    netDifferenceCents,
    status: "EXCEPTIONS_FOUND",
  },
  ap: {
    files: { purchase_orders_demo: 18, invoices_demo: 20 },
    autoApprove: 15,
    holdForReview: 5,
    holdBreakdown: { no_matching_po: 3, amount_variance: 1, duplicate_invoice: 1 },
    edgeCaseVariancePct: 1.9,
    variancePctOf8: 8.0,
  },
  fpa: {
    files: { budget_demo: 48, actuals_demo: 48 },
    period: PERIOD,
    materialVariances: [
      { department: "R&D", category: "Payroll", varianceCents: MATERIAL["R&D|Payroll"], rank: 1 },
      {
        department: "Marketing",
        category: "Advertising",
        varianceCents: MATERIAL["Marketing|Advertising"],
        rank: 2,
      },
      {
        department: "Operations",
        category: "Cloud Infrastructure",
        varianceCents: MATERIAL["Operations|Cloud Infrastructure"],
        rank: 3,
      },
    ],
    netVarianceCents: netFpaVariance,
    overallStatus: "unfavorable",
  },
};

write("expected-results.json", JSON.stringify(expected, null, 2) + "\n");

console.log("Demo data generated (all assertions passed):");
console.log(`  erp_export_demo.csv       ${erp.length} rows`);
console.log(`  bank_statement_demo.csv   ${bank.length} rows`);
console.log(`  purchase_orders_demo.csv  ${pos.length} rows`);
console.log(`  invoices_demo.csv         ${invoices.length} rows`);
console.log(`  budget_demo.csv           ${budget.length} rows`);
console.log(`  actuals_demo.csv          ${actuals.length} rows`);
console.log(`  expected-results.json     (acceptance oracle)`);
