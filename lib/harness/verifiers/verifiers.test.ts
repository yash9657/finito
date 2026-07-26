/**
 * Tests for the verification layer and the role registry (Plan 4 §3/§4).
 *
 * Verifiers are pure functions of (action, context), so these are plain unit tests — which
 * is the point of D-H9's "no DB client in a verifier": a business rule you cannot test in
 * isolation is one nobody will change with confidence.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_VERIFICATION_POLICY,
  hasVerifier,
  verifyAction,
  type VerificationContext,
} from "@/lib/harness/verifiers";
import {
  AP_MATCH,
  APPROVE_INVOICE_PAYMENT,
  BOOK_JOURNAL_ENTRY,
  NORMALIZE_DATASET,
  RECONCILIATION_MATCH,
  WRITE_COMMENTARY,
} from "@/lib/harness/action-types";
import {
  ROLE_SPECS,
  roleMayDeclareRisk,
  roleMayPropose,
} from "@/lib/harness/roles";
import { RISK_CLASS_SPECS } from "@/lib/approvals/risk";
import type { ParsedFile, ProposedAction, RiskClass, StepRole } from "@/lib/types";

function context(over: Partial<VerificationContext> = {}): VerificationContext {
  return {
    files: {},
    priorOutputs: { parse_erp: {} },
    policy: DEFAULT_VERIFICATION_POLICY,
    ...over,
  };
}

function action(over: Partial<ProposedAction>): ProposedAction {
  return {
    actionKey: "k:1",
    actionType: BOOK_JOURNAL_ENTRY,
    riskClass: "writes_ledger",
    target: { kind: "journal_entry", id: "je-1", counterparty: null, amountCents: null },
    summary: "test action",
    ...over,
  };
}

const CHART = new Set(["1000", "6000", "2000"]);

/* -------------------------------------------------------------------------- */

