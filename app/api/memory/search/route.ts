import { NextResponse, type NextRequest } from "next/server";
import { requireOrgAccess } from "@/lib/api/guard";
import { searchMemory } from "@/lib/memory/store";
import { memoryErrorResponse } from "@/lib/memory/http";
import type { MemoryKind } from "@/lib/memory/types";

export async function GET(req: NextRequest) {
  const access = await requireOrgAccess();
  if (!access.ok) return access.response;
  try {
    const params = req.nextUrl.searchParams;
    const result = await searchMemory(access.admin, access.profile.org_id, access.profile.id, {
      query: params.get("q") ?? "",
      kinds: params.has("kinds") ? params.get("kinds")!.split(",") as MemoryKind[] : undefined,
      since: params.get("since") ?? undefined,
      until: params.get("until") ?? undefined,
      limit: params.has("limit") ? Number(params.get("limit")) : undefined,
      // This endpoint is an explicit user search, not automatic assistant recall.
      explicit: true,
    });
    return NextResponse.json(result);
  } catch (error) { return memoryErrorResponse(error); }
}
