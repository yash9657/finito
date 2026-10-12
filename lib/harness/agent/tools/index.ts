/**
 * The tool registry (Plan 5 §5, D-G20).
 *
 * Mirrors the shape `roles/index.ts` uses for action types, and for the same reason: a role's
 * capabilities should be a closed array someone can read, not an emergent property of which
 * modules happen to be imported where.
 *
 * `investigator` gets the read and isolated-analysis tools below. Every other role gets none —
 * no other role runs an agent loop; a parser has no turn in which to call a tool. A role
 * with an empty list cannot be started as an investigation at all, which is the fail-closed
 * default this table exists to provide.
 */

import { READ_TOOLS } from "@/lib/harness/agent/tools/read-tools";
import { SOURCE_TOOLS } from "@/lib/harness/agent/tools/source-tools";
import { MEMORY_TOOLS } from "@/lib/harness/agent/tools/memory-tools";
import { recommendAction } from "@/lib/harness/agent/tools/recommend-action";
import type { AgentTool } from "@/lib/harness/agent/tools/types";
import type { ToolDefinition } from "@/lib/llm/messages";
import type { StepRole } from "@/lib/types";

export const ALL_TOOLS: AgentTool[] = [...READ_TOOLS, ...SOURCE_TOOLS, ...MEMORY_TOOLS, recommendAction];

const BY_NAME = new Map(ALL_TOOLS.map((t) => [t.name, t]));

/**
 * The closed set of tools each role may reach.
 *
 * Read tools carry no risk class and are not action types (D-G1: reading is open-ended), so they
 * are constrained here rather than in `allowedActionTypes`. `recommend_action` appears in BOTH
 * tables — it needs tool access to be callable and action-type permission for what it proposes —
 * which is correct: it is the one place the two kinds of permission meet.
 */
export const ROLE_TOOLS: Record<StepRole, readonly string[]> = {
  parser: [],
  matcher: [],
  classifier: [],
  writer: [],
  investigator: ALL_TOOLS.map((t) => t.name),
};

/** The tools this role may use, as `AgentTool`s. Empty for a role that runs no loop. */
export function toolsForRole(role: StepRole): AgentTool[] {
  const allowed = new Set(ROLE_TOOLS[role]);
  return ALL_TOOLS.filter((t) => allowed.has(t.name));
}

/** The same set, as the provider-facing declarations `dispatchTools` sends. */
export function toolDefinitionsForRole(role: StepRole): ToolDefinition[] {
  return toolsForRole(role).map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

/**
 * Look up a tool a role is permitted to call.
 *
 * Returns null both for a tool that does not exist and for one this role may not reach — the
 * caller turns either into the same correctable message, because the distinction is meaningless
 * to the model and revealing it would describe a capability it cannot have.
 */
export function lookupTool(role: StepRole, name: string): AgentTool | null {
  if (!ROLE_TOOLS[role].includes(name)) return null;
  return BY_NAME.get(name) ?? null;
}

export { type AgentTool, type ToolContext, type ToolResultEnvelope } from "@/lib/harness/agent/tools/types";
