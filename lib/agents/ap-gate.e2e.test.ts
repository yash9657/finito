/**
 * End-to-end authorization walkthrough (Plan 3 §8, the checkpoint after A6) against the
 * REAL AP graph, the real orchestrator, the real permission engine, and the committed
 * demo CSVs. Only two things are substituted: Supabase (an in-memory PostgREST-shaped
 * fake, including Storage serving the demo files) and the LLM transport (a stub that
 * answers each step's schema from the payload it is given, so no network and no key).
 *
 * It walks the exact story the product promises:
 *
 *   1. A fresh org has no policy and no rules → the AP run SUSPENDS on `awaiting_approval`
 *      with one pending action per payable invoice. Nothing is committed.
 *   2. A reviewer approves one payment and mints a standing rule bound to that vendor and
 *      an amount cap → on resume the run auto-approves everything that rule covers, and
 *      the rest of the run's payments still wait.
 *   3. Approving the remainder resumes the run to `awaiting_review`, and the deliverable
 *      contains exactly the authorized payments, each carrying how it was authorized.
 *   4. A hard ceiling denies an oversized payment un-overridably, and the run still
 *      completes without it.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* -------------------------------------------------------------------------- */
/* Hoisted fakes: Supabase (tables + storage) and the LLM router.              */
/* -------------------------------------------------------------------------- */

const h = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const state: Record<string, Row[]> = {
    workflows: [],
    workflow_steps: [],
    workflow_files: [],
    audit_log: [],
    action_requests: [],
    approval_rules: [],
    org_approval_policies: [],
  };
  const storage: Record<string, Buffer> = {};

  function makeDb() {
    function query(table: string) {
      const arr = () => (state[table] ??= []);
      let op: "select" | "insert" | "update" | "delete" = "select";
      let payload: Row | Row[] | null = null;
      const filters: [string, unknown][] = [];
      const match = (row: Row) => filters.every(([c, v]) => row[c] === v);
      const run = () => {
        if (op === "insert") {
          const rows = Array.isArray(payload) ? payload : [payload as Row];
          let n = arr().length;
          for (const r of rows) arr().push({ id: (r.id as string) ?? `id-${++n}`, ...r });
          return { data: null, error: null };
        }
        if (op === "update") {
          const hit = arr().filter(match);
          for (const row of hit) Object.assign(row, payload as Row);
          return { data: hit, error: null };
        }
        if (op === "delete") {
          for (let i = arr().length - 1; i >= 0; i--) if (match(arr()[i])) arr().splice(i, 1);
          return { data: null, error: null };
        }
        const rows = arr()
          .filter(match)
          .sort((a, b) => ((a.step_number as number) ?? 0) - ((b.step_number as number) ?? 0));
        return { data: rows, error: null };
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
        delete: () => {
          op = "delete";
          return q;
        },
        eq: (col: string, val: unknown) => {
          filters.push([col, val]);
          return q;
        },
        order: () => q,
        single: () => Promise.resolve({ data: (run().data ?? [])[0] ?? null, error: null }),
        maybeSingle: () => Promise.resolve({ data: (run().data ?? [])[0] ?? null, error: null }),
        then: (resolve: (v: unknown) => void) => resolve(run()),
      });
      return q;
    }
    return {
      from: (t: string) => query(t),
      storage: {
        from: () => ({
          download: async (p: string) => {
            const buf = storage[p];
            if (!buf) return { data: null, error: { message: `no object ${p}` } };
            return {
              data: { arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) },
              error: null,
            };
          },
        }),
      },
    };
  }

  return { state, storage, makeDb };
});

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.makeDb() }));

/**
 * The LLM stub. Each AP step's payload is unambiguous about what it wants, so the stub
 * answers from the payload — including echoing back every code-detected finding, which is
 * what the flag step's post-validation requires.
 */
vi.mock("@/lib/llm/router", () => ({
  NoProviderConfiguredError: class extends Error {},
  resolveProvider: async () => ({
    provider: { id: "anthropic", complete: async () => ({}) },
    configId: null,
    providerId: "anthropic",
    model: "stub-model",
  }),
  invoke: async (_resolved: unknown, opts: { user: string }) => {
    const payload = JSON.parse(opts.user) as Record<string, unknown>;
    let data: unknown;
    if ("candidatePairs" in payload) {
      data = { reasoning: "stub adjudication", confirmedMatches: [], rejectedPairs: [] };
    } else if ("findings" in payload) {
      const findings = payload.findings as Array<{ invoiceId: string; category: string }>;
      data = {
        reasoning: "stub flags",
        flags: findings.map((f) => ({
          invoiceId: f.invoiceId,
          category: f.category,
          explanation: "stub explanation",
          recommendation: "stub recommendation",
        })),
      };
    } else {
      data = { reasoning: "stub narrative", narrative: "stub narrative" };
    }
    return {
      data,
      reasoning: "stub reasoning",
      meta: {
        providerId: "anthropic",
        modelUsed: "stub-model",
        tokensIn: 10,
        tokensOut: 10,
        latencyMs: 5,
        raw: null,
      },
    };
  },
}));

