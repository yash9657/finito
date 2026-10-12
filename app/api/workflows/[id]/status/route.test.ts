import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocked = vi.hoisted(() => ({ access: vi.fn(), actions: vi.fn() }));
vi.mock("@/lib/api/guard", () => ({ requireWorkflowAccess: mocked.access }));
vi.mock("@/lib/approvals/service", () => ({ listActions: mocked.actions }));
import { GET } from "@/app/api/workflows/[id]/status/route";

afterEach(() => vi.resetAllMocks());
describe("observational workflow status", () => {
  it.each(["analyst", "reviewer", "admin"])("does not mutate a long-running step when polled by %s", async role => {
    const update = vi.fn(() => { throw new Error("A status poll must never write"); });
    const step = { id: "step-1", step_number: 1, status: "running", started_at: "2020-01-01T00:00:00Z" };
    const admin = { from(table: string) {
      const data = table === "workflow_steps" ? [step] : null;
      const result = { data, error: null };
      const chain = { select: () => chain, eq: () => chain, order: () => chain, limit: () => chain, maybeSingle: async () => result, update, then: <T>(resolve: (value: typeof result) => T) => Promise.resolve(result).then(resolve) };
      return chain;
    } };
    mocked.access.mockResolvedValue({ ok: true, admin, profile: { role }, workflow: { id: "wf-1", name: "Cash", type: "reconciliation", status: "running" } });
    mocked.actions.mockResolvedValue([]);
    const response = await GET(new NextRequest("https://finflow.test/api/workflows/wf-1/status"), { params: Promise.resolve({ id: "wf-1" }) });
    const result = await response.json();
    expect(result.workflow.status).toBe("running");
    expect(result.steps[0].status).toBe("running");
    expect(result.viewer.canReview).toBe(role !== "analyst");
    expect(update).not.toHaveBeenCalled();
  });
});
