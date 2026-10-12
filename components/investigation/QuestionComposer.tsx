"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowUp, Loader2, Paperclip } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { DataSourceMetadata } from "@/lib/data/types";

export function QuestionComposer({
  parentId,
  sourceIds,
  disabled = false,
  initialQuestion = "",
}: {
  parentId?: string;
  sourceIds?: string[] | null;
  disabled?: boolean;
  initialQuestion?: string;
}) {
  const router = useRouter();
  const [question, setQuestion] = useState(initialQuestion);
  const [sources, setSources] = useState<DataSourceMetadata[]>([]);
  const [selected, setSelected] = useState<string[]>(sourceIds ?? []);
  const [loadingFiles, setLoadingFiles] = useState(true);
  const [fileError, setFileError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [catalogOffset, setCatalogOffset] = useState(0);
  const [moreBusy, setMoreBusy] = useState(false);
  useEffect(() => {
    setQuestion(initialQuestion);
  }, [initialQuestion]);
  useEffect(() => {
    const controller = new AbortController();
    setLoadingFiles(true);
    setFileError("");
    void fetch("/api/data-sources", {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]),
      cache: "no-store",
    })
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? "Files are unavailable.");
        setHasMore(body.hasMore);
        setCatalogOffset(body.sources.length);
        return body.sources as DataSourceMetadata[];
      })
      .then(async (files) => {
        const missing = (sourceIds ?? []).filter(
          (id) => !files.some((file) => file.id === id),
        );
        const inherited = await Promise.all(
          missing.map(async (id) => {
            const res = await fetch(`/api/data-sources/${id}`, {
              signal: AbortSignal.any([
                controller.signal,
                AbortSignal.timeout(60_000),
              ]),
            });
            const body = await res.json();
            // Deleted sources remain visible so a follow-up can deliberately deselect them.
            return res.ok
              ? (body.source as DataSourceMetadata)
              : ({
                  id,
                  filename: "Unavailable earlier file",
                  tables: [],
                  warnings: [],
                } as unknown as DataSourceMetadata);
          }),
        );
        setSources([...inherited, ...files]);
        setSelected(sourceIds ?? []);
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setFileError(
            e instanceof Error ? e.message : "Files are unavailable.",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingFiles(false);
      });
    return () => controller.abort();
  }, [sourceIds, loadAttempt]);
  async function loadMore() {
    setMoreBusy(true);
    try {
      const res = await fetch(
        `/api/data-sources?offset=${catalogOffset}&limit=100`,
        { signal: AbortSignal.timeout(60_000) },
      );
      const body = await res.json();
      if (!res.ok)
        throw new Error(body.error ?? "More files could not be loaded.");
      setSources((current) => [
        ...current,
        ...body.sources.filter(
          (item: DataSourceMetadata) =>
            !current.some((source) => source.id === item.id),
        ),
      ]);
      setHasMore(body.hasMore);
      setCatalogOffset((current) => current + body.sources.length);
    } catch (e) {
      setFileError(
        e instanceof Error ? e.message : "More files could not be loaded.",
      );
    } finally {
      setMoreBusy(false);
    }
  }
  async function submit() {
    if (submitting || disabled || loadingFiles || fileError) return;
    if (question.trim().length < 8) {
      setError("Add a little more detail—at least 8 characters.");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch("/api/investigations", {
        method: "POST",
        signal: AbortSignal.timeout(60_000),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: question.trim(),
          parentId,
          sourceIds: selected,
        }),
      });
      const body = await res.json();
      if (!res.ok || !body.id)
        throw new Error(
          body.error ?? "Could not start this question. Try again.",
        );
      router.push(`/investigations/${body.id}`);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Could not start this question. Try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <form
      className="question-composer"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label
        htmlFor={parentId ? "follow-up" : "new-question"}
        className="mb-3 block text-sm font-medium"
      >
        {parentId
          ? "Continue the conversation"
          : "What would you like to understand?"}
      </label>
      <Textarea
        id={parentId ? "follow-up" : "new-question"}
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        maxLength={8000}
        rows={4}
        disabled={disabled || submitting}
        placeholder={
          parentId
            ? "Ask a follow-up, challenge an assumption, or take the analysis further…"
            : "Compare these periods, explain an unexpected result, or investigate a question across your files…"
        }
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
        }}
        className="resize-y border-0 bg-transparent p-0 text-base leading-relaxed focus-visible:ring-0"
      />
      <details className="mt-4 border-t border-border pt-3">
        <summary className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-muted">
          <Paperclip size={16} />
          {loadingFiles
            ? "Loading files…"
            : selected.length ? `${selected.length} ${selected.length === 1 ? "file" : "files"} selected` : "Choose files for this question"}
          <span className="ml-auto text-xs">Change sources</span>
        </summary>
        <p className="mb-3 text-xs leading-relaxed text-muted">
          Select up to ten files to focus this question. The agent can search
          workspace history for older questions and files when needed.
          Follow-ups retain recent conversation context and your file selection.
        </p>
        {sources.length > 0 && (
          <div className="max-h-64 overflow-y-auto">
            {sources.map((source) => (
              <label
                key={source.id}
                className="flex min-h-11 cursor-pointer items-start gap-3 py-3 text-sm"
              >
                <input
                  type="checkbox"
                  className="mt-1 size-4 shrink-0 accent-accent"
                  checked={selected.includes(source.id)}
                  disabled={
                    disabled ||
                    submitting ||
                    (!selected.includes(source.id) && selected.length >= 10)
                  }
                  onChange={(e) =>
                    setSelected((s) =>
                      e.target.checked
                        ? [...s, source.id]
                        : s.filter((id) => id !== source.id),
                    )
                  }
                />
                <span className="min-w-0 break-words">
                  {source.filename}
                  <span className="ml-2 text-xs text-muted">
                    {source.tables.length}{" "}
                    {source.tables.length === 1 ? "table" : "tables"}
                  </span>
                </span>
              </label>
            ))}
          </div>
        )}
        {hasMore && (
          <Button
            variant="ghost"
            disabled={moreBusy}
            onClick={() => void loadMore()}
          >
            {moreBusy ? "Loading…" : "Load more files"}
          </Button>
        )}
        <Link
          href="/data"
          className="inline-flex min-h-11 items-center text-sm text-accent"
        >
          Upload or inspect files
        </Link>
      </details>
      {fileError && (
        <div
          role="alert"
          className="mt-3 flex flex-wrap items-center gap-3 text-sm text-warning"
        >
          <p>{fileError}</p>
          <Button variant="ghost" onClick={() => setLoadAttempt((n) => n + 1)}>
            Reload sources
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-error">
          {error}
        </p>
      )}
      <div className="mt-4 flex flex-col-reverse justify-between gap-4 sm:flex-row sm:items-center">
        <p className="max-w-lg text-xs leading-relaxed text-muted">
          {disabled
            ? "You can follow up when the current analysis finishes."
            : "The agent can inspect data and run calculations. It will show its sources and call out missing context. Up to 20 turns per question."}
        </p>
        <Button
          type="submit"
          variant="accent"
          disabled={
            submitting ||
            disabled ||
            loadingFiles ||
            !!fileError ||
            question.trim().length < 8
          }
          className="shrink-0"
        >
          {submitting ? (
            <Loader2 size={16} className="mr-2 animate-spin" />
          ) : (
            <ArrowUp size={16} className="mr-2" />
          )}
          {submitting
            ? "Starting…"
            : parentId
              ? "Send follow-up"
              : "Ask question"}
        </Button>
      </div>
    </form>
  );
}
