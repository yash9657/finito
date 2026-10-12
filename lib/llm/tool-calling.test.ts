/**
 * Cross-provider tool-calling parity (Plan 5, G2).
 *
 * These tests are the load-bearing half of "works with any model". `scripts/tool-calling-proof.ts`
 * runs the real thing against whatever is configured, but it can only cover providers whose
 * credentials are present — and it cannot pin the exact bytes we send. This file can do both, for
 * all five providers, on every commit:
 *
 *   1. THE SAME two-tool conversation is driven through every provider's `complete()` under a
 *      fake transport, and the exact request body is asserted.
 *   2. A recorded provider response is fed back, and the resulting canonical `toolCalls` are
 *      asserted — so a translation bug shows up here rather than as a confusing agent failure.
 *   3. A tool result is threaded back and the follow-up body is asserted, because the round trip
 *      is where the per-provider shapes diverge most (one user message vs one message per result
 *      vs `functionResponse` parts).
 *
 * The differences being pinned are exactly the ones HANDOFF-AGENT.md §5 lists as "not cosmetic".
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assistantMessage,
  toolResultMessage,
  userMessage,
  type CanonicalMessage,
  type ToolDefinition,
} from "@/lib/llm/messages";
import { buildAnthropicParams } from "@/lib/llm/providers/anthropic";
import { buildChatCompletionsBody, openaiProvider } from "@/lib/llm/providers/openai";
import { buildGenerateContentBody, googleProvider } from "@/lib/llm/providers/google";
import { buildOllamaChatBody, ollamaProvider } from "@/lib/llm/providers/ollama";
import { customProvider } from "@/lib/llm/providers/custom-endpoint";
import type { LLMCompleteParams } from "@/lib/llm/provider";

/* -------------------------------------------------------------------------- */
/* The shared fixture — one conversation, five providers                       */
/* -------------------------------------------------------------------------- */

const TOOLS: ToolDefinition[] = [
  {
    name: "list_datasets",
    description: "What financial data exists for this org.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "query_ledger",
    description: "Filter, group and aggregate ledger rows in one call.",
    parameters: {
      type: "object",
      properties: {
        dataset: { type: "string" },
        limit: { type: "integer" },
      },
      required: ["dataset"],
      additionalProperties: false,
    },
  },
];

/** Turn 1: the question. Turn 2: the model called a tool. Turn 3: here is the result. */
const CONVERSATION: CanonicalMessage[] = [
  userMessage("Why doesn't the bank account tie out?"),
  assistantMessage("Let me look at what data exists.", [
    { id: "call_1", name: "list_datasets", arguments: {} },
  ]),
  toolResultMessage([
    { toolCallId: "call_1", name: "list_datasets", content: '{"ok":true,"data":["erp_export"]}' },
  ]),
];

function params(overrides: Partial<LLMCompleteParams> = {}): LLMCompleteParams {
  return {
    systemPrompt: "You are an investigator.",
    messages: [],
    conversation: CONVERSATION,
    tools: TOOLS,
    toolChoice: "auto",
    model: "test-model",
    maxTokens: 4096,
    responseFormat: "text",
    apiKey: "k",
    ...overrides,
  };
}

/** Capture the single fetch a provider makes and reply with a recorded body. */
function stubFetch(responseBody: unknown): { calls: { url: string; body: unknown }[] } {
  const calls: { url: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(init.body as string) });
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/* -------------------------------------------------------------------------- */
/* Request shape — the exact bytes, per provider                               */
/* -------------------------------------------------------------------------- */

