import type { SupabaseClient } from "@supabase/supabase-js";
import { MemoryError } from "./types";

export interface InteractionEvent {
  id: string;
  occurredAt: string;
  action: string;
  entityType: string;
  entityId: string | null;
  workflowId: string | null;
  sourceId: string | null;
  summary: string;
  actorKind: "user" | "system";
  metadata: Record<string, string | boolean | number>;
  redacted: boolean;
}
export const INTERACTION_ROUTES = ["/", "/dashboard", "/data", "/investigations", "/workflows/new", "/settings", "/settings/models", "/settings/approvals", "/settings/memory"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DYNAMIC_ROUTE = /^\/(?:workflows\/[0-9a-f-]{36}(?:\/report)?|investigations\/[0-9a-f-]{36})$/i;

/** Navigation observations only; write-boundary database triggers record substantive actions. */
export async function recordPageView(db: SupabaseClient, orgId: string, userId: string, input: { id: string; action: "page_view"; route: string }): Promise<{ id: string; duplicate: boolean }> {
  if (!UUID.test(orgId) || !UUID.test(userId) || !UUID.test(input.id)) throw new MemoryError("A verified organization, user and event identifier are required.");
  if (input.action !== "page_view" || typeof input.route !== "string" || input.route.length > 160 || (!INTERACTION_ROUTES.includes(input.route as typeof INTERACTION_ROUTES[number]) && !DYNAMIC_ROUTE.test(input.route))) throw new MemoryError("Only approved application pathnames can be recorded. Query strings, fragments and external URLs are excluded.");
  const { data, error } = await db.rpc("record_page_interaction", { p_org: orgId, p_user: userId, p_id: input.id, p_route: input.route });
  if (error) {
    if (error.message === "interaction_rate_limited") throw new InteractionRateError();
    if (error.code === "42501" || error.code === "P0002") throw new MemoryError("The event or its target is unavailable for this user.", "not_found");
    if (error.code === "22023") throw new MemoryError("The navigation event is invalid or its identifier was reused with different content.");
    throw new MemoryError("The navigation event could not be saved. Retry shortly.", "unavailable");
  }
  if (!data || typeof data.id !== "string" || data.id.toLowerCase() !== input.id.toLowerCase() || typeof data.duplicate !== "boolean") throw new MemoryError("The event could not be confirmed.", "unavailable");
  return data;
}

export async function listInteractionEvents(db: SupabaseClient, orgId: string, userId: string, options: { limit?: number; before?: string; beforeId?: string } = {}): Promise<{ events: InteractionEvent[]; hasMore: boolean; nextCursor: { before: string; beforeId: string } | null }> {
  if (!UUID.test(orgId) || !UUID.test(userId)) throw new MemoryError("A verified organization and user are required.");
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new MemoryError("History pages must contain between 1 and 100 events.");
  if ((options.before === undefined) !== (options.beforeId === undefined) || (options.beforeId && !UUID.test(options.beforeId))) throw new MemoryError("Use both timestamp and event ID from the returned history cursor.");
  if (options.before && (!/^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/.test(options.before) || !Number.isFinite(Date.parse(options.before)))) throw new MemoryError("Invalid history cursor timestamp.");
  const { data, error } = await db.rpc("list_interaction_events", { p_org: orgId, p_user: userId, p_limit: limit + 1, p_before: options.before ?? null, p_before_id: options.beforeId ?? null });
  if (error || !Array.isArray(data) || data.length > limit + 1) throw new MemoryError("The interaction history is unavailable. Retry shortly.", "unavailable");
  const events: InteractionEvent[] = data.slice(0, limit);
  const last = events.at(-1);
  return { events, hasMore: data.length > limit, nextCursor: data.length > limit && last ? { before: last.occurredAt, beforeId: last.id } : null };
}

export class InteractionRateError extends Error {
  constructor() { super("Too many navigation events. Retry after one minute."); this.name = "InteractionRateError"; }
}
