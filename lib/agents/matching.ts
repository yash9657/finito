/**
 * Deterministic matching algorithms (PLAN §7 step 3, §8 step 3, D3/D7/D8).
 *
 * These are PURE functions — no I/O, no Claude, no DB. The auditable, reproducible
 * first pass of the hybrid matcher (D3): exact-rule matches, duplicate detection, and
 * candidate-pair generation. Claude only adjudicates the residual candidate pairs; the
 * arithmetic here is never trusted to an LLM.
 *
 * Money is integer cents everywhere (D7). Row IDs are the stable synthetic ids assigned
 * at parse time (D8): `erp-001`, `bank-001`, `inv-001`, `po-001`.
 */

import type {
  ErpTxn,
  BankTxn,
  Invoice,
  PurchaseOrder,
  MatchedPair,
  DuplicateBankTxn,
} from "@/lib/types";

/* -------------------------------------------------------------------------- */
/* Shared tokenization + Jaccard similarity (used by recon and AP).            */
/* -------------------------------------------------------------------------- */

/** Reconciliation description stopwords (§7 step 1) — removed before Jaccard. */
export const RECON_STOPWORDS: ReadonlySet<string> = new Set([
  "payment",
  "to",
  "from",
  "the",
  "inc",
  "llc",
  "corp",
  "co",
]);

/** Vendor-name suffixes stripped during AP vendor normalization (§8 step 3). */
export const VENDOR_SUFFIXES: ReadonlySet<string> = new Set([
  "inc",
  "llc",
  "corp",
  "co",
  "ltd",
]);

/**
 * Split text into a lowercased word set, dropping punctuation, empties, and any
 * stopwords. The set (not a bag) is what Jaccard operates on.
 */
export function tokenize(
  text: string,
  stopwords: ReadonlySet<string> = new Set<string>(),
): Set<string> {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0 && !stopwords.has(t));
  return new Set(tokens);
}

/** Jaccard similarity of two token sets: |A∩B| / |A∪B|. Empty∪Empty ⇒ 0. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/* -------------------------------------------------------------------------- */
/* Small numeric/date helpers.                                                 */
/* -------------------------------------------------------------------------- */

/** Whole calendar days between two ISO (`YYYY-MM-DD`) dates, always ≥ 0. */
export function daysBetween(a: string, b: string): number {
  const da = Date.parse(`${a}T00:00:00Z`);
  const db = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(da) || Number.isNaN(db)) return Number.POSITIVE_INFINITY;
  return Math.round(Math.abs(da - db) / 86_400_000);
}

/** True when |a − b| ≤ tol · max(|a|, |b|). Boundary (exactly tol) counts as within. */
export function withinTolerance(a: number, b: number, tol: number): boolean {
  const larger = Math.max(Math.abs(a), Math.abs(b));
  if (larger === 0) return a === b;
  return Math.abs(a - b) <= tol * larger;
}

/** Exact whole-cent allowance, using the PO as the base; never round up a fraction of a cent. */
export function poToleranceAllowanceCents(poAmountCents: number, fraction: number): number | null {
  if (!Number.isSafeInteger(poAmountCents) || poAmountCents <= 0 || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) return null;
  const [coefficient, exponentText = "0"] = fraction.toString().split("e");
  const [whole, decimals = ""] = coefficient.split(".");
  const digits = BigInt(whole + decimals);
  const scale = decimals.length - Number(exponentText);
  const numerator = scale < 0 ? digits * BigInt(10) ** BigInt(-scale) : digits;
  const denominator = scale > 0 ? BigInt(10) ** BigInt(scale) : BigInt(1);
  return Number(BigInt(poAmountCents) * numerator / denominator);
}

/** Symmetric review band around a positive approved PO; its base never shifts with the invoice. */
export function withinPoTolerance(invoiceAmountCents: number, poAmountCents: number, fraction: number): boolean {
  if (!Number.isSafeInteger(invoiceAmountCents) || invoiceAmountCents <= 0) return false;
  const allowance = poToleranceAllowanceCents(poAmountCents, fraction);
  return allowance !== null && Math.abs(invoiceAmountCents - poAmountCents) <= allowance;
}