import { runWorkflow } from "@/lib/agents/orchestrator";
import { resolveAction, reevaluatePending, listActions } from "@/lib/approvals/service";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ActionRequest, ApApprovalQueue } from "@/lib/types";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const WF = "wf-ap";
const ORG = "org-1";
const REVIEWER = "user-reviewer";

function seed() {
  const root = path.resolve(__dirname, "../../demo-data");
  h.storage["po.csv"] = readFileSync(path.join(root, "purchase_orders_demo.csv"));
  h.storage["inv.csv"] = readFileSync(path.join(root, "invoices_demo.csv"));

  h.state.workflows.push({
    id: WF,
    org_id: ORG,
    created_by: "user-analyst",
    type: "ap_matching",
    status: "running",
    error_message: null,
    started_at: "2026-07-24T09:00:00.000Z",
    completed_at: null,
  });
  h.state.workflow_files.push(
    { id: "f1", workflow_id: WF, file_type: "po", storage_path: "po.csv", filename: "purchase_orders_demo.csv", sha256: createHash("sha256").update(h.storage["po.csv"]).digest("hex") },
    { id: "f2", workflow_id: WF, file_type: "invoice", storage_path: "inv.csv", filename: "invoices_demo.csv", sha256: createHash("sha256").update(h.storage["inv.csv"]).digest("hex") },
  );
}

function actions(): ActionRequest[] {
  return h.state.action_requests.filter((a) => a.workflow_id === WF) as unknown as ActionRequest[];
}

function workflowRow() {
  return h.state.workflows[0];
}

function queueOutput(): ApApprovalQueue | null {
  const row = h.state.workflow_steps.find((s) => s.step_key === "approval_queue");
  return (row?.output as ApApprovalQueue) ?? null;
}

/** What the decide route does: resolve, then resume if nothing is left pending. */
async function approve(ids: string[]) {
  const db = createAdminClient();
  for (const id of ids) {
    await resolveAction(db, {
      actionId: id,
      workflowId: WF,
      decision: "approve",
      approverId: REVIEWER,
    });
  }
  const pending = (await listActions(db, WF)).filter((a) => a.status === "pending");
  if (pending.length === 0) {
    workflowRow().status = "running";
    await runWorkflow(WF);
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-07-01T12:00:00Z"));
  for (const key of Object.keys(h.state)) h.state[key] = [];
  for (const key of Object.keys(h.storage)) delete h.storage[key];
});

afterEach(() => vi.useRealTimers());

/* -------------------------------------------------------------------------- */

