import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireOrgAccess } from "@/lib/api/guard";
import { loadDataSources } from "@/lib/data/store";
import { DataSourceError } from "@/lib/data/types";
import { indexDataSource } from "@/lib/memory/index";
import { memoryErrorResponse, memoryRequestBody } from "@/lib/memory/http";
import { MemoryError } from "@/lib/memory/types";

export const maxDuration = 300;
const schema = z.object({ sourceIds: z.array(z.string().uuid()).min(1).max(3).optional() });
export async function POST(req: NextRequest) {
  const access = await requireOrgAccess();
  if (!access.ok) return access.response;
  const { admin, profile } = access;
  if (profile.role !== "admin" && profile.role !== "analyst") return NextResponse.json({ error: "Only administrators and analysts may rebuild source search indexes." }, { status: 403 });
  try {
    const body = schema.safeParse(await memoryRequestBody(req));
    if (!body.success) throw new MemoryError("Choose at most three distinct source IDs per indexing request.");
    const ids = body.data.sourceIds;
    if (ids && new Set(ids).size !== ids.length) throw new MemoryError("Choose distinct source IDs.");
    let query = admin.from("data_sources").select("id,org_id").eq("org_id", profile.org_id).eq("status", "active");
    query = ids ? query.in("id", ids) : query.in("search_index_status", ["pending", "failed"]);
    // Pending first, so permanently failed older files cannot starve new backfill work.
    const { data, error } = await query.order("search_index_status", { ascending: false }).order("created_at", { ascending: true }).limit(3);
    if (error) throw new MemoryError("The source index catalog is unavailable. Apply the memory migration and retry.", "unavailable");
    if (data?.some(row => row.org_id !== profile.org_id) || (ids && (data?.length !== ids.length || data.some(row => !ids.includes(row.id))))) throw new MemoryError("One or more selected sources are unavailable in this organization.", "not_found");
    const results: { sourceId: string; status: "indexed" | "failed"; error?: string }[] = [];
    for (const row of data ?? []) {
      try {
        const [source] = await loadDataSources(admin, profile.org_id, [row.id]);
        const outcome = await indexDataSource(admin, profile.org_id, source);
        results.push({ sourceId: row.id, status: outcome.status, ...(outcome.error ? { error: outcome.error } : {}) });
      } catch (error) {
        const message = error instanceof DataSourceError ? error.message : "The source could not be loaded safely for indexing. Restore or re-upload it before retrying.";
        const { error: markError } = await admin.from("data_sources").update({ search_index_status: "failed", search_index_error: message }).eq("org_id", profile.org_id).eq("id", row.id).eq("status", "active");
        results.push({ sourceId: row.id, status: "failed", error: markError ? `${message} Its failure status could not be saved.` : message });
      }
    }
    const { count, error: countError } = await admin.from("data_sources").select("id", { count: "exact", head: true }).eq("org_id", profile.org_id).eq("status", "active").neq("search_index_status", "indexed");
    return NextResponse.json({ results, remaining: countError ? null : count ?? 0, ...(countError ? { warning: "The remaining source count could not be loaded. Refresh before continuing." } : {}) });
  } catch (error) { return memoryErrorResponse(error); }
}
