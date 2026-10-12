import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { loadOrgDatasets } from "./datasets";

const ORG = "aaaaaaaa-1111-4111-8111-111111111111", WORKFLOW = "bbbbbbbb-2222-4222-8222-222222222222";
const csv = "date,description,amount,transaction_id\n2026-05-03,Retained entry,100.25,old-1\n";
function database(options: { otherOrg?: boolean; wrongHash?: boolean; wrongPath?: boolean; missing?: boolean; wrongSize?: boolean } = {}) {
  const requests: { table: string; filters: Record<string, unknown> }[] = [];
  const file = { id: "file", workflow_id: WORKFLOW, filename: "retained-bank.csv", file_type: "bank_statement", storage_path: `${options.wrongPath ? "other-org" : ORG}/${WORKFLOW}/bank_statement/retained.csv`, size_bytes: Buffer.byteLength(csv) + (options.wrongSize ? 1 : 0), sha256: options.wrongHash ? "0".repeat(64) : createHash("sha256").update(csv).digest("hex"), uploaded_at: "2026-05-03" };
  const download = vi.fn(async () => ({ data: new Blob([csv]), error: null }));
  const db = { from(table: string) {
    const filters: Record<string, unknown> = {}; requests.push({ table, filters });
    const result = { data: table === "workflows" ? (options.missing ? [] : [{ id: WORKFLOW, org_id: options.otherOrg ? "other-org" : ORG, name: "May close", type: "reconciliation", created_at: "2026-05-03" }]) : [file], error: null };
    const chain = { select: () => chain, eq: (key: string, value: unknown) => { filters[key] = value; return chain; }, neq: () => chain, in: (key: string, value: unknown) => { filters[`${key}:in`] = value; return chain; }, order: () => chain, limit: () => chain, then: <T>(resolve: (value: typeof result) => T) => Promise.resolve(result).then(resolve) };
    return chain;
  }, storage: { from: () => ({ download }) } } as unknown as SupabaseClient;
  return { db, requests, download };
}
describe("historical workflow loading", () => {
  it("selects the exact old workflow with org scope and verifies original bytes", async () => {
    const { db, requests } = database();
    const result = await loadOrgDatasets(db, ORG, { workflowIds: [WORKFLOW] });
    expect(requests[0].filters).toMatchObject({ org_id: ORG, "id:in": [WORKFLOW] });
    expect(result.rows[0]).toMatchObject({ workflowId: WORKFLOW, amountCents: 10025, period: "2026-05" });
    expect(result.loadedBytes).toBe(Buffer.byteLength(csv));
    expect(result.unreadable).toEqual([]);
  });
  it("refuses foreign or deleted workflow selection", async () => {
    await expect(loadOrgDatasets(database({ otherOrg: true }).db, ORG, { workflowIds: [WORKFLOW] })).rejects.toThrow("scope");
    await expect(loadOrgDatasets(database({ missing: true }).db, ORG, { workflowIds: [WORKFLOW] })).rejects.toThrow("unavailable");
  });
  it("refuses mismatched hash, size and object scope rather than returning financial rows", async () => {
    for (const options of [{ wrongHash: true }, { wrongSize: true }, { wrongPath: true }]) {
      const { db } = database(options);
      const result = await loadOrgDatasets(db, ORG, { workflowIds: [WORKFLOW] });
      expect(result.rows).toHaveLength(0); expect(result.unreadable).toHaveLength(1);
    }
  });
  it("enforces remaining combined byte and row budgets", async () => {
    const { db, download } = database();
    expect((await loadOrgDatasets(db, ORG, { workflowIds: [WORKFLOW], maxBytes: 1 })).unreadable[0].reason).toContain("byte limit");
    expect(download).not.toHaveBeenCalled();
    expect((await loadOrgDatasets(db, ORG, { workflowIds: [WORKFLOW], maxRows: 0 })).unreadable[0].reason).toContain("dataset limit");
  });
});
