/**
 * The catalogue of consequential action types (Plan 3, D-A2).
 *
 * A registry rather than string literals scattered across step code and UI: the grant
 * form needs to know which action types exist, what their target is called, and what
 * counterparty means for them ("Vendor" for a payment, "Filing authority" for a return).
 * Steps import the ids from here so a typo cannot silently create an unauthorizable
 * action type that no rule can ever match.
 */

import type { RiskClass } from "@/lib/types";

export interface ActionTypeSpec {
  id: string;
  label: string;
  /** `ActionTarget.kind` every action of this type carries. */
  targetKind: string;
  riskClass: RiskClass;
  /** What the target id is called in the UI ("Invoice"). */
  targetLabel: string;
  /** What the counterparty is called in the UI ("Vendor"). */
  counterpartyLabel: string;
}

/** AP: authorizing a supplier invoice for payment — today's one money-moving action. */
export const APPROVE_INVOICE_PAYMENT = "approve_invoice_payment";

export const ACTION_TYPE_SPECS: ActionTypeSpec[] = [
  {
    id: APPROVE_INVOICE_PAYMENT,
    label: "Approve invoice payment",
    targetKind: "invoice",
    riskClass: "moves_money",
    targetLabel: "Invoice",
    counterpartyLabel: "Vendor",
  },
];

export function actionTypeSpec(id: string): ActionTypeSpec | null {
  return ACTION_TYPE_SPECS.find((s) => s.id === id) ?? null;
}

/** Display label for an action type, falling back to the raw id for forward compat. */
export function actionTypeLabel(id: string): string {
  return actionTypeSpec(id)?.label ?? id;
}
