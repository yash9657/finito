import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toGeminiSchema, toJsonSchema } from "@/lib/llm/json-schema";
import { redactAndCap } from "@/lib/llm/redact";
import { buildChatCompletionsBody } from "@/lib/llm/providers/openai";
import { buildAnthropicParams } from "@/lib/llm/providers/anthropic";
import { buildGenerateContentBody } from "@/lib/llm/providers/google";
import { buildOllamaChatBody } from "@/lib/llm/providers/ollama";
import type { LLMCompleteParams } from "@/lib/llm/provider";
import { matchAdjudicationSchema } from "@/lib/types";

/* -------------------------------------------------------------------------- */
/* zod → JSON schema conversion (D-P9)                                         */
/* -------------------------------------------------------------------------- */

describe("toJsonSchema", () => {
  it("converts a real agent schema to a plain object schema with required + no additionalProperties", () => {
    const js = toJsonSchema(matchAdjudicationSchema);
    expect(js.$schema).toBeUndefined();
    expect(js.type).toBe("object");
    const props = js.properties as Record<string, unknown>;
    expect(Object.keys(props)).toEqual(
      expect.arrayContaining(["reasoning", "confirmedMatches", "rejectedPairs"]),
    );
    expect(js.required).toEqual(
      expect.arrayContaining(["reasoning", "confirmedMatches", "rejectedPairs"]),
    );
    expect(js.additionalProperties).toBe(false);
  });

  it("preserves enums on nested array items", () => {
    const js = toJsonSchema(matchAdjudicationSchema);
    const confirmed = (js.properties as Record<string, { items?: Record<string, unknown> }>)
      .confirmedMatches;
    const itemProps = confirmed.items?.properties as Record<string, { enum?: string[] }>;
    expect(itemProps.confidence.enum).toEqual(["high", "medium", "low"]);
  });
});

