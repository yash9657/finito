"use client";

/**
 * ReviewBanner (PLAN §11.5, bottom).
 *
 * The human review gate rendered under the live workflow view. It has three
 * visible states, keyed off `workflow.status`:
 *
 *   - `awaiting_review` → prominent warning bar with a comment textarea and the
 *     three decision buttons (Approve / Request revision / Reject). Each POSTs
 *     `{ decision, comment }` to `/api/workflows/[id]/review`, then calls
 *     `onDecided()` so the parent refetches status. `revision_requested` keeps
 *     the workflow `awaiting_review` (the route records the decision only).
 *   - `approved` → "Approved by … at …" confirmation + a "View report →" link.
 *   - `error`    → error banner with `workflow.error_message` + a "Re-run" button
 *     that POSTs `/run` again (resume semantics, D2).
 *   - `rejected` → terminal rejected banner (comment shown if present).
 *
 * Any other status renders nothing.
 */

import * as React from "react";
import Link from "next/link";
import {
  Check,
  RotateCcw,
  AlertCircle,
  XCircle,
  CheckCircle2,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import MissingKeyNotice from "@/components/workflow/MissingKeyNotice";
import { hasStoredKey, runHeaders } from "@/lib/anthropic-key";
import { formatDateTime } from "@/lib/format";
import type {
  WorkflowRow,
  ReviewRow,
  ReviewDecisionValue,
} from "@/lib/types";

interface ReviewBannerProps {
  workflow: WorkflowRow;
  review: ReviewRow | null;
  onDecided: () => void;
}

export default function ReviewBanner({
  workflow,
  review,
  onDecided,
}: ReviewBannerProps) {
  const [comment, setComment] = React.useState("");
  const [pending, setPending] = React.useState<ReviewDecisionValue | null>(null);
  const [rerunning, setRerunning] = React.useState(false);
  const [missingKey, setMissingKey] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const busy = pending !== null;

  async function decide(decision: ReviewDecisionValue) {
    setError(null);
    setPending(decision);
    try {
      const res = await fetch(`/api/workflows/${workflow.id}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision,
          comment: comment.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(body?.error ?? `Review failed (${res.status})`);
      }
      setComment("");
      onDecided();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to submit decision");
    } finally {
      setPending(null);
    }
  }

  async function rerun() {
    // BYOK guard: without a key stored in this browser, don't call /run.
    if (!hasStoredKey()) {
      setMissingKey(true);
      return;
    }
    setMissingKey(false);
    setError(null);
    setRerunning(true);
    try {
      const res = await fetch(`/api/workflows/${workflow.id}/run`, {
        method: "POST",
        headers: runHeaders(),
      });
      if (!res.ok && res.status !== 202) {
        const body = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(body?.error ?? `Re-run failed (${res.status})`);
      }
      onDecided();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to re-run workflow");
    } finally {
      setRerunning(false);
    }
  }

  /* ---- awaiting review: the decision gate ---- */
  if (workflow.status === "awaiting_review") {
    return (
      <div className="rounded-lg border-2 border-warning bg-warning/5 p-4">
        <div className="mb-3 flex items-center gap-2 text-warning">
          <AlertCircle className="h-4 w-4" />
          <span className="text-sm font-medium">
            Awaiting human review
          </span>
        </div>
        <Textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Add a review comment (optional for approve/reject, recommended for revisions)…"
          disabled={busy}
          className="mb-3"
        />
        {error && (
          <p className="mb-3 font-mono text-xs text-error">{error}</p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="accent"
            onClick={() => decide("approved")}
            disabled={busy}
          >
            {pending === "approved" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Check className="h-4 w-4" />
            )}
            Approve
          </Button>
          <Button
            variant="warning"
            onClick={() => decide("revision_requested")}
            disabled={busy}
          >
            {pending === "revision_requested" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RotateCcw className="h-4 w-4" />
            )}
            Request revision
          </Button>
          <Button
            variant="destructive"
            onClick={() => decide("rejected")}
            disabled={busy}
          >
            {pending === "rejected" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <XCircle className="h-4 w-4" />
            )}
            Reject
          </Button>
        </div>
      </div>
    );
  }

  /* ---- approved: confirmation + report link ---- */
  if (workflow.status === "approved") {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border-2 border-accent bg-accent/5 p-4">
        <div className="flex items-center gap-2 text-accent">
          <CheckCircle2 className="h-4 w-4" />
          <span className="text-sm">
            Approved
            {review ? (
              <>
                {" "}
                by{" "}
                <span className="font-mono">{review.reviewer_id}</span> at{" "}
                <span className="font-mono">
                  {formatDateTime(review.decided_at)}
                </span>
              </>
            ) : null}
          </span>
        </div>
        <Link href={`/workflows/${workflow.id}/report`}>
          <Button variant="accent">View report →</Button>
        </Link>
      </div>
    );
  }

  /* ---- error: failure banner + resume ---- */
  if (workflow.status === "error") {
    return (
      <div className="rounded-lg border-2 border-error bg-error/5 p-4">
        <div className="mb-3 flex items-start gap-2 text-error">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="text-sm">
            <p className="font-medium">Workflow failed</p>
            {workflow.error_message && (
              <p className="mt-1 font-mono text-xs text-error/90">
                {workflow.error_message}
              </p>
            )}
          </div>
        </div>
        {error && (
          <p className="mb-3 font-mono text-xs text-error">{error}</p>
        )}
        {missingKey && <MissingKeyNotice className="mb-3" />}
        <Button variant="outline" onClick={rerun} disabled={rerunning}>
          {rerunning ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RotateCcw className="h-4 w-4" />
          )}
          Re-run
        </Button>
      </div>
    );
  }

  /* ---- rejected: terminal banner ---- */
  if (workflow.status === "rejected") {
    return (
      <div className="rounded-lg border-2 border-error bg-error/5 p-4">
        <div className="flex items-start gap-2 text-error">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="text-sm">
            <p className="font-medium">
              Rejected
              {review ? (
                <>
                  {" "}
                  by{" "}
                  <span className="font-mono">{review.reviewer_id}</span> at{" "}
                  <span className="font-mono">
                    {formatDateTime(review.decided_at)}
                  </span>
                </>
              ) : null}
            </p>
            {review?.comment && (
              <p className="mt-1 text-xs text-muted">{review.comment}</p>
            )}
          </div>
        </div>
      </div>
    );
  }

  return null;
}
