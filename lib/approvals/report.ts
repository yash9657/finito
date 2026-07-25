/**
 * Authorization-chain presentation helpers (Plan 3 §7, Edge #4).
 *
 * Shared by the on-page audit certificate (`AuditTrail.tsx`) and the Excel workbook, so
 * the two can never tell an auditor different stories about the same run. Pure functions
 * over `action_requests` rows — no DB, no React.
 */

import type { ActionRequest } from "@/lib/types";

export interface AuthorizationSummary {
  total: number;
  /** Cleared by a standing/run/once grant, with no human in the loop. */
  byRule: number;
  byHuman: number;
  /** Refused by a structural ceiling or the counterparty allowlist (D-A4). */
  denied: number;
  rejected: number;
  authorized: number;
  committed: number;
}

export function authorizationSummary(actions: ActionRequest[]): AuthorizationSummary {
  const byRule = actions.filter((a) => a.status === "auto_approved").length;
  const byHuman = actions.filter((a) => a.status === "approved").length;
  return {
    total: actions.length,
    byRule,
    byHuman,
    denied: actions.filter((a) => a.status === "denied").length,
    rejected: actions.filter((a) => a.status === "rejected").length,
    authorized: byRule + byHuman,
    committed: actions.filter((a) => a.committed_at !== null).length,
  };
}

/**
 * How one action was resolved, in the words an auditor needs: which rule, or which person.
 * `approverEmails` maps profile ids to emails (the report page loads them); an id falls
 * through unchanged when the profile is not available.
 */
export function decisionNarrative(
  action: ActionRequest,
  approverEmails: Record<string, string> = {},
): string {
  const who = action.decided_by ? (approverEmails[action.decided_by] ?? action.decided_by) : null;
  switch (action.status) {
    case "auto_approved":
      return action.standing_rule_id
        ? `auto-approved under rule ${action.standing_rule_id}`
        : "auto-approved by policy";
    case "approved":
      return `approved by ${who ?? "a reviewer"}`;
    case "rejected":
      return `rejected by ${who ?? "a reviewer"}`;
    case "denied":
      return action.decision_source === "ceiling"
        ? "denied by the organization's amount ceiling"
        : "denied by organization policy";
    default:
      return "awaiting approval";
  }
}

/** The certificate footer clause about authorization; empty when the run had no actions. */
export function authorizationFooterClause(summary: AuthorizationSummary): string {
  if (summary.total === 0) return "";
  const parts = [
    `${summary.authorized} of ${summary.total} consequential actions authorized ` +
      `(${summary.byRule} by standing rule, ${summary.byHuman} by a reviewer)`,
  ];
  if (summary.denied > 0) parts.push(`${summary.denied} denied by policy`);
  if (summary.rejected > 0) parts.push(`${summary.rejected} rejected`);
  return parts.join(", ");
}
