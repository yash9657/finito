/**
 * Audit-log helper (PLAN §5.2 / §10). Every meaningful action in the runner and the
 * API routes writes exactly one row into `public.audit_log` via the admin client.
 *
 * The column is `created_at` (D10), auto-defaulted by the DB — callers never set it.
 * `id` is a bigint identity, also DB-assigned. So the insert payload is the
 * AuditLogRow minus those two fields.
 */

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ActorType } from "./types";

export interface WriteAuditArgs {
  workflowId: string;
  /** Present for step-scoped actions; null/omitted for workflow-level ones. */
  stepId?: string | null;
  actorType: ActorType;
  /** Model id (agent), profile uuid (human), or 'system'. */
  actorId: string;
  /** e.g. 'step_started', 'step_completed', 'file_uploaded', 'review_submitted'. */
  action: string;
  detail?: unknown;
}

/**
 * Insert one audit_log row using the passed admin (service-role) client.
 * Throws on DB error so the caller's try/catch can mark the workflow `error`.
 */
export async function writeAudit(
  db: SupabaseClient,
  args: WriteAuditArgs,
): Promise<void> {
  const { error } = await db.from("audit_log").insert({
    workflow_id: args.workflowId,
    step_id: args.stepId ?? null,
    actor_type: args.actorType,
    actor_id: args.actorId,
    action: args.action,
    detail: args.detail ?? null,
  });
  if (error) {
    throw new Error(`writeAudit failed (${args.action}): ${error.message}`);
  }
}

/**
 * Canonical JSON string with recursively sorted object keys, so the same logical
 * value always hashes to the same digest regardless of key insertion order.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

/** sha256 (hex) of the canonical JSON of a value — the `input_hash` primitive (§5.2). */
export function sha256Json(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** sha256 (hex) of a buffer/string — used for uploaded-file hashing (§10). */
export function sha256Bytes(data: Buffer | Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortValue(source[key]);
    }
    return sorted;
  }
  return value;
}
