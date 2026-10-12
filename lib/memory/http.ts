import { NextResponse, type NextRequest } from "next/server";
import { MemoryError } from "./types";

export function memoryErrorResponse(error: unknown): NextResponse {
  if (error instanceof MemoryError) return NextResponse.json({ error: error.message }, { status: error.code === "not_found" ? 404 : error.code === "disabled" ? 409 : error.code === "unavailable" ? 503 : 400 });
  return NextResponse.json({ error: "The memory operation could not be completed. Retry shortly." }, { status: 503 });
}

export async function memoryRequestBody(req: NextRequest): Promise<unknown> {
  const maxBytes = 32 * 1024;
  if (Number(req.headers.get("content-length")) > maxBytes) throw new MemoryError("The memory request is too large.");
  const reader = req.body?.getReader();
  if (!reader) throw new MemoryError("Send a JSON request body.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new MemoryError("The memory request is too large."); }
      chunks.push(result.value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new MemoryError("Send valid UTF-8 JSON for this memory operation."); }
}
