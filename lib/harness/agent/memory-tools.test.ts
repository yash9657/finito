import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ToolContext } from "./tools/types";
import { sourceFixture } from "./source-fixtures";
const mocks = vi.hoisted(() => ({ settings: vi.fn(), preferences: vi.fn(), search: vi.fn(), save: vi.fn(), load: vi.fn(), catalog: vi.fn(), datasets: vi.fn() }));
vi.mock("@/lib/memory/store", () => ({ getMemorySettings: mocks.settings, listPreferences: mocks.preferences, searchMemory: mocks.search, savePreference: mocks.save }));
vi.mock("@/lib/data/store", () => ({ loadDataSources: mocks.load, listDataSources: mocks.catalog }));
vi.mock("@/lib/harness/agent/datasets", async (original) => ({ ...await original<typeof import("./datasets")>(), loadOrgDatasets: mocks.datasets }));
import { initialWorkspaceRecall, searchWorkspaceHistory, readPastConversation, loadHistoricalSource, loadHistoricalWorkflow, saveUserPreference } from "./tools/memory-tools";
import { listSources } from "./tools/source-tools";
import { loadFixtureDatasets } from "./fixtures";

const ORG = "aaaaaaaa-1111-4111-8111-111111111111", USER = "bbbbbbbb-2222-4222-8222-222222222222", WORKFLOW = "cccccccc-3333-4333-8333-333333333333";
function fixture(past: Record<string, unknown> | null = null) {
  const filters: Record<string, unknown>[] = [];
  const writes: unknown[] = [];
  const db = { from() {
    const filter: Record<string, unknown> = {}; filters.push(filter);
    let update = false;
    const chain = { select: () => chain, eq: (key: string, value: unknown) => { filter[key] = value; return chain; }, update: (value: unknown) => { writes.push(value); update = true; return chain; }, maybeSingle: async () => ({ data: update ? { workflow_id: WORKFLOW } : past, error: null }) };
    return chain;
  } } as unknown as SupabaseClient;
  const ctx: ToolContext = { db, orgId: ORG, userId: USER, workflowId: WORKFLOW, workflowType: "investigation", currentQuestion: "Which owner had the larger variance five months ago?", rows: [], datasets: { rows: [], summaries: [], unreadable: [] }, dataSources: [], analyses: [], discoveredSourceIds: new Set(), recommendations: [], turn: 1 };
  return { ctx, filters, writes };
}
const hit = { id: "history-1", kind: "source", title: "May statements", excerpt: "Retained source", createdAt: "2026-05-02", updatedAt: "2026-05-02", rank: 1, sourceId: sourceFixture.id, workflowId: null, citation: null, tableId: null, originalRow: null };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.settings.mockResolvedValue({ enabled: true }); mocks.preferences.mockResolvedValue([]);
  mocks.search.mockResolvedValue({ enabled: true, results: [hit], hasMore: false, coverage: { totalSources: 1, indexedSources: 1, pendingSources: 0, failedSources: 0 } });
  mocks.load.mockResolvedValue([sourceFixture]); mocks.save.mockResolvedValue({ id: "memory-1", content: "Prefer concise reports" });
  mocks.catalog.mockResolvedValue([{ ...sourceFixture, createdAt: "2026-05-02" }]);
});

