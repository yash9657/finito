import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { deletePreference, getMemorySettings, listPreferences, normalizeMemoryDate, savePreference, searchMemory } from "./store";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ID = "33333333-3333-4333-8333-333333333333";
const preference = { id: ID, org_id: ORG, user_id: USER, content: "Use fiscal quarters ending in March", status: "active", source_question_id: null, source_question: null, created_at: "2026-05-12T00:00:00Z", updated_at: "2026-05-12T00:00:00Z" };
const coverage = { totalSources: 3, indexedSources: 1, pendingSources: 1, failedSources: 1 };

function database(enabled = true) {
  const chain = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(), maybeSingle: vi.fn().mockResolvedValue({ data: { org_id: ORG, user_id: USER, enabled }, error: null }), limit: vi.fn().mockResolvedValue({ data: [preference], error: null }) };
  const rpc = vi.fn().mockResolvedValue({ data: { results: [], coverage }, error: null });
  const db = { from: vi.fn().mockReturnValue(chain), rpc } as unknown as SupabaseClient;
  return { db, chain, rpc };
}

describe("durable memory boundaries", () => {
  it("reads preferences using both organization and user identity, excluding deleted rows", async () => {
    const mock = database();
    expect(await listPreferences(mock.db, ORG, USER)).toEqual([expect.objectContaining({ id: ID, content: preference.content, createdAt: preference.created_at })]);
    expect(mock.chain.eq).toHaveBeenCalledWith("org_id", ORG);
    expect(mock.chain.eq).toHaveBeenCalledWith("user_id", USER);
    expect(mock.chain.eq).toHaveBeenCalledWith("status", "active");
    mock.chain.limit.mockResolvedValue({ data: [{ ...preference, user_id: OTHER }], error: null });
    await expect(listPreferences(mock.db, ORG, USER)).rejects.toThrow(/identity/);
    mock.chain.limit.mockResolvedValue({ data: [{ ...preference, status: "deleted" }], error: null });
    await expect(listPreferences(mock.db, ORG, USER)).rejects.toThrow(/deletion state/);
  });

  it("stops automatic recall when disabled while allowing an explicit user search", async () => {
    const mock = database(false);
    expect(await searchMemory(mock.db, ORG, USER, { query: "quarter" })).toMatchObject({ enabled: false, results: [], hasMore: false });
    expect(mock.rpc).not.toHaveBeenCalled();
    await searchMemory(mock.db, ORG, USER, { query: "quarter", explicit: true });
    expect(mock.rpc).toHaveBeenCalledWith("search_durable_memory", expect.objectContaining({ p_org: ORG, p_user: USER }));
  });

  it("preserves five-month-old provenance, sends bounded date filters, and exposes incomplete indexing", async () => {
    const mock = database();
    const oldQuestion = { id: ID, kind: "question", title: "May shipment variance", excerpt: "May shipment variance was reviewed.", createdAt: "2026-05-12T00:00:00Z", updatedAt: "2026-05-12T00:01:00Z", rank: 0.7, workflowId: ID, sourceId: null, tableId: null, originalRow: null, citation: null };
    mock.rpc.mockResolvedValue({ data: { results: [oldQuestion, { ...oldQuestion, id: OTHER }], coverage }, error: null });
    const result = await searchMemory(mock.db, ORG, USER, { query: "shipment variance", kinds: ["question", "source"], since: "2026-05-01", until: "2026-05-31", limit: 1 });
    expect(mock.rpc).toHaveBeenCalledWith("search_durable_memory", expect.objectContaining({ p_since: "2026-05-01T00:00:00.000Z", p_until: "2026-05-31T23:59:59.999Z", p_limit: 2, p_kinds: ["question", "source"] }));
    expect(result).toMatchObject({ results: [oldQuestion], hasMore: true, coverage });
    expect(result.results[0].createdAt).toBe("2026-05-12T00:00:00Z");
  });

  it("requires provenance for chat writes and rejects wrong-owner write responses", async () => {
    const mock = database();
    await expect(savePreference(mock.db, ORG, USER, { content: "Use ISO dates", automatic: true })).rejects.toThrow(/original question/);
    expect(mock.rpc).not.toHaveBeenCalled();
    mock.rpc.mockResolvedValue({ data: { ...preference, source_question_id: ID, source_question: "Remember to use ISO dates." }, error: null });
    expect(await savePreference(mock.db, ORG, USER, { content: "Use ISO dates", sourceQuestionId: ID, automatic: true })).toMatchObject({ sourceQuestionId: ID, sourceQuestion: "Remember to use ISO dates." });
    expect(mock.rpc).toHaveBeenCalledWith("save_memory_preference", expect.objectContaining({ p_user: USER, p_org: ORG, p_question: ID, p_automatic: true }));
    mock.rpc.mockResolvedValue({ data: { ...preference, user_id: OTHER }, error: null });
    await expect(savePreference(mock.db, ORG, USER, { content: "Use ISO dates" })).rejects.toThrow(/identity/);
  });

  it("surfaces disabled automatic writes and deletes only the current user's scoped preference", async () => {
    const mock = database();
    mock.rpc.mockResolvedValue({ data: null, error: { message: "memory_disabled" } });
    await expect(savePreference(mock.db, ORG, USER, { content: "Use ISO dates", sourceQuestionId: ID, automatic: true })).rejects.toMatchObject({ code: "disabled" });
    mock.rpc.mockResolvedValue({ data: true, error: null });
    await deletePreference(mock.db, ORG, USER, ID);
    expect(mock.rpc).toHaveBeenCalledWith("delete_memory_preference", { p_org: ORG, p_user: USER, p_id: ID });
    mock.rpc.mockResolvedValue({ data: false, error: null });
    await expect(deletePreference(mock.db, ORG, USER, ID)).rejects.toMatchObject({ code: "not_found" });
  });

  it("rejects huge inputs, reversed or invalid dates, and unsupported search types before querying", async () => {
    const mock = database();
    await expect(searchMemory(mock.db, ORG, USER, { query: "x".repeat(501) })).rejects.toThrow(/500/);
    await expect(savePreference(mock.db, ORG, USER, { content: "x".repeat(2001) })).rejects.toThrow(/2,000/);
    await expect(searchMemory(mock.db, ORG, USER, { query: "variance", since: "2026-06-01", until: "2026-05-01" })).rejects.toThrow(/start date/);
    expect(() => normalizeMemoryDate("2026-02-30", false)).toThrow(/invalid date/);
    await expect(searchMemory(mock.db, ORG, USER, { query: "variance", kinds: ["source", "source"] })).rejects.toThrow(/distinct/);
    expect(mock.rpc).not.toHaveBeenCalled();
  });

  it("fails closed on unavailable or cross-user settings instead of silently enabling recall", async () => {
    const mock = database();
    mock.chain.maybeSingle.mockResolvedValue({ data: null, error: { message: "secret database URL" } });
    await expect(getMemorySettings(mock.db, ORG, USER)).rejects.toThrow("Memory settings are unavailable. Apply the memory migration and retry.");
    mock.chain.maybeSingle.mockResolvedValue({ data: { org_id: ORG, user_id: OTHER, enabled: true }, error: null });
    await expect(getMemorySettings(mock.db, ORG, USER)).rejects.toThrow(/identity/);
  });
});
