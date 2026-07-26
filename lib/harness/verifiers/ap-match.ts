/**
 * Verifier for `ap_match` and `approve_invoice_payment` (Plan 4 §4, Part 5).
 *
 * An invoice must sit within the org-configured variance band of the PO it is matched to.
 * The band is a FRACTION OF THE PO, not of the invoice: an invoice inflated well above its
 * PO would otherwise be measured against its own inflated value and look proportionally
 * closer than it is.
 *
 * Note the asymmetry, which is deliberate rather than an oversight: an invoice *under* its
 * PO is normal commerce (partial delivery, a discount taken) and passes at `low`. An invoice
 * *over* its PO is the direction money leaks, so it is held to the band and escalates.
 */

import { fail, pass, type Verifier, type VerificationVerdict } from "@/lib/harness/verifiers/types";

interface ApMatchPayload {
  invoiceId?: unknown;
  poId?: unknown;
  invoiceAmountCents?: unknown;
  poAmountCents?: unknown;
}

function intCents(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

export const verifyApMatch: Verifier = (action, context): VerificationVerdict => {
  const p = (action.payload ?? {}) as ApMatchPayload;

  const invoiceId = typeof p.invoiceId === "string" ? p.invoiceId : null;
  const poId = typeof p.poId === "string" ? p.poId : null;
  if (!invoiceId) {
    return fail("Proposed AP match must name an invoiceId");
  }
  if (!poId) {
    // No PO at all is not a tolerance question — there is nothing to match against, so a
    // human must decide whether this invoice should be paid on any basis.
    return fail(`Invoice ${invoiceId} has no matched purchase order`);
  }

  const invoiceAmount = intCents(p.invoiceAmountCents);
  const poAmount = intCents(p.poAmountCents);
  if (invoiceAmount === null || poAmount === null) {
    return fail("Proposed AP match amounts must be integer cents");
  }
  if (poAmount <= 0) {
    return fail(`Purchase order ${poId} has a non-positive amount (${poAmount}c)`);
  }

  const overage = invoiceAmount - poAmount;
  if (overage <= 0) {
    // At or under the PO — normal commerce.
    return pass("low");
  }

  const fraction = context.policy.apVarianceFraction;
  // Compare in integer cents: overage/poAmount > fraction  ⟺  overage > poAmount*fraction.
  // Rounding the allowance rather than dividing keeps this exact at the boundary.
  const allowance = Math.round(poAmount * fraction);
  if (overage > allowance) {
    const pct = ((overage / poAmount) * 100).toFixed(2);
    return fail(
      `Invoice ${invoiceId} exceeds PO ${poId} by ${overage}c (${pct}%), beyond the ` +
        `${(fraction * 100).toFixed(2)}% tolerance (allowance ${allowance}c)`,
    );
  }

  // Within tolerance but over the PO: passes, and never silently — an overage that a
  // reviewer should see if this run is reviewed at all.
  return pass("medium");
};
