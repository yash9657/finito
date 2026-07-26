/**
 * `POST /api/investigations` — ask an open-ended question (Plan 5).
 * `GET  /api/investigations` — the org's investigations, newest first.
 *
 * The POST returns as soon as the rows exist and the run is under way, rather than blocking for
 * the length of the investigation. A bounded run can still take minutes (D-G22 allows up to 15),
 * which is well past a serverless request's patience — and the client has a better way to follow
 * it than a held-open connection: the Realtime event stream the transcript already subscribes to.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { jsonError, requireOrgAccess } from "@/lib/api/guard";
import {
  createInvestigation,
  executeInvestigation,
  listInvestigations,
} from "@/lib/harness/agent/service";
import { resolveInvestigatorModel } from "@/lib/llm/router";
import { INVESTIGATION_TYPE } from "@/lib/types";

const bodySchema = z.object({
  question: z.string().trim().min(8, "Ask a question of at least 8 characters"),
  budget: z
    .object({
      maxTurns: z.number().int().positive().optional(),
      maxTokens: z.number().int().positive().optional(),
      maxWallClockMs: z.number().int().positive().optional(),
      maxToolCallsPerTurn: z.number().int().positive().optional(),
    })
    .optional(),
});

export async function POST(req: NextRequest) {
  const access = await requireOrgAccess();
  if (!access.ok) return access.response;
  const { admin, profile } = access;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return jsonError(parsed.error.issues[0]?.message ?? "Invalid request body", 400);
  }

  // Fail fast, before creating any rows (D-G16). A model that cannot call tools produces one
  // clear message here rather than an investigation row that exists only to hold a failure.
  const model = await resolveInvestigatorModel(admin, {
    orgId: profile.org_id,
    workflowType: INVESTIGATION_TYPE,
  });
  if (!model.ok) return jsonError(model.reason, 400);

  let created;
  try {
    created = await createInvestigation({
      db: admin,
      orgId: profile.org_id,
      createdBy: profile.id,
      question: parsed.data.question,
      budget: parsed.data.budget,
    });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Could not start investigation", 500);
  }

  // Fire and forget, exactly as `POST /api/workflows/[id]/run` does for a pipeline. The run's
  // own terminal paths always write a status, so a dropped serverless invocation leaves a row
  // stuck at `running` rather than losing the record — and the event stream shows where it got
  // to. Same tradeoff the pipeline runner already makes.
  void executeInvestigation({
    db: admin,
    workflowId: created.workflowId,
    orgId: profile.org_id,
    question: parsed.data.question,
    budget: parsed.data.budget,
  });

  return NextResponse.json(
    {
      id: created.workflowId,
      budget: created.budget,
      model: { provider: model.providerId, model: model.model },
    },
    { status: 201 },
  );
}

export async function GET() {
  const access = await requireOrgAccess();
  if (!access.ok) return access.response;

  try {
    const investigations = await listInvestigations(access.admin, access.profile.org_id);
    return NextResponse.json({ investigations });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Failed to list investigations", 500);
  }
}
