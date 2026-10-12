import type { ActionRequestRow, StepRow } from "@/lib/types";

type SourceRecord = Record<string, unknown>;
function output(steps: StepRow[], number: number): SourceRecord {
  const value = steps.find(
    (s) => s.step_number === number && s.status === "complete",
  )?.output;
  return value && typeof value === "object" ? (value as SourceRecord) : {};
}
function records(value: unknown): SourceRecord[] {
  return Array.isArray(value)
    ? value.filter((v): v is SourceRecord => !!v && typeof v === "object")
    : [];
}
export function paymentReviewEvidence(
  action: ActionRequestRow,
  steps: StepRow[],
) {
  const invoices = records(output(steps, 2).rows);
  const pos = records(output(steps, 1).rows);
  const match = records(output(steps, 3).matchedPairs).find(
    (m) => m.invoiceId === action.target_id,
  );
  const invoice = invoices.find((i) => i.id === action.target_id);
  const po = pos.find((p) => p.id === match?.poId);
  const flags = records(output(steps, 4).flags).filter(
    (f) => f.invoiceId === action.target_id,
  );
  const sources = steps
    .filter((s) => [1, 2].includes(s.step_number))
    .flatMap((s) => s.sources ?? []);
  const ready =
    !!invoice &&
    !!po &&
    Number.isSafeInteger(invoice.amountCents) &&
    Number.isSafeInteger(po.amountCents) &&
    invoice.amountCents === action.amount_cents &&
    action.payload?.poId === po.id &&
    match?.confidence === "high" &&
    typeof po.approvedBy === "string" &&
    !!po.approvedBy.trim() &&
    sources.length >= 2 &&
    flags.length === 0;
  return { invoice, po, match, flags, sources, ready };
}
export function approvalScopeTotal(actions: ActionRequestRow[]): number | null {
  if (actions.some((a) => !Number.isSafeInteger(a.amount_cents))) return null;
  const sum = actions.reduce(
    (value, a) => value + BigInt(a.amount_cents!),
    BigInt(0),
  );
  return sum <= BigInt(Number.MAX_SAFE_INTEGER) &&
    sum >= BigInt(Number.MIN_SAFE_INTEGER)
    ? Number(sum)
    : null;
}
