/**
 * Context management tests (Plan 5, D-G22).
 *
 * The rule under test is the one compaction may not break: a source id seen before compaction is
 * still citable after it. Everything else here protects the mechanics that make a compacted
 * conversation still *sendable* — an orphaned tool result is a hard 400 from every provider.
 */

import { describe, expect, it, vi } from "vitest";
import {
  compact,
  extractSourceIds,
  renderDigest,
  shouldCompact,
  trimToolResult,
  type ContextDigest,
} from "@/lib/harness/agent/context";
import {
  assistantMessage,
  toolResultMessage,
  userMessage,
  type CanonicalMessage,
} from "@/lib/llm/messages";

const EMPTY_DIGEST: ContextDigest = {
  findings: [],
  ruledOut: [],
  keyFigures: [],
  openQuestions: [],
};

function conversation(turns: number): CanonicalMessage[] {
  const out: CanonicalMessage[] = [userMessage("Why doesn't the account tie out?")];
  for (let i = 0; i < turns; i++) {
    out.push(
      assistantMessage(`Checking ${i}`, [
        { id: `c${i}`, name: "query_ledger", arguments: { dataset: "erp_export", page: i } },
      ]),
    );
    out.push(
      toolResultMessage([
        {
          toolCallId: `c${i}`,
          name: "query_ledger",
          content: JSON.stringify({
            ok: true,
            rows: [{ sourceId: `wf:1a2b3c4d/erp_export/erp-${String(i).padStart(3, "0")}` }],
          }),
        },
      ]),
    );
  }
  return out;
}

describe("trimToolResult", () => {
  it("passes a small result through untouched", () => {
    expect(trimToolResult("small", 100)).toBe("small");
  });

  it("states the truncation, with both sizes", () => {
    // Silent truncation makes the agent parse a cut payload as complete.
    const trimmed = trimToolResult("x".repeat(500), 100);
    expect(trimmed).toContain("[TRUNCATED");
    expect(trimmed).toContain("500");
    expect(trimmed).toContain("audit trail");
  });
});

describe("shouldCompact", () => {
  it("is false for a short conversation and true near the window", () => {
    expect(shouldCompact([userMessage("hi")], "sys", 100_000)).toBe(false);
    expect(shouldCompact(conversation(40), "sys", 1_000)).toBe(true);
  });
});

describe("extractSourceIds", () => {
  it("finds ids in prose, tool arguments and tool results alike", () => {
    const ids = extractSourceIds([
      userMessage("Look at wf:1a2b3c4d/erp_export/erp-001"),
      assistantMessage("", [
        { id: "c", name: "t", arguments: { sourceId: "wf:1a2b3c4d/invoice/inv-002" } },
      ]),
      toolResultMessage([
        { toolCallId: "c", name: "t", content: '{"sourceId":"wf:1a2b3c4d/po/po-003"}' },
      ]),
    ]);
    expect(ids).toEqual([
      "wf:1a2b3c4d/erp_export/erp-001",
      "wf:1a2b3c4d/invoice/inv-002",
      "wf:1a2b3c4d/po/po-003",
    ]);
  });

  it("deduplicates", () => {
    const id = "wf:1a2b3c4d/erp_export/erp-001";
    expect(extractSourceIds([userMessage(`${id} and ${id}`)])).toEqual([id]);
  });
});

describe("compact", () => {
  it("NEVER drops a source id seen in the compacted turns", async () => {
    // The rule the whole design depends on: the final answer must still be able to prove its
    // numbers, and a digest that summarized the ids away would leave the agent able to remember
    // a finding but not to evidence it.
    const messages = conversation(20);
    const before = extractSourceIds(messages);

    const result = await compact(messages, "sys", async () => EMPTY_DIGEST);
    expect(result.compacted).toBe(true);

    const after = extractSourceIds(result.messages);
    for (const id of before) expect(after).toContain(id);
  });

  it("keeps the question — an investigation that forgets it answers something adjacent", async () => {
    const messages = conversation(20);
    const result = await compact(messages, "sys", async () => EMPTY_DIGEST);
    expect(result.messages[0]).toEqual(messages[0]);
  });

  it("shrinks the estimate and reports what it dropped", async () => {
    const result = await compact(conversation(30), "sys", async () => EMPTY_DIGEST);
    expect(result.estimatedTokensAfter).toBeLessThan(result.estimatedTokensBefore);
    expect(result.droppedMessages).toBeGreaterThan(0);
  });

  it("leaves an unorphaned tool result in the tail alone", async () => {
    const result = await compact(conversation(20), "sys", async () => EMPTY_DIGEST);
    // Every tool result still present must have its originating call present too, or the next
    // request is a hard 400 from every provider.
    const callIds = new Set(result.messages.flatMap((m) => (m.toolCalls ?? []).map((c) => c.id)));
    for (const msg of result.messages) {
      for (const r of msg.toolResults ?? []) expect(callIds.has(r.toolCallId)).toBe(true);
    }
  });

  it("does nothing when there is nothing droppable", async () => {
    const summarize = vi.fn();
    const result = await compact([userMessage("q"), userMessage("a")], "sys", summarize);
    expect(result.compacted).toBe(false);
    // And does not spend a model call discovering that.
    expect(summarize).not.toHaveBeenCalled();
  });
});

describe("renderDigest", () => {
  it("leads with what was RULED OUT — the field that stops a re-investigation", () => {
    const rendered = renderDigest(
      {
        findings: ["Two ERP entries never cleared"],
        ruledOut: ["The June bank duplicates are legitimate recurring charges"],
        keyFigures: [{ label: "Gap", valueCents: 412000, sourceIds: ["wf:1a2b3c4d/erp_export/erp-014"] }],
        openQuestions: ["Why was the payroll run posted twice?"],
      },
      ["wf:1a2b3c4d/erp_export/erp-014"],
    );
    expect(rendered).toContain("do not re-investigate");
    expect(rendered).toContain("legitimate recurring charges");
    expect(rendered).toContain("wf:1a2b3c4d/erp_export/erp-014");
  });

  it("carries preserved ids even when the digest itself is empty", () => {
    // A summarizer that failed must not cost the run its citations.
    const rendered = renderDigest(EMPTY_DIGEST, ["wf:1a2b3c4d/erp_export/erp-001"]);
    expect(rendered).toContain("wf:1a2b3c4d/erp_export/erp-001");
  });
});
