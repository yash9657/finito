/**
 * Verifier for `normalize_dataset` — the parser role's own operation (Plan 4 §3).
 *
 * A read step's proposed action is its intended operation, so verification here checks the
 * INPUTS are sane rather than checking a mutation: the named file was actually uploaded and
 * parsed, it yielded rows, its content hash matches what the proposal claims, and the rows
 * carry the columns downstream steps will read.
 *
 * The hash check is the load-bearing one. It ties the action to a specific byte-level input,
 * so an event trail claiming "normalized erp_export sha256:abc…" cannot later be reconciled
 * against a different file — which is the whole point of `input_hash` on the event.
 */

import { fail, pass, type Verifier, type VerificationVerdict } from "@/lib/harness/verifiers/types";

interface DatasetPayload {
  fileType?: unknown;
  expectedSha256?: unknown;
  requiredColumns?: unknown;
}

export const verifyNormalizeDataset: Verifier = (action, context): VerificationVerdict => {
  const p = (action.payload ?? {}) as DatasetPayload;

  const fileType = typeof p.fileType === "string" ? p.fileType : null;
  if (!fileType) {
    return fail("Proposed normalization must name a fileType");
  }

  const parsed = context.files[fileType];
  if (!parsed) {
    const available = Object.keys(context.files);
    return fail(
      `No parsed file for "${fileType}" (uploaded: ${available.length ? available.join(", ") : "none"})`,
    );
  }

  if (parsed.rows.length === 0) {
    // An empty dataset is not a benign no-op: every downstream step would report
    // "0 exceptions" and a reviewer would read that as a clean close.
    return fail(
      `"${fileType}" parsed to 0 usable rows (${parsed.meta.skippedCount} skipped) — ` +
        `a downstream clean result would be misleading`,
    );
  }

  // Tie the action to specific bytes.
  if (typeof p.expectedSha256 === "string" && p.expectedSha256 !== parsed.meta.sha256) {
    return fail(
      `Content hash mismatch for "${fileType}": proposal cites ${p.expectedSha256}, ` +
        `parsed file is ${parsed.meta.sha256}`,
    );
  }

  // Required columns, checked against the first row (the parser guarantees a uniform shape).
  if (Array.isArray(p.requiredColumns)) {
    const required = p.requiredColumns.filter((c): c is string => typeof c === "string");
    const present = new Set(Object.keys(parsed.rows[0] as Record<string, unknown>));
    const missing = required.filter((c) => !present.has(c));
    if (missing.length > 0) {
      return fail(`"${fileType}" is missing required column(s): ${missing.join(", ")}`);
    }
  }

  // A parse that dropped a meaningful share of the file is worth a reviewer's eye even
  // though it passes — silent partial ingestion is how a reconciliation quietly balances.
  const total = parsed.rows.length + parsed.meta.skippedCount;
  const skipRatio = total > 0 ? parsed.meta.skippedCount / total : 0;
  return pass(skipRatio > 0.1 ? "medium" : "low");
};
