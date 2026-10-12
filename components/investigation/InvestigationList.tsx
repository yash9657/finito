"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { QuestionComposer } from "@/components/investigation/QuestionComposer";
import type { Investigation } from "@/lib/types";
const EXAMPLES = [
  "Explore the files and explain their structure and any data-quality issues.",
  "Compare the periods in my workbook and trace the largest changes to source rows.",
  "Which invoices need attention, and what evidence supports each exception?",
];
export function InvestigationList() {
  const [question, setQuestion] = useState("");
  const [items, setItems] = useState<Investigation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/investigations", { cache: "no-store" });
      const body = await res.json();
      if (!res.ok)
        throw new Error(body.error ?? "Conversations could not be loaded.");
      const seen = new Set<string>();
      setItems(
        body.investigations.filter((i: Investigation) => {
          const key = i.conversation_id ?? i.workflow_id;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        }),
      );
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Conversations could not be loaded.",
      );
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <div className="page-container space-y-9">
      <header>
        <h1 className="page-title">Ask your data</h1>
        <p className="page-description">
          A question can take more than one step. Follow the evidence together.
        </p>
      </header>
      <div className="investigation-start">
        <section className="min-w-0">
          <QuestionComposer initialQuestion={question} />
        </section>
        <aside className="min-w-0">
          <h2 className="mb-3 text-base font-medium">A place to start</h2>
          <div className="divide-y divide-border border-y border-border">
            {EXAMPLES.map((example) => (
              <button
                key={example}
                className="flex w-full items-start gap-3 py-4 text-left text-sm leading-relaxed text-muted hover:text-foreground"
                onClick={() => setQuestion(example)}
              >
                {example}
                <ArrowRight size={16} className="mt-1 shrink-0" />
              </button>
            ))}
          </div>
          <p className="mt-5 text-sm leading-relaxed text-muted">
            New export format? Add it in{" "}
            <Link className="text-accent underline" href="/data">
              Your data
            </Link>
            . The agent can inspect sheets and columns before choosing an
            analysis.
          </p>
        </aside>
      </div>
      <section>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-medium">Recent conversations</h2>
          <Link
            href="/settings/memory"
            className="ml-auto mr-3 inline-flex min-h-11 items-center text-sm text-accent"
          >
            Memory &amp; history
          </Link>
          <Button
            variant="ghost"
            aria-label="Refresh conversations"
            onClick={() => void load()}
            disabled={loading}
          >
            <RefreshCw size={16} />
          </Button>
        </div>
        {loading && (
          <p role="status" className="py-6 text-sm text-muted">
            Loading conversations…
          </p>
        )}
        {error && (
          <p role="alert" className="py-5 text-sm text-error">
            {error}
          </p>
        )}
        {!loading && !error && !items.length && (
          <p className="border-t border-border py-8 text-sm text-muted">
            Your first question starts a conversation here. You can return to
            its sources, calculations, and follow-ups.
          </p>
        )}
        <div className="divide-y divide-border border-y border-border">
          {items.map((item) => (
            <Link
              key={item.workflow_id}
              href={`/investigations/${item.workflow_id}`}
              className="flex flex-col justify-between gap-3 px-1 py-5 transition-colors hover:bg-card sm:flex-row sm:items-center"
            >
              <div className="min-w-0">
                <p className="break-words text-sm font-medium">
                  {item.question}
                </p>
                <p className="mt-2 text-xs text-muted">
                  {new Date(item.created_at).toLocaleString()} ·{" "}
                  {item.turns_used} analysis steps
                </p>
              </div>
              <Badge
                variant={
                  item.status === "running"
                    ? "running"
                    : item.status === "answered"
                      ? "accent"
                      : item.status === "failed"
                        ? "error"
                        : "warning"
                }
                className="w-fit shrink-0"
              >
                {item.status === "running"
                  ? "Working"
                  : item.status === "answered"
                    ? "Answered"
                    : item.status === "failed"
                      ? "Needs attention"
                      : "Partial answer"}
              </Badge>
            </Link>
          ))}
        </div>
        <p className="mt-3 text-xs text-muted">
          Conversations represented in the latest 50 questions.
        </p>
      </section>
    </div>
  );
}
