"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  ArrowRight,
  FileSpreadsheet,
  Loader2,
  RefreshCw,
  Upload,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DataRow, DataSourceMetadata } from "@/lib/data/types";

export function DataLibrary() {
  const params = useSearchParams();
  const sourceParam = params.get("source");
  const tableParam = params.get("table");
  const [sources, setSources] = useState<DataSourceMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState(params.get("source") ?? "");
  const [tableId, setTableId] = useState(params.get("table") ?? "t0");
  const [offset, setOffset] = useState(0);
  const [preview, setPreview] = useState<{
    columns: string[];
    rows: DataRow[];
    total: number;
    preamble: DataRow[];
    trimmed: boolean;
    offset: number;
  } | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [linkedSource, setLinkedSource] = useState<DataSourceMetadata | null>(
    null,
  );
  const [linkedError, setLinkedError] = useState("");
  const [removeId, setRemoveId] = useState<string | null>(null);
  const [headerRow, setHeaderRow] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [catalogOffset, setCatalogOffset] = useState(0);
  const [moreBusy, setMoreBusy] = useState(false);
  const [viewer, setViewer] = useState<{
    id: string;
    canUpload: boolean;
    isAdmin: boolean;
  } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (sourceParam) {
      setSelected(sourceParam);
      setTableId(tableParam ?? "t0");
      setOffset(0);
    }
  }, [sourceParam, tableParam]);
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/data-sources", {
        cache: "no-store",
        signal: AbortSignal.timeout(60_000),
      });
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.error ?? "Files could not be loaded.");
      setSources(body.sources);
      setHasMore(body.hasMore);
      setCatalogOffset(body.sources.length);
      setViewer(body.viewer ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Files could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const source =
    sources.find((s) => s.id === selected) ??
    (linkedSource?.id === selected ? linkedSource : undefined);
  useEffect(() => {
    setLinkedError("");
    if (!selected || loading || sources.some((s) => s.id === selected)) return;
    const controller = new AbortController();
    void fetch(`/api/data-sources/${selected}`, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]),
    })
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok)
          throw new Error(body.error ?? "The linked source is unavailable.");
        setLinkedSource(body.source);
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setLinkedError(
            e instanceof Error
              ? e.message
              : "The linked source is unavailable.",
          );
      });
    return () => controller.abort();
  }, [selected, loading, sources]);
  const table = source?.tables.find((t) => t.id === tableId);
  useEffect(() => {
    if (!selected || !table) {
      setPreview(null);
      return;
    }
    const controller = new AbortController();
    setPreviewLoading(true);
    setPreviewError("");
    setPreview(null);
    void fetch(
      `/api/data-sources/${selected}?preview=1&tableId=${encodeURIComponent(tableId)}&offset=${offset}&limit=25${offset === 0 && params.get("source") === selected && params.get("row") ? `&originalRow=${encodeURIComponent(params.get("row")!)}` : ""}`,
      {
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(60_000),
        ]),
      },
    )
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "Preview unavailable.");
        return body;
      })
      .then((body) =>
        setPreview({
          columns: body.columns ?? body.table?.columns ?? table.columns,
          rows: body.rows ?? body.table?.rows ?? [],
          total: body.total ?? body.table?.rowCount ?? table.rowCount,
          preamble: body.table?.preamble ?? [],
          trimmed: body.table?.previewTruncated ?? false,
          offset: body.table?.offset ?? offset,
        }),
      )
      .catch((e) => {
        if (!controller.signal.aborted)
          setPreviewError(
            e instanceof Error ? e.message : "Preview unavailable.",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setPreviewLoading(false);
      });
    return () => controller.abort();
  }, [selected, tableId, offset, table, params]);

  async function more() {
    setMoreBusy(true);
    try {
      const res = await fetch(
        `/api/data-sources?offset=${catalogOffset}&limit=100`,
        { signal: AbortSignal.timeout(60_000) },
      );
      const body = await res.json();
      if (!res.ok)
        throw new Error(body.error ?? "More files could not be loaded.");
      setSources((current) => [...current, ...body.sources]);
      setHasMore(body.hasMore);
      setCatalogOffset((current) => current + body.sources.length);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "More files could not be loaded.",
      );
    } finally {
      setMoreBusy(false);
    }
  }
  async function upload(file: File) {
    if (busy) return;
    if (file.size > 20 * 1024 * 1024) {
      setError("This file is larger than 20 MB. Split it into smaller files.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    const form = new FormData();
    form.append("file", file);
    if (headerRow !== "") {
      const row = Number(headerRow);
      if (!Number.isInteger(row) || row < 0 || row > 20000) {
        setBusy(false);
        setError(
          "Header row must be a whole number from 0 to 20,000. Use 0 for a file without headers.",
        );
        return;
      }
      form.append("headerRows", JSON.stringify({ t0: row === 0 ? null : row }));
    }
    try {
      const res = await fetch("/api/data-sources", {
        method: "POST",
        signal: AbortSignal.timeout(60_000),
        body: form,
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Upload failed. Try again.");
      setSelected(body.source.id);
      setTableId(body.source.tables[0]?.id ?? "t0");
      setOffset(0);
      await load();
      setNotice(`${file.name} is ready to inspect and use in a question.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed. Try again.");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }
  async function remove() {
    if (!removeId || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/data-sources/${removeId}`, {
        method: "DELETE",
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "Could not remove this file.");
      }
      if (selected === removeId) setSelected("");
      setRemoveId(null);
      setNotice(
        "File removed. Earlier answers may still contain excerpts from it.",
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove this file.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="page-container space-y-8">
      <header className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
        <div>
          <h1 className="page-title">Your data</h1>
          <p className="page-description">
            Bring the files. Keep their context.
          </p>
        </div>
        <Link
          href="/investigations"
          className="inline-flex min-h-11 items-center gap-2 text-sm text-accent"
        >
          Ask your data <ArrowRight size={16} />
        </Link>
      </header>
      {!loading && viewer && !viewer.canUpload && (
        <p className="text-sm text-muted">
          You have read-only access to this data library. An administrator or
          analyst can upload new files.
        </p>
      )}
      <section
        className="rounded-lg border border-border bg-card p-5 sm:p-7"
        aria-label="Upload data"
      >
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="max-w-2xl">
            <h2 className="text-lg font-medium">
              A workspace for unfamiliar files
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              Spreadsheets with multiple sheets, delimited exports, JSON, and
              text-based documents. Inspect what was read before you ask a
              question.
            </p>
            <p
              id="file-help"
              className="mt-3 text-xs leading-relaxed text-muted"
            >
              CSV, TSV, XLSX, XLS, JSON, JSONL, TXT, MD or text-based PDF · up
              to 20 MB per file. Scanned pages need text extraction first.
            </p>
          </div>
          <div className="shrink-0">
            <input
              ref={fileRef}
              type="file"
              className="sr-only"
              aria-label="Upload a data file"
              aria-describedby="file-help"
              accept=".csv,.tsv,.xlsx,.xls,.json,.jsonl,.ndjson,.txt,.md,.pdf"
              disabled={busy || !viewer?.canUpload}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void upload(file);
              }}
            />
            <Button
              variant="accent"
              disabled={busy || !viewer?.canUpload}
              onClick={() => fileRef.current?.click()}
            >
              {busy ? (
                <Loader2 size={16} className="mr-2 animate-spin" />
              ) : (
                <Upload size={16} className="mr-2" />
              )}
              {busy ? "Working…" : "Upload file"}
            </Button>
          </div>
        </div>
        <details className="mt-4">
          <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm text-muted">
            Import options
          </summary>
          <label className="mt-2 flex max-w-sm flex-col gap-2 text-sm">
            Header row in the first table
            <input
              type="number"
              min="0"
              max="20000"
              inputMode="numeric"
              value={headerRow}
              onChange={(e) => setHeaderRow(e.target.value)}
              placeholder="Detect automatically"
              className="field-control"
              disabled={busy}
            />
            <span className="text-xs leading-relaxed text-muted">
              Leave blank for automatic detection, or enter the original row
              number. Use 0 if there is no header. Other sheets are detected
              individually.
            </span>
          </label>
        </details>
      </section>
      {error && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 text-sm text-error"
        >
          <p>{error}</p>
          <Button variant="outline" onClick={() => void load()}>
            <RefreshCw size={16} className="mr-2" />
            Retry
          </Button>
        </div>
      )}
      {notice && (
        <p role="status" className="text-sm text-accent">
          {notice}
        </p>
      )}
      <div className="workspace-split">
        <section aria-labelledby="files-heading" className="min-w-0">
          <h2 id="files-heading" className="mb-4 text-lg font-medium">
            Files{" "}
            <span className="ml-2 text-sm text-muted">{sources.length}</span>
          </h2>
          {loading && (
            <p role="status" className="py-8 text-sm text-muted">
              Loading files…
            </p>
          )}
          {!loading && !sources.length && (
            <p className="border-t border-border py-8 text-sm leading-relaxed text-muted">
              Upload your first file to explore its sheets and columns. Workflow
              exports remain available to the agent automatically.
            </p>
          )}
          <div className="divide-y divide-border border-y border-border">
            {sources.map((item) => (
              <button
                type="button"
                key={item.id}
                aria-pressed={selected === item.id}
                onClick={() => {
                  setSelected(item.id);
                  setTableId(item.tables[0]?.id ?? "t0");
                  setOffset(0);
                }}
                className={`flex min-h-20 w-full gap-3 p-4 text-left transition-colors ${selected === item.id ? "bg-card-hover" : "hover:bg-card"}`}
              >
                <FileSpreadsheet
                  size={19}
                  className="mt-1 shrink-0 text-muted"
                />
                <span className="min-w-0">
                  <span className="block break-words text-sm font-medium">
                    {item.filename}
                  </span>
                  <span className="mt-1 block text-xs text-muted">
                    {item.tables.length}{" "}
                    {item.tables.length === 1 ? "table" : "tables"} ·{" "}
                    {item.tables
                      .reduce((n, t) => n + t.rowCount, 0)
                      .toLocaleString()}{" "}
                    rows
                  </span>
                  {item.warnings.length > 0 && (
                    <span className="mt-1 block text-xs text-warning">
                      Read import notes
                    </span>
                  )}
                </span>
              </button>
            ))}
          </div>
          {hasMore && (
            <Button
              variant="ghost"
              disabled={moreBusy}
              onClick={() => void more()}
              className="mt-3"
            >
              {moreBusy ? "Loading…" : "Load more files"}
            </Button>
          )}
        </section>
        <section className="min-w-0" aria-label="Source preview">
          {linkedError && (
            <p role="alert" className="mb-4 text-sm text-error">
              {linkedError}
            </p>
          )}
          {!source ? (
            <div className="flex min-h-64 flex-col justify-center border-y border-border py-8">
              <h2 className="text-lg font-medium">
                Read the source, then reason.
              </h2>
              <p className="mt-3 max-w-lg text-sm leading-relaxed text-muted">
                Select a file to see its tables, original row numbers, and
                import notes. Uploaded values are preserved; the agent
                investigates their meaning.
              </p>
            </div>
          ) : (
            <>
              <div className="mb-5 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="break-words text-lg font-medium">
                    {source.filename}
                  </h2>
                  <p className="mt-1 text-xs text-muted">
                    {source.format.toUpperCase()} ·{" "}
                    {(source.byteSize / 1024).toLocaleString(undefined, {
                      maximumFractionDigits: 1,
                    })}{" "}
                    KB
                  </p>
                </div>
                {(viewer?.isAdmin || source.createdBy === viewer?.id) && (
                  <Button
                    variant="ghost"
                    aria-label={`Remove ${source.filename}`}
                    onClick={() => setRemoveId(source.id)}
                  >
                    <Trash2 size={16} />
                  </Button>
                )}
              </div>
              {removeId === source.id && (
                <div className="mb-5 rounded-md border border-border p-4">
                  <p className="text-sm">
                    Remove this file from the workspace? Future questions will
                    no longer be able to read it. Earlier answers retain their
                    recorded results.
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      variant="destructive"
                      disabled={busy}
                      onClick={() => void remove()}
                    >
                      Remove file
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setRemoveId(null)}
                    >
                      Keep file
                    </Button>
                  </div>
                </div>
              )}
              {source.warnings.length > 0 && (
                <details open className="mb-5 border-y border-border py-3">
                  <summary className="cursor-pointer text-sm text-warning">
                    Import notes
                  </summary>
                  <ul className="mt-3 space-y-2 pl-4 text-sm leading-relaxed text-muted">
                    {source.warnings.map((warning, i) => (
                      <li key={i}>{warning}</li>
                    ))}
                  </ul>
                </details>
              )}
              <label className="mb-4 flex flex-col gap-2 text-sm">
                Table or sheet
                <select
                  className="field-control"
                  value={tableId}
                  onChange={(e) => {
                    setTableId(e.target.value);
                    setOffset(0);
                  }}
                >
                  {source.tables.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} · {t.rowCount.toLocaleString()} rows
                    </option>
                  ))}
                </select>
              </label>
              {table && (
                <p className="mb-3 text-xs text-muted">
                  {table.columns.length} columns ·{" "}
                  {table.headerRow
                    ? `Header inferred at row ${table.headerRow}`
                    : "Generated column names"}
                  {table.preambleRowCount
                    ? ` · ${table.preambleRowCount} introductory rows retained`
                    : ""}
                  . Scroll the table horizontally to inspect all columns.
                </p>
              )}
              {previewError && (
                <p role="alert" className="py-5 text-sm text-error">
                  {previewError}
                </p>
              )}
              {previewLoading && (
                <p role="status" className="py-5 text-sm text-muted">
                  Reading source rows…
                </p>
              )}
              {preview && (
                <>
                  {preview.preamble.length > 0 && (
                    <details className="mb-4">
                      <summary className="min-h-11 cursor-pointer py-3 text-sm text-muted">
                        Introductory rows
                      </summary>
                      <div className="space-y-2">
                        {preview.preamble.map((row) => (
                          <p
                            key={row.sourceId}
                            className="break-words text-sm leading-relaxed"
                          >
                            <span className="mr-3 font-mono text-xs text-muted">
                              {row.originalRow}
                            </span>
                            {Object.values(row.values)
                              .filter((v) => v !== null && v !== "")
                              .map(String)
                              .join(" · ")}
                          </p>
                        ))}
                      </div>
                    </details>
                  )}
                  {preview.trimmed && (
                    <p className="mb-3 text-xs text-warning">
                      Long cell text is shortened in this preview. The agent
                      reads the original values.
                    </p>
                  )}
                  <div
                    className="data-scroll"
                    tabIndex={0}
                    role="region"
                    aria-label="Source rows"
                  >
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Row</th>
                          {preview.columns.map((c, i) => (
                            <th key={i}>{c}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {preview.rows.map((row) => (
                          <tr
                            key={row.sourceId}
                            className={
                              params.get("source") === source.id &&
                              Number(params.get("row")) === row.originalRow
                                ? "bg-accent/10"
                                : undefined
                            }
                          >
                            <td className="font-mono text-muted">
                              {row.originalRow}
                            </td>
                            {preview.columns.map((c, i) => (
                              <td key={i}>{String(row.values[c] ?? "")}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-muted">
                    <span>
                      {preview.total
                        ? `${preview.offset + 1}–${Math.min(preview.offset + preview.rows.length, preview.total)} of ${preview.total.toLocaleString()} rows`
                        : "No rows"}
                    </span>
                    <div className="flex gap-2">
                      <Button
                        variant="ghost"
                        disabled={preview.offset === 0}
                        onClick={() =>
                          setOffset(Math.max(0, preview.offset - 25))
                        }
                      >
                        Previous
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={preview.offset + 25 >= preview.total}
                        onClick={() => setOffset(preview.offset + 25)}
                      >
                        Next
                      </Button>
                    </div>
                  </div>
                </>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
