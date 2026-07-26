/**
 * The harness action-type vocabulary (Plan 4 §3).
 *
 * One module so that `roles/` (which decides who may propose what) and `verifiers/` (which
 * decides whether a proposal is legal) can both import the ids without importing each
 * other. Those two are the same fact viewed from opposite sides, and every action type must
 * appear in BOTH tables — a type in neither cannot be proposed; a type in `roles` but not
 * `verifiers` fails closed at verification (see `verifyAction`).
 *
 * `APPROVE_INVOICE_PAYMENT` is NOT redefined here — it is re-exported from
 * `lib/approvals/action-types.ts`, which is the registry the approval UI reads for target
 * and counterparty labels. Two definitions of one action-type string is how a grant stops
 * matching the action it was meant to authorize.
 */

export { APPROVE_INVOICE_PAYMENT } from "@/lib/approvals/action-types";

/* -------------------------------------------------------------------------- */
/* Role-native operations — what a role does when doing its own job. A `read`  */
/* step proposes one of these, standing for its own operation, so that no step */
/* bypasses propose→verify (D-H8).                                            */
/* -------------------------------------------------------------------------- */

export const NORMALIZE_DATASET = "normalize_dataset";
export const ADJUDICATE_MATCHES = "adjudicate_matches";
export const FLAG_EXCEPTIONS = "flag_exceptions";
export const WRITE_COMMENTARY = "write_commentary";

/* -------------------------------------------------------------------------- */
/* Item-level actions. These decompose a step's work into one action per       */
/* affected row, which is what makes per-action verification and per-action    */
/* authorization possible (Plan 3's core move, extended to verification).      */
/* -------------------------------------------------------------------------- */

/** One reconciliation match: this ERP transaction against this bank transaction. */
export const RECONCILIATION_MATCH = "reconciliation_match";
/** One AP match: this invoice against this purchase order. */
export const AP_MATCH = "ap_match";
/**
 * Posting one entry to a system of record.
 *
 * No FinFlow step proposes this yet — it is the action type Plan 4's Part 5 verifier is
 * written for, and the brief's canonical example of a consequential act that must be
 * checked before execution (debits equal credits, valid account codes, threshold review).
 * It is registered now so the verifier is reachable and testable rather than dead code
 * waiting on a step that does not exist.
 */
export const BOOK_JOURNAL_ENTRY = "book_journal_entry";
