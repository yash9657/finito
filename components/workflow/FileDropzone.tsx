"use client";

/**
 * FileDropzone (PLAN §11.4).
 *
 * One dropzone per required file type in the creation wizard. Supports drag-drop
 * and click-to-select, POSTs a multipart `{ file, fileType }` to
 * `/api/workflows/[id]/upload`, and — once the route returns `{ fileId, sha256 }` —
 * shows the filename, human size, the short SHA-256 (`shortHash`) and a green check.
 *
 * `onUploaded` is fired with the upload result. It is typed with a result object,
 * but a no-arg `() => void` consumer is also assignable, so callers may ignore it.
 */

import * as React from "react";
import {
  UploadCloud,
  FileText,
  CheckCircle2,
  Loader2,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { shortHash } from "@/lib/format";
import type { FileType } from "@/lib/types";

export interface FileDropzoneResult {
  fileType: FileType;
  fileId: string;
  sha256: string;
  filename: string;
  sizeBytes: number;
}

interface FileDropzoneProps {
  fileType: FileType;
  label: string;
  workflowId: string;
  onUploaded: (result: FileDropzoneResult) => void;
}

const ACCEPT = ".csv,.xlsx,.xls";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

export default function FileDropzone({
  fileType,
  label,
  workflowId,
  onUploaded,
}: FileDropzoneProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [uploaded, setUploaded] = React.useState<{
    filename: string;
    sizeBytes: number;
    sha256: string;
  } | null>(null);

  async function upload(file: File) {
    if (uploading) return;
    if (!/\.(csv|xlsx|xls)$/i.test(file.name)) { setError("Choose a CSV or Excel file (.csv, .xlsx, .xls)."); return; }
    if (!file.size || file.size > 10 * 1024 * 1024) { setError("Choose a nonempty file smaller than 10 MB."); return; }
    setError(null);
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("fileType", fileType);

      const res = await fetch(`/api/workflows/${workflowId}/upload`, {
        method: "POST",
        body: form,
      });
      const body = (await res.json().catch(() => null)) as
        | { fileId?: string; sha256?: string; error?: string }
        | null;
      if (!res.ok || !body?.fileId || !body?.sha256) {
        throw new Error(body?.error ?? `Upload failed (${res.status})`);
      }

      setUploaded({
        filename: file.name,
        sizeBytes: file.size,
        sha256: body.sha256,
      });
      onUploaded({
        fileType,
        fileId: body.fileId,
        sha256: body.sha256,
        filename: file.name,
        sizeBytes: file.size,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  function onSelect(files: FileList | null) {
    const file = files?.[0];
    if (file) void upload(file);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (uploading) return;
    onSelect(e.dataTransfer.files);
  }

  const clickable = !uploading;

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <span className="text-xs text-muted">CSV or Excel · up to 10 MB</span>
      </div>

      <div
        role="button"
        tabIndex={uploading ? -1 : 0}
        aria-disabled={uploading}
        aria-label={`Upload ${label}`}
        onClick={() => clickable && inputRef.current?.click()}
        onKeyDown={(e) => {
          if (clickable && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          if (!uploading) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          "flex min-h-24 w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-card px-4 py-5 text-center transition-colors",
          clickable && "cursor-pointer hover:border-muted",
          dragging && "border-accent bg-accent/5",
          uploaded && "border-accent/50 bg-accent/5",
          error && "border-error/60",
        )}
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => {
            onSelect(e.target.files);
            e.target.value = "";
          }}
        />

        {uploading ? (
          <>
            <Loader2 className="h-5 w-5 animate-spin text-running" />
            <span className="text-xs text-muted">Uploading…</span>
          </>
        ) : uploaded ? (
          <>
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-accent" />
              <FileText className="h-4 w-4 text-muted" />
              <span className="max-w-[16rem] truncate text-sm text-foreground">
                {uploaded.filename}
              </span>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-x-3 font-mono text-xs text-muted">
              <span>{formatBytes(uploaded.sizeBytes)}</span>
              <span>sha256:{shortHash(uploaded.sha256)}</span>
            </div>
            <span className="text-xs text-muted">Click to replace</span>
          </>
        ) : (
          <>
            <UploadCloud className="h-5 w-5 text-muted" />
            <span className="text-sm text-foreground">
              Drop file or click to browse
            </span>
            <span className="font-mono text-xs text-muted">
              .csv · .xlsx · .xls
            </span>
          </>
        )}
      </div>

      {error && (
        <p className="mt-1.5 flex items-center gap-1 font-mono text-xs text-error">
          <XCircle className="h-3.5 w-3.5" />
          {error}
        </p>
      )}
    </div>
  );
}
