import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireOrgAccess } from "@/lib/api/guard";
import { savePreference, deletePreference } from "@/lib/memory/store";
import { memoryErrorResponse, memoryRequestBody } from "@/lib/memory/http";
import { MemoryError } from "@/lib/memory/types";

const schema = z.object({ content: z.string().trim().min(1).max(2000) });
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const access = await requireOrgAccess();
  if (!access.ok) return access.response;
  try {
    const { id } = await params;
    const body = schema.safeParse(await memoryRequestBody(req));
    if (!body.success) throw new MemoryError("Provide a preference of 1–2,000 characters.");
    const preference = await savePreference(access.admin, access.profile.org_id, access.profile.id, { id, content: body.data.content });
    return NextResponse.json({ preference });
  } catch (error) { return memoryErrorResponse(error); }
}
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const access = await requireOrgAccess();
  if (!access.ok) return access.response;
  try {
    const { id } = await params;
    await deletePreference(access.admin, access.profile.org_id, access.profile.id, id);
    return NextResponse.json({ deleted: true, id });
  } catch (error) { return memoryErrorResponse(error); }
}
