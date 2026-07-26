/**
 * Salvage-layer tests (Plan 5, D-G17).
 *
 * Two properties matter more than the recovery rate:
 *
 *   - It never invents. A salvaged call names a real tool with schema-shaped arguments, or it is
 *     not returned at all. Guessing turns "I could not read that" into an executed call the model
 *     never made.
 *   - It is never silent. Every recovery is marked, because a rising salvage rate is the earliest
 *     signal that a customer's local model is not fit for purpose.
 */

import { describe, expect, it } from "vitest";
import { repairArguments, salvageToolCalls } from "@/lib/llm/salvage";
import type { ToolDefinition } from "@/lib/llm/messages";

const TOOLS: ToolDefinition[] = [
  {
    name: "query_ledger",
    description: "Query the ledger.",
    parameters: {
      type: "object",
      properties: {
        dataset: { type: "string" },
        limit: { type: "integer" },
        includeVoid: { type: "boolean" },
        accounts: { type: "array", items: { type: "string" } },
      },
      required: ["dataset"],
      additionalProperties: false,
    },
  },
];

describe("salvageToolCalls — recovery", () => {
  it("recovers a fenced JSON block", () => {
    const out = salvageToolCalls(
      'I will check.\n```json\n{"name":"query_ledger","arguments":{"dataset":"erp_export"}}\n```',
      TOOLS,
    );
    expect(out.strategy).toBe("fenced_json");
    expect(out.toolCalls[0]).toMatchObject({
      name: "query_ledger",
      arguments: { dataset: "erp_export" },
      salvaged: true,
    });
  });

  it("recovers a <tool_call> tagged block", () => {
    const out = salvageToolCalls(
      '<tool_call>{"name": "query_ledger", "arguments": {"dataset": "bank_statement"}}</tool_call>',
      TOOLS,
    );
    expect(out.strategy).toBe("tool_call_tag");
    expect(out.toolCalls).toHaveLength(1);
  });

  it("recovers a bare object embedded in prose", () => {
    const out = salvageToolCalls(
      'Let me run {"tool": "query_ledger", "args": {"dataset": "erp_export"}} now.',
      TOOLS,
    );
    expect(out.strategy).toBe("bare_json");
    expect(out.toolCalls[0].name).toBe("query_ledger");
  });

  it("handles nested braces and braces inside strings", () => {
    // A regex-based scan gets this wrong; the brace matcher is string- and escape-aware.
    const out = salvageToolCalls(
      '{"name":"query_ledger","arguments":{"dataset":"erp","accounts":["a{b}"]}}',
      TOOLS,
    );
    expect(out.toolCalls[0].arguments).toEqual({ dataset: "erp", accounts: ["a{b}"] });
  });

  it("unwraps a list of calls under any of the common envelope keys", () => {
    const out = salvageToolCalls(
      '{"tool_calls":[{"name":"query_ledger","arguments":{"dataset":"a"}},{"name":"query_ledger","arguments":{"dataset":"b"}}]}',
      TOOLS,
    );
    expect(out.toolCalls.map((c) => c.arguments.dataset)).toEqual(["a", "b"]);
  });

  it("prefers a fenced block over a JSON example elsewhere in the prose", () => {
    // Strategy ordering: a fence is a deliberate emission, a loose object may be illustrative.
    const out = salvageToolCalls(
      'For example {"name":"query_ledger","arguments":{"dataset":"WRONG"}} — but actually:\n' +
        '```json\n{"name":"query_ledger","arguments":{"dataset":"RIGHT"}}\n```',
      TOOLS,
    );
    expect(out.toolCalls[0].arguments.dataset).toBe("RIGHT");
  });
});

describe("salvageToolCalls — refusal", () => {
  it("refuses a tool that was never offered", () => {
    const out = salvageToolCalls('{"name":"drop_table","arguments":{}}', TOOLS);
    expect(out.toolCalls).toEqual([]);
  });

  it("refuses when a schema-required argument is missing, rather than filling it in", () => {
    // Running query_ledger without `dataset` would silently query everything and look successful.
    const out = salvageToolCalls('{"name":"query_ledger","arguments":{"limit":10}}', TOOLS);
    expect(out.toolCalls).toEqual([]);
  });

  it("returns nothing for prose with no call in it", () => {
    expect(salvageToolCalls("I think the account ties out.", TOOLS).toolCalls).toEqual([]);
  });

  it("returns nothing when no tools are on offer", () => {
    expect(salvageToolCalls('{"name":"query_ledger","arguments":{"dataset":"a"}}', []).toolCalls)
      .toEqual([]);
  });
});

describe("repairArguments", () => {
  const tool = TOOLS[0];

  it("passes valid JSON through unmarked", () => {
    const out = repairArguments('{"dataset":"erp"}', tool);
    expect(out).toEqual({ arguments: { dataset: "erp" }, salvaged: false });
  });

  it("accepts an already-parsed object (the Ollama shape)", () => {
    expect(repairArguments({ dataset: "erp" }, tool)).toEqual({
      arguments: { dataset: "erp" },
      salvaged: false,
    });
  });

  it("unwraps double-encoded arguments and marks them", () => {
    const out = repairArguments(JSON.stringify('{"dataset":"erp"}'), tool);
    expect(out).toMatchObject({ salvaged: true, strategy: "double_encoded" });
  });

  it("repairs trailing commas and unquoted keys", () => {
    const out = repairArguments('{dataset: "erp", limit: 5,}', tool);
    expect(out?.arguments).toEqual({ dataset: "erp", limit: 5 });
    expect(out?.salvaged).toBe(true);
  });

  it("coerces stringified scalars toward the schema", () => {
    // Weak models stringify constantly; a strict consumer would reject for the wrong reason.
    const out = repairArguments('{"dataset":"erp","limit":"50","includeVoid":"true"}', tool);
    expect(out?.arguments).toEqual({ dataset: "erp", limit: 50, includeVoid: true });
  });

  it("wraps a lone value where the schema wants an array", () => {
    expect(repairArguments('{"dataset":"erp","accounts":"4000"}', tool)?.arguments).toEqual({
      dataset: "erp",
      accounts: ["4000"],
    });
  });

  it("leaves an ambiguous value alone so a real type error still surfaces", () => {
    // "fifty" is not a number; coercing it to NaN would hide the model's actual mistake.
    expect(repairArguments('{"dataset":"erp","limit":"fifty"}', tool)?.arguments).toEqual({
      dataset: "erp",
      limit: "fifty",
    });
  });

  it("drops keys the schema does not declare", () => {
    expect(repairArguments('{"dataset":"erp","sqlInjection":"--"}', tool)?.arguments).toEqual({
      dataset: "erp",
    });
  });

  it("treats an empty argument string as an empty object", () => {
    expect(repairArguments("", tool)).toEqual({ arguments: {}, salvaged: false });
  });

  it("gives up on something it cannot read at all", () => {
    expect(repairArguments("not json at all", tool)).toBeNull();
  });
});
