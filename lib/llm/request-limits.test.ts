import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { assertModelInputWithinLimits, MAX_MODEL_INPUT_BYTES } from "@/lib/llm/request-limits";
import { FIREWORKS_DEFAULT_MODEL } from "@/lib/llm/fireworks-config";
import { invoke, type ResolvedProvider } from "@/lib/llm/router";

afterEach(() => vi.unstubAllEnvs());
describe("bounded model input", () => {
  it("rejects a large source before transmitting it to a provider", async () => {
    const complete = vi.fn();
    const resolved: ResolvedProvider = { providerId: "fireworks", model: FIREWORKS_DEFAULT_MODEL, configId: null, provider: { id: "fireworks", complete, testConnection: vi.fn() } };
    await expect(invoke(resolved, { system: "Check financial rows", user: "x".repeat(MAX_MODEL_INPUT_BYTES + 1), schema: z.object({ ok: z.boolean() }) })).rejects.toThrow("No source rows were truncated");
    expect(complete).not.toHaveBeenCalled();
  });

  it("accounts for UTF-8 bytes rather than JavaScript character count", () => {
    expect(() => assertModelInputWithinLimits("fireworks", FIREWORKS_DEFAULT_MODEL, { source: "€".repeat(90_000) }, 16_000)).toThrow("256 KiB");
  });

  it("lets deployments tighten but not expand the request ceiling", () => {
    vi.stubEnv("LLM_MAX_INPUT_BYTES", "2048");
    expect(() => assertModelInputWithinLimits("fireworks", FIREWORKS_DEFAULT_MODEL, "x".repeat(3000), 16000)).toThrow("2 KiB");
    vi.stubEnv("LLM_MAX_INPUT_BYTES", "999999999");
    expect(() => assertModelInputWithinLimits("fireworks", FIREWORKS_DEFAULT_MODEL, "x".repeat(MAX_MODEL_INPUT_BYTES + 1), 16000)).toThrow("256 KiB");
  });

  it("applies the smaller known model context budget as well", () => {
    expect(() => assertModelInputWithinLimits("custom", "unknown-model", { source: "x".repeat(80_000) }, 4096)).toThrow("safe context budget");
  });
});
