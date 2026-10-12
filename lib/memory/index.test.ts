import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { parseDataSource } from "@/lib/data/parser";
import { buildSourceMemoryChunks, indexDataSource } from "./index";

const ID = "33333333-3333-4333-8333-333333333333";
const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const source = () => parseDataSource(new TextEncoder().encode("May export,,\n\nProduct,Region,Units\nHawthorn,Osaka,4319\nJuniper,Dhaka,7512"), "five-months-ago.csv", ID, { headerRows: { t0: 3 } });

describe("historical source indexing", () => {
  it("indexes actual row content, headers and preamble with original citations", async () => {
    const chunks = buildSourceMemoryChunks(await source());
    expect(chunks).toEqual(expect.arrayContaining([
      expect.objectContaining({ row_kind: "metadata", original_row: null, content: expect.stringContaining("five-months-ago.csv") }),
      expect.objectContaining({ row_kind: "preamble", original_row: 1, content: expect.stringContaining("May export") }),
      expect.objectContaining({ row_kind: "header", original_row: 3, content: expect.stringContaining("Region") }),
      expect.objectContaining({ row_kind: "data", original_row: 5, content: '["Juniper","Dhaka","7512"]' }),
    ]));
    expect(chunks.every(chunk => chunk.table_id === "t0")).toBe(true);
  });

  it("preserves all long-row content across bounded chunks without splitting Unicode code points", async () => {
    const input = await source();
    const value = "🙂".repeat(9000);
    input.tables[0].rows = [{ sourceId: `src:${ID}/t0/r17`, originalRow: 17, values: { Product: value, Region: null, Units: null } }];
    const chunks = buildSourceMemoryChunks(input).filter(chunk => chunk.row_kind === "data");
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(chunk => chunk.original_row === 17 && chunk.content.length <= 8000)).toBe(true);
    expect(chunks.map(chunk => chunk.content).join("")).toBe(JSON.stringify([value, null, null]));
    expect(chunks.some(chunk => /^[\uDC00-\uDFFF]/.test(chunk.content) || /[\uD800-\uDBFF]$/.test(chunk.content))).toBe(false);
  });

  it("replaces the complete organization-scoped index with one atomic RPC", async () => {
    const input = await source();
    const chunks = buildSourceMemoryChunks(input);
    const rpc = vi.fn().mockResolvedValue({ data: chunks.length, error: null });
    const result = await indexDataSource({ rpc } as unknown as SupabaseClient, ORG, input);
    expect(result).toEqual({ status: "indexed", chunks: chunks.length });
    expect(rpc).toHaveBeenCalledWith("replace_source_memory_chunks", { p_org: ORG, p_source: ID, p_chunks: chunks });
  });

  it("marks failures visibly and never claims a partial or missing index is complete", async () => {
    const chain = { update: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), then: (resolve: (value: unknown) => void) => Promise.resolve({ error: null }).then(resolve) };
    const db = { rpc: vi.fn().mockResolvedValue({ data: null, error: { message: "secret infrastructure details" } }), from: vi.fn().mockReturnValue(chain) } as unknown as SupabaseClient;
    const result = await indexDataSource(db, ORG, await source());
    expect(result.status).toBe("failed");
    expect(result.error).not.toContain("secret");
    expect(chain.update).toHaveBeenCalledWith(expect.objectContaining({ search_index_status: "failed" }));
    expect(chain.eq).toHaveBeenCalledWith("org_id", ORG);
    expect(chain.eq).toHaveBeenCalledWith("id", ID);
    expect(chain.eq).toHaveBeenCalledWith("status", "active");
  });

  it("rejects excessive index chunks rather than storing only a prefix", async () => {
    const input = await source();
    input.tables[0].rows = Array.from({ length: 60_001 }, (_, index) => ({ sourceId: `src:${ID}/t0/r${index + 10}`, originalRow: index + 10, values: { Product: "A", Region: null, Units: null } }));
    expect(() => buildSourceMemoryChunks(input)).toThrow(/60,000 chunks/);
  });
});
