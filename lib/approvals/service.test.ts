import { beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  decisionMap,
  defaultPolicy,
  gateStepActions,
  listActions,
  loadPolicy,
  markCommitted,
  pendingActions,
  reevaluatePending,
  resolveAction,
} from "@/lib/approvals/service";
import type { ApprovalRule, ProposedAction } from "@/lib/types";

/* -------------------------------------------------------------------------- */
/* A small PostgREST-shaped fake. The service takes its client as a parameter, */
/* so no module mocking is needed — just pass this in.                         */
/* -------------------------------------------------------------------------- */

type Row = Record<string, unknown>;

const state: Record<string, Row[]> = {
  action_requests: [],
  approval_rules: [],
  org_approval_policies: [],
  audit_log: [],
};

function fakeDb(): SupabaseClient {
  function query(table: string) {
    const arr = () => (state[table] ??= []);
    let op: "select" | "insert" | "update" = "select";
    let payload: Row | Row[] | null = null;
    const filters: [string, unknown][] = [];
    const match = (row: Row) => filters.every(([c, v]) => row[c] === v);
    const run = () => {
      if (op === "insert") {
        const rows = Array.isArray(payload) ? payload : [payload as Row];
        arr().push(...rows.map((r) => ({ ...r })));
        return { data: null, error: null };
      }
      if (op === "update") {
        const hit = arr().filter(match);
        for (const row of hit) Object.assign(row, payload as Row);
        return { data: hit, error: null };
      }
      return { data: arr().filter(match), error: null };
    };
    const q: Record<string, unknown> = {};
    Object.assign(q, {
      select: () => q,
      insert: (rows: Row | Row[]) => {
        op = "insert";
        payload = rows;
        return q;
      },
      update: (patch: Row) => {
        op = "update";
        payload = patch;
        return q;
      },
      eq: (col: string, val: unknown) => {
        filters.push([col, val]);
        return q;
      },
      order: () => q,
      maybeSingle: () => Promise.resolve({ data: (run().data ?? [])[0] ?? null, error: null }),
      single: () => Promise.resolve({ data: (run().data ?? [])[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => void) => resolve(run()),
    });
    return q;
  }
  return { from: (t: string) => query(t) } as unknown as SupabaseClient;
}

const db = fakeDb();
const WF = "wf-1";
const ORG = "org-1";

function payment(id: string, amountCents: number, counterparty = "Acme Supplies"): ProposedAction {
  return {
    actionKey: `approve_invoice_payment:${id}`,
    actionType: "approve_invoice_payment",
    riskClass: "moves_money",
    target: { kind: "invoice", id, counterparty, amountCents },
    summary: `Approve payment to ${counterparty}`,
    payload: { poId: "po-001" },
  };
}

function standingRule(over: Partial<ApprovalRule> = {}): Row {
  return {
    id: "rule-1",
    org_id: ORG,
    scope: "standing",
    workflow_id: null,
    action_type: "approve_invoice_payment",
    target_kind: "invoice",
    target_id: null,
    counterparty: "Acme Supplies",
    max_amount_cents: 500_000,
    note: null,
    created_by: "user-1",
    created_at: "2026-07-01T00:00:00.000Z",
    expires_at: null,
    consumed_at: null,
    revoked_at: null,
    revoked_by: null,
    ...over,
  };
}

function gate(actions: ProposedAction[]) {
  return gateStepActions(db, {
    workflowId: WF,
    orgId: ORG,
    stepKey: "approval_queue",
    stepId: "step-5",
    actions,
  });
}

beforeEach(() => {
  state.action_requests = [];
  state.approval_rules = [];
  state.org_approval_policies = [];
  state.audit_log = [];
});

/* -------------------------------------------------------------------------- */

describe("loadPolicy", () => {
  it("returns the fail-closed default when the org has no row", async () => {
    const p = await loadPolicy(db, ORG);
    expect(p).toEqual(defaultPolicy(ORG));
    expect(p.hard_deny_above_cents).toBeNull();
    expect(p.require_separate_approver).toBe(false);
  });

  it("fills missing columns from the default", async () => {
    state.org_approval_policies.push({ org_id: ORG, hard_deny_above_cents: 100, approved_counterparties: null });
    const p = await loadPolicy(db, ORG);
    expect(p.hard_deny_above_cents).toBe(100);
    expect(p.approved_counterparties).toEqual([]);
    expect(p.auto_approve_max_cents).toBeNull();
  });
});

describe("gateStepActions", () => {
  it("persists one row per action with the target denormalized for rule matching", async () => {
    const rows = await gate([payment("inv-001", 120_000), payment("inv-002", 90_000, "Globex")]);
    expect(rows.map((r) => r.status)).toEqual(["pending", "pending"]);
    expect(rows[0].target_kind).toBe("invoice");
    expect(rows[0].target_id).toBe("inv-001");
    expect(rows[0].amount_cents).toBe(120_000);
    expect(rows[1].counterparty).toBe("Globex");
    expect(rows[0].payload).toEqual({ poId: "po-001" });
    expect(state.action_requests).toHaveLength(2);
  });

  it("is idempotent by (workflow, action_key) across re-entry", async () => {
    await gate([payment("inv-001", 120_000)]);
    const again = await gate([payment("inv-001", 120_000)]);
    expect(state.action_requests).toHaveLength(1);
    expect(again[0].status).toBe("pending");
  });

  it("preserves an already-resolved decision on re-entry", async () => {
    const [row] = await gate([payment("inv-001", 120_000)]);
    await resolveAction(db, {
      actionId: row.id,
      workflowId: WF,
      decision: "approve",
      approverId: "user-9",
    });
    const again = await gate([payment("inv-001", 120_000)]);
    expect(again[0].status).toBe("approved");
    expect(again[0].decided_by).toBe("user-9");
  });

  it("auto-approves under a standing rule and audits the chain", async () => {
    state.approval_rules.push(standingRule());
    const [row] = await gate([payment("inv-001", 120_000)]);
    expect(row.status).toBe("auto_approved");
    expect(row.standing_rule_id).toBe("rule-1");
    const actions = state.audit_log.map((a) => a.action);
    expect(actions).toContain("action_proposed");
    expect(actions).toContain("action_auto_approved");
  });

  it("consumes a once-grant so it can never fire twice", async () => {
    state.approval_rules.push(
      standingRule({ id: "r-once", scope: "once", workflow_id: WF, target_id: "inv-001", counterparty: null }),
    );
    const [first] = await gate([payment("inv-001", 120_000)]);
    expect(first.status).toBe("auto_approved");
    expect(state.approval_rules[0].consumed_at).not.toBeNull();

    // A second action for the same target (different key) must not ride the used grant.
    const [second] = await gate([{ ...payment("inv-001", 120_000), actionKey: "approve_invoice_payment:inv-001b" }]);
    expect(second.status).toBe("pending");
  });

  it("clears pending items when a grant is minted between attempts (D-A7)", async () => {
    const [before] = await gate([payment("inv-001", 120_000)]);
    expect(before.status).toBe("pending");

    state.approval_rules.push(standingRule()); // minted after the first suspension
    const [after] = await gate([payment("inv-001", 120_000)]);
    expect(after.status).toBe("auto_approved");
    expect(after.standing_rule_id).toBe("rule-1");
    expect(await pendingActions(db, WF)).toHaveLength(0);
  });
});

describe("reevaluatePending", () => {
  it("denies a pending action when a ceiling is tightened mid-flight", async () => {
    await gate([payment("inv-001", 400_000)]);
    state.org_approval_policies.push({ org_id: ORG, hard_deny_above_cents: 100_000 });

    const changed = await reevaluatePending(db, { workflowId: WF, orgId: ORG });
    expect(changed).toHaveLength(1);
    expect(changed[0].status).toBe("denied");
    expect((await listActions(db, WF))[0].status).toBe("denied");
  });

  it("never touches an already-resolved action", async () => {
    const [row] = await gate([payment("inv-001", 400_000)]);
    await resolveAction(db, { actionId: row.id, workflowId: WF, decision: "approve", approverId: "user-9" });
    state.org_approval_policies.push({ org_id: ORG, hard_deny_above_cents: 1 });

    const changed = await reevaluatePending(db, { workflowId: WF, orgId: ORG });
    expect(changed).toHaveLength(0);
    expect((await listActions(db, WF))[0].status).toBe("approved"); // not retro-denied
  });
});

describe("resolveAction", () => {
  it("resolves exactly once; the second responder loses and is told who won", async () => {
    const [row] = await gate([payment("inv-001", 120_000)]);

    const first = await resolveAction(db, {
      actionId: row.id,
      workflowId: WF,
      decision: "approve",
      approverId: "user-1",
      comment: "checked the PO",
    });
    expect(first.ok).toBe(true);

    const second = await resolveAction(db, {
      actionId: row.id,
      workflowId: WF,
      decision: "reject",
      approverId: "user-2",
    });
    expect(second.ok).toBe(false);
    if (!second.ok && second.reason === "already_resolved") {
      expect(second.row.status).toBe("approved");
      expect(second.row.decided_by).toBe("user-1"); // never overwritten
    } else {
      throw new Error(`expected already_resolved, got ${JSON.stringify(second)}`);
    }
    expect(state.audit_log.filter((a) => a.action === "approval_resolved")).toHaveLength(1);
  });

  it("refuses to override a ceiling denial (D-A4)", async () => {
    state.org_approval_policies.push({ org_id: ORG, hard_deny_above_cents: 100_000 });
    const [row] = await gate([payment("inv-big", 5_000_000)]);
    expect(row.status).toBe("denied");

    const res = await resolveAction(db, {
      actionId: row.id,
      workflowId: WF,
      decision: "approve",
      approverId: "user-1",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_overridable");
    expect((await listActions(db, WF))[0].status).toBe("denied");
  });

  it("scopes by workflow and reports a missing action", async () => {
    const [row] = await gate([payment("inv-001", 120_000)]);
    const res = await resolveAction(db, {
      actionId: row.id,
      workflowId: "wf-other",
      decision: "approve",
      approverId: "user-1",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_found");
  });

  it("records a rejection with its comment", async () => {
    const [row] = await gate([payment("inv-001", 120_000)]);
    const res = await resolveAction(db, {
      actionId: row.id,
      workflowId: WF,
      decision: "reject",
      approverId: "user-3",
      comment: "duplicate of INV-88",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.row.status).toBe("rejected");
      expect(res.row.comment).toBe("duplicate of INV-88");
      expect(res.row.decision_source).toBe("human");
    }
  });
});

describe("decisionMap / markCommitted", () => {
  it("marks only authorized statuses as authorized", async () => {
    state.approval_rules.push(standingRule());
    const rows = await gate([payment("inv-001", 120_000), payment("inv-002", 90_000, "Globex")]);
    const map = decisionMap(rows);
    expect(map.get("approve_invoice_payment:inv-001")?.authorized).toBe(true);
    expect(map.get("approve_invoice_payment:inv-002")?.authorized).toBe(false);
    expect(map.get("nope")).toBeUndefined();
  });

  it("stamps committed_at on authorized rows and audits withheld ones", async () => {
    state.approval_rules.push(standingRule());
    const rows = await gate([payment("inv-001", 120_000), payment("inv-002", 90_000, "Globex")]);
    await markCommitted(db, { workflowId: WF, stepId: "step-5", rows });

    const stored = await listActions(db, WF);
    expect(stored.find((r) => r.target_id === "inv-001")?.committed_at).not.toBeNull();
    expect(stored.find((r) => r.target_id === "inv-002")?.committed_at).toBeNull();
    const audit = state.audit_log.map((a) => a.action);
    expect(audit).toContain("action_committed");
    expect(audit).toContain("action_withheld");
  });
});
