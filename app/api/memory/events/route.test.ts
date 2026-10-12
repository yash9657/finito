import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { GET, POST } from "./route";
import { InteractionRateError } from "@/lib/memory/events";

const mocks = vi.hoisted(() => ({ access: vi.fn(), record: vi.fn(), list: vi.fn() }));
vi.mock("@/lib/api/guard", () => ({ requireOrgAccess: mocks.access }));
vi.mock("@/lib/memory/events", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/memory/events")>(), recordPageView: mocks.record, listInteractionEvents: mocks.list }));
const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "11111111-1111-4111-8111-111111111111";
const ID = "33333333-3333-4333-8333-333333333333";
const request = (body: unknown) => new NextRequest("http://localhost/api/memory/events", { method: "POST", body: JSON.stringify(body) });
describe("interaction event API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.access.mockResolvedValue({ ok: true, admin: {}, profile: { org_id: ORG, id: USER, role: "reviewer" } });
    mocks.record.mockResolvedValue({ id: ID, duplicate: false });
    mocks.list.mockResolvedValue({ events: [], hasMore: false, nextCursor: null });
  });
  it("accepts a navigation observation for the authenticated user", async () => {
    const body = { id: ID, action: "page_view", route: "/data" };
    expect((await POST(request(body))).status).toBe(200);
    expect(mocks.record).toHaveBeenCalledWith({}, ORG, USER, body);
  });
  it("rejects supplied identity, arbitrary metadata and fabricated business actions", async () => {
    for (const body of [{ id: ID, action: "page_view", route: "/data", userId: ID }, { id: ID, action: "page_view", route: "/data", metadata: { apiKey: "secret" } }, { id: ID, action: "preference.created", route: "/data" }]) expect((await POST(request(body))).status).toBe(400);
    expect(mocks.record).not.toHaveBeenCalled();
  });
  it("returns a retry bound for rate limiting and tuple history cursors", async () => {
    mocks.record.mockRejectedValue(new InteractionRateError());
    const response = await POST(request({ id: ID, action: "page_view", route: "/data" }));
    expect(response.status).toBe(429);expect(response.headers.get("Retry-After")).toBe("60");
    expect((await GET(new NextRequest(`http://localhost/api/memory/events?limit=25&before=2026-05-12T00:00:00Z&beforeId=${ID}`))).status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith({}, ORG, USER, { limit: 25, before: "2026-05-12T00:00:00Z", beforeId: ID });
  });
  it("authenticates before reading or writing history", async () => {
    mocks.access.mockResolvedValue({ ok: false, response: NextResponse.json({ error: "Not authenticated" }, { status: 401 }) });
    expect((await GET(new NextRequest("http://localhost/api/memory/events"))).status).toBe(401);
    expect((await POST(request({ id: ID, action: "page_view", route: "/data" }))).status).toBe(401);
    expect(mocks.list).not.toHaveBeenCalled();expect(mocks.record).not.toHaveBeenCalled();
  });
});
