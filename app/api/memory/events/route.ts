import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireOrgAccess } from "@/lib/api/guard";
import { InteractionRateError, listInteractionEvents, recordPageView } from "@/lib/memory/events";
import { memoryErrorResponse, memoryRequestBody } from "@/lib/memory/http";
import { MemoryError } from "@/lib/memory/types";
import { interactionTargets } from "@/lib/memory/event-targets";

const schema = z.object({ id: z.string().uuid(), action: z.literal("page_view"), route: z.string().min(1).max(160) }).strict();
export async function POST(req: NextRequest) {
  const access = await requireOrgAccess();
  if (!access.ok) return access.response;
  try {
    const body = schema.safeParse(await memoryRequestBody(req));
    if (!body.success) throw new MemoryError("Record only an event UUID, page_view action and approved pathname; no additional fields are accepted.");
    return NextResponse.json(await recordPageView(access.admin, access.profile.org_id, access.profile.id, body.data));
  } catch (error) {
    if (error instanceof InteractionRateError) return NextResponse.json({ error: error.message }, { status: 429, headers: { "Retry-After": "60" } });
    return memoryErrorResponse(error);
  }
}
export async function GET(req: NextRequest) {
  const access = await requireOrgAccess();
  if (!access.ok) return access.response;
  try {
    const params = req.nextUrl.searchParams;
    const page = await listInteractionEvents(access.admin, access.profile.org_id, access.profile.id, { limit: params.has("limit") ? Number(params.get("limit")) : undefined, before: params.get("before") ?? undefined, beforeId: params.get("beforeId") ?? undefined });
    return NextResponse.json({ ...page, targets: await interactionTargets(access.admin, access.profile.org_id, page.events) });
  } catch (error) { return memoryErrorResponse(error); }
}
