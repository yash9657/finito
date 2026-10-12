import { describe, expect, it } from "vitest";
import type { MemorySearchHit, MemorySearchResult } from "@/lib/memory/types";
import { clipUtf8, compactSearchResult, MEMORY_CONTEXT_BYTES, MEMORY_TOOL_BYTES, recallQuery, selectMemoryContext } from "./memory-context";

const source: MemorySearchHit = { id: "source:one", kind: "source", title: "May variance", excerpt: "Retained May statement", createdAt: "2026-05-01", updatedAt: "2026-05-01", rank: 2, workflowId: null, sourceId: "aaaaaaaa-1111-4111-8111-111111111111", tableId: "t0", originalRow: 2, citation: "src:aaaaaaaa-1111-4111-8111-111111111111/t0/r2" };
const recall = (results: MemorySearchHit[]): MemorySearchResult => ({ enabled: true, results, hasMore: false, coverage: { totalSources: 1000, indexedSources: 995, pendingSources: 4, failedSources: 1 } });

describe("bounded selective memory context", () => {
  it("keeps the immediate follow-up referent and provenance without replaying older answers", () => {
    const context = selectMemoryContext({ question: "Why did North have a larger variance?", history: [
      { workflowId: "old", question: "Unrelated old question", answer: "OLD ANSWER MUST NOT APPEAR".repeat(5000) },
      { workflowId: "parent", createdAt: "2026-05-03", question: "Compare North and South", answer: "North has the larger variance. Re-check the underlying statement before asserting an amount.".repeat(100) },
    ] });
    expect(context.text).toContain("North has the larger variance");
    expect(context.text).toContain('"workflowId":"parent"');
    expect(context.text).toContain('"workflowId":"old"');
    expect(context.text).not.toContain("OLD ANSWER MUST NOT APPEAR");
    expect(context.telemetry.estimated_tokens).toBeLessThanOrEqual(1500);
  });

  it("does not scale prompt size with long unrelated archived history", () => {
    const history = Array.from({ length: 500 }, (_, i) => ({ workflowId: `old-${i}`, question: "Past question".repeat(1000), answer: "Unrelated old response".repeat(5000) }));
    const context = selectMemoryContext({ question: "Explain the last comparison", history });
    expect(Buffer.byteLength(context.text)).toBeLessThanOrEqual(MEMORY_CONTEXT_BYTES);
    expect(context.telemetry.included_count).toBeLessThanOrEqual(3);
    expect(context.telemetry.dropped_count).toBeGreaterThanOrEqual(497);
  });

  it("ranks relevant preferences and deduplicates several chunks from the same file", () => {
    const context = selectMemoryContext({ question: "May variance", recall: recall([
      source, { ...source, id: "chunk:two", rank: 1 },
      { ...source, id: "preference:one", kind: "preference", sourceId: null, citation: null, title: "Variance presentation", excerpt: "I prefer variance explanations in basis points", rank: 3 },
    ]) });
    const items = JSON.parse(context.text).items;
    expect(items.filter((item: { kind: string }) => item.kind === "source")).toHaveLength(1);
    expect(items[0].kind).toBe("preference");
    expect(context.telemetry.dropped_count).toBe(1);
    expect(context.text).toContain("indexedSources");
  });

  it("caps aggregate UTF-8 bytes, including metadata and JSON escaping", () => {
    const results = Array.from({ length: 10 }, (_, i) => ({ ...source, id: `question:${i}`, kind: "question" as const, sourceId: null, title: "決算💶".repeat(100), excerpt: "取引💶\n\"".repeat(1000) }));
    const initial = selectMemoryContext({ question: "決算", recall: recall(results) });
    const searched = compactSearchResult(recall(results));
    expect(Buffer.byteLength(initial.text)).toBeLessThanOrEqual(MEMORY_CONTEXT_BYTES);
    expect(initial.telemetry.estimated_tokens).toBe(Math.ceil(Buffer.byteLength(initial.text) / 2));
    expect(Buffer.byteLength(JSON.stringify(searched))).toBeLessThanOrEqual(MEMORY_TOOL_BYTES - 500);
    expect(searched.omittedCount).toBeGreaterThan(0);
    expect(clipUtf8("💶💶💶", 9)).toBe("💶💶");
    expect(initial.text).not.toMatch(/\\ud[89ab][0-9a-f]{2}/i);
  });

  it("builds small lexical retrieval candidates without using document instructions", () => {
    expect(recallQuery("Can you show our May variance report?")).toBe('"may" OR "variance" OR "report"');
    expect(recallQuery("What is it?")).toBe("");
    expect(Buffer.byteLength(recallQuery("oversized ".repeat(1000)))).toBeLessThanOrEqual(500);
  });
});
