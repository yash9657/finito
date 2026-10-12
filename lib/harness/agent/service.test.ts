import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { InvestigationOutcome } from "@/lib/harness/agent/loop";

const mocked = vi.hoisted(() => ({ run: vi.fn(), audit: vi.fn(), event: vi.fn() }));
vi.mock("@/lib/harness/agent/loop", () => ({ runInvestigation: mocked.run, clampBudget: vi.fn() }));
vi.mock("@/lib/audit", () => ({ writeAudit: mocked.audit }));
vi.mock("@/lib/harness/events", () => ({ appendEvent: mocked.event }));
import { executeInvestigation } from "@/lib/harness/agent/service";

function outcome(overrides: Partial<InvestigationOutcome> = {}): InvestigationOutcome {
  return { status: "answered", reason: "answered", answer: null, turnsUsed: 2, tokensIn: 100, tokensOut: 50, recommendations: [], ...overrides };
}

function database(failingTable?: string, missing = false) {
  const writes: { table: string; values: Record<string, unknown>; filters: Record<string, unknown> }[] = [];
  const db = { from(table: string) {
    const entry = { table, values: {} as Record<string, unknown>, filters: {} as Record<string, unknown> };
    const result = () => table === failingTable ? { data: null, error: missing ? null : { message: "database unavailable" } } : { data: { id: "wf-1", workflow_id: "wf-1" }, error: null };
    const chain = {
      update(values: Record<string, unknown>) { entry.values = values; writes.push(entry); return chain; },
      eq(key: string, value: unknown) { entry.filters[key] = value; return chain; },
      select: () => chain,
      maybeSingle: async () => result(),
      then: <T>(resolve: (value: ReturnType<typeof result>) => T) => Promise.resolve(result()).then(resolve),
    };
    return chain;
  } } as unknown as SupabaseClient;
  return { db, writes };
}

beforeEach(() => { mocked.run.mockResolvedValue(outcome()); mocked.audit.mockResolvedValue(undefined); mocked.event.mockResolvedValue({}); });
afterEach(() => vi.resetAllMocks());

describe("investigation persistence", () => {
  it("forwards trusted user identity and persists actual retained source selections", async () => {
    mocked.run.mockResolvedValue(outcome({ sourceIds: ["historical-source"] }));
    const { db, writes } = database();
    await executeInvestigation({ db, workflowId: "wf-1", orgId: "org-a", userId: "signed-in-user", question: "Recall the May comparison" });
    expect(mocked.run).toHaveBeenCalledWith(expect.objectContaining({ userId: "signed-in-user", orgId: "org-a" }));
    expect(writes.find((write) => write.table === "investigations")?.values.source_ids).toEqual(["historical-source"]);
    expect(writes.filter((write) => write.table === "workflows").every((write) => !("source_ids" in write.values))).toBe(true);
  });
  it("keeps a partial terminated answer awaiting review, never approved", async () => {
    const answer = { prose: "Partial finding", proseTemplate: "Partial finding", findings: [], figures: [], citations: [], partial: true };
    mocked.run.mockResolvedValue(outcome({ status: "terminated", reason: "max_turns", answer, error: "Reached turn limit" }));
    const { db, writes } = database();
    const result = await executeInvestigation({ db, workflowId: "wf-1", orgId: "org-a", question: "Why did it move?" });
    expect(result.status).toBe("terminated");
    expect(writes.find(write => write.table === "workflows")?.values).toMatchObject({ status: "awaiting_review", error_message: "Reached turn limit" });
    expect(writes.every(write => write.filters.org_id === "org-a")).toBe(true);
  });

  it("marks a terminated run with no answer as error", async () => {
    mocked.run.mockResolvedValue(outcome({ status: "terminated", reason: "max_tokens" }));
    const { db, writes } = database();
    await executeInvestigation({ db, workflowId: "wf-1", orgId: "org-a", question: "Why did it move?" });
    expect(writes.find(write => write.table === "workflows")?.values.status).toBe("error");
  });

  it.each([false, true])("fails closed when the investigation result cannot be saved (missing=%s)", async missing => {
    const { db, writes } = database("investigations", missing);
    await expect(executeInvestigation({ db, workflowId: "wf-1", orgId: "org-a", question: "Why did it move?" })).rejects.toThrow("persist investigation result");
    expect(writes.filter(write => write.table === "workflows").every(write => write.values.status === "error")).toBe(true);
    expect(mocked.audit).not.toHaveBeenCalled();
  });

  it("reports workflow projection failures instead of claiming persisted completion", async () => {
    const { db, writes } = database("workflows");
    await expect(executeInvestigation({ db, workflowId: "wf-1", orgId: "org-a", question: "Why did it move?" })).rejects.toThrow("persist investigation workflow status");
    expect(writes.at(-1)?.values.status).toBe("error");
  });

  it("marks the workflow error if its completion audit fails", async () => {
    mocked.audit.mockRejectedValue(new Error("audit unavailable"));
    const { db, writes } = database();
    await expect(executeInvestigation({ db, workflowId: "wf-1", orgId: "org-a", question: "Why did it move?" })).rejects.toThrow("completion audit");
    expect(writes.at(-1)?.values.status).toBe("error");
  });
});