/* -------------------------------------------------------------------------- */
/* Reconciliation — deterministic pass (§7 step 3).                            */
/* -------------------------------------------------------------------------- */

// The current matcher enumerates pairs in memory. Reject unsupported jobs before
// allocating pair arrays or spending model tokens; indexed matching is a separate capability.
export const MAX_MATCH_ROW_PAIRS = 2_000_000;

function assertMatchingWorkload(left: number, right: number): void {
  if (left * right > MAX_MATCH_ROW_PAIRS) {
    throw new Error(`Matching exceeds the supported ${MAX_MATCH_ROW_PAIRS.toLocaleString("en-US")} row-pair limit. Split both source files into aligned periods, accounts or entities and retry.`);
  }
}

/** An ERP↔bank pair the deterministic matcher flags for Claude adjudication. */
export interface ReconCandidatePair {
  erpId: string;
  bankId: string;
  /** erp − bank (cents). */
  amountDiffCents: number;
  daysDiff: number;
  descriptionJaccard: number;
  reason: string;
}

/** Result of the deterministic reconciliation pass, before LLM adjudication. */
export interface ReconMatchPass {
  /** One-to-one exact matches (confidence `exact`). */
  matchedPairs: MatchedPair[];
  /** Residual pairs handed to Claude. */
  candidatePairs: ReconCandidatePair[];
  /** ERP rows with no exact match. */
  unmatchedErp: ErpTxn[];
  /** Non-duplicate bank rows with no exact match. */
  unmatchedBank: BankTxn[];
  /** Duplicate bank rows (excluded from matching, §15). */
  duplicates: DuplicateBankTxn[];
}

/**
 * Exclude repeat imports only when source transaction identity AND monetary details
 * agree. Identical same-day amounts/descriptions can be separate real payments; absent
 * or distinct transaction IDs must not cause cash movements to disappear from totals.
 */
export function detectBankDuplicates(bank: BankTxn[]): {
  duplicates: DuplicateBankTxn[];
  unique: BankTxn[];
} {
  const firstSeen = new Map<string, string>();
  const duplicates: DuplicateBankTxn[] = [];
  const unique: BankTxn[] = [];
  for (const b of bank) {
    const transactionId = b.transactionId.trim();
    if (!transactionId) {
      unique.push(b);
      continue;
    }
    const key = JSON.stringify([transactionId, b.amountCents, b.date, b.description.trim().toLowerCase()]);
    const first = firstSeen.get(key);
    if (first === undefined) {
      firstSeen.set(key, b.id);
      unique.push(b);
    } else {
      duplicates.push({ ...b, duplicateOf: first });
    }
  }
  return { duplicates, unique };
}

/**
 * Deterministic reconciliation pass (§7 step 3):
 *  1. Detect + exclude bank duplicates.
 *  2. Exact match: same amountCents AND date within ±3 days AND description
 *     Jaccard ≥ 0.5 (stopwords removed). Greedy one-to-one, ordered by amount then
 *     date proximity. Confidence `exact`.
 *  3. Candidate pairs for the residual: (same amount, any date) OR
 *     (Jaccard ≥ 0.4 AND |amount diff| ≤ 5% of the larger).
 */