describe("toGeminiSchema", () => {
  it("translates objects/arrays/strings/enums into the Gemini OpenAPI subset", () => {
    const plain = toJsonSchema(
      z.object({
        reasoning: z.string(),
        items: z.array(z.object({ id: z.string(), kind: z.enum(["a", "b"]) })),
      }),
    );
    const g = toGeminiSchema(plain);
    expect(g.type).toBe("OBJECT");
    expect(g.properties?.reasoning.type).toBe("STRING");
    expect(g.properties?.items.type).toBe("ARRAY");
    const itemProps = g.properties?.items.items?.properties;
    expect(itemProps?.id.type).toBe("STRING");
    expect(itemProps?.kind.type).toBe("STRING");
    expect(itemProps?.kind.enum).toEqual(["a", "b"]);
    expect(g.required).toEqual(expect.arrayContaining(["reasoning", "items"]));
  });

  it("marks a nullable union field nullable and keeps the base type", () => {
    const plain = toJsonSchema(z.object({ n: z.number().nullable() }));
    const g = toGeminiSchema(plain);
    expect(g.properties?.n.type).toBe("NUMBER");
    expect(g.properties?.n.nullable).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* redactAndCap (D-P11)                                                        */
/* -------------------------------------------------------------------------- */

describe("redactAndCap", () => {
  it("redacts key-shaped fields case-insensitively and recursively", () => {
    const out = redactAndCap({
      apiKey: "sk-secret",
      api_key: "sk-secret2",
      Authorization: "Bearer x",
      token: "abc",
      nested: { access_token: "y", safe: "keep" },
      list: [{ ApiKey: "z" }],
    }) as Record<string, unknown>;
    expect(out.apiKey).toBe("[redacted]");
    expect(out.api_key).toBe("[redacted]");
    expect(out.Authorization).toBe("[redacted]");
    expect(out.token).toBe("[redacted]");
    const nested = out.nested as Record<string, unknown>;
    expect(nested.access_token).toBe("[redacted]");
    expect(nested.safe).toBe("keep");
    expect((out.list as Record<string, unknown>[])[0].ApiKey).toBe("[redacted]");
  });

  it("caps oversized payloads at 64KB with a head slice", () => {
    const big = { blob: "x".repeat(70 * 1024) };
    const out = redactAndCap(big) as { truncated: boolean; bytes: number; head: string };
    expect(out.truncated).toBe(true);
    expect(out.bytes).toBeGreaterThan(64 * 1024);
    expect(out.head.length).toBeLessThanOrEqual(8 * 1024);
  });

  it("passes small payloads through unchanged", () => {
    const out = redactAndCap({ hello: "world", n: 3 });
    expect(out).toEqual({ hello: "world", n: 3 });
  });

  /*
   * Regression (Plan 5): `/token/i` also matches `tokens_in`.
   *
   * Harmless while this only guarded `llm_raw` — usage lived in dedicated columns (D-P12) — but
   * Plan 4 reused it for harness_events payloads, where `loop.ts` writes its own token counts on
   * every `step_completed`. Those were being stored as "[redacted]", which quietly made
   * PLAN-4's "the usage dashboard becomes a query over the event stream" impossible.
   */
  it("does NOT redact token COUNTS — they are telemetry, not credentials", () => {
    const out = redactAndCap({
      tokens_in: 1200,
      tokens_out: 340,
      max_tokens: 16000,
      estimated_tokens_before: 90_000,
      estimated_tokens_after: 40_000,
      usage: { input_tokens: 1200, output_tokens: 340, prompt_eval_count: 12 },
    }) as Record<string, unknown>;

    expect(out.tokens_in).toBe(1200);
    expect(out.tokens_out).toBe(340);
    expect(out.max_tokens).toBe(16000);
    expect(out.estimated_tokens_before).toBe(90_000);
    expect((out.usage as Record<string, unknown>).input_tokens).toBe(1200);
  });

  it("still redacts every credential-shaped token key", () => {
    // The allowlist is exact-match, so anything not explicitly known stays fail-closed.
    const out = redactAndCap({
      access_token: "a",
      refresh_token: "b",
      id_token: "c",
      bearer_token: "d",
      token: "e",
      session_token_hint: "f",
      client_secret: "g",
      password: "h",
    }) as Record<string, unknown>;

    for (const key of Object.keys(out)) {
      expect(out[key], `${key} must be redacted`).toBe("[redacted]");
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Provider request-body builders (D-P9) — exact JSON, no network             */
/* -------------------------------------------------------------------------- */

const SCHEMA = { type: "object", properties: { x: { type: "string" } }, required: ["x"] };

function jsonParams(overrides: Partial<LLMCompleteParams> = {}): LLMCompleteParams {
  return {
    systemPrompt: "SYS",
    messages: [{ role: "user", content: "USER" }],
    model: "m",
    maxTokens: 16000,
    responseFormat: "json",
    jsonSchema: SCHEMA,
    ...overrides,
  };
}

describe("buildChatCompletionsBody (openai / custom)", () => {
  it("openai strict json_schema: schema in response_format, system message unchanged", () => {
    const body = buildChatCompletionsBody(jsonParams(), "json_schema");
    expect(body.model).toBe("m");
    expect(body.max_completion_tokens).toBe(16000);
    expect(body.messages).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: "USER" },
    ]);
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "output", schema: SCHEMA, strict: true },
    });
  });

  it("custom json_object: schema appended to the system prompt, json_object format", () => {
    const body = buildChatCompletionsBody(jsonParams(), "json_object");
    expect(body.response_format).toEqual({ type: "json_object" });
    const messages = body.messages as { role: string; content: string }[];
    expect(messages[0].content).toContain("SYS");
    expect(messages[0].content).toContain("Respond with JSON matching this schema");
    expect(messages[0].content).toContain('"x"');
  });

  it("text mode: no response_format", () => {
    const body = buildChatCompletionsBody(
      jsonParams({ responseFormat: "text", jsonSchema: undefined }),
      "json_schema",
    );
    expect(body.response_format).toBeUndefined();
  });
});

describe("buildAnthropicParams", () => {
  it("sets adaptive thinking and output_config.format from the plain schema", () => {
    const p = buildAnthropicParams(jsonParams());
    expect(p.model).toBe("m");
    expect(p.max_tokens).toBe(16000);
    expect(p.thinking).toEqual({ type: "adaptive" });
    expect(p.system).toBe("SYS");
    expect(p.output_config).toEqual({
      format: { type: "json_schema", schema: SCHEMA },
    });
  });

  it("omits output_config in text mode", () => {
    const p = buildAnthropicParams(jsonParams({ responseFormat: "text", jsonSchema: undefined }));
    expect(p.output_config).toBeUndefined();
  });
});

describe("buildGenerateContentBody (google)", () => {
  it("uses responseMimeType + converted responseSchema, key never in body", () => {
    const { body, schemaInPrompt } = buildGenerateContentBody(jsonParams());
    expect(schemaInPrompt).toBe(false);
    const gc = body.generationConfig as Record<string, unknown>;
    expect(gc.responseMimeType).toBe("application/json");
    expect((gc.responseSchema as { type: string }).type).toBe("OBJECT");
    expect(gc.maxOutputTokens).toBe(16000);
    expect(JSON.stringify(body)).not.toContain("apiKey");
    const contents = body.contents as { role: string }[];
    expect(contents[0].role).toBe("user");
  });
});

describe("buildOllamaChatBody", () => {
  it("sets stream:false, num_predict, format:json, schema-in-prompt", () => {
    const body = buildOllamaChatBody(jsonParams());
    expect(body.stream).toBe(false);
    expect((body.options as { num_predict: number }).num_predict).toBe(16000);
    expect(body.format).toBe("json");
    const messages = body.messages as { role: string; content: string }[];
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("Respond with JSON matching this schema");
  });
});
