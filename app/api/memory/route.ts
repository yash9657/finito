import { NextResponse, type NextRequest } from "next/server";
import { requireOrgAccess } from "@/lib/api/guard";
import { getMemorySettings, listPreferences, setMemoryEnabled } from "@/lib/memory/store";
import { memoryErrorResponse, memoryRequestBody } from "@/lib/memory/http";
import { MemoryError } from "@/lib/memory/types";

export async function GET() {
  const access = await requireOrgAccess();
  if (!access.ok) return access.response;
  try {
    const [settings, preferences] = await Promise.all([getMemorySettings(access.admin, access.profile.org_id, access.profile.id), listPreferences(access.admin, access.profile.org_id, access.profile.id)]);
    return NextResponse.json({ ...settings, preferences, viewer: { canReindex: access.profile.role === "admin" || access.profile.role === "analyst" } });
  } catch (error) { return memoryErrorResponse(error); }
}

export async function PATCH(req: NextRequest) {
  const access = await requireOrgAccess();
  if (!access.ok) return access.response;
  try {
    const body = await memoryRequestBody(req);
    if (!body || typeof body !== "object" || !("enabled" in body) || typeof body.enabled !== "boolean") throw new MemoryError("enabled must be true or false.");
    return NextResponse.json(await setMemoryEnabled(access.admin, access.profile.org_id, access.profile.id, body.enabled));
  } catch (error) { return memoryErrorResponse(error); }
}
