/* Static host bootstrap. Model code is evaluated ONLY by QuickJS, never by Node. */
/* eslint-disable @typescript-eslint/no-require-imports -- This static worker is loaded directly by Node, outside the application bundler. */
const { parentPort, workerData } = require("node:worker_threads");
const { getQuickJS } = require("quickjs-emscripten");

async function main() {
  const quickjs = await getQuickJS();
  const runtime = quickjs.newRuntime();
  runtime.setMemoryLimit(32 * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  const deadline = Date.now() + workerData.executionMs;
  runtime.setInterruptHandler(() => Date.now() >= deadline);
  const context = runtime.newContext();
  try {
    // No host functions, Node objects, module loader, timers, or network APIs are installed.
    // Only JSON text crosses the isolation boundary. Serialization also runs inside QuickJS.
    const input = context.newString(workerData.inputJson);
    context.setProp(context.global, "__inputJson", input);
    input.dispose();
    const code = context.newString(workerData.code);
    context.setProp(context.global, "__analysisCode", code);
    code.dispose();
    const result = context.evalCode(`
      (() => {
        "use strict";
        const stringify = JSON.stringify.bind(JSON);
        const parse = JSON.parse.bind(JSON);
        const SafeError = Error;
        const input = parse(__inputJson);
        const code = __analysisCode;
        delete globalThis.__inputJson;
        delete globalThis.__analysisCode;
        const scale = 1000000000000n;
        const parseDecimal = (value) => {
          if (typeof value === "number" && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) {
            throw new SafeError("Unsafe numeric source value; use original decimal strings");
          }
          const text = String(value);
          if (!/^[+-]?\\d{1,30}(?:\\.\\d{1,12})?$/.test(text)) {
            throw new SafeError("decimal requires plain decimal strings, max 30 integer and 12 fractional digits; do not assume locale or units");
          }
          const negative = text.startsWith("-");
          const [whole, fraction = ""] = text.replace(/^[+-]/, "").split(".");
          return (negative ? -1n : 1n) * (BigInt(whole) * scale + BigInt(fraction.padEnd(12, "0")));
        };
        const formatDecimal = (value) => {
          const negative = value < 0n;
          const abs = negative ? -value : value;
          const fraction = String(abs % scale).padStart(12, "0").replace(/0+$/, "");
          return (negative ? "-" : "") + String(abs / scale) + (fraction ? "." + fraction : "");
        };
        const decimal = Object.freeze({
          sum: (values) => formatDecimal(values.reduce((sum, value) => sum + parseDecimal(value), 0n)),
          add: (left, right) => formatDecimal(parseDecimal(left) + parseDecimal(right)),
          subtract: (left, right) => formatDecimal(parseDecimal(left) - parseDecimal(right)),
          compare: (left, right) => { const a = parseDecimal(left), b = parseDecimal(right); return a < b ? -1 : a > b ? 1 : 0; },
          multiply: (left, right) => {
            const product = parseDecimal(left) * parseDecimal(right);
            if (product % scale !== 0n) throw new SafeError("Exact multiplication exceeds 12 decimal places");
            return formatDecimal(product / scale);
          },
          divide: (left, right) => {
            const numerator = parseDecimal(left) * scale, denominator = parseDecimal(right);
            if (denominator === 0n) throw new SafeError("Division by zero");
            if (numerator % denominator !== 0n) throw new SafeError("Division is not exact within 12 decimal places");
            return formatDecimal(numerator / denominator);
          }
        });
        const output = new Function("tables", "decimal", '"use strict";\\n' + code)(input.tables, decimal);
        if (output === undefined || (output && typeof output.then === "function")) {
          throw new SafeError("Return a synchronous JSON value; promises and undefined are not supported");
        }
        const encoded = stringify(output, (_key, value) => {
          if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol" ||
              (typeof value === "number" && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))))) {
            throw new SafeError("Output must contain JSON values with finite, safe numbers; use decimal strings for exact amounts");
          }
          return value;
        });
        if (typeof encoded !== "string" || encoded.length > ${24 * 1024}) {
          throw new SafeError("Output exceeds 24 KiB; return a compact summary or page of rows");
        }
        return encoded;
      })()
    `, "analysis.js");
    if (result.error) {
      const error = context.dump(result.error);
      result.error.dispose();
      parentPort.postMessage({ ok: false, error: String(error?.message || error).slice(0, 1200) });
    } else {
      const outputJson = context.getString(result.value);
      result.value.dispose();
      if (Buffer.byteLength(outputJson, "utf8") > 24 * 1024) {
        parentPort.postMessage({ ok: false, error: "Output exceeds 24 KiB; return a compact summary or page of rows" });
      } else {
        parentPort.postMessage({ ok: true, outputJson });
      }
    }
  } finally {
    context.dispose();
    runtime.dispose();
  }
}

main().catch(() => {
  // Do not expose host exception details or file paths to model-controlled code.
  parentPort.postMessage({ ok: false, error: "Analysis exceeded available resources or the isolated runtime failed" });
});
