/**
 * Verifier for `book_journal_entry` (Plan 4 §4, Part 5).
 *
 * Three checks, in escalating cost order:
 *   1. Debits equal credits, to the cent.
 *   2. Every account code exists in the supplied chart of accounts.
 *   3. Entries at or above the org's review threshold get a `high` verdict — mandatory
 *      human review regardless of any other configuration (D-H10).
 *
 * **Integer cents only.** Every amount is validated as a safe integer before it is summed.
 * A float here would be a correctness bug of exactly the kind this layer exists to catch:
 * `0.1 + 0.2 !== 0.3`, so a "balanced" entry expressed in dollars can fail to balance after
 * a rounding step nobody sees. The parser normalizes to integer cents (PLAN.md D3) and this
 * verifier refuses anything that is not one rather than coercing it.
 */

import { fail, pass, type Verifier, type VerificationVerdict } from "@/lib/harness/verifiers/types";

/** One leg of a proposed entry, as it appears in the action payload. */
interface JournalLine {
  accountCode?: unknown;
  debitCents?: unknown;
  creditCents?: unknown;
}

/** `payload.lines` is the entry. Anything else is a malformed proposal. */
function readLines(payload: unknown): JournalLine[] | null {
  if (payload === null || typeof payload !== "object") return null;
  const lines = (payload as { lines?: unknown }).lines;
  if (!Array.isArray(lines)) return null;
  return lines as JournalLine[];
}

/** Integer cents or null — never a coerced float (see the module note). */
function cents(value: unknown): number | null {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

export const verifyJournalEntry: Verifier = (action, context): VerificationVerdict => {
  const lines = readLines(action.payload);
  if (lines === null) {
    return fail("Proposed journal entry carries no `lines` array");
  }
  if (lines.length < 2) {
    return fail(`A journal entry needs at least two lines; got ${lines.length}`);
  }

  let totalDebits = 0;
  let totalCredits = 0;
  const unknownAccounts: string[] = [];

  for (const [i, line] of lines.entries()) {
    const debit = cents(line.debitCents);
    const credit = cents(line.creditCents);
    if (debit === null || credit === null) {
      return fail(
        `Line ${i + 1} has a non-integer or negative amount — amounts must be integer cents`,
      );
    }
    if (debit > 0 && credit > 0) {
      return fail(`Line ${i + 1} carries both a debit and a credit`);
    }
    if (debit === 0 && credit === 0) {
      return fail(`Line ${i + 1} has neither a debit nor a credit`);
    }

    const account = line.accountCode;
    if (typeof account !== "string" || account.trim().length === 0) {
      return fail(`Line ${i + 1} has no account code`);
    }
    // An absent chart of accounts is not a licence to skip the check: without one we
    // cannot validate codes at all, so the entry cannot be verified and must not pass.
    if (!context.chartOfAccounts) {
      return fail("No chart of accounts supplied — account codes cannot be verified");
    }
    if (!context.chartOfAccounts.has(account)) {
      unknownAccounts.push(account);
    }

    totalDebits += debit;
    totalCredits += credit;
  }

  if (unknownAccounts.length > 0) {
    return fail(
      `Unknown account code${unknownAccounts.length === 1 ? "" : "s"}: ${unknownAccounts.join(", ")}`,
    );
  }

  if (totalDebits !== totalCredits) {
    const diff = Math.abs(totalDebits - totalCredits);
    return fail(
      `Entry does not balance: debits ${totalDebits}c vs credits ${totalCredits}c ` +
        `(off by ${diff}c)`,
    );
  }

  if (totalDebits === 0) {
    return fail("Entry balances at zero — nothing would be posted");
  }

  // Balanced, valid, and posts something. The remaining question is size.
  //
  // HARDCODED SAFETY FLOOR (D-H10): at or above the threshold this returns `high`, which
  // `executeStep` turns into a mandatory human review request. There is deliberately no
  // way to switch this off — an org can raise or lower the threshold, but it cannot
  // configure "post large entries without review". Do not add one.
  const threshold = context.policy.journalEntryReviewThresholdCents;
  if (totalDebits >= threshold) {
    return {
      pass: true,
      riskLevel: "high",
      reason:
        `Entry totals ${totalDebits}c, at or above the ${threshold}c review threshold — ` +
        `human sign-off is mandatory`,
    };
  }

  return pass("medium"); // posting to a ledger is never "low"
};
