import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { memoryRequestBody } from "./http";

describe("bounded memory request body", () => {
  it("reads valid JSON and rejects oversized streaming input without a declared length", async () => {
    expect(await memoryRequestBody(new NextRequest("http://localhost/api/memory", { method: "PATCH", body: '{"enabled":false}' }))).toEqual({ enabled: false });
    const request = new NextRequest("http://localhost/api/memory", { method: "POST", body: "x".repeat(33 * 1024) });
    expect(request.headers.has("content-length")).toBe(false);
    await expect(memoryRequestBody(request)).rejects.toThrow(/too large/);
  });
  it("does not repair invalid input or expose the original request in errors", async () => {
    await expect(memoryRequestBody(new NextRequest("http://localhost/api/memory", { method: "PATCH", body: '{"secret":"' }))).rejects.toThrow("Send valid UTF-8 JSON for this memory operation.");
  });
});
