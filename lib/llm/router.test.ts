import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ENV_FALLBACK_MODEL,
  NoProviderConfiguredError,
  resolveProvider,
} from "@/lib/llm/router";
import { encryptApiKey } from "@/lib/llm/crypto";
import type { OrgModelConfig } from "@/lib/types";

/* -------------------------------------------------------------------------- */
/* A tiny chainable Supabase-admin mock: from(table).select().eq()... .maybeSingle().*/
/* `handler(table, filters)` returns the row (or null) for a resolved query.   */
/* -------------------------------------------------------------------------- */

function makeDb(handler: (table: string, filters: Record<string, unknown>) => unknown) {
  const builder = (table: string) => {
    const filters: Record<string, unknown> = {};
    const chain = {
      select: () => chain,
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return chain;
      },
      maybeSingle: async () => ({ data: handler(table, filters), error: null }),
    };
    return chain;
  };
  // Only `.from` is used by resolveProvider.
  return { from: builder } as unknown as Parameters<typeof resolveProvider>[0];
}

const ORG = "org-1";

function config(overrides: Partial<OrgModelConfig>): OrgModelConfig {
  return {
    id: "cfg-x",
    org_id: ORG,
    provider: "openai",
    display_name: "Test",
    api_key_ciphertext: "",
    key_last4: "",
    base_url: null,
    default_model: "gpt-4.1",
    is_default: false,
    is_active: true,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("resolveProvider (D-P7 order)", () => {
  const originalEnv = process.env.ANTHROPIC_API_KEY;
  const originalSecret = process.env.LLM_KEY_ENCRYPTION_SECRET;

  beforeEach(() => {
    process.env.LLM_KEY_ENCRYPTION_SECRET = "router-test-secret-0123456789";
    delete process.env.ANTHROPIC_API_KEY;
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalEnv;
    if (originalSecret === undefined) delete process.env.LLM_KEY_ENCRYPTION_SECRET;
    else process.env.LLM_KEY_ENCRYPTION_SECRET = originalSecret;
  });

  it("step-config pin beats the org default and decrypts the key", async () => {
    const pinned = config({
      id: "cfg-pinned",
      provider: "openai",
      default_model: "gpt-4.1",
      api_key_ciphertext: encryptApiKey("sk-pinned-key"),
      key_last4: "-key",
    });
    const def = config({ id: "cfg-default", is_default: true, default_model: "should-not-win" });

    const db = makeDb((table, f) => {
      if (table === "workflow_step_configs") return { assigned_provider_config_id: "cfg-pinned" };
      if (table === "org_model_configs") {
        if (f.id === "cfg-pinned") return pinned;
        if (f.is_default === true) return def;
      }
      return null;
    });

    const r = await resolveProvider(db, { orgId: ORG, workflowType: "reconciliation", stepKey: "match" });
    expect(r.configId).toBe("cfg-pinned");
    expect(r.providerId).toBe("openai");
    expect(r.model).toBe("gpt-4.1");
    expect(r.apiKey).toBe("sk-pinned-key");
    expect(r.warning).toBeUndefined();
  });

  it("falls back to the org default (with a warning) when the pin is inactive", async () => {
    const inactive = config({ id: "cfg-pinned", is_active: false });
    const def = config({
      id: "cfg-default",
      provider: "anthropic",
      is_default: true,
      default_model: "claude-sonnet-4-6",
    });

    const db = makeDb((table, f) => {
      if (table === "workflow_step_configs") return { assigned_provider_config_id: "cfg-pinned" };
      if (table === "org_model_configs") {
        if (f.id === "cfg-pinned") return inactive;
        if (f.is_default === true) return def;
      }
      return null;
    });

    const r = await resolveProvider(db, { orgId: ORG, workflowType: "reconciliation", stepKey: "match" });
    expect(r.configId).toBe("cfg-default");
    expect(r.providerId).toBe("anthropic");
    expect(r.warning).toMatch(/inactive/i);
  });

  it("uses the org default when there is no pin", async () => {
    const def = config({ id: "cfg-default", is_default: true, provider: "google", default_model: "gemini-2.5-pro" });
    const db = makeDb((table, f) => {
      if (table === "workflow_step_configs") return null;
      if (table === "org_model_configs" && f.is_default === true) return def;
      return null;
    });
    const r = await resolveProvider(db, { orgId: ORG, workflowType: "fpa_commentary", stepKey: "commentary" });
    expect(r.configId).toBe("cfg-default");
    expect(r.providerId).toBe("google");
    expect(r.model).toBe("gemini-2.5-pro");
  });

  it("falls back to the env-var Anthropic config when the org has no configs", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-env-fallback";
    const db = makeDb(() => null);
    const r = await resolveProvider(db, { orgId: ORG, workflowType: "ap_matching", stepKey: "match_invoices" });
    expect(r.configId).toBeNull();
    expect(r.providerId).toBe("anthropic");
    expect(r.model).toBe(ENV_FALLBACK_MODEL);
    expect(r.apiKey).toBe("sk-env-fallback");
  });

  it("throws NoProviderConfiguredError when nothing resolves", async () => {
    const db = makeDb(() => null);
    await expect(
      resolveProvider(db, { orgId: ORG, workflowType: "reconciliation", stepKey: "match" }),
    ).rejects.toBeInstanceOf(NoProviderConfiguredError);
  });

  it("treats a keyless config (empty ciphertext) as undefined apiKey", async () => {
    const def = config({
      id: "cfg-ollama",
      provider: "ollama",
      is_default: true,
      api_key_ciphertext: "",
      base_url: "http://localhost:11434",
      default_model: "llama3.2:3b",
    });
    const db = makeDb((table, f) => {
      if (table === "workflow_step_configs") return null;
      if (table === "org_model_configs" && f.is_default === true) return def;
      return null;
    });
    const r = await resolveProvider(db, { orgId: ORG, workflowType: "reconciliation", stepKey: "match" });
    expect(r.apiKey).toBeUndefined();
    expect(r.baseUrl).toBe("http://localhost:11434");
    expect(r.providerId).toBe("ollama");
  });
});
