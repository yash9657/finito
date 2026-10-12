import type { SupabaseClient } from "@supabase/supabase-js";
import { MEMORY_LIMITS, MemoryError, type MemorySearchOptions, type MemorySearchResult, type PreferenceMemory } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
interface PreferenceRecord { id: string; org_id: string; user_id: string; content: string; status: "active" | "deleted"; source_question_id: string | null; source_question: string | null; created_at: string; updated_at: string }
const EMPTY_COVERAGE = { totalSources: 0, indexedSources: 0, pendingSources: 0, failedSources: 0 };

export async function getMemorySettings(db: SupabaseClient, orgId: string, userId: string): Promise<{ enabled: boolean }> {
  identity(orgId, userId);
  const { data, error } = await db.from("memory_settings").select("enabled,org_id,user_id").eq("org_id", orgId).eq("user_id", userId).maybeSingle();
  if (error) throw new MemoryError("Memory settings are unavailable. Apply the memory migration and retry.", "unavailable");
  if (data && (data.org_id !== orgId || data.user_id !== userId || typeof data.enabled !== "boolean")) throw new MemoryError("Memory settings failed their identity check.", "unavailable");
  return { enabled: data?.enabled ?? true };
}

export async function setMemoryEnabled(db: SupabaseClient, orgId: string, userId: string, enabled: boolean): Promise<{ enabled: boolean }> {
  identity(orgId, userId);
  if (typeof enabled !== "boolean") throw new MemoryError("enabled must be true or false.");
  const { error } = await db.rpc("set_memory_enabled", { p_org: orgId, p_user: userId, p_enabled: enabled });
  if (error) throw new MemoryError("The memory setting could not be saved. Retry shortly.", "unavailable");
  return { enabled };
}

export async function listPreferences(db: SupabaseClient, orgId: string, userId: string): Promise<PreferenceMemory[]> {
  identity(orgId, userId);
  const { data, error } = await db.from("memory_preferences").select("*").eq("org_id", orgId).eq("user_id", userId).eq("status", "active").order("updated_at", { ascending: false }).limit(MEMORY_LIMITS.preferences + 1);
  if (error) throw new MemoryError("Saved preferences are unavailable. Retry shortly.", "unavailable");
  if ((data?.length ?? 0) > MEMORY_LIMITS.preferences) throw new MemoryError("The saved preference limit was exceeded. Contact an administrator.", "unavailable");
  return ((data ?? []) as PreferenceRecord[]).map(record => preference(record, orgId, userId));
}

export async function savePreference(db: SupabaseClient, orgId: string, userId: string, input: { content: string; id?: string; sourceQuestionId?: string; automatic?: boolean }): Promise<PreferenceMemory> {
  identity(orgId, userId);
  const content = input.content?.trim();
  if (!content || content.length > MEMORY_LIMITS.preferenceChars) throw new MemoryError("A preference must contain 1–2,000 characters.");
  if ((input.id && !UUID.test(input.id)) || (input.sourceQuestionId && !UUID.test(input.sourceQuestionId))) throw new MemoryError("Invalid preference or question identifier.");
  if (input.automatic && !input.sourceQuestionId) throw new MemoryError("Remembering a preference from chat requires its original question as provenance.");
  const { data, error } = await db.rpc("save_memory_preference", { p_org: orgId, p_user: userId, p_content: content, p_id: input.id ?? null, p_question: input.sourceQuestionId ?? null, p_automatic: input.automatic ?? false });
  if (error) {
    if (error.message === "memory_disabled") throw new MemoryError("Memory is disabled. Enable it in settings before asking the assistant to remember preferences.", "disabled");
    if (error.code === "P0002") throw new MemoryError("Preference not found.", "not_found");
    if (error.message?.includes("at most 100")) throw new MemoryError("You have 100 saved preferences. Delete or update an existing preference before adding another.");
    if (error.code === "42501") throw new MemoryError("The preference or its original question is unavailable for this user.", "not_found");
    throw new MemoryError("The preference could not be saved. Retry shortly.", "unavailable");
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new MemoryError("The preference was not returned after saving.", "unavailable");
  return preference(row as PreferenceRecord, orgId, userId);
}

export async function deletePreference(db: SupabaseClient, orgId: string, userId: string, id: string): Promise<void> {
  identity(orgId, userId);
  if (!UUID.test(id)) throw new MemoryError("Invalid preference identifier.");
  const { data, error } = await db.rpc("delete_memory_preference", { p_org: orgId, p_user: userId, p_id: id });
  if (error) throw new MemoryError("The preference could not be deleted. Retry shortly.", "unavailable");
  if (data !== true) throw new MemoryError("Preference not found.", "not_found");
}

/** Ranked lexical retrieval. Agent callers must never opt into the manual-search override. */
export async function searchMemory(db: SupabaseClient, orgId: string, userId: string, options: MemorySearchOptions): Promise<MemorySearchResult> {
  identity(orgId, userId);
  const query = options.query?.trim();
  if (!query || query.length > MEMORY_LIMITS.queryChars) throw new MemoryError("Search with 1–500 characters.");
  const kinds = options.kinds ?? ["preference", "question", "source", "interaction"];
  if (!kinds.length || kinds.some(kind => !["preference", "question", "source", "interaction"].includes(kind)) || new Set(kinds).size !== kinds.length) throw new MemoryError("Choose distinct valid memory types.");
  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > MEMORY_LIMITS.results) throw new MemoryError("Search limit must be between 1 and 30.");
  const since = normalizeMemoryDate(options.since, false);
  const until = normalizeMemoryDate(options.until, true);
  if (since && until && since > until) throw new MemoryError("The start date must be on or before the end date.");
  const { enabled } = await getMemorySettings(db, orgId, userId);
  if (!enabled && !options.explicit) return { enabled, results: [], hasMore: false, coverage: EMPTY_COVERAGE };
  const { data, error } = await db.rpc("search_durable_memory", { p_org: orgId, p_user: userId, p_query: query, p_kinds: kinds, p_since: since, p_until: until, p_limit: limit + 1 });
  if (error) throw new MemoryError("Memory search is unavailable. Apply the memory migration and retry.", "unavailable");
  if (!data || !Array.isArray(data.results) || data.results.length > limit + 1 || !data.coverage) throw new MemoryError("Memory search returned an invalid result.", "unavailable");
  return { enabled, results: data.results.slice(0, limit), hasMore: data.results.length > limit, coverage: data.coverage };
}

export function normalizeMemoryDate(value: string | undefined, endOfDay: boolean): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) throw new MemoryError("Use an ISO date or timestamp for the history range.");
  const text = value.length === 10 ? `${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z` : value;
  const date = new Date(text);
  if (!Number.isFinite(date.getTime()) || (value.length === 10 && date.toISOString().slice(0, 10) !== value)) throw new MemoryError("The history range contains an invalid date.");
  return date.toISOString();
}

function identity(orgId: string, userId: string): void {
  if (!UUID.test(orgId) || !UUID.test(userId)) throw new MemoryError("Memory requires a verified organization and signed-in user.");
}
function preference(row: PreferenceRecord, orgId: string, userId: string): PreferenceMemory {
  if (row.org_id !== orgId || row.user_id !== userId || row.status !== "active") throw new MemoryError("Preference identity or deletion state failed validation.", "unavailable");
  return { id: row.id, content: row.content, sourceQuestionId: row.source_question_id, sourceQuestion: row.source_question, createdAt: row.created_at, updatedAt: row.updated_at, status: "active" };
}
