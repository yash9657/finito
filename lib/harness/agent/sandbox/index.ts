import { Worker } from "node:worker_threads";
import path from "node:path";

export const ANALYSIS_LIMITS = Object.freeze({
  codeBytes: 16 * 1024,
  inputBytes: 4 * 1024 * 1024,
  outputBytes: 24 * 1024,
  executionMs: 1500,
  workerMs: 5000,
  concurrentWorkers: 2,
});

export type AnalysisResult = { ok: true; output: unknown } | { ok: false; error: string };
let activeWorkers = 0;

/**
 * A worker bounds WASM native operations that QuickJS's bytecode interrupt cannot stop.
 * The worker itself never evaluates the model's code in Node. Its only job is to host the
 * separate QuickJS interpreter. No host callbacks, secrets, module loader or I/O reach it.
 */
export async function runIsolatedAnalysis(
  code: string,
  input: unknown,
  options: { signal?: AbortSignal } = {},
): Promise<AnalysisResult> {
  if (!code.trim() || Buffer.byteLength(code, "utf8") > ANALYSIS_LIMITS.codeBytes) {
    return { ok: false, error: "Analysis code must contain 1–16,384 UTF-8 bytes" };
  }
  let inputJson: string;
  try { inputJson = JSON.stringify(input); }
  catch { return { ok: false, error: "Analysis inputs must be JSON data" }; }
  if (!inputJson || Buffer.byteLength(inputJson, "utf8") > ANALYSIS_LIMITS.inputBytes) {
    return { ok: false, error: "Selected data exceeds the 4 MiB analysis input limit; select fewer tables or a row range" };
  }
  if (options.signal?.aborted) return { ok: false, error: "Investigation was cancelled or reached its deadline" };
  if (activeWorkers >= ANALYSIS_LIMITS.concurrentWorkers) {
    return { ok: false, error: "Analysis capacity is busy; use source inspection tools or retry later" };
  }
  activeWorkers++;
  return new Promise<AnalysisResult>((resolve) => {
    let worker: Worker | undefined;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: AnalysisResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      // Retain the capacity slot until the worker is actually gone.
      const stopped = worker ? worker.terminate() : Promise.resolve();
      void stopped.finally(() => { activeWorkers--; resolve(result); });
    };
    const abort = () => finish({ ok: false, error: "Investigation was cancelled or reached its deadline" });
    try {
      worker = new Worker(path.join(process.cwd(), "lib/harness/agent/sandbox/worker.cjs"), {
        workerData: { code, inputJson, executionMs: ANALYSIS_LIMITS.executionMs },
        env: {},
        execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 },
      });
      timer = setTimeout(() => finish({ ok: false, error: "Analysis exceeded the 5-second hard deadline; narrow the data or simplify the code" }), ANALYSIS_LIMITS.workerMs);
      options.signal?.addEventListener("abort", abort, { once: true });
      worker.once("message", (message: unknown) => {
        if (!message || typeof message !== "object") return finish({ ok: false, error: "Isolated analysis returned an invalid response" });
        const result = message as { ok?: boolean; outputJson?: string; error?: string };
        if (!result.ok) return finish({ ok: false, error: typeof result.error === "string" ? result.error.slice(0, 1200) : "Isolated analysis failed" });
        if (typeof result.outputJson !== "string" || Buffer.byteLength(result.outputJson, "utf8") > ANALYSIS_LIMITS.outputBytes) {
          return finish({ ok: false, error: "Analysis output exceeded its size limit" });
        }
        try { finish({ ok: true, output: JSON.parse(result.outputJson) }); }
        catch { finish({ ok: false, error: "Analysis did not return valid JSON" }); }
      });
      worker.once("error", () => finish({ ok: false, error: "Isolated analysis failed or exceeded its memory limit" }));
      worker.once("exit", () => finish({ ok: false, error: "Isolated analysis stopped without a result" }));
      if (options.signal?.aborted) abort();
    } catch {
      finish({ ok: false, error: "Isolated analysis is unavailable on this server" });
    }
  });
}
