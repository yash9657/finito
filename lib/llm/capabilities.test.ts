/**
 * Capability table tests (Plan 5, D-G16).
 *
 * The behaviour worth pinning is not the numbers — those are a vendored snapshot and will move —
 * but the two decisions the table drives: does an investigation start at all, and does it plan
 * around a real fact or a conservative guess.
 */

import { describe, expect, it } from "vitest";
import { canRunInvestigation, capabilitiesFor } from "@/lib/llm/capabilities";

describe("capabilitiesFor", () => {
  it("prefers the longest matching prefix", () => {
    // `claude-haiku-4-5` must not be answered by a shorter `claude-` entry with a 1M window.
    expect(capabilitiesFor("anthropic", "claude-haiku-4-5").contextWindow).toBe(200_000);
    expect(capabilitiesFor("anthropic", "claude-opus-5").contextWindow).toBe(1_000_000);
  });

  it("marks a vendored fact as vendored and a fallback as assumed", () => {
    expect(capabilitiesFor("anthropic", "claude-opus-5").source).toBe("vendored");
    const unknown = capabilitiesFor("anthropic", "claude-something-unreleased");
    expect(unknown.source).toBe("assumed");
    // The floor, not the best-known model's numbers — an over-estimate fails a run mid-flight.
    expect(unknown.contextWindow).toBeLessThan(1_000_000);
  });

  it("ignores an Ollama tag and a vendor namespace", () => {
    // `llama3.1:8b` and `llama3.1:70b` share a tool template, which is what this table is about.
    expect(capabilitiesFor("ollama", "llama3.1:8b-instruct-q4_K_M").matched).toBe("llama3.1");
    expect(capabilitiesFor("ollama", "accounts/org/models/qwen2.5:14b").matched).toBe("qwen2.5");
  });

  it("is case-insensitive", () => {
    expect(capabilitiesFor("anthropic", "Claude-Opus-5").source).toBe("vendored");
  });

  it("assumes an unknown local model can attempt tools but not parallel ones", () => {
    // Refusing outright would make every un-tabulated local model unusable; assuming parallel
    // support would have us execute calls a weak model never reasoned about together.
    const caps = capabilitiesFor("ollama", "some-community-finetune");
    expect(caps.toolCalling).toBe(true);
    expect(caps.parallelToolCalls).toBe(false);
  });
});

describe("canRunInvestigation", () => {
  it("refuses a model that cannot call tools, naming it and pointing at Settings", () => {
    const check = canRunInvestigation("openai", "text-embedding-3-large");
    expect(check.ok).toBe(false);
    if (check.ok) throw new Error("unreachable");
    expect(check.reason).toContain("text-embedding-3-large");
    expect(check.reason).toContain("Settings");
  });

  it("allows a tool-capable model and hands back its capabilities", () => {
    const check = canRunInvestigation("anthropic", "claude-opus-5");
    expect(check.ok).toBe(true);
    if (!check.ok) throw new Error("unreachable");
    expect(check.capabilities.parallelToolCalls).toBe(true);
  });

  it("refuses BEFORE turn 1 rather than looping — the embedding-model case", () => {
    // The failure this exists to prevent: 20 turns on a model that cannot call a tool, ending on
    // max_turns with an empty answer and no explanation.
    expect(canRunInvestigation("ollama", "nomic-embed-text").ok).toBe(false);
  });
});
