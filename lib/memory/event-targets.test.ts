import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { interactionTargets } from "./event-targets";
import type { InteractionEvent } from "./events";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SOURCE = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";
const MISSING = "33333333-3333-4333-8333-333333333333";
function event(id: string, fields: Partial<InteractionEvent> = {}): InteractionEvent {
  return { id, occurredAt: "2026-05-12T12:00:00Z", action: "page_view", entityType: "page", entityId: null, workflowId: null, sourceId: null, summary: "Visited an application page", actorKind: "user", metadata: {}, redacted: false, ...fields };
}
function database(results: Record<string, { data: unknown[] | null; error: unknown }>) {
  const queries: { table: string; filters: [string, unknown][]; ids: string[] }[] = [];
  const from = vi.fn((table: string) => {
    const query = { table, filters: [] as [string, unknown][], ids: [] as string[] };
    queries.push(query);
    const chain = {
      select: vi.fn(() => chain),
      eq: vi.fn((key: string, value: unknown) => { query.filters.push([key, value]); return chain; }),
      in: vi.fn((_key: string, ids: string[]) => { query.ids = ids; return Promise.resolve(results[table]); }),
    };
    return chain;
  });
  return { db: { from } as unknown as SupabaseClient, from, queries };
}

describe("current-access activity targets", () => {
  it("names approved pages without resolving arbitrary URLs, query strings or object keys", async () => {
    const mock = database({});
    const routes = ["/settings/memory", "/data", "https://example.com", "//example.com", "/data?source=secret", "/settings#secret", "__proto__", "constructor"];
    const result = await interactionTargets(mock.db, ORG, routes.map((route, i) => event(String(i), { metadata: { route } })));
    expect(result).toEqual({ "0": { label: "Memory & history", href: "/settings/memory" }, "1": { label: "Your data", href: "/data" } });
    expect(mock.from).not.toHaveBeenCalled();
  });
  it("resolves source names with organization and active-state filters and deduplicates reads", async () => {
    const mock = database({ data_sources: { data: [{ id: SOURCE, filename: "Helios close.csv" }], error: null } });
    const result = await interactionTargets(mock.db, ORG, [event("upload", { sourceId: SOURCE }), event("again", { sourceId: SOURCE }), event("gone", { sourceId: MISSING }), event("invalid", { sourceId: "../../secret" })]);
    expect(mock.queries).toEqual([{ table: "data_sources", filters: [["org_id", ORG], ["status", "active"]], ids: [SOURCE, MISSING] }]);
    expect(result).toEqual({ upload: { label: "Helios close.csv", href: `/data?source=${SOURCE}` }, again: { label: "Helios close.csv", href: `/data?source=${SOURCE}` } });
  });
  it("reopens accessible workflow reports and conversations using their current type", async () => {
    const mock = database({ workflows: { data: [{ id: RUN, name: "May close", type: "reconciliation" }, { id: SOURCE, name: "Question about May", type: "investigation" }], error: null } });
    const result = await interactionTargets(mock.db, ORG, [event("report", { metadata: { route: `/workflows/${RUN}/report` } }), event("question", { workflowId: SOURCE }), event("unavailable", { workflowId: MISSING })]);
    expect(mock.queries).toEqual([{ table: "workflows", filters: [["org_id", ORG]], ids: [RUN, SOURCE, MISSING] }]);
    expect(result).toEqual({ report: { label: "May close", href: `/workflows/${RUN}/report` }, question: { label: "Question about May", href: `/investigations/${SOURCE}` } });
  });
  it("never resolves redacted records even if their old pointers remain", async () => {
    const mock = database({});
    expect(await interactionTargets(mock.db, ORG, [event("redacted", { redacted: true, sourceId: SOURCE, workflowId: RUN, metadata: { route: "/data" } })])).toEqual({});
    expect(mock.from).not.toHaveBeenCalled();
  });
  it("omits unavailable names on database errors and retains safe navigation links", async () => {
    const mock = database({ data_sources: { data: [{ id: SOURCE, filename: "untrusted stale result" }], error: { message: "not available" } }, workflows: { data: null, error: { message: "not available" } } });
    expect(await interactionTargets(mock.db, ORG, [event("source", { sourceId: SOURCE }), event("workflow", { workflowId: RUN }), event("settings", { metadata: { route: "/settings" } })])).toEqual({ settings: { label: "Workspace settings", href: "/settings" } });
  });
});
