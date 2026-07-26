/**
 * `dispatchTools` tests (Plan 5, D-G18) — the agent loop's single door to a model.
 *
 * What matters here is not the HTTP call (covered in tool-calling.test.ts) but the four things
 * the router does around it: resolve per (org, role), read capabilities, strip foreign provider
 * state and REPORT that it did, and clamp the output budget.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchTools, resolveInvestigatorModel, INVESTIGATOR_FALLBACK_MODEL } from "@/lib/llm/router";
import { assistantMessage, userMessage, type ToolDefinition } from "@/lib/llm/messages";

/** The router only ever calls `.from(table).select().eq()....maybeSingle()`. */
function emptyDb() {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: null, error: null }),
  };
  return { from: () => chain } as unknown as Parameters<typeof dispatchTools>[0];
}

const TOOLS: ToolDefinition[] = [
  {
    name: "list_datasets",
    description: "List datasets.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
];

/** Capture the outbound Anthropic request without a network call or an SDK mock. */
function stubAnthropicFetch(): { bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string));
    return new Response(
      JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-opus-5",
        stop_reason: "tool_use",
        content: [
          { type: "thinking", thinking: "…", signature: "sig-abc" },
          { type: "tool_use", id: "tu_1", name: "list_datasets", input: {} },
        ],
        usage: { input_tokens: 100, output_tokens: 20 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
  return { bodies };
}

describe("dispatchTools", () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
  });

  it("returns canonical tool calls, capabilities and attribution", async () => {
    stubAnthropicFetch();

    const result = await dispatchTools(emptyDb(), {
      orgId: "org-1",
      workflowType: "investigation",
      role: "investigator",
      stepKey: "investigate",
      system: "s",
      conversation: [userMessage("q")],
      tools: TOOLS,
    });

    expect(result.toolCalls).toEqual([{ id: "tu_1", name: "list_datasets", arguments: {} }]);
    expect(result.stopReason).toBe("tool_use");
    expect(result.meta.providerId).toBe("anthropic");
    expect(result.meta.tokensIn).toBe(100);
    expect(result.capabilities.source).toBe("vendored");
    // The thinking block comes back as replay state, signature intact — Anthropic rejects a
    // modified one, so "carried" is not enough; it has to be carried unchanged.
    expect(result.sidecar).toEqual({
      providerId: "anthropic",
      data: [{ type: "thinking", thinking: "…", signature: "sig-abc" }],
    });
  });

  it("uses the investigator's higher env-fallback model (D-G5)", async () => {
    const { bodies } = stubAnthropicFetch();
    await dispatchTools(emptyDb(), {
      orgId: "org-1",
      workflowType: "investigation",
      role: "investigator",
      stepKey: "investigate",
      system: "s",
      conversation: [userMessage("q")],
      tools: TOOLS,
    });
    expect(bodies[0].model).toBe(INVESTIGATOR_FALLBACK_MODEL);
  });

  it("strips foreign provider state and REPORTS it, so the loss can be evented (D-G13)", async () => {
    const { bodies } = stubAnthropicFetch();

    const result = await dispatchTools(emptyDb(), {
      orgId: "org-1",
      workflowType: "investigation",
      role: "investigator",
      stepKey: "investigate",
      system: "s",
      conversation: [
        userMessage("q"),
        // A turn produced earlier in this investigation by a DIFFERENT provider.
        assistantMessage("earlier", undefined, { providerId: "google", data: [{ text: "x" }] }),
      ],
      tools: TOOLS,
    });

    // Reported, so the loop can append `provider_state_dropped` — silence here would be the
    // debugging nightmare D-G13 is written to avoid.
    expect(result.droppedSidecars).toEqual([{ providerId: "google", count: 1 }]);
    // And genuinely absent from the wire: replaying Gemini parts to Anthropic is malformed.
    expect(JSON.stringify(bodies[0])).not.toContain("thoughtSignature");
  });

  it("clamps maxTokens below the non-streaming ceiling, not to the model's capability", async () => {
    // Caught a real bug: clamping to `capabilities.maxOutputTokens` (128K on Opus 5) makes the
    // Anthropic SDK refuse the request outright — "Streaming is required for operations that may
    // take longer than 10 minutes" — before any network call. The provider layer is
    // non-streaming by design, so the clamp has to respect that, not just the model.
    const { bodies } = stubAnthropicFetch();
    await dispatchTools(emptyDb(), {
      orgId: "org-1",
      workflowType: "investigation",
      role: "investigator",
      stepKey: "investigate",
      system: "s",
      conversation: [userMessage("q")],
      tools: TOOLS,
      maxTokens: 10_000_000,
    });
    expect(bodies[0].max_tokens).toBe(16_000);
  });

  it("still honours a caller asking for less", async () => {
    const { bodies } = stubAnthropicFetch();
    await dispatchTools(emptyDb(), {
      orgId: "org-1",
      workflowType: "investigation",
      role: "investigator",
      stepKey: "investigate",
      system: "s",
      conversation: [userMessage("q")],
      tools: TOOLS,
      maxTokens: 2_000,
    });
    expect(bodies[0].max_tokens).toBe(2_000);
  });
});

describe("resolveInvestigatorModel (D-G16)", () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;
  afterEach(() => {
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
  });

  it("reports the model an investigation would run on before turn 1", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
    const check = await resolveInvestigatorModel(emptyDb(), {
      orgId: "org-1",
      workflowType: "investigation",
    });
    expect(check.ok).toBe(true);
    if (!check.ok) throw new Error("unreachable");
    expect(check.model).toBe(INVESTIGATOR_FALLBACK_MODEL);
    expect(check.capabilities.toolCalling).toBe(true);
  });

  it("returns a clear reason instead of throwing when nothing is configured", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const check = await resolveInvestigatorModel(emptyDb(), {
      orgId: "org-1",
      workflowType: "investigation",
    });
    expect(check.ok).toBe(false);
    if (check.ok) throw new Error("unreachable");
    expect(check.reason).toContain("Settings");
  });
});
