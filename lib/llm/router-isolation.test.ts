import { afterEach, describe, expect, it, vi } from "vitest";
import { NoProviderConfiguredError, resolveProvider } from "@/lib/llm/router";
import { FIREWORKS_DEFAULT_MODEL } from "@/lib/llm/fireworks-config";

type Query = { table: string; filters: Record<string, unknown> };
function database(read: (query: Query) => { data: unknown; error: unknown }) {
  return { from(table: string) {
    const filters: Record<string, unknown> = {};
    const chain = { select: () => chain, eq: (key: string, value: unknown) => { filters[key] = value; return chain; }, maybeSingle: async () => read({ table, filters }) };
    return chain;
  } } as unknown as Parameters<typeof resolveProvider>[0];
}
const args = { orgId: "org-a", workflowType: "reconciliation" as const, stepKey: "match" };
const empty = () => ({ data: null, error: null });
afterEach(() => vi.unstubAllEnvs());

describe("server credential isolation", () => {
  it("prefers Fireworks for the explicitly bound production organization", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LLM_ENV_ORG_ID", "org-a");
    vi.stubEnv("FIREWORKS_API_KEY", "synthetic-fireworks-key");
    vi.stubEnv("FIREWORKS_MODEL", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-anthropic-key");
    const result = await resolveProvider(database(empty), args);
    expect(result.providerId).toBe("fireworks");
    expect(result.model).toBe(FIREWORKS_DEFAULT_MODEL);
  });

  it.each(["", "org-b"])("does not expose unbound or foreign credentials (%s)", async (org) => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LLM_ENV_ORG_ID", org);
    vi.stubEnv("FIREWORKS_API_KEY", "synthetic-fireworks-key");
    await expect(resolveProvider(database(empty), args)).rejects.toBeInstanceOf(NoProviderConfiguredError);
  });

  it("does not fail open to server credentials when assignment reads fail", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("FIREWORKS_API_KEY", "synthetic-fireworks-key");
    await expect(resolveProvider(database(() => ({ data: null, error: { message: "database unavailable" } })), args)).rejects.toThrow("Unable to load model assignment");
  });

  it("scopes a pinned provider lookup and rejects a foreign result defensively", async () => {
    const queries: Query[] = [];
    const db = database(query => {
      queries.push(query);
      if (query.table === "workflow_step_configs") return { data: { assigned_provider_config_id: "foreign-config" }, error: null };
      return { data: { id: "foreign-config", org_id: "org-b", is_active: true }, error: null };
    });
    await expect(resolveProvider(db, args)).rejects.toThrow("organization mismatch");
    expect(queries[1].filters).toMatchObject({ id: "foreign-config", org_id: "org-a" });
  });
});