describe("AP end-to-end authorization walkthrough", () => {
  it("suspends on a fresh org, clears via a standing rule, and commits only authorized payments", async () => {
    seed();

    /* --- 1. Fresh org: the run suspends with one pending action per payable invoice --- */
    await runWorkflow(WF);

    expect(workflowRow().status).toBe("awaiting_approval");
    expect(workflowRow().error_message).toBeNull();
    expect(queueOutput()).toBeNull(); // nothing committed

    const gated = h.state.workflow_steps.find((s) => s.step_key === "approval_queue");
    expect(gated?.status).toBe("awaiting_approval");
    // Upstream steps completed and are not re-run.
    expect(
      h.state.workflow_steps.filter((s) => s.status === "complete").map((s) => s.step_key).sort(),
    ).toEqual(["flag_invoices", "match_invoices", "parse_invoices", "parse_pos"]);

    const pending = actions();
    expect(pending.length).toBeGreaterThan(1);
    expect(pending.every((a) => a.status === "pending")).toBe(true);
    expect(pending.every((a) => a.action_type === "approve_invoice_payment")).toBe(true);
    expect(pending.every((a) => a.risk_class === "moves_money")).toBe(true);
    // Every action is bound to a real invoice with a real vendor and amount.
    expect(pending.every((a) => a.counterparty !== null && (a.amount_cents ?? 0) > 0)).toBe(true);

    /* --- 2. Approve one by hand, then mint a standing rule bound by an amount cap --- */
    const amounts = pending.map((a) => a.amount_cents ?? 0).sort((a, b) => a - b);
    // A cap that covers some pending payments but deliberately not all of them.
    const cap = amounts[Math.floor(amounts.length / 2)];
    const first = pending.find((a) => (a.amount_cents ?? 0) > cap) ?? pending[0];
    const coveredByCap = pending.filter((a) => a.id !== first.id && (a.amount_cents ?? 0) <= cap);
    const aboveCap = pending.filter((a) => a.id !== first.id && (a.amount_cents ?? 0) > cap);
    expect(coveredByCap.length).toBeGreaterThan(0);
    expect(aboveCap.length).toBeGreaterThan(0);

    const db = createAdminClient();
    const resolveRes = await resolveAction(db, {
      actionId: first.id,
      workflowId: WF,
      decision: "approve",
      approverId: REVIEWER,
      comment: "checked against the PO",
    });
    expect(resolveRes.ok).toBe(true);

    // Exactly once: a second responder cannot overwrite that decision.
    const second = await resolveAction(db, {
      actionId: first.id,
      workflowId: WF,
      decision: "reject",
      approverId: "user-other",
    });
    expect(second.ok).toBe(false);

    h.state.approval_rules.push({
      id: "rule-under-cap",
      org_id: ORG,
      scope: "standing",
      workflow_id: null,
      action_type: "approve_invoice_payment",
      target_kind: "invoice",
      target_id: null,
      counterparty: null, // bound by the cap alone — still a bounded grant (D-A6)
      max_amount_cents: cap,
      note: "routine payments under the cap",
      created_by: REVIEWER,
      created_at: "2026-07-24T10:00:00.000Z",
      expires_at: null,
      consumed_at: null,
      revoked_at: null,
      revoked_by: null,
    });
    const cleared = await reevaluatePending(db, { workflowId: WF, orgId: ORG });

    // Everything the grant covers cleared with no human; nothing above the cap did.
    expect(cleared).toHaveLength(coveredByCap.length);
    expect(cleared.every((a) => a.status === "auto_approved")).toBe(true);
    expect(cleared.every((a) => a.standing_rule_id === "rule-under-cap")).toBe(true);
    expect(actions().filter((a) => a.status === "pending").map((a) => a.id).sort()).toEqual(
      aboveCap.map((a) => a.id).sort(),
    );

    /* --- 3. Approve the remainder → the run resumes and completes --- */
    await approve(aboveCap.map((a) => a.id));

    expect(workflowRow().status).toBe("awaiting_review");
    const queue = queueOutput()!;
    const authorized = actions().filter(
      (a) => a.status === "approved" || a.status === "auto_approved",
    );
    expect(queue.autoApprove).toHaveLength(authorized.length);
    expect(queue.stats.autoApproveCount).toBe(authorized.length);
    // Each committed payment records how it was authorized, and the chain is closed.
    expect(queue.autoApprove.every((a) => a.authorization?.authorized === true)).toBe(true);
    expect(queue.autoApprove.some((a) => a.authorization?.source === "standing_rule")).toBe(true);
    expect(queue.autoApprove.some((a) => a.authorization?.source === "human")).toBe(true);
    expect(actions().every((a) => a.committed_at !== null)).toBe(true);

    // No action was duplicated across the two suspensions and the resume.
    expect(new Set(actions().map((a) => a.action_key)).size).toBe(actions().length);

    const audit = h.state.audit_log.map((a) => a.action);
    for (const expected of [
      "action_proposed",
      "approval_requested",
      "approval_resolved",
      "action_auto_approved",
      "workflow_suspended",
      "action_committed",
      "workflow_awaiting_review",
    ]) {
      expect(audit).toContain(expected);
    }
  });

  it("denies an oversized payment un-overridably and still finishes the run", async () => {
    seed();
    // A ceiling low enough to deny the largest invoices outright.
    h.state.org_approval_policies.push({
      org_id: ORG,
      hard_deny_above_cents: 5_000_000, // $50k
      auto_approve_max_cents: null,
      require_known_counterparty: false,
      approved_counterparties: [],
      require_separate_approver: false,
      updated_by: null,
      updated_at: null,
    });

    await runWorkflow(WF);

    const denied = actions().filter((a) => a.status === "denied");
    expect(denied.length).toBeGreaterThan(0);
    expect(denied.every((a) => a.decision_source === "ceiling")).toBe(true);

    // No approval can release a denied action.
    const db = createAdminClient();
    const res = await resolveAction(db, {
      actionId: denied[0].id,
      workflowId: WF,
      decision: "approve",
      approverId: REVIEWER,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_overridable");

    // Approve everything still pending; the run completes without the denied payments.
    await approve(actions().filter((a) => a.status === "pending").map((a) => a.id));

    expect(workflowRow().status).toBe("awaiting_review");
    const queue = queueOutput()!;
    const deniedIds = new Set(denied.map((a) => a.target_id));
    expect(queue.autoApprove.some((a) => deniedIds.has(a.invoiceId))).toBe(false);
    // Each denied payment is visible as withheld, with the ceiling reason attached.
    for (const id of deniedIds) {
      const held = queue.holdForReview.find((held) => held.invoice.id === id);
      expect(held?.authorization?.status).toBe("denied");
      expect(held?.authorization?.reason).toMatch(/hard ceiling/i);
    }
    expect(h.state.audit_log.map((a) => a.action)).toContain("action_denied_by_ceiling");
    expect(h.state.audit_log.map((a) => a.action)).toContain("action_withheld");
  });
});
