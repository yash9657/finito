/**
 * The finance risk taxonomy (Plan 3 §1, D-A2).
 *
 * A DATA TABLE, deliberately: nothing in FinFlow decides whether an act is
 * consequential by inspecting a step name or an action-type string. A step declares its
 * `risk`, an action carries its `riskClass`, and the two booleans below
 * (`requiresAuthorization`, `ceilingApplies`) are the only inputs the permission engine
 * consults about the *class* of act. Adding `external_filing` behaviour later is a row
 * edit plus a `proposeActions` body — never a new `if (stepKey === …)`.
 */

// Type-only import: this module stays runtime-dependency-free so client components can
// import the specs for risk chips without pulling zod into the browser bundle.
import type { RiskClass } from "@/lib/types";

export interface RiskClassSpec {
  id: RiskClass;
  /** Ordering for display and "most severe action in this run" summaries. */
  severity: number;
  label: string;
  /** Short description shown in the approval UI next to the risk chip. */
  description: string;
  /** False only for `read`: a read action never needs a permission decision. */
  requiresAuthorization: boolean;
  /** Whether monetary ceilings (D-A4) are meaningful for this class. */
  ceilingApplies: boolean;
}

export const RISK_CLASS_SPECS: Record<RiskClass, RiskClassSpec> = {
  read: {
    id: "read",
    severity: 0,
    label: "Read",
    description: "Reads source data and produces analysis only.",
    requiresAuthorization: false,
    ceilingApplies: false,
  },
  writes_ledger: {
    id: "writes_ledger",
    severity: 1,
    label: "Writes ledger",
    description: "Posts or amends an entry in a system of record.",
    requiresAuthorization: true,
    ceilingApplies: true,
  },
  moves_money: {
    id: "moves_money",
    severity: 2,
    label: "Moves money",
    description: "Authorizes a payment or release of funds to a counterparty.",
    requiresAuthorization: true,
    ceilingApplies: true,
  },
  external_filing: {
    id: "external_filing",
    severity: 3,
    label: "External filing",
    description: "Submits a statement or return to a third party or regulator.",
    requiresAuthorization: true,
    ceilingApplies: true,
  },
};

export function riskSpec(riskClass: RiskClass): RiskClassSpec {
  return RISK_CLASS_SPECS[riskClass];
}

/** True when a step/action of this class must pass the permission gate (D-A3). */
export function requiresAuthorization(riskClass: RiskClass): boolean {
  return RISK_CLASS_SPECS[riskClass].requiresAuthorization;
}

/** The most severe class present, for run-level summaries. Null for an empty list. */
export function mostSevere(classes: RiskClass[]): RiskClass | null {
  let winner: RiskClass | null = null;
  for (const c of classes) {
    if (winner === null || RISK_CLASS_SPECS[c].severity > RISK_CLASS_SPECS[winner].severity) {
      winner = c;
    }
  }
  return winner;
}

/** Ordered most-severe-last, for stable UI iteration. */
export const RISK_CLASSES_BY_SEVERITY: RiskClass[] = Object.values(RISK_CLASS_SPECS)
  .sort((a, b) => a.severity - b.severity)
  .map((s) => s.id);
