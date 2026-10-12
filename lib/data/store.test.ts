import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { parseDataSource } from "./parser";
import { dataSourcePath, listDataSources, loadDataSources, sourceManifest, type StoredDataSource } from "./store";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FOREIGN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ID = "11111111-1111-4111-8111-111111111111";
const content = new TextEncoder().encode("Label,Amount\nA,10.50\nB,12.75");

async function record(): Promise<StoredDataSource> {
  const parsed = await parseDataSource(content, "source.csv", ID);
  return { id: ID, org_id: ORG, created_by: ID, filename: parsed.filename, sha256: parsed.sha256, format: parsed.format, byte_size: content.byteLength, storage_path: dataSourcePath(ORG, ID), status: "active", manifest: sourceManifest(parsed), parse_options: {}, created_at: "2026-10-12T00:00:00Z" };
}

function database(records: StoredDataSource[], file: Uint8Array = content, error: unknown = null) {
  const filters: [string, unknown][] = [];
  const query = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn((column: string, value: unknown) => { filters.push([column, value]); return query; }),
    in: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue({ data: records, error }),
    range: vi.fn().mockResolvedValue({ data: records, error }),
  };
  const download = vi.fn().mockResolvedValue({ data: new Blob([Buffer.from(file)]), error: null });
  const storageFrom = vi.fn().mockReturnValue({ download });
  const db = { from: vi.fn().mockReturnValue(query), storage: { from: storageFrom } } as unknown as SupabaseClient;
  return { db, query, download, filters, storageFrom };
}

describe("source tenant and integrity boundaries", () => {
  it("scopes metadata and storage to the requesting organization and accepts JSONB key reordering", async () => {
    const row = await record();
    row.manifest = { warnings: row.manifest.warnings, tables: row.manifest.tables.map(table => ({ preambleRowCount: table.preambleRowCount, headerRow: table.headerRow, truncated: table.truncated, rowCount: table.rowCount, columns: table.columns, name: table.name, id: table.id })), parserVersion: 1 };
    const mock = database([row]);
    const loaded = await loadDataSources(mock.db, ORG, [ID]);
    expect(loaded[0].tables[0].rows[0].values.Amount).toBe("10.50");
    expect(mock.filters).toContainEqual(["org_id", ORG]);
    expect(mock.filters).toContainEqual(["status", "active"]);
    expect(mock.query.in).toHaveBeenCalledWith("id", [ID]);
    expect(mock.storageFrom).toHaveBeenCalledWith("analysis-sources");
    expect(mock.download).toHaveBeenCalledWith(`${ORG}/${ID}/source`);
  });

  it("fails missing/foreign selections before touching storage", async () => {
    const missing = database([]);
    await expect(loadDataSources(missing.db, ORG, [ID])).rejects.toMatchObject({ code: "not_found" });
    expect(missing.download).not.toHaveBeenCalled();
    const row = await record();
    const foreign = database([{ ...row, org_id: FOREIGN, storage_path: dataSourcePath(FOREIGN, ID) }]);
    await expect(loadDataSources(foreign.db, ORG, [ID])).rejects.toMatchObject({ code: "integrity_error" });
    expect(foreign.download).not.toHaveBeenCalled();
  });

  it("rejects changed bytes even when their size matches", async () => {
    const row = await record();
    const changed = new TextEncoder().encode("Label,Amount\nA,90.50\nB,12.75");
    const mock = database([row], changed);
    await expect(loadDataSources(mock.db, ORG, [ID])).rejects.toThrow(/SHA-256 integrity/);
  });

  it("rejects altered columns or manifest array order", async () => {
    const row = await record();
    row.manifest.tables[0].columns.reverse();
    await expect(loadDataSources(database([row]).db, ORG, [ID])).rejects.toMatchObject({ code: "integrity_error" });
  });

  it("does not silently choose ten sources from a larger workspace", async () => {
    const row = await record();
    const mock = database(Array.from({ length: 11 }, () => row));
    await expect(loadDataSources(mock.db, ORG)).rejects.toThrow(/none were silently omitted/);
    expect(mock.download).not.toHaveBeenCalled();
  });

  it("keeps catalog paging explicit and rejects duplicate or invalid source selections", async () => {
    const row = await record();
    const mock = database([row]);
    expect(await listDataSources(mock.db, ORG, { limit: 25, offset: 50 })).toHaveLength(1);
    expect(mock.query.range).toHaveBeenCalledWith(50, 74);
    await expect(loadDataSources(mock.db, ORG, [ID, ID])).rejects.toThrow(/distinct/);
    await expect(loadDataSources(mock.db, ORG, ["../foreign"])).rejects.toThrow(/valid source IDs/);
    expect(await loadDataSources(mock.db, ORG, [])).toEqual([]);
  });

  it("does not expose database errors or permit storage path substitution", async () => {
    const row = await record();
    const mock = database([{ ...row, storage_path: `${FOREIGN}/${ID}/source` }]);
    await expect(loadDataSources(mock.db, ORG, [ID])).rejects.toMatchObject({ code: "integrity_error" });
    expect(mock.download).not.toHaveBeenCalled();
    await expect(loadDataSources(database([], content, { message: "secret connection string" }).db, ORG)).rejects.toThrow("Could not load the selected source metadata. Retry shortly.");
  });
});
