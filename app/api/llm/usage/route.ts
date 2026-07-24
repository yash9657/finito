/**
 * GET /api/llm/usage — derived usage view (Plan 2 §5, D-P12). No separate events
 * table: aggregate workflow_steps (⋈ workflows for org scoping) where provider_used is
 * not null, grouped by provider_used, model, and month. Test-connection calls are not
 * persisted, so they never count. Any org member.
 *
 * Response: { months: [{ month: '2026-07', rows: [{ provider, model, calls, tokensIn,
 * tokensOut }] }] }, months sorted newest first.
 */

import { NextResponse } from "next/server";
import { jsonError, requireOrgAccess } from "@/lib/api/guard";

interface StepUsageRow {
  provider_used: string | null;
  model: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  completed_at: string | null;
}

export async function GET() {
  const g = await requireOrgAccess();
  if (!g.ok) return g.response;
  const { admin, profile } = g;

  const { data, error } = await admin
    .from("workflow_steps")
    .select("provider_used, model, tokens_in, tokens_out, completed_at, workflows!inner(org_id)")
    .eq("workflows.org_id", profile.org_id)
    .not("provider_used", "is", null);

  if (error) return jsonError(`Failed to load usage: ${error.message}`, 500);

  const rows = (data ?? []) as unknown as StepUsageRow[];

  // month -> "provider|model" -> aggregate
  const byMonth = new Map<string, Map<string, { provider: string; model: string; calls: number; tokensIn: number; tokensOut: number }>>();
  for (const r of rows) {
    if (!r.provider_used) continue;
    const month = (r.completed_at ?? "").slice(0, 7) || "unknown";
    const provider = r.provider_used;
    const model = r.model ?? "unknown";
    const key = `${provider}|${model}`;
    let monthMap = byMonth.get(month);
    if (!monthMap) {
      monthMap = new Map();
      byMonth.set(month, monthMap);
    }
    const agg = monthMap.get(key) ?? { provider, model, calls: 0, tokensIn: 0, tokensOut: 0 };
    agg.calls += 1;
    agg.tokensIn += r.tokens_in ?? 0;
    agg.tokensOut += r.tokens_out ?? 0;
    monthMap.set(key, agg);
  }

  const months = [...byMonth.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([month, map]) => ({
      month,
      rows: [...map.values()].sort(
        (a, b) => b.tokensIn + b.tokensOut - (a.tokensIn + a.tokensOut),
      ),
    }));

  return NextResponse.json({ months });
}
