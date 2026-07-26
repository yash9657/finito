/**
 * Canonical message format tests (Plan 5, D-G13).
 *
 * The sidecar rules are the interesting part: they are the mechanism behind "seamless model
 * swapping", and getting them wrong is either an API rejection (Anthropic refuses a modified
 * thinking block) or a silent, unexplained quality drop mid-investigation.
 */

import { describe, it, expect } from "vitest";
import {
  allToolCalls,
  assistantMessage,
  estimateTokens,
  fromLegacyMessages,
  stripForeignSidecars,
  toolResultMessage,
  userMessage,
  type CanonicalMessage,
} from "@/lib/llm/messages";

describe("canonical message constructors", () => {
  it("omits toolCalls entirely when there are none, rather than storing an empty array", () => {
    // An empty array and an absent field serialize differently into provider bodies, and a
    // provider that sees `tool_calls: []` can behave differently from one that sees nothing.
    const msg = assistantMessage("hello", []);
    expect(msg).toEqual({ role: "assistant", content: "hello" });
    expect("toolCalls" in msg).toBe(false);
  });

  it("batches every tool result of a turn into ONE tool message", () => {
    // Anthropic requires all parallel tool_result blocks in a single user message; splitting
    // them trains the model out of parallel calls. Modelling one-result-per-message would make
    // that conversion lossy, so the canonical form is the batched one.
    const msg = toolResultMessage([
      { toolCallId: "a", name: "query_ledger", content: "{}" },
      { toolCallId: "b", name: "list_datasets", content: "{}" },
    ]);
    expect(msg.role).toBe("tool");
    expect(msg.toolResults).toHaveLength(2);
  });

  it("adapts legacy text-only messages without loss", () => {
    expect(fromLegacyMessages([{ role: "user", content: "hi" }])).toEqual([
      { role: "user", content: "hi" },
    ]);
  });
});

describe("stripForeignSidecars (D-G13)", () => {
  const withSidecars: CanonicalMessage[] = [
    userMessage("q"),
    assistantMessage("a1", undefined, { providerId: "anthropic", data: { thinking: "…" } }),
    assistantMessage("a2", undefined, { providerId: "anthropic", data: { thinking: "…" } }),
    assistantMessage("a3", undefined, { providerId: "google", data: { sig: "…" } }),
  ];

  it("replays same-provider state verbatim", () => {
    const { messages, dropped } = stripForeignSidecars(withSidecars, "anthropic");
    expect(dropped).toEqual([{ providerId: "google", count: 1 }]);
    // Same-provider sidecars must survive byte-identical: Anthropic rejects a modified
    // thinking block, so "mostly preserved" is the same as broken.
    expect(messages[1].sidecar).toBe(withSidecars[1].sidecar);
    expect(messages[2].sidecar).toBe(withSidecars[2].sidecar);
    expect(messages[3].sidecar).toBeUndefined();
  });

  it("reports every dropped provider with a count, so the event can name them", () => {
    const { messages, dropped } = stripForeignSidecars(withSidecars, "openai");
    expect(dropped).toEqual([
      { providerId: "anthropic", count: 2 },
      { providerId: "google", count: 1 },
    ]);
    expect(messages.every((m) => m.sidecar === undefined)).toBe(true);
  });

  it("does not mutate the input", () => {
    stripForeignSidecars(withSidecars, "openai");
    expect(withSidecars[1].sidecar).toBeDefined();
  });

  it("reports nothing when there is nothing to drop", () => {
    expect(stripForeignSidecars([userMessage("q")], "ollama").dropped).toEqual([]);
  });
});

describe("allToolCalls", () => {
  it("flattens calls across turns in order", () => {
    const calls = allToolCalls([
      assistantMessage("", [{ id: "1", name: "a", arguments: {} }]),
      toolResultMessage([{ toolCallId: "1", name: "a", content: "{}" }]),
      assistantMessage("", [
        { id: "2", name: "b", arguments: {} },
        { id: "3", name: "c", arguments: {} },
      ]),
    ]);
    expect(calls.map((c) => c.id)).toEqual(["1", "2", "3"]);
  });
});

describe("estimateTokens", () => {
  it("counts the system prompt, tool arguments and tool results, not just message text", () => {
    // The compaction trigger reads this. Tool results dominate a financial investigation's
    // context, so an estimate that ignored them would fire far too late.
    const bare = estimateTokens([userMessage("x")]);
    const withResult = estimateTokens([
      userMessage("x"),
      toolResultMessage([{ toolCallId: "1", name: "query_ledger", content: "y".repeat(4000) }]),
    ]);
    expect(withResult).toBeGreaterThan(bare + 900);
  });

  it("charges per-message overhead so many short messages are not under-counted", () => {
    const one = estimateTokens([userMessage("abcd".repeat(10))]);
    const many = estimateTokens(Array.from({ length: 10 }, () => userMessage("abcd")));
    expect(many).toBeGreaterThan(one);
  });

  it("includes the system prompt", () => {
    expect(estimateTokens([], "s".repeat(400))).toBeGreaterThanOrEqual(100);
  });
});