export function reconcile(erp: ErpTxn[], bank: BankTxn[]): ReconMatchPass {
  assertMatchingWorkload(erp.length, bank.length);
  const { duplicates, unique: bankPool } = detectBankDuplicates(bank);

  const erpTokens = new Map(
    erp.map((e) => [e.id, tokenize(e.description, RECON_STOPWORDS)] as const),
  );
  const bankTokens = new Map(
    bankPool.map((b) => [b.id, tokenize(b.description, RECON_STOPWORDS)] as const),
  );

  // 2. Gather every eligible exact pair, then greedily assign one-to-one.
  interface Eligible {
    erp: ErpTxn;
    bank: BankTxn;
    days: number;
  }
  const eligible: Eligible[] = [];
  for (const e of erp) {
    const eTok = erpTokens.get(e.id)!;
    for (const b of bankPool) {
      if (e.amountCents !== b.amountCents) continue;
      const days = daysBetween(e.date, b.date);
      if (days > 3) continue;
      if (jaccard(eTok, bankTokens.get(b.id)!) < 0.5) continue;
      eligible.push({ erp: e, bank: b, days });
    }
  }
  // Ordered by amount, then date proximity (then ids, for determinism).
  eligible.sort(
    (x, y) =>
      x.erp.amountCents - y.erp.amountCents ||
      x.days - y.days ||
      x.erp.id.localeCompare(y.erp.id) ||
      x.bank.id.localeCompare(y.bank.id),
  );

  const usedErp = new Set<string>();
  const usedBank = new Set<string>();
  const matchedPairs: MatchedPair[] = [];
  for (const p of eligible) {
    if (usedErp.has(p.erp.id) || usedBank.has(p.bank.id)) continue;
    usedErp.add(p.erp.id);
    usedBank.add(p.bank.id);
    matchedPairs.push({
      erpId: p.erp.id,
      bankId: p.bank.id,
      amountCents: p.erp.amountCents,
      confidence: "exact",
      matchReason: "exact amount + date within 3 days",
    });
  }

  const unmatchedErp = erp.filter((e) => !usedErp.has(e.id));
  const unmatchedBank = bankPool.filter((b) => !usedBank.has(b.id));

  // 3. Candidate pairs over the residual.
  const candidatePairs: ReconCandidatePair[] = [];
  for (const e of unmatchedErp) {
    const eTok = erpTokens.get(e.id)!;
    for (const b of unmatchedBank) {
      const sameAmount = e.amountCents === b.amountCents;
      const jac = jaccard(eTok, bankTokens.get(b.id)!);
      const fuzzy = jac >= 0.4 && withinTolerance(e.amountCents, b.amountCents, 0.05);
      if (!sameAmount && !fuzzy) continue;
      candidatePairs.push({
        erpId: e.id,
        bankId: b.id,
        amountDiffCents: e.amountCents - b.amountCents,
        daysDiff: daysBetween(e.date, b.date),
        descriptionJaccard: jac,
        reason: sameAmount
          ? "same amount; date and/or description differ"
          : "similar description and amount within 5%",
      });
    }
  }

  return { matchedPairs, candidatePairs, unmatchedErp, unmatchedBank, duplicates };
}

/* -------------------------------------------------------------------------- */
/* Nearest-miss context (§7 step 4).                                           */
/* -------------------------------------------------------------------------- */

export interface NearestMiss {
  id: string;
  /** target − candidate (cents). */
  amountDiffCents: number;
  daysDiff: number;
  descriptionJaccard: number;
}

interface Missable {
  id: string;
  amountCents: number;
  description: string;
  date: string;
}

/**
 * Closest counterpart to an unmatched item, so Claude can classify the exception
 * (§7 step 4). Ranks the pool by smallest absolute amount difference, then highest
 * description Jaccard, then smallest date gap. Returns `null` for an empty pool.
 */
export function nearestMiss(
  target: Missable,
  pool: Missable[],
  stopwords: ReadonlySet<string> = RECON_STOPWORDS,
): NearestMiss | null {
  if (pool.length === 0) return null;
  const tTok = tokenize(target.description, stopwords);
  let best: NearestMiss | null = null;
  for (const p of pool) {
    const cand: NearestMiss = {
      id: p.id,
      amountDiffCents: target.amountCents - p.amountCents,
      daysDiff: daysBetween(target.date, p.date),
      descriptionJaccard: jaccard(tTok, tokenize(p.description, stopwords)),
    };
    if (best === null || isCloserMiss(cand, best)) best = cand;
  }
  return best;
}

