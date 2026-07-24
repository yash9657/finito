import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import Anthropic, { APIError } from "@anthropic-ai/sdk";
import { createClient } from "@/lib/supabase/server";
import { AGENT_MODEL } from "@/lib/agents/client";

// A validation call should never run long; cap it (BYOK settings check).
export const maxDuration = 30;

/**
 * POST /api/anthropic/test-key — BYOK key validation.
 *
 * Requires a signed-in user (no workflow scope). Reads the candidate key from the
 * `x-anthropic-api-key` header (never a body, so it can't be logged) and makes a single
 * minimal `messages.create` to confirm the key authenticates. The key is used transiently
 * and is NEVER logged, persisted, echoed back, or written to any store.
 */
export async function POST(req: NextRequest) {
  // 1. Require an authenticated user (no org/workflow scope needed here).
  const supabase = await createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // 2. The key rides in the header only.
  const apiKey = req.headers.get("x-anthropic-api-key");
  if (!apiKey) {
    return NextResponse.json({ error: "No Anthropic API key provided" }, { status: 400 });
  }

  // 3. Cheapest possible authenticated call — 1 token, trivial prompt.
  try {
    const anthropic = new Anthropic({ apiKey });
    await anthropic.messages.create({
      model: AGENT_MODEL,
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    // Map an auth failure to a friendly message; never surface the key.
    if (err instanceof APIError && err.status === 401) {
      return NextResponse.json({ ok: false, error: "Invalid API key" });
    }
    const message = err instanceof Error ? err.message : "Key validation failed";
    return NextResponse.json({ ok: false, error: message });
  }
}
