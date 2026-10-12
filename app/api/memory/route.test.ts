import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { GET, PATCH } from "./route";
import { POST as addPreference } from "./preferences/route";
import { PATCH as editPreference, DELETE as removePreference } from "./preferences/[id]/route";
import { GET as search } from "./search/route";

const mocks = vi.hoisted(() => ({ access: vi.fn(), settings: vi.fn(), preferences: vi.fn(), enabled: vi.fn(), save: vi.fn(), remove: vi.fn(), search: vi.fn() }));
vi.mock("@/lib/api/guard", () => ({ requireOrgAccess: mocks.access }));
vi.mock("@/lib/memory/store", () => ({ getMemorySettings: mocks.settings, listPreferences: mocks.preferences, setMemoryEnabled: mocks.enabled, savePreference: mocks.save, deletePreference: mocks.remove, searchMemory: mocks.search }));
const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "11111111-1111-4111-8111-111111111111";
const ID = "33333333-3333-4333-8333-333333333333";
const params = { params: Promise.resolve({ id: ID }) };
const request = (body: unknown, method = "POST") => new NextRequest("http://localhost/api/memory", { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } });

describe("memory API identity and controls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.access.mockResolvedValue({ ok: true, admin: {}, profile: { org_id: ORG, id: USER, role: "analyst" } });
    mocks.settings.mockResolvedValue({ enabled: false });
    mocks.preferences.mockResolvedValue([]);
    mocks.enabled.mockResolvedValue({ enabled: true });
    mocks.save.mockResolvedValue({ id: ID, content: "Use ISO dates" });
    mocks.remove.mockResolvedValue(undefined);
    mocks.search.mockResolvedValue({ enabled: false, results: [], hasMore: false, coverage: {} });
  });

  it("returns settings and correction controls for the authenticated user only", async () => {
    const response = await GET();
    expect(await response.json()).toEqual({ enabled: false, preferences: [], viewer: { canReindex: true } });
    expect(mocks.settings).toHaveBeenCalledWith({}, ORG, USER);
    expect(mocks.preferences).toHaveBeenCalledWith({}, ORG, USER);
  });

  it("ignores supplied user/organization identity when changing settings or preferences", async () => {
    expect((await PATCH(request({ enabled: true, userId: ID, orgId: ID }, "PATCH"))).status).toBe(200);
    expect(mocks.enabled).toHaveBeenCalledWith({}, ORG, USER, true);
    expect((await addPreference(request({ content: "Use ISO dates", userId: ID, orgId: ID }))).status).toBe(201);
    expect(mocks.save).toHaveBeenCalledWith({}, ORG, USER, { content: "Use ISO dates" });
    expect((await editPreference(request({ content: "Use ISO dates", userId: ID }, "PATCH"), params)).status).toBe(200);
    expect(mocks.save).toHaveBeenLastCalledWith({}, ORG, USER, { id: ID, content: "Use ISO dates" });
  });

  it("scopes deletion to the signed-in user and keeps manual search available when recall is disabled", async () => {
    expect((await removePreference(request({}, "DELETE"), params)).status).toBe(200);
    expect(mocks.remove).toHaveBeenCalledWith({}, ORG, USER, ID);
    const response = await search(new NextRequest("http://localhost/api/memory/search?q=May&kinds=source,question&since=2026-05-01&until=2026-05-31"));
    expect(response.status).toBe(200);
    expect(mocks.search).toHaveBeenCalledWith({}, ORG, USER, expect.objectContaining({ query: "May", kinds: ["source", "question"], since: "2026-05-01", until: "2026-05-31", explicit: true }));
  });

  it("rejects invalid and excessive preference bodies before mutation", async () => {
    expect((await PATCH(request({ enabled: "false" }, "PATCH"))).status).toBe(400);
    expect((await addPreference(request({ content: "x".repeat(2001) }))).status).toBe(400);
    expect((await addPreference(request({ content: "x".repeat(34 * 1024) }))).status).toBe(400);
    expect(mocks.enabled).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("does not run any memory query before authentication succeeds", async () => {
    mocks.access.mockResolvedValue({ ok: false, response: NextResponse.json({ error: "Not authenticated" }, { status: 401 }) });
    expect((await GET()).status).toBe(401);
    expect((await PATCH(request({ enabled: true }, "PATCH"))).status).toBe(401);
    expect((await addPreference(request({ content: "Use ISO dates" }))).status).toBe(401);
    expect((await removePreference(request({}, "DELETE"), params)).status).toBe(401);
    expect(mocks.settings).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});
