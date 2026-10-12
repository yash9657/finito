import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireOrgAccess } from "@/lib/api/guard";
import { savePreference } from "@/lib/memory/store";
import { memoryErrorResponse, memoryRequestBody } from "@/lib/memory/http";
import { MemoryError } from "@/lib/memory/types";

const schema = z.object({ content: z.string().trim().min(1).max(2000), sourceQuestionId: z.string().uuid().optional() });
export async function POST(req: NextRequest) {
  const access = await requireOrgAccess();
  if (!access.ok) return access.response;
  try {
    const body = schema.safeParse(await memoryRequestBody(req));
    if (!body.success) throw new MemoryError("Provide a preference of 1–2,000 characters and an optional valid source question ID.");
    const preference = await savePreference(access.admin, access.profile.org_id, access.profile.id, body.data);
    return NextResponse.json({ preference }, { status: 201 });
  } catch (error) { return memoryErrorResponse(error); }
}