describe("registry fails closed", () => {
  it("rejects an unregistered action type rather than passing it unchecked", () => {
    const verdict = verifyAction(action({ actionType: "wire_funds_to_vendor" }), context());
    expect(verdict.pass).toBe(false);
    expect(verdict.riskLevel).toBe("high");
    expect(verdict.reason).toMatch(/No verifier registered/);
  });

  it("has a verifier for every action type a role may propose", () => {
    // The invariant from action-types.ts: a type in `roles` but not `verifiers` would be
    // proposable and then always fail closed — a latent dead end. Catch it here.
    for (const spec of Object.values(ROLE_SPECS)) {
      for (const type of spec.allowedActionTypes) {
        expect(hasVerifier(type), `${spec.id} may propose "${type}" with no verifier`).toBe(true);
      }
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("journal entry", () => {
  const balanced = [
    { accountCode: "6000", debitCents: 50_000 },
    { accountCode: "1000", creditCents: 50_000 },
  ];

  it("passes a balanced entry with known accounts", () => {
    const v = verifyAction(
      action({ payload: { lines: balanced } }),
      context({ chartOfAccounts: CHART }),
    );
    expect(v.pass).toBe(true);
    // Posting to a ledger is never "low".
    expect(v.riskLevel).toBe("medium");
  });

  it("rejects an entry off by a single cent", () => {
    const v = verifyAction(
      action({
        payload: {
          lines: [
            { accountCode: "6000", debitCents: 50_000 },
            { accountCode: "1000", creditCents: 49_999 },
          ],
        },
      }),
      context({ chartOfAccounts: CHART }),
    );
    expect(v.pass).toBe(false);
    expect(v.reason).toMatch(/off by 1c/);
  });

  it("rejects a non-integer amount instead of coercing it", () => {
    // A float here is the bug class this layer exists to catch: 0.1+0.2 !== 0.3, so a
    // "balanced" dollar-denominated entry can fail to balance after rounding.
    const v = verifyAction(
      action({
        payload: {
          lines: [
            { accountCode: "6000", debitCents: 500.5 },
            { accountCode: "1000", creditCents: 500.5 },
          ],
        },
      }),
      context({ chartOfAccounts: CHART }),
    );
    expect(v.pass).toBe(false);
    expect(v.reason).toMatch(/integer cents/);
  });

  it("rejects an entry when no chart of accounts was supplied", () => {
    // "We cannot check" must not mean "it passes".
    const v = verifyAction(action({ payload: { lines: balanced } }), context());
    expect(v.pass).toBe(false);
    expect(v.reason).toMatch(/No chart of accounts/);
  });

  it("rejects a line carrying both a debit and a credit", () => {
    const v = verifyAction(
      action({
        payload: {
          lines: [
            { accountCode: "6000", debitCents: 100, creditCents: 100 },
            { accountCode: "1000", creditCents: 100 },
          ],
        },
      }),
      context({ chartOfAccounts: CHART }),
    );
    expect(v.pass).toBe(false);
    expect(v.reason).toMatch(/both a debit and a credit/);
  });

  it("rejects an entry that balances at zero", () => {
    const v = verifyAction(
      action({
        payload: {
          lines: [
            { accountCode: "6000", debitCents: 0, creditCents: 0 },
            { accountCode: "1000", creditCents: 0 },
          ],
        },
      }),
      context({ chartOfAccounts: CHART }),
    );
    expect(v.pass).toBe(false);
  });

  it("escalates to `high` at exactly the threshold, not just above it", () => {
    const threshold = DEFAULT_VERIFICATION_POLICY.journalEntryReviewThresholdCents;
    const v = verifyAction(
      action({
        payload: {
          lines: [
            { accountCode: "6000", debitCents: threshold },
            { accountCode: "1000", creditCents: threshold },
          ],
        },
      }),
      context({ chartOfAccounts: CHART }),
    );
    // Passing but high: legal, and mandatory review (D-H10).
    expect(v.pass).toBe(true);
    expect(v.riskLevel).toBe("high");
  });

  it("stays below `high` one cent under the threshold", () => {
    const under = DEFAULT_VERIFICATION_POLICY.journalEntryReviewThresholdCents - 1;
    const v = verifyAction(
      action({
        payload: {
          lines: [
            { accountCode: "6000", debitCents: under },
            { accountCode: "1000", creditCents: under },
          ],
        },
      }),
      context({ chartOfAccounts: CHART }),
    );
    expect(v.riskLevel).toBe("medium");
  });

  it("rejects a single-line entry", () => {
    const v = verifyAction(
      action({ payload: { lines: [{ accountCode: "6000", debitCents: 100 }] } }),
      context({ chartOfAccounts: CHART }),
    );
    expect(v.pass).toBe(false);
    expect(v.reason).toMatch(/at least two lines/);
  });
});

/* -------------------------------------------------------------------------- */

describe("reconciliation match", () => {
  const base = {
    erpId: "e1",
    bankId: "b1",
    erpAmountCents: 12_500,
    bankAmountCents: 12_500,
    erpDate: "2026-01-05",
    bankDate: "2026-01-05",
  };
  const match = (over: Record<string, unknown> = {}) =>
    action({ actionType: RECONCILIATION_MATCH, riskClass: "read", payload: { ...base, ...over } });

  it("passes an exact same-day match at `low`", () => {
    const v = verifyAction(match(), context());
    expect(v.pass).toBe(true);
    expect(v.riskLevel).toBe("low");
  });

  it("passes within tolerance but flags it `medium`", () => {
    const v = verifyAction(match({ bankAmountCents: 12_450, bankDate: "2026-01-07" }), context());
    expect(v.pass).toBe(true);
    expect(v.riskLevel).toBe("medium");
  });

  it("rejects an amount beyond tolerance", () => {
    const v = verifyAction(match({ bankAmountCents: 12_000 }), context());
    expect(v.pass).toBe(false);
    expect(v.reason).toMatch(/beyond the 100c tolerance/);
  });

  it("rejects a date beyond the window", () => {
    const v = verifyAction(match({ bankDate: "2026-01-15" }), context());
    expect(v.pass).toBe(false);
    expect(v.reason).toMatch(/10 days, beyond the 3-day window/);
  });

  it("rejects a double match, which is checked before tolerance", () => {
    // Ordering matters: a duplicate misstates the reconciliation however well the amounts
    // line up, so it must not be reported as a tolerance problem.
    const v = verifyAction(
      match({ bankAmountCents: 999_999 }),
      context({ alreadyMatchedIds: new Set(["e1"]) }),
    );
    expect(v.pass).toBe(false);
    expect(v.reason).toMatch(/already matched: e1/);
  });
});

/* -------------------------------------------------------------------------- */

describe("AP match", () => {
  const ap = (over: Record<string, unknown> = {}) =>
    action({
      actionType: AP_MATCH,
      riskClass: "read",
      payload: {
        invoiceId: "inv-1",
        poId: "po-1",
        invoiceAmountCents: 100_000,
        poAmountCents: 100_000,
        ...over,
      },
    });

  it("passes an invoice under its PO at `low` — normal commerce", () => {
    const v = verifyAction(ap({ invoiceAmountCents: 90_000 }), context());
    expect(v.pass).toBe(true);
    expect(v.riskLevel).toBe("low");
  });

  it("passes an overage inside the 2% band, flagged `medium`", () => {
    const v = verifyAction(ap({ invoiceAmountCents: 101_500 }), context());
    expect(v.pass).toBe(true);
    expect(v.riskLevel).toBe("medium");
  });

  it("passes at exactly the 2% allowance boundary", () => {
    const v = verifyAction(ap({ invoiceAmountCents: 102_000 }), context());
    expect(v.pass).toBe(true);
  });

  it("rejects one cent past the allowance", () => {
    const v = verifyAction(ap({ invoiceAmountCents: 102_001 }), context());
    expect(v.pass).toBe(false);
    expect(v.reason).toMatch(/beyond the 2\.00% tolerance/);
  });

  it("measures the band against the PO, not the invoice", () => {
    // An invoice inflated far above its PO must not be measured against its own inflated
    // value, which would make it look proportionally closer than it is.
    const v = verifyAction(ap({ invoiceAmountCents: 200_000 }), context());
    expect(v.pass).toBe(false);
    expect(v.reason).toMatch(/100\.00%/);
  });

  it("rejects an invoice with no matched PO as un-verifiable, not as a tolerance miss", () => {
    const v = verifyAction(ap({ poId: null }), context());
    expect(v.pass).toBe(false);
    expect(v.reason).toMatch(/no matched purchase order/);
  });

  it("applies to approve_invoice_payment too", () => {
    const v = verifyAction(
      action({
        actionType: APPROVE_INVOICE_PAYMENT,
        riskClass: "moves_money",
        payload: {
          invoiceId: "inv-9",
          poId: "po-9",
          invoiceAmountCents: 500_000,
          poAmountCents: 100_000,
        },
      }),
      context(),
    );
    expect(v.pass).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe("normalize dataset", () => {
  function parsed(over: Partial<ParsedFile["meta"]> = {}, rows = 3): ParsedFile {
    return {
      rows: Array.from({ length: rows }, (_, i) => ({ id: `r${i}`, amountCents: 100 })),
      errors: [],
      meta: {
        filename: "erp.csv",
        fileType: "erp_export",
        sha256: "hash-a",
        rowCount: rows,
        skippedCount: 0,
        ...over,
      },
    } as ParsedFile;
  }

  const normalize = (payload: Record<string, unknown>) =>
    action({ actionType: NORMALIZE_DATASET, riskClass: "read", payload });

  it("passes a healthy parse", () => {
    const v = verifyAction(
      normalize({ fileType: "erp_export", expectedSha256: "hash-a" }),
      context({ files: { erp_export: parsed() } }),
    );
    expect(v.pass).toBe(true);
    expect(v.riskLevel).toBe("low");
  });

  it("rejects a content-hash mismatch", () => {
    const v = verifyAction(
      normalize({ fileType: "erp_export", expectedSha256: "hash-b" }),
      context({ files: { erp_export: parsed() } }),
    );
    expect(v.pass).toBe(false);
    expect(v.reason).toMatch(/Content hash mismatch/);
  });

  it("rejects a zero-row parse so downstream cannot report a false clean close", () => {
    const v = verifyAction(
      normalize({ fileType: "erp_export" }),
      context({ files: { erp_export: parsed({ rowCount: 0, skippedCount: 4 }, 0) } }),
    );
    expect(v.pass).toBe(false);
    expect(v.reason).toMatch(/0 usable rows/);
  });

  it("rejects a missing required column", () => {
    const v = verifyAction(
      normalize({ fileType: "erp_export", requiredColumns: ["id", "counterparty"] }),
      context({ files: { erp_export: parsed() } }),
    );
    expect(v.pass).toBe(false);
    expect(v.reason).toMatch(/missing required column\(s\): counterparty/);
  });

  it("flags a heavily-skipped parse `medium` — silent partial ingestion is dangerous", () => {
    const v = verifyAction(
      normalize({ fileType: "erp_export" }),
      context({ files: { erp_export: parsed({ skippedCount: 10 }, 3) } }),
    );
    expect(v.pass).toBe(true);
    expect(v.riskLevel).toBe("medium");
  });

  it("names what was uploaded when the file is absent", () => {
    const v = verifyAction(
      normalize({ fileType: "bank_statement" }),
      context({ files: { erp_export: parsed() } }),
    );
    expect(v.pass).toBe(false);
    expect(v.reason).toMatch(/uploaded: erp_export/);
  });
});

/* -------------------------------------------------------------------------- */

describe("analysis operations", () => {
  it("rejects an analysis step with no source data at all", () => {
    const v = verifyAction(
      action({ actionType: WRITE_COMMENTARY, riskClass: "read" }),
      context({ files: {}, priorOutputs: {} }),
    );
    expect(v.pass).toBe(false);
    expect(v.reason).toMatch(/no source data/);
  });

  it("passes when it has prior outputs to work from", () => {
    const v = verifyAction(
      action({ actionType: WRITE_COMMENTARY, riskClass: "read" }),
      context({ priorOutputs: { flag: { flags: [] } } }),
    );
    expect(v.pass).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */

describe("role registry (D-H15)", () => {
  it("a writer may propose exactly one action type", () => {
    // The brief's headline constraint, as a direct assertion on the data.
    expect(ROLE_SPECS.writer.allowedActionTypes).toEqual([WRITE_COMMENTARY]);
    expect(roleMayPropose("writer", BOOK_JOURNAL_ENTRY)).toBe(false);
    expect(roleMayPropose("writer", APPROVE_INVOICE_PAYMENT)).toBe(false);
  });

  it("a parser may only normalize datasets", () => {
    expect(roleMayPropose("parser", NORMALIZE_DATASET)).toBe(true);
    expect(roleMayPropose("parser", BOOK_JOURNAL_ENTRY)).toBe(false);
  });

  it("every role's default action type is inside its own allowed set", () => {
    for (const spec of Object.values(ROLE_SPECS)) {
      if (spec.defaultActionType === null) continue;
      expect(
        spec.allowedActionTypes.includes(spec.defaultActionType),
        `${spec.id}'s default is not in its allowed set`,
      ).toBe(true);
    }
  });

  it("keeps `verifier` out of the role registry — it is not an LLM", () => {
    expect(Object.keys(ROLE_SPECS)).not.toContain("verifier");
  });

  it("agrees with lib/approvals/risk.ts on severity ordering", () => {
    // roles/index.ts duplicates the ordering to stay dependency-free for client components.
    // This is the test that comment promises.
    const order: RiskClass[] = ["read", "writes_ledger", "moves_money", "external_filing"];
    for (let i = 1; i < order.length; i++) {
      expect(RISK_CLASS_SPECS[order[i]].severity).toBeGreaterThan(
        RISK_CLASS_SPECS[order[i - 1]].severity,
      );
    }
    // And the duplicated table is consistent with it, via the public predicate.
    expect(roleMayDeclareRisk("writer", "read")).toBe(true);
    expect(roleMayDeclareRisk("writer", "writes_ledger")).toBe(false);
    expect(roleMayDeclareRisk("classifier", "moves_money")).toBe(true);
    expect(roleMayDeclareRisk("classifier", "external_filing")).toBe(false);
  });

  it("caps each role's declarable risk at its own maximum", () => {
    for (const [role, spec] of Object.entries(ROLE_SPECS)) {
      expect(roleMayDeclareRisk(role as StepRole, spec.maxRiskClass)).toBe(true);
    }
  });
});
