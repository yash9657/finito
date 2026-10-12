"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  History,
  Check,
  FileText,
  Loader2,
  MessageSquare,
  Pencil,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { InteractionEvent } from "@/lib/memory/events";
import type { InteractionTarget } from "@/lib/memory/event-targets";
import {
  MEMORY_LIMITS,
  type PreferenceMemory,
  type MemorySearchHit,
  type MemorySearchResult,
} from "@/lib/memory/types";

interface MemorySettings {
  enabled: boolean;
  preferences: PreferenceMemory[];
  viewer: { canReindex: boolean };
}
const INPUT =
  "min-h-11 min-w-0 w-full rounded-md border border-border bg-background px-3 py-2 text-base text-foreground placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60 sm:text-sm";
const PREFERENCE_LIMIT = MEMORY_LIMITS.preferenceChars;
const PREFERENCE_COUNT_LIMIT = MEMORY_LIMITS.preferences;
const HISTORY_LIMIT = 20;

function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Date unavailable"
    : new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      }).format(date);
}
async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
      ...options,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    if (error instanceof Error && error.name === "TimeoutError")
      throw new Error(
        "The server took too long to respond. Refresh this page to check the latest saved state before retrying.",
      );
    throw new Error(
      "Could not reach FinFlow. Check your connection and try again.",
    );
  }
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(
      body?.error ?? "The request could not be completed. Try again.",
    );
  if (!body)
    throw new Error("The server returned an empty response. Try again.");
  return body as T;
}
function mutation(method: "POST" | "PATCH", body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

export default function MemoryManager() {
  const [settings, setSettings] = useState<MemorySettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newContent, setNewContent] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const operation = useRef(false);
  const addInput = useRef<HTMLTextAreaElement>(null);
  const editInput = useRef<HTMLTextAreaElement>(null);
  const loadController = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    setLoading(true);
    setLoadError("");
    try {
      const body = await request<MemorySettings>("/api/memory", {
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(30_000),
        ]),
      });
      if (!controller.signal.aborted) setSettings(body);
    } catch (error) {
      if (!controller.signal.aborted)
        setLoadError(
          error instanceof Error
            ? error.message
            : "Memory settings could not be loaded.",
        );
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
    return () => loadController.current?.abort();
  }, [load]);
  useEffect(() => {
    if (adding) addInput.current?.focus();
  }, [adding]);
  useEffect(() => {
    if (editingId) editInput.current?.focus();
  }, [editingId]);

  async function changeEnabled() {
    if (!settings || operation.current) return;
    operation.current = true;
    setBusy("toggle");
    setActionError("");
    setNotice("");
    const enabled = !settings.enabled;
    try {
      const result = await request<{ enabled: boolean }>(
        "/api/memory",
        mutation("PATCH", { enabled }),
      );
      setSettings((current) =>
        current ? { ...current, enabled: result.enabled } : current,
      );
      setNotice(
        result.enabled
          ? "Memory is on for new questions."
          : "Memory is off for new questions. Your saved records are retained.",
      );
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : "The memory setting could not be saved.",
      );
    } finally {
      operation.current = false;
      setBusy(null);
    }
  }
  async function savePreference(id?: string) {
    if (operation.current) return;
    const content = (id ? editContent : newContent).trim();
    setActionError("");
    setNotice("");
    if (!content) {
      setActionError("Write a preference before saving.");
      return;
    }
    operation.current = true;
    setBusy(id ?? "add");
    try {
      const result = await request<{ preference: PreferenceMemory }>(
        id ? `/api/memory/preferences/${id}` : "/api/memory/preferences",
        mutation(id ? "PATCH" : "POST", { content }),
      );
      setSettings((current) =>
        current
          ? {
              ...current,
              preferences: id
                ? current.preferences.map((item) =>
                    item.id === id ? result.preference : item,
                  )
                : [result.preference, ...current.preferences],
            }
          : current,
      );
      setNotice(
        `${id ? "Preference updated." : "Preference saved."}${settings?.enabled === false ? " Memory is off, so new answers will not recall it." : ""}`,
      );
      if (id) {
        setEditingId(null);
        setEditContent("");
      } else {
        setAdding(false);
        setNewContent("");
      }
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : "The preference could not be saved.",
      );
    } finally {
      operation.current = false;
      setBusy(null);
    }
  }
  async function deletePreference(id: string) {
    if (operation.current) return;
    operation.current = true;
    setBusy(id);
    setActionError("");
    setNotice("");
    try {
      await request(`/api/memory/preferences/${id}`, { method: "DELETE" });
      setSettings((current) =>
        current
          ? {
              ...current,
              preferences: current.preferences.filter((item) => item.id !== id),
            }
          : current,
      );
      setDeletingId(null);
      setNotice(
        "Preference deleted. Its original conversation and past answers are unchanged.",
      );
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : "The preference could not be deleted.",
      );
    } finally {
      operation.current = false;
      setBusy(null);
    }
  }

  return (
    <div className="min-w-0 space-y-12">
      <section aria-labelledby="personal-memory-title" className="min-w-0">
        <div className="mb-5">
          <h2 id="personal-memory-title" className="text-lg font-medium">
            Your personal memory
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted">
            Saved preferences belong to your account in this workspace. A
            preference saved from chat does not make the original conversation
            private: workspace members can still access that conversation.
          </p>
        </div>
        {loading && (
          <p role="status" className="py-5 text-sm text-muted">
            Loading your saved preferences…
          </p>
        )}
        {loadError && (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-3 py-4 text-sm text-error"
          >
            {loadError}
            <Button
              variant="outline"
              disabled={loading}
              onClick={() => void load()}
            >
              Try again
            </Button>
          </div>
        )}
        {settings && (
          <>
            <div className="flex min-w-0 flex-col gap-4 border-y border-border py-5 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 max-w-3xl">
                <h3 id="memory-toggle-label" className="font-medium">
                  Use memory in new answers
                </h3>
                <p
                  id="memory-toggle-help"
                  className="mt-2 text-sm leading-6 text-muted"
                >
                  Recall saved preferences and relevant history across
                  conversations. Turning this off retains your records. Files
                  and context already selected in a conversation still apply.
                </p>
              </div>
              <Button
                variant={settings.enabled ? "accent" : "outline"}
                role="switch"
                aria-checked={settings.enabled}
                aria-labelledby="memory-toggle-label"
                aria-describedby="memory-toggle-help"
                disabled={
                  busy !== null ||
                  loading ||
                  adding ||
                  editingId !== null ||
                  deletingId !== null
                }
                onClick={() => void changeEnabled()}
                className="w-fit shrink-0"
              >
                {busy === "toggle" ? (
                  <Loader2
                    aria-hidden="true"
                    className="h-4 w-4 animate-spin"
                  />
                ) : settings.enabled ? (
                  <Check aria-hidden="true" className="h-4 w-4" />
                ) : null}
                {busy === "toggle"
                  ? "Saving…"
                  : settings.enabled
                    ? "Memory on"
                    : "Memory off"}
              </Button>
            </div>
            {!adding && !editingId && !deletingId && (
              <FormError message={actionError} />
            )}
            {notice && (
              <p role="status" className="mt-4 text-sm leading-6 text-accent">
                {notice}
              </p>
            )}
            <div className="my-5 flex flex-wrap items-center justify-between gap-3">
              <h3 className="font-medium">
                Saved preferences{" "}
                <span className="ml-1 text-sm font-normal text-muted">
                  ({settings.preferences.length} / {PREFERENCE_COUNT_LIMIT})
                </span>
              </h3>
              {!adding && (
                <Button
                  variant="outline"
                  disabled={
                    busy !== null ||
                    loading ||
                    editingId !== null ||
                    settings.preferences.length >= PREFERENCE_COUNT_LIMIT
                  }
                  onClick={() => {
                    setAdding(true);
                    setEditingId(null);
                    setDeletingId(null);
                    setActionError("");
                  }}
                >
                  <Plus aria-hidden="true" className="h-4 w-4" />
                  Add preference
                </Button>
              )}
            </div>
            {settings.preferences.length >= PREFERENCE_COUNT_LIMIT && (
              <p className="mb-4 text-sm leading-6 text-muted">
                You have reached the 100-preference limit. Edit or delete an
                existing preference before adding another.
              </p>
            )}
            {adding && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void savePreference();
                }}
                className="mb-6 border-b border-border pb-6"
              >
                <label
                  htmlFor="new-preference"
                  className="mb-2 block text-sm font-medium"
                >
                  What should FinFlow remember?
                </label>
                <textarea
                  className={`${INPUT} min-h-24`}
                  ref={addInput}
                  id="new-preference"
                  value={newContent}
                  onChange={(event) => setNewContent(event.target.value)}
                  placeholder="For variance analysis, start with the largest absolute changes and keep the explanation concise."
                  maxLength={PREFERENCE_LIMIT}
                  rows={3}
                  disabled={busy !== null}
                  aria-describedby="new-preference-help"
                />
                <p id="new-preference-help" className="mt-2 text-sm text-muted">
                  {newContent.length.toLocaleString()} /{" "}
                  {PREFERENCE_LIMIT.toLocaleString()} characters. Saved only
                  when you choose Save preference.
                </p>
                <FormError message={actionError} />
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button
                    type="submit"
                    variant="accent"
                    disabled={busy !== null || !newContent.trim()}
                  >
                    {busy === "add" && (
                      <Loader2
                        aria-hidden="true"
                        className="h-4 w-4 animate-spin"
                      />
                    )}
                    {busy === "add" ? "Saving…" : "Save preference"}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => {
                      setAdding(false);
                      setNewContent("");
                      setActionError("");
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            )}
            {settings.preferences.length === 0 ? (
              <p className="py-5 text-sm leading-6 text-muted">
                No saved preferences yet. Add a working preference here, or
                choose to remember one when asking a question.
              </p>
            ) : (
              <ul className="divide-y divide-border border-y border-border">
                {settings.preferences.map((preference) => (
                  <li key={preference.id} className="min-w-0 py-5">
                    {editingId === preference.id ? (
                      <form
                        onSubmit={(event) => {
                          event.preventDefault();
                          void savePreference(preference.id);
                        }}
                      >
                        <label
                          htmlFor={`edit-${preference.id}`}
                          className="mb-2 block text-sm font-medium"
                        >
                          Edit preference
                        </label>
                        <textarea
                          className={`${INPUT} min-h-24`}
                          ref={editInput}
                          id={`edit-${preference.id}`}
                          value={editContent}
                          onChange={(event) =>
                            setEditContent(event.target.value)
                          }
                          maxLength={PREFERENCE_LIMIT}
                          rows={3}
                          disabled={busy !== null}
                        />
                        <FormError message={actionError} />
                        <div className="mt-3 flex flex-wrap gap-2">
                          <Button
                            type="submit"
                            variant="accent"
                            disabled={busy !== null || !editContent.trim()}
                          >
                            {busy === preference.id
                              ? "Saving…"
                              : "Save changes"}
                          </Button>
                          <Button
                            variant="ghost"
                            disabled={busy !== null}
                            onClick={() => {
                              setEditingId(null);
                              setEditContent("");
                              setActionError("");
                            }}
                          >
                            Cancel
                          </Button>
                        </div>
                      </form>
                    ) : (
                      <div className="flex min-w-0 flex-col justify-between gap-3 sm:flex-row sm:items-start">
                        <p className="min-w-0 max-w-3xl whitespace-pre-wrap break-words text-base leading-7 sm:text-sm">
                          {preference.content}
                        </p>
                        <div className="flex shrink-0 flex-wrap gap-1">
                          <Button
                            variant="ghost"
                            disabled={
                              busy !== null || adding || editingId !== null
                            }
                            onClick={() => {
                              setEditingId(preference.id);
                              setEditContent(preference.content);
                              setDeletingId(null);
                              setActionError("");
                            }}
                          >
                            <Pencil aria-hidden="true" className="h-4 w-4" />
                            Edit
                          </Button>
                          <Button
                            variant="ghost"
                            disabled={
                              busy !== null || adding || editingId !== null
                            }
                            onClick={() => {
                              setDeletingId(preference.id);
                              setEditingId(null);
                              setActionError("");
                            }}
                          >
                            <Trash2 aria-hidden="true" className="h-4 w-4" />
                            Delete
                          </Button>
                        </div>
                      </div>
                    )}
                    <div className="mt-3 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
                      <span>Saved {dateLabel(preference.createdAt)}</span>
                      {preference.updatedAt !== preference.createdAt && (
                        <span>Updated {dateLabel(preference.updatedAt)}</span>
                      )}
                      {preference.sourceQuestionId ? (
                        <Link
                          href={`/investigations/${preference.sourceQuestionId}`}
                          className="inline-flex min-h-11 max-w-full items-center gap-1.5 text-accent underline underline-offset-4"
                          title={preference.sourceQuestion ?? undefined}
                        >
                          View original question
                          <ArrowUpRight
                            aria-hidden="true"
                            className="h-4 w-4 shrink-0"
                          />
                        </Link>
                      ) : (
                        <span>Added in settings</span>
                      )}
                    </div>
                    {deletingId === preference.id && (
                      <div className="mt-3 border-t border-border pt-4">
                        <p className="text-sm leading-6">
                          Delete this saved preference? Its original
                          conversation and previous answers remain available.
                        </p>
                        <FormError message={actionError} />
                        <div className="mt-3 flex flex-wrap gap-2">
                          <Button
                            variant="destructive"
                            disabled={busy !== null}
                            onClick={() => void deletePreference(preference.id)}
                          >
                            {busy === preference.id
                              ? "Deleting…"
                              : "Delete preference"}
                          </Button>
                          <Button
                            variant="ghost"
                            disabled={busy !== null}
                            onClick={() => {
                              setDeletingId(null);
                              setActionError("");
                            }}
                          >
                            Keep preference
                          </Button>
                        </div>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>
      <HistorySearch canReindex={settings?.viewer?.canReindex ?? false} />
      <details className="border-t border-border pt-6">
        <summary className="cursor-pointer py-3 text-lg font-medium">
          Your recent activity
        </summary>
        <ActivityHistory />
      </details>
    </div>
  );
}

function ActivityHistory() {
  const [events, setEvents] = useState<InteractionEvent[]>([]);
  const [targets, setTargets] = useState<Record<string, InteractionTarget>>({});
  const [cursor, setCursor] = useState<{
    before: string;
    beforeId: string;
  } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const active = useRef(false);
  async function load() {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setError("");
    try {
      const params = new URLSearchParams({ limit: "20", ...(cursor ?? {}) });
      const result = await request<{
        events: InteractionEvent[];
        targets: Record<string, InteractionTarget>;
        nextCursor: typeof cursor;
      }>(`/api/memory/events?${params}`);
      setEvents((previous) => [
        ...new Map(
          [...previous, ...result.events].map((event) => [event.id, event]),
        ).values(),
      ]);
      setCursor(result.nextCursor);
      setTargets(previous => ({ ...previous, ...result.targets }));
      setLoaded(true);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Activity could not be loaded. Try again.",
      );
    } finally {
      active.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="py-4">
      <p className="mb-5 max-w-3xl text-sm leading-6 text-muted">
        A private record of saved actions and observed page visits. Financial
        records and conversations keep their existing workspace permissions.
        Page visits can be missing when your browser is offline or closed; typed
        drafts and passwords are never recorded here.
      </p>
      <FormError message={error} />
      {events.length > 0 && (
        <ol className="divide-y divide-border border-y border-border">
          {events.map((event) => (
            <li
              key={event.id}
              className="flex min-w-0 flex-col gap-2 py-4 sm:flex-row sm:justify-between"
            >
              <div className="min-w-0">
                <p className="break-words text-sm">{event.summary}</p>
                {!event.redacted && targets[event.id] && (
                  <Link href={targets[event.id].href} className="inline-flex min-h-11 max-w-full items-center gap-2 break-words text-sm text-accent underline underline-offset-4">
                    {targets[event.id].label}
                    <ArrowUpRight size={14} className="shrink-0" aria-hidden="true" />
                  </Link>
                )}
                {!event.redacted && !targets[event.id] && (event.sourceId || event.workflowId) && (
                  <p className="mt-1 text-xs text-muted">Original record unavailable</p>
                )}
                <p className="mt-1 text-xs text-muted">
                  {event.actorKind === "system"
                    ? "System event"
                    : "Saved action"}
                  {event.redacted ? " · Original removed" : ""}
                </p>
              </div>
              <time
                dateTime={event.occurredAt}
                className="shrink-0 text-xs text-muted"
              >
                {dateLabel(event.occurredAt)} ·{" "}
                {new Date(event.occurredAt).toISOString().slice(11, 19)} UTC
              </time>
            </li>
          ))}
        </ol>
      )}
      {loaded && events.length === 0 && (
        <p className="py-5 text-sm text-muted">
          No activity has been recorded yet.
        </p>
      )}
      {(!loaded || cursor) && (
        <Button
          variant="outline"
          disabled={busy}
          className="mt-4"
          onClick={() => void load()}
        >
          {busy
            ? "Loading activity…"
            : error
              ? "Try again"
              : loaded
                ? "Load older activity"
                : "Load recent activity"}
        </Button>
      )}
    </div>
  );
}

function HistorySearch({ canReindex }: { canReindex: boolean }) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("question,source");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<MemorySearchResult | null>(null);
  const [lastQuery, setLastQuery] = useState("");
  const [indexing, setIndexing] = useState(false);
  const [indexNotice, setIndexNotice] = useState("");
  const indexingRef = useRef(false);
  const activeRequest = useRef<AbortController | null>(null);
  useEffect(() => () => activeRequest.current?.abort(), []);

  async function search() {
    const phrase = query.trim();
    if (!phrase) {
      setError("Enter a subject, question, or filename to search.");
      return;
    }
    if (since && until && since > until) {
      setError("Choose an end date on or after the start date.");
      return;
    }
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setLoading(true);
    setError("");
    setResult(null);
    const params = new URLSearchParams({
      q: phrase,
      kinds: kind,
      limit: String(HISTORY_LIMIT),
    });
    if (since) params.set("since", `${since}T00:00:00.000Z`);
    if (until) params.set("until", `${until}T23:59:59.999Z`);
    try {
      const body = await request<MemorySearchResult>(
        `/api/memory/search?${params}`,
        {
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(30_000),
          ]),
        },
      );
      if (controller.signal.aborted) return;
      setResult(body);
      setLastQuery(phrase);
    } catch (err) {
      if (!controller.signal.aborted)
        setError(
          err instanceof Error
            ? err.message
            : "History could not be searched. Try again.",
        );
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  async function updateIndex() {
    if (indexingRef.current || !canReindex) return;
    indexingRef.current = true;
    setIndexing(true);
    setIndexNotice("");
    setError("");
    try {
      const body = await request<{
        results: {
          sourceId: string;
          status: "indexed" | "failed";
          error?: string;
        }[];
        remaining: number | null;
        warning?: string;
      }>("/api/memory/reindex", {
        ...mutation("POST", {}),
        signal: AbortSignal.timeout(310_000),
      });
      const indexed = body.results.filter(
        (item) => item.status === "indexed",
      ).length;
      const failed = body.results.filter((item) => item.status === "failed");
      setIndexNotice(
        `${indexed} ${indexed === 1 ? "file is" : "files are"} now searchable.${body.remaining !== null && body.remaining > 0 ? ` ${body.remaining} still need indexing.` : ""}${failed.length > 0 ? ` ${failed.length} could not be indexed. ${failed[0].error ?? "Open the source file to inspect it directly."}` : ""}${body.warning ? ` ${body.warning}` : ""}`,
      );
      await search();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "File search could not be updated. Try again.",
      );
    } finally {
      indexingRef.current = false;
      setIndexing(false);
    }
  }

  return (
    <section
      id="workspace-history"
      aria-labelledby="workspace-history-title"
      className="min-w-0 border-t border-border pt-9"
    >
      <h2 id="workspace-history-title" className="text-lg font-medium">
        Workspace history
      </h2>
      <p className="mt-2 mb-6 max-w-3xl text-sm leading-6 text-muted">
        Find previous questions and uploaded files available to your
        organization. These are workspace records, separate from your personal
        preferences. Open a conversation to inspect its evidence and ask a
        follow-up. Previous answers are historical context; source files may
        have changed or been removed. Only relevant excerpts are retrieved for a
        new answer; your full history stays in storage. My activity searches
        your own recorded actions, without sharing them with teammates.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
        className="space-y-4"
      >
        <label htmlFor="history-query" className="block text-sm font-medium">
          Search your history
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            id="history-query"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            maxLength={MEMORY_LIMITS.queryChars}
            placeholder="For example, September cash variance"
            className={INPUT}
          />
          <Button
            type="submit"
            variant="accent"
            disabled={loading || indexing || !query.trim()}
            className="shrink-0"
          >
            {loading ? (
              <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
            ) : (
              <Search aria-hidden="true" className="h-4 w-4" />
            )}
            {loading ? "Searching…" : "Search history"}
          </Button>
        </div>
        <div className="grid min-w-0 gap-4 sm:grid-cols-3">
          <label className="flex min-w-0 flex-col gap-2 text-sm">
            Search in
            <select
              value={kind}
              onChange={(event) => setKind(event.target.value)}
              className={INPUT}
            >
              <option value="question,source">Questions and files</option>
              <option value="question">Questions only</option>
              <option value="source">Files only</option>
              <option value="interaction">My activity</option>
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-2 text-sm">
            Added on or after
            <input
              type="date"
              value={since}
              onChange={(event) => setSince(event.target.value)}
              className={INPUT}
            />
          </label>
          <label className="flex min-w-0 flex-col gap-2 text-sm">
            Added on or before
            <input
              type="date"
              value={until}
              min={since || undefined}
              onChange={(event) => setUntil(event.target.value)}
              className={INPUT}
            />
          </label>
        </div>
        <p className="text-sm text-muted">
          Dates refer to when a record was added or an action occurred, in UTC.
        </p>
      </form>
      {loading && (
        <p role="status" className="py-6 text-sm text-muted">
          Searching workspace history…
        </p>
      )}
      {error && (
        <div
          role="alert"
          className="mt-5 flex flex-wrap items-center gap-3 text-sm text-error"
        >
          {error}
          <Button
            variant="outline"
            disabled={loading || indexing || !query.trim()}
            onClick={() => void search()}
          >
            Try again
          </Button>
        </div>
      )}
      {!loading && !error && !result && (
        <p className="mt-6 border-t border-border py-6 text-sm leading-6 text-muted">
          Search to find a previous question or source. For the full lists, open{" "}
          <Link
            href="/investigations"
            className="text-accent underline underline-offset-4"
          >
            Ask your data
          </Link>{" "}
          or{" "}
          <Link
            href="/data"
            className="text-accent underline underline-offset-4"
          >
            Your data
          </Link>
          .
        </p>
      )}
      {indexing && (
        <p role="status" className="mt-5 text-sm leading-6 text-muted">
          Updating search for up to three files. Large sources can take a few
          minutes.
        </p>
      )}
      {indexNotice && (
        <p
          role="status"
          className="mt-5 break-words text-sm leading-6 text-muted"
        >
          {indexNotice}
        </p>
      )}
      {!loading && result && (
        <div className="mt-7">
          {result.coverage &&
            (result.coverage.pendingSources > 0 ||
              result.coverage.failedSources > 0) && (
              <p className="mb-5 border-y border-border py-4 text-sm leading-6 text-warning">
                File content search covers{" "}
                {result.coverage.indexedSources.toLocaleString()} of{" "}
                {result.coverage.totalSources.toLocaleString()} sources.{" "}
                {result.coverage.pendingSources > 0
                  ? `${result.coverage.pendingSources.toLocaleString()} awaiting indexing. `
                  : ""}
                {result.coverage.failedSources > 0
                  ? `${result.coverage.failedSources.toLocaleString()} could not be indexed. `
                  : ""}
                Filenames remain searchable. Open the original file to inspect
                content that is not indexed.
              </p>
            )}
          {canReindex &&
            result.coverage &&
            (result.coverage.pendingSources > 0 ||
              result.coverage.failedSources > 0) && (
              <Button
                variant="outline"
                disabled={indexing || loading}
                onClick={() => void updateIndex()}
                className="mb-5"
              >
                {indexing && (
                  <Loader2
                    aria-hidden="true"
                    className="h-4 w-4 animate-spin"
                  />
                )}
                {indexing
                  ? "Updating file search…"
                  : "Update file search (up to 3 files)"}
              </Button>
            )}
          <p role="status" className="mb-4 break-words text-sm text-muted">
            {result.results.length === 0
              ? `No matches for “${lastQuery}”. Try another term or widen the date range.`
              : `${result.results.length} ${result.results.length === 1 ? "match" : "matches"} for “${lastQuery}”`}
          </p>
          {result.results.length > 0 && (
            <ul className="divide-y divide-border border-y border-border">
              {result.results.map((item) => (
                <HistoryRecord key={`${item.kind}:${item.id}`} item={item} />
              ))}
            </ul>
          )}
          {result.hasMore && (
            <p className="mt-4 text-sm leading-6 text-muted">
              Showing the {HISTORY_LIMIT} most relevant matches. Add a more
              specific term or date range to narrow the results.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function HistoryRecord({ item }: { item: MemorySearchHit }) {
  const question = item.kind === "question";
  let href: string | null = null;
  if (question && item.workflowId) href = `/investigations/${item.workflowId}`;
  if (item.kind === "source" && !item.sourceId && item.workflowId)
    href = `/workflows/${item.workflowId}`;
  if (item.kind === "source" && item.sourceId) {
    const params = new URLSearchParams({ source: item.sourceId });
    if (item.tableId) params.set("table", item.tableId);
    if (item.originalRow !== null) params.set("row", String(item.originalRow));
    href = `/data?${params}`;
  }
  return (
    <li className="min-w-0 py-5">
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
        <span className="inline-flex items-center gap-2">
          {item.kind === "interaction" ? (
            <History aria-hidden="true" className="h-4 w-4" />
          ) : question ? (
            <MessageSquare aria-hidden="true" className="h-4 w-4" />
          ) : (
            <FileText aria-hidden="true" className="h-4 w-4" />
          )}
          {item.kind === "interaction"
            ? "Your activity"
            : question
              ? "Question"
              : "Source file"}
        </span>
        <span>Added {dateLabel(item.createdAt)}</span>
      </div>
      <h3 className="break-words font-medium">{item.title}</h3>
      {item.excerpt && (
        <p className="mt-2 max-w-3xl whitespace-pre-wrap break-words text-base leading-7 sm:text-sm text-muted">
          {item.excerpt}
        </p>
      )}
      {item.originalRow !== null && (
        <p className="mt-2 text-sm text-muted">
          Source row {item.originalRow.toLocaleString()}
          {item.tableId ? ` · Table ${item.tableId}` : ""}
        </p>
      )}
      {href && (
        <Link
          href={href}
          className="mt-2 inline-flex min-h-11 items-center gap-2 text-sm text-accent underline underline-offset-4"
        >
          {question
            ? "Open conversation & continue"
            : item.sourceId
              ? "Open source file"
              : "Open source workflow"}
          <ArrowUpRight aria-hidden="true" className="h-4 w-4" />
        </Link>
      )}
    </li>
  );
}

function FormError({ message }: { message: string }) {
  return message ? (
    <p role="alert" className="mt-4 break-words text-sm leading-6 text-error">
      {message}
    </p>
  ) : null;
}
