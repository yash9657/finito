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
import { clampBudget } from "@/lib/harness/agent/loop";
import { conversationContext, validateSourceScope } from "@/lib/harness/agent/conversation";

export const maxDuration = 300;
// Leave thirty seconds for persistence and request setup before the host terminates the job.
const HOSTED_RUN_LIMIT_MS = 270_000;

const bodySchema = z.object({
  question: z.string().trim().min(8, "Ask a question of at least 8 characters").max(8_000, "Keep your question under 8,000 characters"),
  parentId: z.string().uuid().optional(),
  sourceIds: z.array(z.string().uuid()).max(10).optional(),
  budget: z
    .object({
      maxTurns: z.number().int().positive().optional(),
      maxTokens: z.number().int().positive().optional(),
      maxWallClockMs: z.number().int().positive().optional(),
      maxToolCallsPerTurn: z.number().int().positive().optional(),
      maxRecommendations: z.number().int().nonnegative().optional(),
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

  let context: Awaited<ReturnType<typeof conversationContext>>;
  let sourceIds: string[] | undefined;
  try {
    context = await conversationContext(admin, profile.org_id, parsed.data.parentId);
    sourceIds = parsed.data.sourceIds ?? context.sourceIds;
    await validateSourceScope(admin, profile.org_id, sourceIds);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not check question context.", 400);
  }

  // Fail fast, before creating any rows (D-G16). A model that cannot call tools produces one
  // clear message here rather than an investigation row that exists only to hold a failure.
  let model: Awaited<ReturnType<typeof resolveInvestigatorModel>>;
  try {
    model = await resolveInvestigatorModel(admin, { orgId: profile.org_id, workflowType: INVESTIGATION_TYPE });
  } catch {
    return jsonError("Model configuration is unavailable. Retry before starting an investigation.", 503);
  }
  if (!model.ok) return jsonError(model.reason, 400);

  const budget = clampBudget(parsed.data.budget);
  const cappedForDeployment = process.env.NODE_ENV === "production" && budget.maxWallClockMs > HOSTED_RUN_LIMIT_MS;
  if (cappedForDeployment) budget.maxWallClockMs = HOSTED_RUN_LIMIT_MS;

  let created;
  try {
    created = await createInvestigation({
      db: admin,
      orgId: profile.org_id,
      createdBy: profile.id,
      question: parsed.data.question,
      budget,
      conversationId: context.conversationId,
      parentWorkflowId: context.parentWorkflowId,
      sourceIds,
    });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Could not start investigation", 500);
  }

  // Retain this exact promise through the response. This prevents routine response completion
  // from suspending the run, but is not durable execution: a host crash still needs a worker
  // lease, checkpoint, and recovery process before this can promise enterprise availability.
  const task = executeInvestigation({
    db: admin,
    workflowId: created.workflowId,
    orgId: profile.org_id,
    question: parsed.data.question,
    budget: created.budget,
    sourceIds,
    history: context.history,
    userId: profile.id,
  }).catch((error: unknown) => {
    console.error("[investigation] background execution failed", error instanceof Error ? error.name : "UnknownError");
  });
  try {
    const { waitUntil } = await import("@vercel/functions");
    waitUntil(task);
  } catch {
    // Development lacks the host lifecycle hook. The task already exists; never execute twice.
    void task;
  }

  return NextResponse.json(
    {
      id: created.workflowId,
      budget: created.budget,
      ...(cappedForDeployment ? { budgetAdjustment: "Wall-clock budget capped at 270 seconds for this deployment." } : {}),
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
