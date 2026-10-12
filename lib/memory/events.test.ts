import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { InteractionRateError, listInteractionEvents, recordPageView } from "./events";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "11111111-1111-4111-8111-111111111111";
const ID = "33333333-3333-4333-8333-333333333333";
function database(data: unknown, error: unknown = null) {
  const rpc = vi.fn().mockResolvedValue({ data, error });
  return { rpc, db: { rpc } as unknown as SupabaseClient };
}

describe("private interaction history", () => {
  it("records only a route and stable event ID with trusted identity", async () => {
    const mock = database({ id: ID, duplicate: false });
    expect(await recordPageView(mock.db, ORG, USER, { id: ID, action: "page_view", route: "/settings/memory" })).toEqual({ id: ID, duplicate: false });
    expect(mock.rpc).toHaveBeenCalledWith("record_page_interaction", { p_org: ORG, p_user: USER, p_id: ID, p_route: "/settings/memory" });
  });
  it("rejects queries, fragments, external URLs and unapproved paths before database access", async () => {
    const mock = database(null);
    for (const route of ["/data?key=secret", "/data#secret", "https://example.com/data", "/api/llm/configs", "/settings/unknown"]) {
      await expect(recordPageView(mock.db, ORG, USER, { id: ID, action: "page_view", route })).rejects.toThrow(/approved application pathnames/);
    }
    expect(mock.rpc).not.toHaveBeenCalled();
  });
  it("preserves idempotent replies and gives bounded, safe rate and target errors", async () => {
    const mock = database({ id: ID, duplicate: true });
    expect((await recordPageView(mock.db, ORG, USER, { id: ID, action: "page_view", route: "/data" })).duplicate).toBe(true);
    mock.rpc.mockResolvedValue({ data: null, error: { message: "interaction_rate_limited" } });
    await expect(recordPageView(mock.db, ORG, USER, { id: ID, action: "page_view", route: "/data" })).rejects.toBeInstanceOf(InteractionRateError);
    mock.rpc.mockResolvedValue({ data: null, error: { code: "P0002", message: "secret foreign target" } });
    await expect(recordPageView(mock.db, ORG, USER, { id: ID, action: "page_view", route: `/workflows/${ID}` })).rejects.toThrow("The event or its target is unavailable for this user.");
  });
  it("uses timestamp and UUID together so equal-time events are not skipped", async () => {
    const rows = [{ id: ID, occurredAt: "2026-05-12T12:00:00.123456+00:00", action: "source.uploaded" }, { id: USER, occurredAt: "2026-05-12T12:00:00.123456+00:00", action: "question.asked" }];
    const mock = database(rows);
    const page = await listInteractionEvents(mock.db, ORG, USER, { limit: 1 });
    expect(page.events).toEqual([rows[0]]);
    expect(page.nextCursor).toEqual({ before: rows[0].occurredAt, beforeId: ID });
    mock.rpc.mockResolvedValue({ data: [], error: null });
    await listInteractionEvents(mock.db, ORG, USER, { limit: 1, ...page.nextCursor! });
    expect(mock.rpc).toHaveBeenLastCalledWith("list_interaction_events", { p_org: ORG, p_user: USER, p_limit: 2, p_before: rows[0].occurredAt, p_before_id: ID });
  });
  it("rejects unbounded history pages and incomplete cursors", async () => {
    const mock = database([]);
    await expect(listInteractionEvents(mock.db, ORG, USER, { limit: 101 })).rejects.toThrow(/100/);
    await expect(listInteractionEvents(mock.db, ORG, USER, { before: "2026-05-12T00:00:00Z" })).rejects.toThrow(/both timestamp and event ID/);
    expect(mock.rpc).not.toHaveBeenCalled();
  });
});
