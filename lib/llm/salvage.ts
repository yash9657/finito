/**
 * The tool-call salvage layer (Plan 5 §4, D-G17) — ported in spirit from OpenWorker's
 * `openai_provider.py`.
 *
 * Strong models emit a structured tool call. Weak ones — local models especially, but also
 * OpenAI-compatible gateways in front of quantized weights — emit it as prose, as a fenced JSON
 * block, wrapped in `<tool_call>` tags, or as JSON with the arguments double-encoded. This module
 * recovers those, **validated against the tool's own schema**, so a recovered call can only ever
 * name a real tool with plausibly-typed arguments.
 *
 * It is the difference between "Ollama is supported" and "Ollama actually works".
 *
 * ## Never silent
 *
 * Every recovered call is marked `salvaged: true` with the strategy that worked, and the agent
 * loop puts both on the `tool_called` event. That is not decoration: a salvage rate creeping up is
 * the earliest signal that a customer's local model is not fit for purpose, and it can only be a
 * signal if it is recorded. Silently repairing model output would make a degrading deployment look
 * healthy right up to the point it produced a wrong answer.
 *
 * ## What it will not do
 *
 * It will not invent a tool name, will not fabricate a required argument, and will not coerce a
 * value whose shape the schema does not describe. A call it cannot validate is not returned — the
 * loop then feeds the model a correctable message, which is the SWE-agent guardrail principle
 * (reject with a correction rather than run something malformed).
 */

import type { ToolCall, ToolDefinition } from "@/lib/llm/messages";
import type { PlainJsonSchema } from "@/lib/llm/json-schema";

export interface SalvageResult {
  toolCalls: ToolCall[];
  /** The strategy that worked, for the event payload. Absent when nothing was recovered. */
  strategy?: string;
}

/** How many candidate JSON objects we are willing to scan in one response. */
const MAX_CANDIDATES = 8;

/**
 * Try to recover tool calls from a text response that carried none structurally.
 *
 * Strategies are tried in descending order of confidence; the first that yields at least one
 * schema-valid call wins. Ordering matters: a fenced block is a deliberate emission and an
 * unfenced brace-scan is a guess, so preferring the former avoids picking up a JSON *example*
 * the model happened to include in its prose.
 */
export function salvageToolCalls(text: string, tools: ToolDefinition[]): SalvageResult {
  if (!text || tools.length === 0) return { toolCalls: [] };

  const strategies: [string, (t: string) => unknown[]][] = [
    ["fenced_json", extractFencedJson],
    ["tool_call_tag", extractTaggedJson],
    ["bare_json", extractBareJson],
  ];

  for (const [strategy, extract] of strategies) {
    const candidates = extract(text).slice(0, MAX_CANDIDATES);
    const calls: ToolCall[] = [];
    for (const candidate of candidates) {
      for (const parsed of interpretCandidate(candidate)) {
        const call = validateAgainstTools(parsed, tools, strategy, calls.length);
        if (call) calls.push(call);
      }
    }
    if (calls.length > 0) return { toolCalls: calls, strategy };
  }

  return { toolCalls: [] };
}

/**
 * Repair a tool call that arrived structurally but whose arguments would not parse.
 *
 * This is the OpenAI/Ollama case: `function.arguments` is a JSON **string**, and a weak model
 * produces one with a trailing comma, a single-quoted key, or the whole object double-encoded.
 * The name is already trustworthy here — only the arguments are in question — so this is a
 * narrower and safer repair than `salvageToolCalls`.
 */
