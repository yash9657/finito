/**
 * Schema conversion for the provider layer (Plan 2 §2.2, D-P9).
 *
 * `toJsonSchema(zodSchema)` produces a plain JSON Schema once, router-side, so no
 * provider file ever imports zod. Our agent schemas are flat (PLAN.md §5.3): objects,
 * arrays, strings, numbers, booleans, and string enums only — no min/max/length, no
 * recursion — which keeps both this converter and the Gemini converter small.
 *
 * `toGeminiSchema(jsonSchema)` translates that plain schema into Gemini's OpenAPI-3
 * subset (uppercase `type`, `enum` on STRING, `nullable`), used by google.ts. If a
 * feature can't convert it falls back gracefully (the router's validate-retry loop and
 * the schema-in-prompt path are the real backstop).
 */

import { z } from "zod";

/** A plain JSON Schema object (the subset we emit). */
export type PlainJsonSchema = Record<string, unknown>;

/**
 * Convert a zod schema to a plain JSON Schema. Uses zod v4's built-in
 * `z.toJSONSchema` (the same primitive the Anthropic SDK's `zodOutputFormat` uses),
 * then strips the `$schema` dialect marker so the object embeds cleanly in every
 * provider's request body. All objects come out with `additionalProperties: false`
 * and every property in `required` (our schemas have no optionals), which is exactly
 * what OpenAI strict mode wants.
 */
export function toJsonSchema(schema: z.ZodType): PlainJsonSchema {
  const json = z.toJSONSchema(schema) as PlainJsonSchema;
  const { $schema: _drop, ...rest } = json as { $schema?: unknown };
  void _drop;
  return rest;
}

/** Gemini's OpenAPI-subset schema node. */
export interface GeminiSchema {
  type: string;
  format?: string;
  description?: string;
  nullable?: boolean;
  enum?: string[];
  items?: GeminiSchema;
  properties?: Record<string, GeminiSchema>;
  required?: string[];
}

/**
 * Translate a plain JSON Schema (as produced by `toJsonSchema`) into Gemini's schema
 * subset. Handles object / array / string (+ enum) / number / integer / boolean.
 * Unknown or unsupported nodes degrade to `{ type: 'STRING' }`; google.ts treats a
 * throw here as its cue to fall back to schema-in-prompt for that call (D-P9 / §9).
 */
export function toGeminiSchema(node: PlainJsonSchema): GeminiSchema {
  // Nullable fields come through zod v4 as anyOf:[{...}, {type:'null'}]. Collapse to the
  // non-null branch and mark it nullable.
  const anyOf = node.anyOf as PlainJsonSchema[] | undefined;
  if (Array.isArray(anyOf)) {
    const nonNull = anyOf.find((n) => n.type !== "null");
    const hasNull = anyOf.some((n) => n.type === "null");
    if (nonNull) {
      const single = toGeminiSchema(nonNull);
      if (hasNull) single.nullable = true;
      return single;
    }
  }

  const type = node.type;

  if (type === "object") {
    const props = (node.properties ?? {}) as Record<string, PlainJsonSchema>;
    const properties: Record<string, GeminiSchema> = {};
    for (const [key, value] of Object.entries(props)) {
      properties[key] = toGeminiSchema(value);
    }
    const out: GeminiSchema = { type: "OBJECT", properties };
    const required = node.required as string[] | undefined;
    if (Array.isArray(required) && required.length > 0) out.required = required;
    return out;
  }

  if (type === "array") {
    const items = (node.items ?? {}) as PlainJsonSchema;
    return { type: "ARRAY", items: toGeminiSchema(items) };
  }

  if (type === "string") {
    const out: GeminiSchema = { type: "STRING" };
    const enumValues = node.enum as unknown[] | undefined;
    if (Array.isArray(enumValues)) out.enum = enumValues.map(String);
    return out;
  }

  if (type === "number") return { type: "NUMBER" };
  if (type === "integer") return { type: "INTEGER" };
  if (type === "boolean") return { type: "BOOLEAN" };

  // Nullable unions (["string","null"]) and anything unrecognized: degrade to STRING.
  if (Array.isArray(type)) {
    const nonNull = (type as string[]).find((t) => t !== "null");
    if (nonNull) {
      const single = toGeminiSchema({ ...node, type: nonNull });
      if (type.includes("null")) single.nullable = true;
      return single;
    }
  }

  return { type: "STRING" };
}
