/**
 * The harness's database handle (Plan 4 §4).
 *
 * `lib/harness/loop.ts` takes its client as a parameter, which is what makes it testable. The
 * Mastra step wrappers cannot: Mastra constructs their `execute` calls, so the client has to
 * come from somewhere ambient. This module is that somewhere, and it exists so the answer is
 * one overridable function rather than a `createAdminClient()` call buried in every step.
 *
 * The override is test-only and deliberately narrow — no config, no registry, no fallback
 * chain. Production always takes the first branch.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";

let override: SupabaseClient | null = null;

/** The service-role client harness steps write through (D5). */
export function harnessDb(): SupabaseClient {
  return override ?? createAdminClient();
}

/**
 * Substitute the client for a test. Pass `null` to restore.
 *
 * Tests that use `vi.mock("@/lib/supabase/admin")` do not need this; it is for the cases
 * module mocking cannot reach — a workflow driven by Mastra in a separate process, or a
 * script.
 */
export function setHarnessDbForTests(db: SupabaseClient | null): void {
  override = db;
}
