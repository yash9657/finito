import { describe, expect, it } from "vitest";
import { redactAndCap } from "./redact";

describe("token telemetry retains counts without becoming a credential channel", () => {
  it("keeps numeric cache and memory metrics, including unknown cache usage", () => {
    const input = {
      cached_tokens_in: 80,
      estimated_tokens: 1200,
      estimated_input_tokens: 900,
      system_estimated_tokens: 400,
      tool_definitions_estimated_tokens: 300,
      question_estimated_tokens: 20,
      nested: { cached_tokens_in: null },
    };
    expect(redactAndCap(input)).toEqual(input);
  });
  it("redacts strings and nested credentials even under a known usage key", () => {
    expect(
      redactAndCap({
        cached_tokens_in: "private-key",
        tokens_in: { secret: "private-key" },
        estimated_tokens: -1,
        tokens_out: Infinity,
        access_token: "private-key",
      }),
    ).toEqual({
      cached_tokens_in: "[redacted]",
      tokens_in: "[redacted]",
      estimated_tokens: "[redacted]",
      tokens_out: "[redacted]",
      access_token: "[redacted]",
    });
  });
});