function isCloserMiss(a: NearestMiss, b: NearestMiss): boolean {
  const aAmt = Math.abs(a.amountDiffCents);
  const bAmt = Math.abs(b.amountDiffCents);
  if (aAmt !== bAmt) return aAmt < bAmt;
  if (a.descriptionJaccard !== b.descriptionJaccard)
    return a.descriptionJaccard > b.descriptionJaccard;
  if (a.daysDiff !== b.daysDiff) return a.daysDiff < b.daysDiff;
  return a.id.localeCompare(b.id) < 0;
}

/* -------------------------------------------------------------------------- */
/* AP matching — deterministic pass (§8 step 3).                               */
/* -------------------------------------------------------------------------- */

/**
 * Vendor-name normalization (§8 step 3): lowercase, strip punctuation, drop the
 * `inc/llc/corp/co/ltd` suffix words. Used for exact vendor equality.
 */
export function normalizeVendor(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0 && !VENDOR_SUFFIXES.has(t))
    .join(" ");
}

/** A confirmed invoice↔PO match from the deterministic pass. */
export interface ApMatchPair {
  invoiceId: string;
  poId: string;
  /** Invoice amount (cents). */
  amountCents: number;
  matchReason: string;
}

/** An invoice↔PO pair flagged for Claude adjudication. */
export interface ApCandidatePair {
  invoiceId: string;
  poId: string;
  /** invoice − po (cents). */
  amountDiffCents: number;
  amountWithinTolerance: boolean;
  vendorJaccard: number;
  lineItemJaccard: number;
  reason: string;
}

/** A suspected duplicate requiring review, not proof that an invoice is invalid. */
export interface DuplicateInvoice {
  id: string;
  duplicateOf: string;
}

/** Result of the deterministic AP pass, before LLM adjudication. */
export interface ApMatchPass {
  matchedPairs: ApMatchPair[];
  candidatePairs: ApCandidatePair[];
  unmatchedInvoices: Invoice[];
  unmatchedPos: PurchaseOrder[];
  duplicateInvoices: DuplicateInvoice[];
}

/**
 * Same vendor + invoice number is a suspected resubmission even when date or amount
 * changed. Also retain the conservative same-vendor/amount 30-day heuristic. Both
 * require review; matching characteristics alone do not prove a duplicate payment.
 */
export function detectDuplicateInvoices(invoices: Invoice[]): DuplicateInvoice[] {
  const priorByVendorAmountDay = new Map<string, Map<number, { id: string; index: number }>>();
  const firstByNumber = new Map<string, string>();
  const duplicateOf = new Map<string, string>();
  for (const [index, inv] of invoices.entries()) {
    const vendor = normalizeVendor(inv.vendorName);
    const number = inv.invoiceNumber.normalize("NFKC").toLowerCase().replace(/[\s\-./_]+/g, "");
    if (vendor && number) {
      const identity = JSON.stringify([vendor, number]);
      const original = firstByNumber.get(identity);
      if (original) duplicateOf.set(inv.id, original);
      else firstByNumber.set(identity, inv.id);
    }
    const key = JSON.stringify([vendor, inv.amountCents]);
    const day = Date.parse(`${inv.invoiceDate}T00:00:00Z`) / 86_400_000;
    if (!Number.isFinite(day)) continue;
    const priorDays = priorByVendorAmountDay.get(key) ?? new Map<number, { id: string; index: number }>();
    let first: { id: string; index: number } | undefined;
    // A bounded 61-day lookup preserves the earliest prior source row regardless
    // of input date ordering, without a quadratic scan through recurring bills.
    for (let offset = -30; offset <= 30; offset++) {
      const candidate = priorDays.get(day + offset);
      if (candidate && (!first || candidate.index < first.index)) {
        first = candidate;
      }
    }
    if (first && !duplicateOf.has(inv.id)) duplicateOf.set(inv.id, first.id);
    if (!priorDays.has(day)) priorDays.set(day, { id: inv.id, index });
    priorByVendorAmountDay.set(key, priorDays);
  }
  return invoices.filter((inv) => duplicateOf.has(inv.id)).map((inv) => ({ id: inv.id, duplicateOf: duplicateOf.get(inv.id)! }));
}

