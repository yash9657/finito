import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { conversationContext, validateSourceScope } from "./conversation";
function client(records: Record<string, unknown>[]) {
  return {
    from() {
      const filters: Record<string, unknown> = {};
      return {
        select() {
          return this;
        },
        eq(k: string, v: unknown) {
          filters[k] = v;
          return this;
        },
        maybeSingle: async () => ({
          data:
            records.find((r) =>
              Object.entries(filters).every(([k, v]) => r[k] === v),
            ) ?? null,
          error: null,
        }),
      };
    },
  } as unknown as SupabaseClient;
}
describe("conversation boundaries", () => {
  it("reconstructs only the selected parent chain and retains file scope", async () => {
    const db = client([
      {
        workflow_id: "a",
        org_id: "org",
        conversation_id: "a",
        question: "First",
        answer: { prose: "One" },
        source_ids: ["source"],
        status: "answered",
      },
      {
        workflow_id: "b",
        org_id: "org",
        conversation_id: "a",
        parent_workflow_id: "a",
        question: "Second",
        answer: { prose: "Two" },
        source_ids: ["source"],
        status: "answered",
      },
      {
        workflow_id: "c",
        org_id: "org",
        conversation_id: "a",
        parent_workflow_id: "a",
        question: "Other branch",
        status: "answered",
      },
    ]);
    const result = await conversationContext(db, "org", "b");
    expect(result.history.map((h) => h.question)).toEqual(["First", "Second"]);
    expect(result.history[0].answer).toBe("");
    expect(result.history[0].workflowId).toBe("a");
    expect(result.history[1].answer).toBe("Two");
    expect(result.sourceIds).toEqual(["source"]);
    expect(result.conversationId).toBe("a");
  });
  it("never leaks another organization’s prior answer", async () => {
    const db = client([
      {
        workflow_id: "a",
        org_id: "other",
        question: "private",
        status: "answered",
      },
    ]);
    await expect(conversationContext(db, "org", "a")).rejects.toThrow(
      "unavailable",
    );
  });
  it("requires the prior run to finish", async () => {
    const db = client([
      {
        workflow_id: "a",
        org_id: "org",
        question: "pending",
        status: "running",
      },
    ]);
    await expect(conversationContext(db, "org", "a")).rejects.toThrow("Wait");
  });
  it("rejects cyclic history and duplicate source selections", async () => {
    const db = client([
      {
        workflow_id: "a",
        parent_workflow_id: "a",
        org_id: "org",
        question: "loop",
        status: "answered",
      },
    ]);
    await expect(conversationContext(db, "org", "a")).rejects.toThrow(
      "inconsistent",
    );
    await expect(validateSourceScope(db, "org", ["x", "x"])).rejects.toThrow(
      "distinct",
    );
  });
  it("uses only matching organization sources", async () => {
    let org: string | undefined;
    const db = {
      from: () => ({
        select() {
          return this;
        },
        eq(k: string, v: string) {
          if (k === "org_id") org = v;
          return this;
        },
        in: async () => ({ data: [], error: null }),
      }),
    } as unknown as SupabaseClient;
    await expect(validateSourceScope(db, "org", ["outside"])).rejects.toThrow(
      "unavailable",
    );
    expect(org).toBe("org");
  });
});
