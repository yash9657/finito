import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { DELETE, GET } from "./route";
import { GET as catalog, POST } from "../route";

const mocks = vi.hoisted(() => ({ access: vi.fn(), stored: vi.fn(), load: vi.fn(), list: vi.fn() }));
vi.mock("@/lib/api/guard", () => ({ requireOrgAccess: mocks.access }));
vi.mock("@/lib/data/store", () => ({ DATA_SOURCE_BUCKET: "analysis-sources", getStoredDataSource: mocks.stored, loadDataSources: mocks.load, listDataSources: mocks.list, sourceMetadata: (source: unknown) => source, dataSourcePath: vi.fn(), sourceManifest: vi.fn() }));
const ID = "11111111-1111-4111-8111-111111111111";
const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "22222222-2222-4222-8222-222222222222";
const params = { params: Promise.resolve({ id: ID }) };
const request = (query = "") => new NextRequest(`http://localhost/api/data-sources/${ID}${query}`);
const row = (number: number, value: string) => ({ sourceId: `src:${ID}/t0/r${number}`, originalRow: number, values: { Label: value } });

describe("data source routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.access.mockResolvedValue({ ok: true, admin: {}, profile: { id: USER, org_id: ORG, role: "analyst" } });
    mocks.stored.mockResolvedValue({ id: ID, status: "active", created_by: USER, storage_path: `${ORG}/${ID}/source` });
    mocks.load.mockResolvedValue([{ id: ID, tables: [{ id: "t0", name: "Unfamiliar data", columns: ["Label"], headerRow: 3, header: row(3, "Label"), preamble: [row(1, "Preamble")], rows: [row(4, "A"), row(12, "B"), row(31, "C")], rowCount: 3 }] }]);
    mocks.list.mockResolvedValue([]);
  });

  it("requires authentication before metadata or storage access", async () => {
    mocks.access.mockResolvedValue({ ok: false, response: NextResponse.json({ error: "Not authenticated" }, { status: 401 }) });
    expect((await GET(request("?preview=1"), params)).status).toBe(401);
    expect((await DELETE(request(), params)).status).toBe(401);
    expect(mocks.stored).not.toHaveBeenCalled();
  });

  it("positions a citation by its original row, not its compacted array index", async () => {
    const response = await GET(request("?tableId=t0&originalRow=12&limit=1"), params);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.table.offset).toBe(1);
    expect(body.table.rows).toEqual([row(12, "B")]);
    expect(body.table.header).toEqual(row(3, "Label"));
    expect(body.table.preamble).toEqual([row(1, "Preamble")]);
    expect(mocks.load).toHaveBeenCalledWith({}, ORG, [ID]);
    expect(mocks.stored).toHaveBeenCalledWith({}, ORG, ID);
  });

  it("resolves introductory and header citations, rejects missing cited rows and excessive page sizes", async () => {
    expect((await GET(request("?originalRow=1"), params)).status).toBe(200);
    expect((await GET(request("?originalRow=3"), params)).status).toBe(200);
    expect((await GET(request("?originalRow=2"), params)).status).toBe(404);
    expect((await GET(request("?preview=1&limit=101"), params)).status).toBe(400);
  });

  it("labels clipped previews without changing the original source", async () => {
    const original = row(4, "A".repeat(3000));
    mocks.load.mockResolvedValue([{ tables: [{ id: "t0", name: "Long", columns: ["Label"], headerRow: null, preamble: [], rows: [original], rowCount: 1 }] }]);
    const response = await GET(request("?preview=1"), params);
    const body = await response.json();
    expect(body.table.previewTruncated).toBe(true);
    expect(body.table.rows[0].values.Label).toContain("[preview trimmed]");
    expect(original.values.Label.length).toBe(3000);
  });

  it("exposes read-only catalog capabilities and enforces them on writes", async () => {
    mocks.access.mockResolvedValue({ ok: true, admin: {}, profile: { id: USER, org_id: ORG, role: "reviewer" } });
    const response = await catalog(new NextRequest("http://localhost/api/data-sources"));
    expect((await response.json()).viewer).toEqual({ id: USER, canUpload: false, isAdmin: false });
    expect((await POST(request())).status).toBe(403);
    expect((await DELETE(request(), params)).status).toBe(403);
    expect(mocks.stored).not.toHaveBeenCalled();
  });

  it("rejects deleting another uploader's source before storage access", async () => {
    mocks.stored.mockResolvedValue({ id: ID, status: "active", created_by: "another-user" });
    expect((await DELETE(request(), params)).status).toBe(403);
  });

  it("tombstones within organization scope before deleting bytes and keeps failed removal retryable", async () => {
    const query = { update: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), select: vi.fn().mockReturnThis(), maybeSingle: vi.fn().mockResolvedValue({ data: { id: ID }, error: null }), delete: vi.fn().mockReturnThis() };
    const remove = vi.fn().mockResolvedValue({ error: { message: "storage unavailable" } });
    const admin = { from: vi.fn().mockReturnValue(query), storage: { from: vi.fn().mockReturnValue({ remove }) } };
    mocks.access.mockResolvedValue({ ok: true, admin, profile: { id: USER, org_id: ORG, role: "analyst" } });
    const response = await DELETE(request(), params);
    expect(response.status).toBe(503);
    expect(query.update).toHaveBeenCalledWith({ status: "deleting" });
    expect(query.eq).toHaveBeenCalledWith("org_id", ORG);
    expect(query.eq).toHaveBeenCalledWith("id", ID);
    expect(remove).toHaveBeenCalledWith([`${ORG}/${ID}/source`]);
    expect(query.delete).not.toHaveBeenCalled();
    expect((await response.json()).error).toContain("already unavailable for new analyses");
  });
});