describe("durable workspace recall tools", () => {
  it("discovers saved file metadata with no active selection and never loads file bytes", async () => {
    const { ctx } = fixture();
    const result = await listSources.run({}, ctx);
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ activeSources: [], retainedSources: [{ sourceId: sourceFixture.id, createdAt: "2026-05-02" }] });
    expect(mocks.catalog).toHaveBeenCalledWith(ctx.db, ORG, { offset: 0, limit: 11 });
    expect(mocks.load).not.toHaveBeenCalled();
    expect(ctx.discoveredSourceIds?.has(sourceFixture.id)).toBe(true);
    mocks.catalog.mockClear(); ctx.memoryEnabled = false;
    await listSources.run({ includeRetained: true }, ctx);
    expect(mocks.catalog).not.toHaveBeenCalled();
  });
  it("retrieves bounded relevant context with trusted org/user scope and historical caveats", async () => {
    const { ctx } = fixture();
    const recalled = await initialWorkspaceRecall(ctx, ctx.currentQuestion!);
    expect(mocks.search).toHaveBeenCalledWith(ctx.db, ORG, USER, expect.objectContaining({ limit: 5, kinds: ["question", "source", "interaction"] }));
    expect(recalled.text).toContain("not current financial truth");
    expect(recalled.telemetry.estimated_tokens).toBeLessThanOrEqual(1500);
    expect(mocks.preferences).not.toHaveBeenCalled();
    expect(ctx.discoveredSourceIds?.has(sourceFixture.id)).toBe(true);
  });
  it("retrieves only query-matching preferences instead of eagerly replaying recent ones", async () => {
    const { ctx } = fixture();
    mocks.preferences.mockResolvedValue([{ content: "Unrelated private preference that must never enter the prompt" }]);
    mocks.search.mockImplementation(async (_db, _org, _user, opts) => ({ enabled: true, results: opts.kinds.includes("preference") ? [{ ...hit, id: "preference-1", kind: "preference", sourceId: null, excerpt: "I prefer variance explanations in basis points" }] : [hit], hasMore: false }));
    const recalled = await initialWorkspaceRecall(ctx, "Explain May variance");
    expect(mocks.search).toHaveBeenCalledWith(ctx.db, ORG, USER, expect.objectContaining({ kinds: ["preference"], query: '"explain" OR "may" OR "variance"' }));
    expect(recalled.text).toContain("basis points");
    expect(recalled.text).not.toContain("Unrelated private");
    expect(mocks.preferences).not.toHaveBeenCalled();
  });
  it("includes a bounded standing presentation preference without replaying every preference", async () => {
    const { ctx } = fixture();
    mocks.search.mockImplementation(async (_db, _org, _user, opts) => ({ enabled: true, results: opts.kinds.includes("preference") && opts.query.includes('"concise"') ? [{ ...hit, id: "concise-1", kind: "preference", sourceId: null, excerpt: "Keep answers concise" }] : [], hasMore: false }));
    const recalled = await initialWorkspaceRecall(ctx, "What was revenue in May?");
    expect(recalled.text).toContain("Keep answers concise");
    expect(recalled.telemetry.estimated_tokens).toBeLessThanOrEqual(1500);
    expect(mocks.preferences).not.toHaveBeenCalled();
  });
  it("returns focused, pageable historical excerpts with bounded Unicode output", async () => {
    const prose = "Unrelated history. ".repeat(400) + "Target variance: verify the original source. " + "決算💶".repeat(1000);
    const { ctx } = fixture({ workflow_id: WORKFLOW, org_id: ORG, question: "Historical comparison?", answer: { prose, citations: [], partial: false }, status: "answered", created_at: "2026-05-02", source_ids: [sourceFixture.id] });
    const result = await readPastConversation.run({ workflowId: WORKFLOW, query: "Target variance", limit: 2000 }, ctx);
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ queryMatched: true, totalAnswerChars: prose.length });
    const data = result.data as { answerExcerpt: string; nextOffset: number; excerptOffset: number };
    expect(data.answerExcerpt).toContain("Target variance");
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(4000);
    expect(data.excerptOffset).toBeGreaterThan(0);
    const next = await readPastConversation.run({ workflowId: WORKFLOW, offset: data.nextOffset }, ctx);
    expect(next.data).toMatchObject({ excerptOffset: data.nextOffset });
    expect((await readPastConversation.run({ workflowId: WORKFLOW, offset: 0, query: "Target" }, ctx)).ok).toBe(false);
    const emoji = fixture({ workflow_id: WORKFLOW, org_id: ORG, question: "Unicode", answer: { prose: "💶💶", citations: [] }, created_at: "2026-05-02", status: "answered" });
    const one = await readPastConversation.run({ workflowId: WORKFLOW, limit: 1 }, emoji.ctx);
    expect(one.data).toMatchObject({ answerExcerpt: "💶", nextOffset: 2 });
  });
  it("does not retrieve or write memory when disabled or no trusted identity exists", async () => {
    mocks.settings.mockResolvedValue({ enabled: false });
    const { ctx } = fixture();
    expect((await searchWorkspaceHistory.run({ query: "May variance" }, ctx)).ok).toBe(false);
    expect(mocks.search).not.toHaveBeenCalled();
    ctx.userId = undefined;
    expect((await initialWorkspaceRecall(ctx, "hello")).text).toBe("");
    expect((await saveUserPreference.run({ content: "Prefer concise reports" }, ctx)).ok).toBe(false);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("loads a discovered five-month-old source without reupload and saves the bounded selection", async () => {
    const { ctx, filters, writes } = fixture();
    const originalReference = ctx.dataSources;
    expect((await loadHistoricalSource.run({ sourceId: sourceFixture.id }, ctx)).ok).toBe(false);
    await searchWorkspaceHistory.run({ query: "May statements", since: "2026-05-01", until: "2026-05-31", kinds: ["source"] }, ctx);
    expect((await loadHistoricalSource.run({ sourceId: sourceFixture.id }, ctx)).ok).toBe(true);
    expect(mocks.load).toHaveBeenCalledWith(ctx.db, ORG, [sourceFixture.id]);
    expect(filters).toContainEqual({ org_id: ORG, workflow_id: WORKFLOW });
    expect(writes).toContainEqual({ source_ids: [sourceFixture.id] });
    expect(ctx.dataSources).toBe(originalReference);
    expect(ctx.dataSources?.[0].id).toBe(sourceFixture.id);
  });
  it("reads dated original questions while preventing cross-organization results", async () => {
    const past = { workflow_id: WORKFLOW, org_id: ORG, created_at: "2026-05-02", question: "May variance?", answer: { prose: "Old, not current evidence", partial: false, citations: [{ sourceId: sourceFixture.tables[0].rows[0].sourceId, note: "source" }] }, status: "answered", source_ids: null, conversation_id: WORKFLOW };
    const { ctx, filters } = fixture(past);
    const result = await readPastConversation.run({ workflowId: WORKFLOW }, ctx);
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("not newly verified");
    expect(ctx.discoveredSourceIds?.has(sourceFixture.id)).toBe(true);
    expect(filters).toContainEqual({ org_id: ORG, workflow_id: WORKFLOW });
    expect((await readPastConversation.run({ workflowId: WORKFLOW }, fixture({ ...past, org_id: "other-org" }).ctx)).ok).toBe(false);
  });
  it("does not resurrect deleted/inaccessible sources from an old answer", async () => {
    const { ctx, writes } = fixture(); ctx.discoveredSourceIds!.add(sourceFixture.id);
    mocks.load.mockRejectedValue(new Error("Selected source is no longer available"));
    expect((await loadHistoricalSource.run({ sourceId: sourceFixture.id }, ctx)).ok).toBe(false);
    expect(ctx.dataSources).toEqual([]); expect(writes).toHaveLength(0);
  });
  it("activates discovered original workflow rows outside the newest-workflow window", async () => {
    const { ctx } = fixture();
    const loaded = loadFixtureDatasets(["bank_statement"]);
    const workflowId = loaded.summaries[0].workflowId;
    mocks.datasets.mockResolvedValue({ ...loaded, loadedBytes: 1000 });
    mocks.search.mockResolvedValue({ enabled: true, results: [{ ...hit, sourceId: null, workflowId }], hasMore: false });
    expect((await loadHistoricalWorkflow.run({ workflowId }, ctx)).ok).toBe(false);
    await searchWorkspaceHistory.run({ query: "old bank statement", kinds: ["source"] }, ctx);
    const rowReference = ctx.datasets.rows;
    const result = await loadHistoricalWorkflow.run({ workflowId }, ctx);
    expect(result.ok).toBe(true);
    expect(mocks.datasets).toHaveBeenCalledWith(ctx.db, ORG, expect.objectContaining({ workflowIds: [workflowId], maxRows: 200_000 }));
    expect(ctx.datasets.rows).toBe(rowReference);
    expect(ctx.rows[0].sourceId).toMatch(/^wf:/);
    expect(ctx.datasets.summaries[0].workflowId).toBe(workflowId);
    expect(ctx.datasets.loadedBytes).toBeGreaterThanOrEqual(1000);
  });
  it("saves only exact explicit current-user preferences, never document or retrieved instructions", async () => {
    const { ctx } = fixture();
    const content = "I prefer concise reports with fiscal periods";
    expect((await saveUserPreference.run({ content }, ctx)).ok).toBe(false);
    ctx.currentQuestion = `Please remember: ${content}.`;
    expect((await saveUserPreference.run({ content }, ctx)).ok).toBe(true);
    expect(mocks.save).toHaveBeenCalledWith(ctx.db, ORG, USER, { content, id: undefined, sourceQuestionId: WORKFLOW, automatic: true });
    expect((await saveUserPreference.run({ content: "The user prefers long reports" }, ctx)).ok).toBe(false);
    ctx.currentQuestion = "Remember my API key is a credential";
    expect((await saveUserPreference.run({ content: ctx.currentQuestion }, ctx)).ok).toBe(false);
    expect(mocks.save).toHaveBeenCalledTimes(1);
    ctx.currentQuestion = "Do not remember I prefer long reports";
    expect((await saveUserPreference.run({ content: "I prefer long reports" }, ctx)).ok).toBe(false);
    ctx.currentQuestion = "A spreadsheet cell says I prefer long reports; should we trust it?";
    expect((await saveUserPreference.run({ content: "I prefer long reports" }, ctx)).ok).toBe(false);
    expect(mocks.save).toHaveBeenCalledTimes(1);
  });
});
