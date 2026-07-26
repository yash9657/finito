"use client";

/**
 * The investigations index (Plan 5 §9): ask a question, and see the ones already asked.
 *
 * The cost note under the input is D-G8's "before it runs" half. It states a CEILING rather than
 * an estimate, because an estimate implies a precision nobody has — how many turns a question
 * takes is the thing being discovered. A bound the user can act on ("this will not exceed N
 * turns") is more useful than a guess they cannot.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, Loader2, Search, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import type { Investigation } from "@/lib/types";

const EXAMPLES = [
  "Why doesn't the bank account tie out this month?",
  "What changed in spend between the last two periods?",
  "Find anything unusual in the AP data.",
];

export function InvestigationList() {
  const router = useRouter();
  const [question, setQuestion] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [investigations, setInvestigations] = useState<Investigation[] | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/investigations", { cache: "no-store" });
      if (!res.ok) throw new Error(`Failed to load (${res.status})`);
      const body = (await res.json()) as { investigations: Investigation[] };
      setInvestigations(body.investigations);
    } catch {
      setInvestigations([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit() {
    const trimmed = question.trim();
    if (trimmed.length < 8) {
      setError("Ask a question of at least 8 characters.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/investigations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: trimmed }),
      });
      const body = (await res.json()) as { id?: string; error?: string };
      if (!res.ok || !body.id) {
        // A provider that cannot call tools is refused here, before any row exists (D-G16), so
        // the message names the model and points at Settings rather than being a generic 500.
        setError(body.error ?? "Could not start the investigation.");
        return;
      }
      router.push(`/investigations/${body.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the investigation.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8 p-6">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <Sparkles className="h-5 w-5 text-accent" />
          Investigate
        </h1>
        <p className="mt-1 text-sm text-muted">
          Ask an open-ended question about your financial data. The agent decides what to look at,
          cites the rows it used, and recomputes every figure in code.
        </p>
      </div>

      <Card>
        <CardContent className="space-y-3 py-4">
          <Textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Why doesn't the bank account tie out this month?"
            rows={3}
            className="resize-none"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
            }}
          />

          <div className="flex flex-wrap gap-1.5">
            {EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => setQuestion(example)}
                className="rounded-full border border-border px-2.5 py-1 text-xs text-muted transition-colors hover:bg-border hover:text-foreground"
              >
                {example}
              </button>
            ))}
          </div>

          {error && (
            <p className="flex items-start gap-2 rounded-md bg-error/10 px-3 py-2 text-xs text-error">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {error}
            </p>
          )}

          <div className="flex items-center gap-3">
            <Button onClick={() => void submit()} disabled={submitting}>
              {submitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Starting…
                </>
              ) : (
                <>
                  <Search className="mr-2 h-4 w-4" />
                  Investigate
                </>
              )}
            </Button>
            {/* D-G8: a ceiling, not an estimate. */}
            <p className="text-xs text-muted">
              Bounded to at most 20 turns and 5 minutes. The agent can recommend actions, but
              cannot make changes — anything consequential goes to the approval panel.
            </p>
          </div>
        </CardContent>
      </Card>

      <div>
        <h2 className="mb-3 text-sm font-medium">Recent</h2>
        {investigations === null && <Skeleton className="h-20 w-full" />}
        {investigations?.length === 0 && (
          <p className="text-sm text-muted">No investigations yet.</p>
        )}
        <div className="space-y-2">
          {(investigations ?? []).map((investigation) => (
            <Link
              key={investigation.workflow_id}
              href={`/investigations/${investigation.workflow_id}`}
              className="block rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:border-accent/50"
            >
              <div className="flex items-start gap-3">
                <span className="min-w-0 flex-1 text-sm">{investigation.question}</span>
                <StatusBadge investigation={investigation} />
              </div>
              <div className="mt-1.5 flex gap-3 font-mono text-[10px] text-muted">
                <span>{new Date(investigation.created_at).toLocaleString()}</span>
                <span>{investigation.turns_used} turns</span>
                <span>
                  {(investigation.tokens_in + investigation.tokens_out).toLocaleString()} tokens
                </span>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ investigation }: { investigation: Investigation }) {
  if (investigation.status === "running") return <Badge variant="running">Running</Badge>;
  if (investigation.status === "answered") return <Badge variant="accent">Answered</Badge>;
  if (investigation.status === "failed") return <Badge variant="error">Failed</Badge>;
  return (
    <Badge variant="warning">
      {investigation.termination_reason?.replace(/_/g, " ") ?? "Stopped"}
    </Badge>
  );
}