describe("request bodies carry tools in each provider's own dialect", () => {
  it("anthropic: input_schema, and all tool results in ONE user message", () => {
    const body = buildAnthropicParams(params());

    expect(body.tools).toEqual([
      { name: "list_datasets", description: TOOLS[0].description, input_schema: TOOLS[0].parameters },
      { name: "query_ledger", description: TOOLS[1].description, input_schema: TOOLS[1].parameters },
    ]);
    expect(body.tool_choice).toEqual({ type: "auto" });

    // The property that matters: three canonical messages → three Anthropic messages, with the
    // results batched. Splitting them trains the model out of parallel calls.
    expect(body.messages).toHaveLength(3);
    expect(body.messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "Let me look at what data exists." },
        { type: "tool_use", id: "call_1", name: "list_datasets", input: {} },
      ],
    });
    expect(body.messages[2]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_1",
          content: '{"ok":true,"data":["erp_export"]}',
        },
      ],
    });
  });

  it("anthropic: `required` maps to tool_choice `any`, not to a literal 'required'", () => {
    expect(buildAnthropicParams(params({ toolChoice: "required" })).tool_choice).toEqual({
      type: "any",
    });
    expect(buildAnthropicParams(params({ toolChoice: "none" })).tool_choice).toEqual({
      type: "none",
    });
  });

  it("openai: function wrapper, arguments as a JSON STRING, one tool message per result", () => {
    const body = buildChatCompletionsBody(params(), "json_schema");

    expect(body.tools).toEqual([
      { type: "function", function: { name: "list_datasets", description: TOOLS[0].description, parameters: TOOLS[0].parameters } },
      { type: "function", function: { name: "query_ledger", description: TOOLS[1].description, parameters: TOOLS[1].parameters } },
    ]);
    expect(body.tool_choice).toBe("auto");

    const messages = body.messages as Record<string, unknown>[];
    // system + user + assistant + tool
    expect(messages).toHaveLength(4);
    expect(messages[2]).toEqual({
      role: "assistant",
      content: "Let me look at what data exists.",
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "list_datasets", arguments: "{}" } },
      ],
    });
    expect(messages[3]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: '{"ok":true,"data":["erp_export"]}',
    });
  });

  it("openai: a tool-only assistant turn sends content null, not an empty string", () => {
    // Several OpenAI-compatible gateways reject `content: ""` alongside tool_calls.
    const body = buildChatCompletionsBody(
      params({
        conversation: [
          userMessage("q"),
          assistantMessage("", [{ id: "c", name: "list_datasets", arguments: {} }]),
        ],
      }),
      "json_schema",
    );
    const messages = body.messages as Record<string, unknown>[];
    expect(messages[2].content).toBeNull();
  });

  it("google: functionDeclarations, and functionResponse parts in a user turn", () => {
    const { body } = buildGenerateContentBody(params());

    const tools = body.tools as { functionDeclarations: Record<string, unknown>[] }[];
    expect(tools[0].functionDeclarations.map((d) => d.name)).toEqual([
      "list_datasets",
      "query_ledger",
    ]);
    // Gemini takes its own OpenAPI subset, not raw JSON Schema — uppercase types.
    expect(tools[0].functionDeclarations[1].parameters).toMatchObject({ type: "OBJECT" });
    expect(body.toolConfig).toEqual({ functionCallingConfig: { mode: "AUTO" } });

    const contents = body.contents as { role: string; parts: Record<string, unknown>[] }[];
    expect(contents[1]).toEqual({
      role: "model",
      parts: [
        { text: "Let me look at what data exists." },
        { functionCall: { name: "list_datasets", args: {} } },
      ],
    });
    expect(contents[2]).toEqual({
      role: "user",
      parts: [
        {
          functionResponse: {
            name: "list_datasets",
            response: { result: '{"ok":true,"data":["erp_export"]}' },
          },
        },
      ],
    });
  });

  it("ollama: OpenAI-shaped tools, and no `format: json` when tools are offered", () => {
    const body = buildOllamaChatBody(params());
    expect((body.tools as Record<string, unknown>[])).toHaveLength(2);
    // `format: 'json'` + tools makes a local model DESCRIBE a call instead of making one.
    expect(body.format).toBeUndefined();
  });
});

describe("native JSON output is never sent alongside tools (D-G14)", () => {
  const jsonAndTools = params({ responseFormat: "json", jsonSchema: { type: "object" } });

  it("anthropic omits output_config", () => {
    expect(buildAnthropicParams(jsonAndTools).output_config).toBeUndefined();
  });
  it("openai omits response_format", () => {
    expect(buildChatCompletionsBody(jsonAndTools, "json_schema").response_format).toBeUndefined();
  });
  it("google omits responseMimeType", () => {
    const { body } = buildGenerateContentBody(jsonAndTools);
    expect((body.generationConfig as Record<string, unknown>).responseMimeType).toBeUndefined();
  });
  it("ollama omits format", () => {
    expect(buildOllamaChatBody(jsonAndTools).format).toBeUndefined();
  });

  it("but each still sends it when no tools are offered", () => {
    const jsonOnly = params({
      responseFormat: "json",
      jsonSchema: { type: "object", properties: {} },
      tools: undefined,
    });
    expect(buildAnthropicParams(jsonOnly).output_config).toBeDefined();
    expect(buildChatCompletionsBody(jsonOnly, "json_schema").response_format).toBeDefined();
    expect(buildOllamaChatBody(jsonOnly).format).toBe("json");
  });
});

/* -------------------------------------------------------------------------- */
/* Response shape — a recorded reply becomes canonical tool calls              */
/* -------------------------------------------------------------------------- */

