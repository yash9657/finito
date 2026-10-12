import type { SupabaseClient } from "@supabase/supabase-js";
import type { InteractionEvent } from "./events";

export interface InteractionTarget { label: string; href: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGES: Record<string, string> = {
  "/": "About FinFlow", "/dashboard": "Overview", "/data": "Your data",
  "/investigations": "Ask your data", "/workflows/new": "New workflow",
  "/settings": "Workspace settings", "/settings/models": "Models & usage",
  "/settings/approvals": "Approval controls", "/settings/memory": "Memory & history",
};
function workflowTarget(event: InteractionEvent): string | null {
  if (event.workflowId && UUID.test(event.workflowId)) return event.workflowId;
  const route = typeof event.metadata?.route === "string" ? event.metadata.route : "";
  return /^\/(?:workflows|investigations)\/([0-9a-f-]{36})(?:\/report)?$/i.exec(route)?.[1] ?? null;
}

/** Resolve names at read time; never copy file names or question text into the ledger.
 * Scoped queries recheck current access and omit deleted/unavailable targets.
 */
export async function interactionTargets(db: SupabaseClient, orgId: string, events: InteractionEvent[]): Promise<Record<string, InteractionTarget>> {
  const visible = events.filter(event => !event.redacted);
  const sourceIds = [...new Set(visible.flatMap(event => event.sourceId && UUID.test(event.sourceId) ? [event.sourceId] : []))];
  const workflowIds = [...new Set(visible.flatMap(event => { const id = workflowTarget(event); return id && UUID.test(id) ? [id] : []; }))];
  const [sources, workflows] = await Promise.all([
    sourceIds.length ? db.from("data_sources").select("id,filename").eq("org_id", orgId).eq("status", "active").in("id", sourceIds) : Promise.resolve({ data: [], error: null }),
    workflowIds.length ? db.from("workflows").select("id,name,type").eq("org_id", orgId).in("id", workflowIds) : Promise.resolve({ data: [], error: null }),
  ]);
  const files = new Map((sources.error ? [] : sources.data ?? []).map(source => [source.id, source.filename]));
  const runs = new Map((workflows.error ? [] : workflows.data ?? []).map(workflow => [workflow.id, workflow]));
  const targets: Record<string, InteractionTarget> = {};
  for (const event of visible) {
    const route = typeof event.metadata?.route === "string" ? event.metadata.route : "";
    const file = event.sourceId ? files.get(event.sourceId) : null;
    const workflowId = workflowTarget(event);
    const workflow = workflowId ? runs.get(workflowId) : null;
    if (file) targets[event.id] = { label: file, href: `/data?source=${event.sourceId}` };
    else if (workflow) targets[event.id] = {
      label: workflow.name,
      href: workflow.type === "investigation" ? `/investigations/${workflow.id}` : `/workflows/${workflow.id}${route.endsWith("/report") ? "/report" : ""}`,
    };
    else if (event.action === "page_view" && Object.hasOwn(PAGES, route)) targets[event.id] = { label: PAGES[route], href: route };
  }
  return targets;
}