export function repairArguments(
  raw: unknown,
  tool: ToolDefinition,
): { arguments: Record<string, unknown>; salvaged: boolean; strategy?: string } | null {
  // Already an object: Ollama hands back parsed arguments rather than a string.
  if (isRecord(raw)) {
    return { arguments: coerceToSchema(raw, tool.parameters), salvaged: false };
  }
  if (typeof raw !== "string") return null;

  const trimmed = raw.trim();
  // An empty argument object is legitimate for a no-argument tool.
  if (trimmed === "" || trimmed === "{}") return { arguments: {}, salvaged: false };

  const direct = tryParseJson(trimmed);
  if (isRecord(direct)) {
    return { arguments: coerceToSchema(direct, tool.parameters), salvaged: false };
  }

  // Double-encoded: the arguments string contains a JSON string containing the object.
  if (typeof direct === "string") {
    const inner = tryParseJson(direct);
    if (isRecord(inner)) {
      return { arguments: coerceToSchema(inner, tool.parameters), salvaged: true, strategy: "double_encoded" };
    }
  }

  const relaxed = tryParseJson(relaxJson(trimmed));
  if (isRecord(relaxed)) {
    return { arguments: coerceToSchema(relaxed, tool.parameters), salvaged: true, strategy: "relaxed_json" };
  }

  // Last resort: the arguments object embedded in surrounding prose.
  for (const candidate of extractBareJson(trimmed)) {
    if (isRecord(candidate)) {
      return { arguments: coerceToSchema(candidate, tool.parameters), salvaged: true, strategy: "embedded_object" };
    }
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* Extraction strategies                                                       */
/* -------------------------------------------------------------------------- */

/** ```json { … } ``` or a bare fenced block whose body parses. */
function extractFencedJson(text: string): unknown[] {
  const out: unknown[] = [];
  const fence = /```(?:json|tool_call|tool)?\s*\n?([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(text)) !== null) {
    const parsed = tryParseJson(match[1].trim()) ?? tryParseJson(relaxJson(match[1].trim()));
    if (parsed !== undefined) out.push(parsed);
  }
  return out;
}

/** `<tool_call>{…}</tool_call>`, the shape several open-weight chat templates emit. */
function extractTaggedJson(text: string): unknown[] {
  const out: unknown[] = [];
  const tagged = /<(tool_call|function_call|tool)>\s*([\s\S]*?)<\/\1>/gi;
  let match: RegExpExecArray | null;
  while ((match = tagged.exec(text)) !== null) {
    const body = match[2].trim();
    const parsed = tryParseJson(body) ?? tryParseJson(relaxJson(body));
    if (parsed !== undefined) out.push(parsed);
  }
  return out;
}

/**
 * Every balanced `{…}` region in the text, parsed if it can be.
 *
 * A brace scan rather than a regex because tool arguments nest, and a regex that handles nesting
 * is either wrong or unreadable. String-awareness matters too: a brace inside a description
 * (`"note": "closing balance {as of}"`) must not end the scan.
 */
function extractBareJson(text: string): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    const end = matchBrace(text, i);
    if (end < 0) continue;
    const slice = text.slice(i, end + 1);
    const parsed = tryParseJson(slice) ?? tryParseJson(relaxJson(slice));
    if (parsed !== undefined) {
      out.push(parsed);
      i = end; // don't re-scan the interior of an object we already took
    }
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

/** Index of the `}` closing the `{` at `start`, or -1. String- and escape-aware. */
function matchBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/* -------------------------------------------------------------------------- */
/* Interpretation + validation                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A candidate object may be a single call, a list of calls, or a wrapper around either — models
 * disagree about the envelope even when they agree about the content.
 */
function interpretCandidate(candidate: unknown): unknown[] {
  if (Array.isArray(candidate)) return candidate;
  if (!isRecord(candidate)) return [];
  for (const key of ["tool_calls", "toolCalls", "calls", "actions"]) {
    const nested = candidate[key];
    if (Array.isArray(nested)) return nested;
  }
  return [candidate];
}

/** The keys models use for the tool name and its arguments, in the order we prefer them. */
const NAME_KEYS = ["name", "tool", "tool_name", "function", "function_name", "recipient_name"];
const ARG_KEYS = ["arguments", "args", "input", "parameters", "params", "tool_input"];

/**
 * Turn one candidate into a `ToolCall`, or reject it.
 *
 * Rejects — deliberately, rather than guessing — when: the name is missing or names no offered
 * tool, the arguments are not an object, or a schema-required property has no value. Guessing any
 * of those turns a recoverable "I could not read that" into an executed call the model did not
 * make.
 */
function validateAgainstTools(
  candidate: unknown,
  tools: ToolDefinition[],
  strategy: string,
  index: number,
): ToolCall | null {
  if (!isRecord(candidate)) return null;

  let name: string | undefined;
  for (const key of NAME_KEYS) {
    const value = candidate[key];
    if (typeof value === "string" && value.length > 0) {
      name = value;
      break;
    }
    // OpenAI's own nesting: { function: { name, arguments } }.
    if (isRecord(value) && typeof value.name === "string") {
      name = value.name;
      break;
    }
  }
  if (!name) return null;

  const tool = tools.find((t) => t.name === name);
  if (!tool) return null;

  let rawArgs: unknown;
  for (const key of ARG_KEYS) {
    if (candidate[key] !== undefined) {
      rawArgs = candidate[key];
      break;
    }
  }
  // { function: { name, arguments } } again.
  if (rawArgs === undefined) {
    for (const key of NAME_KEYS) {
      const value = candidate[key];
      if (isRecord(value) && value.arguments !== undefined) {
        rawArgs = value.arguments;
        break;
      }
    }
  }
  // A no-argument tool legitimately emits nothing here.
  if (rawArgs === undefined) rawArgs = {};

  const repaired = repairArguments(rawArgs, tool);
  if (!repaired) return null;

  const required = (tool.parameters.required as string[] | undefined) ?? [];
  for (const key of required) {
    if (repaired.arguments[key] === undefined) return null;
  }

  return {
    id: `salvaged-${index}-${name}`,
    name,
    arguments: repaired.arguments,
    salvaged: true,
    salvageStrategy: repaired.strategy ? `${strategy}+${repaired.strategy}` : strategy,
  };
}

/* -------------------------------------------------------------------------- */
/* Coercion                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Coerce argument values toward what the schema declares, and drop what it does not declare.
 *
 * Weak models stringify numbers and booleans constantly (`{"limit": "50"}`), which a strict
 * consumer then rejects for a reason that has nothing to do with the model's intent. Coercion is
 * narrow on purpose: string→number only when the string is fully numeric, string→boolean only for
 * the four literal spellings. Anything ambiguous is left exactly as it came, so a real type error
 * still surfaces as one.
 *
 * Unknown keys are dropped rather than passed through, because the tools validate their own
 * arguments and a stray key is more likely a hallucinated parameter than a useful one.
 */
function coerceToSchema(
  args: Record<string, unknown>,
  schema: PlainJsonSchema,
): Record<string, unknown> {
  const properties = schema.properties as Record<string, PlainJsonSchema> | undefined;
  if (!properties) return args;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const propSchema = properties[key];
    if (!propSchema) continue; // not in the schema — drop it
    out[key] = coerceValue(value, propSchema);
  }
  return out;
}

function coerceValue(value: unknown, schema: PlainJsonSchema): unknown {
  const type = schemaType(schema);

  if (type === "number" || type === "integer") {
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
      const n = Number(value);
      return type === "integer" ? Math.trunc(n) : n;
    }
    return value;
  }

  if (type === "boolean") {
    if (typeof value === "string") {
      const v = value.trim().toLowerCase();
      if (v === "true") return true;
      if (v === "false") return false;
    }
    return value;
  }

  if (type === "array") {
    const items = schema.items as PlainJsonSchema | undefined;
    if (Array.isArray(value)) {
      return items ? value.map((v) => coerceValue(v, items)) : value;
    }
    // A single value where a list was asked for is a common weak-model slip and unambiguous.
    if (value !== undefined && value !== null) {
      return [items ? coerceValue(value, items) : value];
    }
    return value;
  }

  if (type === "object" && isRecord(value)) {
    return coerceToSchema(value, schema);
  }

  return value;
}

/** The declared type, collapsing zod's nullable `["string","null"]` / `anyOf` encodings. */
function schemaType(schema: PlainJsonSchema): string | undefined {
  const type = schema.type;
  if (typeof type === "string") return type;
  if (Array.isArray(type)) return (type as string[]).find((t) => t !== "null");
  const anyOf = schema.anyOf as PlainJsonSchema[] | undefined;
  if (Array.isArray(anyOf)) {
    const nonNull = anyOf.find((n) => n.type !== "null");
    if (nonNull) return schemaType(nonNull);
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Parsing helpers                                                             */
/* -------------------------------------------------------------------------- */

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Repair the three malformations that account for nearly all weak-model JSON: trailing commas,
 * single-quoted strings, and unquoted keys.
 *
 * Applied only AFTER strict parsing has failed, so well-formed JSON is never put through it —
 * these rewrites are string-level and could corrupt a valid document containing, say, an
 * apostrophe. `relaxJson` is a last resort by construction, not by convention.
 */
function relaxJson(text: string): string {
  let out = text;
  // Trailing commas before a closing brace/bracket.
  out = out.replace(/,(\s*[}\]])/g, "$1");
  // Unquoted object keys: { limit: 50 } → { "limit": 50 }.
  out = out.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3');
  // Single-quoted strings, when the text contains no double-quoted string at all (mixing the two
  // is far more likely to be prose containing an apostrophe than a single-quoted document).
  if (!out.includes('"') && out.includes("'")) {
    out = out.replace(/'([^']*)'/g, '"$1"');
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
