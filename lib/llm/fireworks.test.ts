import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildFireworksBody,
  fireworksCacheHeaders,
  fireworksProvider,
} from "@/lib/llm/providers/fireworks";
import {
  FIREWORKS_BASE_URL,
  FIREWORKS_DEFAULT_MODEL,
} from "@/lib/llm/fireworks-config";
import {
  assistantMessage,
  toolResultMessage,
  userMessage,
} from "@/lib/llm/messages";
import {
  TransportError,
  withTransportRetry,
  type LLMCompleteParams,
} from "@/lib/llm/provider";

const tool = {
  name: "lookup_invoice",
  description: "Read an invoice",
  parameters: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
};
const params: LLMCompleteParams = {
  model: FIREWORKS_DEFAULT_MODEL,
  apiKey: "synthetic-secret",
  maxTokens: 2048,
  systemPrompt: "Synthetic finance check",
  messages: [{ role: "user", content: "Check DEMO-42" }],
  responseFormat: "json",
  jsonSchema: {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
    additionalProperties: false,
  },
};

function response(
  message: unknown = { content: '{"ok":true}' },
  finish = "stop",
  usage: unknown = { prompt_tokens: 50, completion_tokens: 20 },
) {
  return new Response(
    JSON.stringify({
      model: params.model,
      choices: [{ message, finish_reason: finish }],
      usage,
    }),
    { status: 200 },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Fireworks protocol and failure boundaries", () => {
  it("isolates cached prefixes by organization and routes a run consistently without exposing IDs", async () => {
    const scope = {
      organizationId: "private-org-a",
      sessionId: "private-run-a",
    };
    const headers = fireworksCacheHeaders(scope);
    expect(headers).toEqual(fireworksCacheHeaders(scope));
    expect(JSON.stringify(headers)).not.toContain("private-");
    expect(headers["x-prompt-cache-isolation-key"]).not.toBe(
      fireworksCacheHeaders({ ...scope, organizationId: "private-org-b" })[
        "x-prompt-cache-isolation-key"
      ],
    );
    expect(headers["x-session-affinity"]).not.toBe(
      fireworksCacheHeaders({ ...scope, sessionId: "private-run-b" })[
        "x-session-affinity"
      ],
    );
    expect(fireworksCacheHeaders(undefined)).toEqual({});
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      response(undefined, "stop", {
        prompt_tokens: 50,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 40 },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const result = await fireworksProvider.complete({
      ...params,
      cacheScope: scope,
    });
    expect(fetch.mock.calls[0][1]?.headers).toMatchObject(headers);
    expect(result.cachedTokensIn).toBe(40);
    expect(result.tokensIn).toBe(50);
  });

  it.each([-1, 51, 1.5, "40", null])(
    "ignores invalid cache telemetry (%s) while retaining total usage",
    async (cached_tokens) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          response(undefined, "stop", {
            prompt_tokens: 50,
            completion_tokens: 20,
            prompt_tokens_details: { cached_tokens },
          }),
        ),
      );
      const result = await fireworksProvider.complete(params);
      expect(result.cachedTokensIn).toBeUndefined();
      expect(result.tokensIn).toBe(50);
    },
  );

  it("sends schema-constrained JSON with the Fireworks token field and schema in the prompt", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response());
    vi.stubGlobal("fetch", fetch);
    await fireworksProvider.complete(params);
    expect(fetch.mock.calls[0][0]).toBe(
      `${FIREWORKS_BASE_URL}/chat/completions`,
    );
    const init = fetch.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.max_tokens).toBe(2048);
    expect(body.max_completion_tokens).toBeUndefined();
    expect(body.response_format.json_schema.schema).toEqual(params.jsonSchema);
    expect(body.messages[0].content).toContain(
      JSON.stringify(params.jsonSchema),
    );
    expect(init.redirect).toBe("error");
  });

  it("replays reasoning only on its assistant turn after batched tool results", () => {
    const call = {
      id: "call-1",
      name: tool.name,
      arguments: { id: "DEMO-42" },
    };
    const body = buildFireworksBody({
      ...params,
      tools: [tool],
      conversation: [
        userMessage("Inspect the invoice"),
        assistantMessage("", [call], {
          providerId: "fireworks",
          data: "opaque-one",
        }),
        toolResultMessage([
          { toolCallId: "call-1", name: tool.name, content: "{}" },
          { toolCallId: "call-2", name: tool.name, content: "{}" },
        ]),
        assistantMessage("Ready", undefined, {
          providerId: "fireworks",
          data: "opaque-two",
        }),
      ],
    });
    const messages = body.messages as Record<string, unknown>[];
    expect(messages[2].reasoning_content).toBe("opaque-one");
    expect(messages[5].reasoning_content).toBe("opaque-two");
    expect(messages[3].reasoning_content).toBeUndefined();
    expect(body.response_format).toBeUndefined();
  });

  it("preserves native reasoning state in the result for the next tool turn", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response(
          {
            content: null,
            reasoning_content: "opaque",
            tool_calls: [
              {
                id: "c1",
                type: "function",
                function: { name: tool.name, arguments: '{"id":"DEMO-42"}' },
              },
            ],
          },
          "tool_calls",
        ),
      ),
    );
    const result = await fireworksProvider.complete({
      ...params,
      tools: [tool],
      toolChoice: "required",
    });
    expect(result.toolCalls?.[0].arguments).toEqual({ id: "DEMO-42" });
    expect(result.sidecar).toEqual({ providerId: "fireworks", data: "opaque" });
  });

  it("refuses endpoint overrides before transmitting a key", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      fireworksProvider.complete({
        ...params,
        baseUrl: "https://attacker.example",
      }),
    ).rejects.toThrow("standard Fireworks endpoint");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["length", "content_filter"])(
    "rejects %s even when the payload appears valid",
    async (finish) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => response(undefined, finish)),
      );
      await expect(fireworksProvider.complete(params)).rejects.toThrow();
    },
  );

  it.each([
    { message: { content: "" }, finish: "stop" },
    { message: { content: null, tool_calls: [] }, finish: "tool_calls" },
    {
      message: {
        content: null,
        tool_calls: [
          { id: "bad", function: { name: "send_payment", arguments: "{}" } },
        ],
      },
      finish: "tool_calls",
    },
    {
      message: {
        content: null,
        tool_calls: [
          {
            id: "same",
            function: { name: tool.name, arguments: '{"id":"A"}' },
          },
          {
            id: "same",
            function: { name: tool.name, arguments: '{"id":"B"}' },
          },
        ],
      },
      finish: "tool_calls",
    },
  ])(
    "rejects malformed or empty tool turns without executing a subset",
    async ({ message, finish }) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => response(message, finish)),
      );
      await expect(
        fireworksProvider.complete({ ...params, tools: [tool] }),
      ).rejects.toThrow();
    },
  );

  it("refuses unmetered completions so run budgets cannot silently count zero", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(undefined, "stop", null)),
    );
    await expect(fireworksProvider.complete(params)).rejects.toThrow(
      "token usage",
    );
  });

  it("maps errors without including secrets or provider response bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("synthetic-secret private invoice", { status: 401 }),
      ),
    );
    await expect(fireworksProvider.complete(params)).rejects.toThrow(
      "Invalid API key",
    );
  });
});

describe("deadline-aware retries", () => {
  it("cancels rate-limit backoff without making another billable request", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const invoke = vi.fn(async () => {
      throw new TransportError(429, 60, "HTTP 429");
    });
    const result = withTransportRetry(invoke, controller.signal);
    const rejected = expect(result).rejects.toThrow("deadline");
    await Promise.resolve();
    controller.abort(new Error("deadline"));
    await rejected;
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not enter the transport after a deadline has already expired", async () => {
    const invoke = vi.fn();
    await expect(
      withTransportRetry(invoke, AbortSignal.abort(new Error("deadline"))),
    ).rejects.toThrow("deadline");
    expect(invoke).not.toHaveBeenCalled();
  });
});