/**
 * Deterministic AP pass (§8 step 3):
 *  - Exact match: normalized vendor equal AND amount within 2% AND line-item
 *    Jaccard ≥ 0.3. Greedy one-to-one, ordered by smallest amount diff then line
 *    similarity.
 *  - Candidate pairs for the residual: vendor Jaccard ≥ 0.6 OR amount within 2%.
 *  - Duplicate invoices detected in parallel (flagged, not excluded).
 */
export function matchAp(invoices: Invoice[], pos: PurchaseOrder[]): ApMatchPass {
  assertMatchingWorkload(invoices.length, pos.length);
  const duplicateInvoices = detectDuplicateInvoices(invoices);

  const invVendorNorm = new Map(
    invoices.map((i) => [i.id, normalizeVendor(i.vendorName)] as const),
  );
  const poVendorNorm = new Map(
    pos.map((p) => [p.id, normalizeVendor(p.vendorName)] as const),
  );
  const invLineTok = new Map(
    invoices.map((i) => [i.id, tokenize(i.lineItem)] as const),
  );
  const poLineTok = new Map(pos.map((p) => [p.id, tokenize(p.lineItem)] as const));

  interface Eligible {
    inv: Invoice;
    po: PurchaseOrder;
    amountDiff: number;
    lineJac: number;
  }
  const eligible: Eligible[] = [];
  for (const inv of invoices) {
    const vendor = invVendorNorm.get(inv.id)!;
    for (const po of pos) {
      if (vendor !== poVendorNorm.get(po.id)!) continue;
      if (!withinPoTolerance(inv.amountCents, po.amountCents, 0.02)) continue;
      const lineJac = jaccard(invLineTok.get(inv.id)!, poLineTok.get(po.id)!);
      if (lineJac < 0.3) continue;
      eligible.push({ inv, po, amountDiff: inv.amountCents - po.amountCents, lineJac });
    }
  }
  eligible.sort(
    (x, y) =>
      Math.abs(x.amountDiff) - Math.abs(y.amountDiff) ||
      y.lineJac - x.lineJac ||
      x.inv.id.localeCompare(y.inv.id) ||
      x.po.id.localeCompare(y.po.id),
  );

  const usedInv = new Set<string>();
  const usedPo = new Set<string>();
  const matchedPairs: ApMatchPair[] = [];
  for (const p of eligible) {
    if (usedInv.has(p.inv.id) || usedPo.has(p.po.id)) continue;
    usedInv.add(p.inv.id);
    usedPo.add(p.po.id);
    matchedPairs.push({
      invoiceId: p.inv.id,
      poId: p.po.id,
      amountCents: p.inv.amountCents,
      matchReason: "vendor match, amount within 2%, line-item overlap",
    });
  }

  const unmatchedInvoices = invoices.filter((i) => !usedInv.has(i.id));
  const unmatchedPos = pos.filter((p) => !usedPo.has(p.id));

  const candidatePairs: ApCandidatePair[] = [];
  for (const inv of unmatchedInvoices) {
    const invVendorTok = tokenize(invVendorNorm.get(inv.id)!);
    for (const po of unmatchedPos) {
      const vendorJac = jaccard(invVendorTok, tokenize(poVendorNorm.get(po.id)!));
      const amtOk = withinPoTolerance(inv.amountCents, po.amountCents, 0.02);
      if (vendorJac < 0.6 && !amtOk) continue;
      candidatePairs.push({
        invoiceId: inv.id,
        poId: po.id,
        amountDiffCents: inv.amountCents - po.amountCents,
        amountWithinTolerance: amtOk,
        vendorJaccard: vendorJac,
        lineItemJaccard: jaccard(invLineTok.get(inv.id)!, poLineTok.get(po.id)!),
        reason:
          vendorJac >= 0.6 && amtOk
            ? "similar vendor and amount within 2%"
            : vendorJac >= 0.6
              ? "similar vendor name"
              : "amount within 2%",
      });
    }
  }

  return {
    matchedPairs,
    candidatePairs,
    unmatchedInvoices,
    unmatchedPos,
    duplicateInvoices,
  };
}
