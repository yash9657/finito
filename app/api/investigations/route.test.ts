import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
const mocked = vi.hoisted(() => ({ access: vi.fn(), model: vi.fn(), create: vi.fn(), execute: vi.fn(), waitUntil: vi.fn() }));
vi.mock("@/lib/api/guard", () => ({ requireOrgAccess: mocked.access, jsonError: (error: string, status: number) => NextResponse.json({ error }, { status }) }));
vi.mock("@/lib/llm/router", () => ({ resolveInvestigatorModel: mocked.model }));
vi.mock("@/lib/harness/agent/service", () => ({ createInvestigation: mocked.create, executeInvestigation: mocked.execute, listInvestigations: vi.fn() }));
vi.mock("@vercel/functions", () => ({ waitUntil: mocked.waitUntil }));
import { POST, maxDuration } from "@/app/api/investigations/route";

beforeEach(() => {
  mocked.access.mockResolvedValue({ ok: true, admin: {}, profile: { org_id: "org-a", id: "user-a" } });
  mocked.model.mockResolvedValue({ ok: true, providerId: "fireworks", model: "synthetic-model" });
  mocked.create.mockImplementation(async ({ budget }) => ({ workflowId: "wf-1", budget }));
  mocked.execute.mockResolvedValue({ status: "answered" });
});
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });
const request = (body: unknown) => new NextRequest("https://finflow.test/api/investigations", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

describe("investigation execution lifetime", () => {
  it("retains a single execution promise and returns the effective hosted budget", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const response = await POST(request({ question: "Why did cash decline?", budget: { maxWallClockMs: 900_000 } }));
    const body = await response.json();
    expect(response.status).toBe(201);
    expect(maxDuration).toBe(300);
    expect(body.budget.maxWallClockMs).toBe(270_000);
    expect(body.budgetAdjustment).toContain("270 seconds");
    expect(mocked.execute).toHaveBeenCalledTimes(1);
    expect(mocked.execute.mock.calls[0][0].budget).toEqual(body.budget);
    expect(mocked.waitUntil).toHaveBeenCalledWith(expect.any(Promise));
  });

  it("never relaunches the run when the host lifecycle hook is unavailable", async () => {
    mocked.waitUntil.mockImplementation(() => { throw new Error("no host context"); });
    const response = await POST(request({ question: "Why did cash decline?" }));
    expect(response.status).toBe(201);
    expect(mocked.execute).toHaveBeenCalledTimes(1);
  });

  it("returns a safe service error before creating a run when resolution fails", async () => {
    mocked.model.mockRejectedValue(new Error("private database detail"));
    const response = await POST(request({ question: "Why did cash decline?" }));
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("private database detail");
    expect(mocked.create).not.toHaveBeenCalled();
  });

  it("rejects an oversized question before spending tokens", async () => {
    const response = await POST(request({ question: "x".repeat(8_001) }));
    expect(response.status).toBe(400);
    expect(mocked.model).not.toHaveBeenCalled();
  });
});
