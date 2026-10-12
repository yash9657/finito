/**
 * Verifier for `reconciliation_match` (Plan 4 §4, Part 5).
 *
 * A proposed match must:
 *   - have amounts within the org-configured tolerance,
 *   - have dates within the org-configured window,
 *   - not double-match a transaction that is already matched.
 *
 * The double-match check reads `context.alreadyMatchedIds`, which the loop resolves from
 * committed state before verification. That is what makes it resume-safe: after a crash
 * and restart, a transaction matched in an earlier attempt is still known to be matched, so
 * a re-proposal is rejected rather than silently creating a second match for the same
 * economic event.
 */

import { fail, pass, type Verifier, type VerificationVerdict } from "@/lib/harness/verifiers/types";

interface MatchPayload {
  erpId?: unknown;
  bankId?: unknown;
  erpAmountCents?: unknown;
  bankAmountCents?: unknown;
  erpDate?: unknown;
  bankDate?: unknown;
}

function intCents(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/** Parse an ISO `YYYY-MM-DD` into a UTC epoch-day, or null. */
function epochDay(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(ms)) return null;
  if (new Date(ms).toISOString().slice(0, 10) !== value.trim()) return null;
  return Math.floor(ms / 86_400_000);
}

export const verifyReconciliationMatch: Verifier = (action, context): VerificationVerdict => {
  const p = (action.payload ?? {}) as MatchPayload;

  const erpId = typeof p.erpId === "string" ? p.erpId : null;
  const bankId = typeof p.bankId === "string" ? p.bankId : null;
  if (!erpId || !bankId) {
    return fail("Proposed match must name both an erpId and a bankId");
  }

  // Double-match check first: it is the cheapest and the most consequential. A duplicate
  // match misstates the reconciliation regardless of how well the amounts line up.
  const matched = context.alreadyMatchedIds;
  if (matched) {
    const already = [erpId, bankId].filter((id) => matched.has(id));
    if (already.length > 0) {
      return fail(
        `Transaction${already.length === 1 ? "" : "s"} already matched: ${already.join(", ")}`,
      );
    }
  }

  const erpAmount = intCents(p.erpAmountCents);
  const bankAmount = intCents(p.bankAmountCents);
  if (erpAmount === null || bankAmount === null) {
    return fail("Proposed match amounts must be integer cents");
  }

  const difference = BigInt(erpAmount) - BigInt(bankAmount);
  const amountDiff = difference < BigInt(0) ? -difference : difference;
  const tolerance = context.policy.matchAmountToleranceCents;
  if (!Number.isSafeInteger(tolerance) || tolerance < 0) return fail("Match amount tolerance must be non-negative integer cents");
  if (amountDiff > BigInt(tolerance)) {
    return fail(
      `Amounts differ by ${amountDiff}c, beyond the ${tolerance}c tolerance ` +
        `(${erpId} ${erpAmount}c vs ${bankId} ${bankAmount}c)`,
    );
  }

  const erpDay = epochDay(p.erpDate);
  const bankDay = epochDay(p.bankDate);
  if (erpDay === null || bankDay === null) {
    return fail("Proposed match dates must be ISO YYYY-MM-DD");
  }

  const daysDiff = Math.abs(erpDay - bankDay);
  const window = context.policy.matchDateWindowDays;
  if (!Number.isSafeInteger(window) || window < 0) return fail("Match date window must be a non-negative integer number of days");
  if (daysDiff > window) {
    return fail(
      `Dates differ by ${daysDiff} day${daysDiff === 1 ? "" : "s"}, beyond the ` +
        `${window}-day window (${p.erpDate as string} vs ${p.bankDate as string})`,
    );
  }

  // An exact-amount, same-day match is routine. Anything using up the tolerance is worth a
  // reviewer's attention if the run is being reviewed, so it is not "low".
  const usesTolerance = amountDiff > BigInt(0) || daysDiff > 0;
  return pass(usesTolerance ? "medium" : "low");
};
