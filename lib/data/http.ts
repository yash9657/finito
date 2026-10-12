import { NextResponse, type NextRequest } from "next/server";
import { DATA_LIMITS, DataSourceError } from "@/lib/data/types";

export function dataSourceErrorResponse(error: unknown): NextResponse {
  if (error instanceof DataSourceError) {
    const status = error.code === "not_found" ? 404 : error.code === "limit_exceeded" ? 413 : error.code === "storage_error" ? 503 : error.code === "integrity_error" ? 409 : 400;
    return NextResponse.json({ error: error.message, code: error.code }, { status });
  }
  return NextResponse.json({ error: "The source operation could not be completed. Retry shortly.", code: "storage_error" }, { status: 503 });
}

/** Bound the incoming stream before multipart parsing, including requests without Content-Length. */
export async function boundedSourceFormData(req: NextRequest): Promise<FormData> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) throw new DataSourceError("Upload one file using multipart/form-data.");
  const ceiling = DATA_LIMITS.maxUploadBytes + 128 * 1024;
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > ceiling) throw new DataSourceError("The upload exceeds the 20 MiB file limit.", "limit_exceeded");
  const reader = req.body?.getReader();
  if (!reader) throw new DataSourceError("The upload body is empty.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > ceiling) {
        await reader.cancel();
        throw new DataSourceError("The upload exceeds the 20 MiB file limit.", "limit_exceeded");
      }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  try {
    return await new Response(Buffer.concat(chunks), { headers: { "content-type": contentType } }).formData();
  } catch { throw new DataSourceError("The upload form could not be read. Select the file and try again."); }
}

export function pagingInteger(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < min || Number(raw) > max) throw new DataSourceError(`Paging values must be integers between ${min} and ${max}.`);
  return Number(raw);
}