describe("responses normalize to canonical tool calls", () => {
  it("openai: parses the JSON-string arguments", async () => {
    stubFetch({
      model: "gpt-x",
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: null,
            tool_calls: [
              {
                id: "call_abc",
                type: "function",
                function: { name: "query_ledger", arguments: '{"dataset":"erp_export","limit":50}' },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    const result = await openaiProvider.complete(params());
    expect(result.stopReason).toBe("tool_use");
    expect(result.toolCalls).toEqual([
      { id: "call_abc", name: "query_ledger", arguments: { dataset: "erp_export", limit: 50 } },
    ]);
  });

  it("openai: repairs malformed arguments and MARKS the call as salvaged", async () => {
    // A trailing comma and an unquoted key — the two most common weak-gateway slips.
    stubFetch({
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: null,
            tool_calls: [
              {
                id: "c1",
                function: { name: "query_ledger", arguments: '{dataset: "erp_export", limit: "50",}' },
              },
            ],
          },
        },
      ],
    });

    const result = await openaiProvider.complete(params());
    expect(result.toolCalls?.[0]).toMatchObject({
      name: "query_ledger",
      // "50" coerced to 50 because the schema says integer.
      arguments: { dataset: "erp_export", limit: 50 },
      salvaged: true,
    });
    expect(result.toolCalls?.[0].salvageStrategy).toBeDefined();
  });

  it("openai: rejects a turn naming a tool that was never offered", async () => {
    stubFetch({
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: null,
            tool_calls: [{ id: "c", function: { name: "drop_table", arguments: "{}" } }],
          },
        },
      ],
    });
    await expect(openaiProvider.complete(params())).rejects.toThrow("invalid or unsupported tool calls");
  });

  it("google: synthesizes positional ids so two calls to ONE tool stay distinct (D-G15)", async () => {
    stubFetch({
      modelVersion: "gemini-x",
      candidates: [
        {
          finishReason: "STOP",
          content: {
            parts: [
              { functionCall: { name: "query_ledger", args: { dataset: "erp_export" } } },
              { functionCall: { name: "query_ledger", args: { dataset: "bank_statement" } } },
            ],
          },
        },
      ],
    });

    const result = await googleProvider.complete(params());
    // Gemini sends no ids and matches by name. Two calls to the same tool would be
    // indistinguishable; position is what keeps them apart.
    expect(result.toolCalls?.map((c) => c.id)).toEqual(["query_ledger#0", "query_ledger#1"]);
    expect(result.toolCalls?.[1].arguments).toEqual({ dataset: "bank_statement" });
  });

  it("google: carries the raw parts as a sidecar so thought signatures survive a replay", async () => {
    stubFetch({
      candidates: [
        {
          content: {
            parts: [
              { functionCall: { name: "list_datasets", args: {} }, thoughtSignature: "opaque-sig" },
            ],
          },
        },
      ],
    });
    const result = await googleProvider.complete(params());
    expect(result.sidecar?.providerId).toBe("google");
    expect(result.sidecar?.data).toEqual([
      { functionCall: { name: "list_datasets", args: {} }, thoughtSignature: "opaque-sig" },
    ]);
  });

  it("ollama: accepts arguments as an OBJECT, not a string", async () => {
    // The single most common cross-provider mistake: Ollama does not stringify arguments.
    stubFetch({
      model: "llama3.1",
      message: {
        content: "",
        tool_calls: [{ function: { name: "query_ledger", arguments: { dataset: "erp_export" } } }],
      },
      done_reason: "stop",
    });

    const result = await ollamaProvider.complete(params({ baseUrl: "http://localhost:11434" }));
    expect(result.toolCalls).toEqual([
      { id: "call-0-query_ledger", name: "query_ledger", arguments: { dataset: "erp_export" } },
    ]);
    expect(result.stopReason).toBe("tool_use");
  });

  it("ollama: salvages a call the model wrote as prose, and marks it", async () => {
    stubFetch({
      model: "llama3.1",
      message: {
        content:
          'I should look at the ledger.\n```json\n{"name": "query_ledger", "arguments": {"dataset": "erp_export"}}\n```',
      },
    });

    const result = await ollamaProvider.complete(params({ baseUrl: "http://localhost:11434" }));
    expect(result.toolCalls?.[0]).toMatchObject({
      name: "query_ledger",
      arguments: { dataset: "erp_export" },
      salvaged: true,
      salvageStrategy: "fenced_json",
    });
  });

  it("custom: reaches the OpenAI path against the configured base url", async () => {
    const { calls } = stubFetch({
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: null,
            tool_calls: [{ id: "c", function: { name: "list_datasets", arguments: "{}" } }],
          },
        },
      ],
    });

    const result = await customProvider.complete(
      params({ baseUrl: "https://api.deepseek.com" }),
    );
    expect(calls[0].url).toBe("https://api.deepseek.com/v1/chat/completions");
    expect(result.toolCalls?.[0].name).toBe("list_datasets");
  });
});

/* -------------------------------------------------------------------------- */
/* Round trip — a text-only answer must not read as a failure                  */
/* -------------------------------------------------------------------------- */

describe("a tool-free turn is a normal outcome, not an error", () => {
  it("openai: an empty completion cannot masquerade as a successful tool-free answer", async () => {
    stubFetch({ choices: [{ finish_reason: "stop", message: { content: null } }] });
    await expect(openaiProvider.complete(params())).rejects.toThrow("empty completion");
    // Without them, the legacy contract stands: no content is a hard failure.
    await expect(
      openaiProvider.complete(params({ tools: undefined, conversation: undefined, messages: [{ role: "user", content: "x" }] })),
    ).rejects.toThrow(/no message content/);
  });

  it("openai: a plain text answer ends the turn", async () => {
    stubFetch({
      choices: [{ finish_reason: "stop", message: { content: "The account ties out." } }],
    });
    const result = await openaiProvider.complete(params());
    expect(result.stopReason).toBe("end");
    expect(result.toolCalls).toBeUndefined();
  });
});
