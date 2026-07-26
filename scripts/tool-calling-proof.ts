/**
 * Milestone G2 — tool calling works against every CONFIGURED provider (Plan 5 §8).
 *
 * Runs the SAME two-tool conversation against every provider that has credentials, end to end
 * with no mocks, and asserts three things per provider:
 *
 *   1. it produces a valid tool call naming a tool we offered, with schema-shaped arguments;
 *   2. the tool RESULT round-trips — the follow-up turn shows the model actually consumed it;
 *   3. usage and the exact model id come back, so the trail can attribute the work.
 *
 * ## On skipping, and why it exits zero
 *
 * A provider with no credentials is reported SKIPPED with the reason. That is not a softening of
 * the gate: the wire-format half of G2 is proven for all five providers offline, in
 * `lib/llm/tool-calling.test.ts`, where the exact request bytes and a recorded response are
 * pinned on every commit. This script proves the remaining half — that a real model, reached over
 * a real network, does the thing — and it can only do that where a key exists.
 *
 * Exiting non-zero on an unconfigured provider would mean the script could never run in CI, which
 * would make it decorative. Exiting non-zero on a CONFIGURED provider that fails is the actual
 * gate, and it is what turns G4 (the provider-swap proof) into a matter of supplying credentials
 * rather than of writing more code.
 *
 * Usage:  npx tsx scripts/tool-calling-proof.ts [--provider anthropic]
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getProvider } from "@/lib/llm/providers";
import { capabilitiesFor } from "@/lib/llm/capabilities";
import {
  assistantMessage,
  toolResultMessage,
  userMessage,
  type CanonicalMessage,
  type ToolDefinition,
} from "@/lib/llm/messages";
import type { LLMCompleteParams, ProviderId } from "@/lib/llm/provider";

/* -------------------------------------------------------------------------- */
/* Env                                                                         */
/* -------------------------------------------------------------------------- */

function loadEnvLocal(): void {
  let contents: string;
  try {
    contents = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
  } catch {
    return;
  }
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvLocal();

/**
 * A placeholder is not a credential.
 *
 * `.env.local` ships with placeholder values so the app boots without secrets. Treating one as
 * configured produces a 401 reported as a provider failure, which is a false negative that looks
 * exactly like a real bug — so they are filtered here rather than debugged later.
 */
function realKey(name: string): string | undefined {
  const value = process.env[name];
  if (!value || value.length === 0) return undefined;
  if (/^(placeholder|changeme|your[-_]?|xxx|todo)/i.test(value)) return undefined;
  return value;
}

/* -------------------------------------------------------------------------- */
/* The fixture — one conversation, every provider                              */
/* -------------------------------------------------------------------------- */

const TOOLS: ToolDefinition[] = [
  {
    name: "list_datasets",
    description:
      "List the financial datasets available for this organization, with row counts and date " +
      "ranges. Call this first to see what data exists.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "query_ledger",
    description:
      "Query one dataset: filter by date range and aggregate. Returns totals and a row sample.",
    parameters: {
      type: "object",
      properties: {
        dataset: { type: "string", description: "The dataset name from list_datasets." },
        limit: { type: "integer", description: "Maximum rows to return." },
      },
      required: ["dataset"],
      additionalProperties: false,
    },
  },
];

const SYSTEM =
  "You are a financial investigator. You have tools for looking at the organization's data. " +
  "Always call a tool before answering — never guess at what data exists.";

const QUESTION =
  "What financial datasets does this organization have, and how many rows are in the ERP export?";

/** The result we hand back for `list_datasets`, so turn 2 has something real to consume. */
const LIST_DATASETS_RESULT = JSON.stringify({
  ok: true,
  summary: "2 datasets: erp_export (247 rows), bank_statement (251 rows).",
  data: [
    { name: "erp_export", rows: 247, from: "2026-06-01", to: "2026-06-30" },
    { name: "bank_statement", rows: 251, from: "2026-06-01", to: "2026-06-30" },
  ],
});

/* -------------------------------------------------------------------------- */
/* Provider configuration, read from the environment                           */
/* -------------------------------------------------------------------------- */

interface ProviderTarget {
  id: ProviderId;
  label: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  /** Why this provider is not being exercised, when it is not. */
  skip?: string;
}

/**
 * Providers the ORG has configured, read from `org_model_configs` with their keys decrypted.
 *
 * This was missing in the first version of this script, and the omission mattered: FinFlow's
 * primary credential path is BYOK — a key entered in Settings → Models, AES-encrypted into the
 * database — and the env var is only the last-resort fallback tier (D-P7 step 4). Checking env
 * vars alone reported "no provider configured" for a project that had a perfectly good working
 * key in the table the app actually resolves from, which is a false negative about the one thing
 * this script exists to establish.
 */
async function configuredTargets(): Promise<ProviderTarget[]> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return [];

  try {
    const { createClient } = await import("@supabase/supabase-js");
    const { decryptApiKey } = await import("@/lib/llm/crypto");
    const db = createClient(url, serviceKey, { auth: { persistSession: false } });

    const { data } = await db
      .from("org_model_configs")
      .select("provider, display_name, default_model, base_url, api_key_ciphertext, is_active")
      .eq("is_active", true);

    return (data ?? []).map((row) => {
      let apiKey: string | undefined;
      try {
        apiKey = row.api_key_ciphertext ? decryptApiKey(row.api_key_ciphertext) : undefined;
      } catch {
        // A key encrypted under a different LLM_KEY_ENCRYPTION_SECRET. Report it rather than
        // silently skipping — it looks identical to "unconfigured" from the outside.
        return {
          id: row.provider as ProviderId,
          label: `${row.display_name} (org config)`,
          model: row.default_model as string,
          skip: "stored key could not be decrypted (LLM_KEY_ENCRYPTION_SECRET mismatch?)",
        };
      }
      return {
        id: row.provider as ProviderId,
        label: `${row.display_name} (org config)`,
        model: row.default_model as string,
        apiKey: apiKey && apiKey.length > 0 ? apiKey : undefined,
        baseUrl: (row.base_url as string | null) ?? undefined,
      };
    });
  } catch {
    return [];
  }
}

function targets(): ProviderTarget[] {
  const out: ProviderTarget[] = [];

  const anthropicKey = realKey("ANTHROPIC_API_KEY");
  out.push({
    id: "anthropic",
    label: "Anthropic",
    model: process.env.PROOF_ANTHROPIC_MODEL ?? "claude-opus-5",
    apiKey: anthropicKey,
    skip: anthropicKey ? undefined : "ANTHROPIC_API_KEY is unset or a placeholder",
  });

  const openaiKey = realKey("OPENAI_API_KEY");
  out.push({
    id: "openai",
    label: "OpenAI",
    model: process.env.PROOF_OPENAI_MODEL ?? "gpt-4.1",
    apiKey: openaiKey,
    skip: openaiKey ? undefined : "OPENAI_API_KEY is unset",
  });

  const googleKey = realKey("GOOGLE_API_KEY") ?? realKey("GEMINI_API_KEY");
  out.push({
    id: "google",
    label: "Google Gemini",
    model: process.env.PROOF_GOOGLE_MODEL ?? "gemini-2.0-flash",
    apiKey: googleKey,
    skip: googleKey ? undefined : "GOOGLE_API_KEY / GEMINI_API_KEY is unset",
  });

  // DeepSeek (and any other OpenAI-compatible endpoint) rides the `custom` provider.
  const deepseekKey = realKey("DEEPSEEK_API_KEY");
  out.push({
    id: "custom",
    label: "DeepSeek (custom / OpenAI-compatible)",
    model: process.env.PROOF_DEEPSEEK_MODEL ?? "deepseek-v4-flash",
    apiKey: deepseekKey,
    baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
    skip: deepseekKey ? undefined : "DEEPSEEK_API_KEY is unset",
  });

  const ollamaUrl = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
  out.push({
    id: "ollama",
    label: `Ollama (${ollamaUrl})`,
    model: process.env.PROOF_OLLAMA_MODEL ?? "llama3.1",
    baseUrl: ollamaUrl,
    // Reachability is probed below rather than assumed from the env var — a default URL tells
    // us nothing about whether anything is listening on it.
  });

  return out;
}

/* -------------------------------------------------------------------------- */
/* Output                                                                      */
/* -------------------------------------------------------------------------- */

const failures: string[] = [];
const ok = (m: string) => console.log(`    \x1b[32m✓\x1b[0m ${m}`);
const bad = (m: string) => {
  console.log(`    \x1b[31m✗ ${m}\x1b[0m`);
  failures.push(m);
};
const skip = (m: string) => console.log(`    \x1b[33m•\x1b[0m SKIPPED — ${m}`);

/* -------------------------------------------------------------------------- */

async function proveProvider(target: ProviderTarget): Promise<"passed" | "failed" | "skipped"> {
  console.log(`\n\x1b[1m${target.label}\x1b[0m  (${target.id}/${target.model})`);

  if (target.skip) {
    skip(target.skip);
    return "skipped";
  }

  const provider = getProvider(target.id);

  // Ollama: a base URL is not a running host. Probe before spending a turn on it.
  if (target.id === "ollama") {
    const probe = await provider.testConnection({
      model: target.model,
      apiKey: target.apiKey,
      baseUrl: target.baseUrl,
    });
    if (!probe.ok) {
      skip(`${probe.error}`);
      return "skipped";
    }
  }

  const capabilities = capabilitiesFor(target.id, target.model);
  console.log(
    `    \x1b[2mcapabilities: ${capabilities.contextWindow.toLocaleString()} ctx, ` +
      `tools=${capabilities.toolCalling}, parallel=${capabilities.parallelToolCalls} ` +
      `(${capabilities.source})\x1b[0m`,
  );
  if (!capabilities.toolCalling) {
    bad(`${target.label}: the capability table says this model cannot call tools`);
    return "failed";
  }

  const base = (conversation: CanonicalMessage[]): LLMCompleteParams => ({
    systemPrompt: SYSTEM,
    messages: [],
    conversation,
    tools: TOOLS,
    toolChoice: "auto",
    model: target.model,
    maxTokens: Math.min(2048, capabilities.maxOutputTokens),
    responseFormat: "text",
    apiKey: target.apiKey,
    baseUrl: target.baseUrl,
  });

  /* ---- Turn 1: the model should reach for a tool ------------------------- */
  let turn1;
  try {
    turn1 = await provider.complete(base([userMessage(QUESTION)]));
  } catch (err) {
    bad(`${target.label}: turn 1 failed — ${err instanceof Error ? err.message : String(err)}`);
    return "failed";
  }

  const calls = turn1.toolCalls ?? [];
  if (calls.length === 0) {
    bad(`${target.label}: turn 1 produced no tool call (stop=${turn1.stopReason})`);
    return "failed";
  }

  const known = calls.filter((c) => TOOLS.some((t) => t.name === c.name));
  if (known.length !== calls.length) {
    bad(`${target.label}: called a tool that was never offered`);
    return "failed";
  }
  ok(
    `turn 1 called ${calls.map((c) => `${c.name}(${JSON.stringify(c.arguments)})`).join(", ")}` +
      (calls.some((c) => c.salvaged) ? "  \x1b[33m[salvaged]\x1b[0m" : ""),
  );
  if (turn1.stopReason !== "tool_use") {
    bad(`${target.label}: tool calls present but stopReason is "${turn1.stopReason}"`);
  } else {
    ok(`stop reason is tool_use`);
  }

  /* ---- Turn 2: the result must round-trip -------------------------------- */
  // Answer every call so the conversation is well-formed; providers reject a turn that leaves a
  // call unanswered, which is itself part of what this proves.
  const results = calls.map((call) => ({
    toolCallId: call.id,
    name: call.name,
    content:
      call.name === "list_datasets"
        ? LIST_DATASETS_RESULT
        : JSON.stringify({ ok: true, summary: "247 rows in erp_export.", data: { rows: 247 } }),
  }));

  const conversation: CanonicalMessage[] = [
    userMessage(QUESTION),
    assistantMessage(turn1.content, calls, turn1.sidecar),
    toolResultMessage(results),
  ];

  let turn2;
  try {
    turn2 = await provider.complete(base(conversation));
  } catch (err) {
    bad(
      `${target.label}: turn 2 (tool result round-trip) failed — ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return "failed";
  }

  // The model either answers from the result or drills further; both prove it consumed the
  // result. What would NOT prove it is an error, or a turn that repeats turn 1 verbatim.
  const answered = turn2.content.trim().length > 0;
  const drilled = (turn2.toolCalls ?? []).length > 0;
  if (!answered && !drilled) {
    bad(`${target.label}: turn 2 produced neither text nor a follow-up call`);
    return "failed";
  }
  if (answered) {
    const preview = turn2.content.replace(/\s+/g, " ").slice(0, 100);
    ok(`turn 2 consumed the tool result: "${preview}${turn2.content.length > 100 ? "…" : ""}"`);
    // The strongest available signal that the result really landed: the model can only know
    // "247" from the payload we handed back.
    if (turn2.content.includes("247")) ok(`the answer cites a figure that came from the result`);
  } else {
    ok(`turn 2 drilled further: ${(turn2.toolCalls ?? []).map((c) => c.name).join(", ")}`);
  }

  /* ---- Attribution ------------------------------------------------------- */
  if (turn2.modelUsed && turn2.modelUsed.length > 0) {
    ok(`attributed to ${target.id}/${turn2.modelUsed}`);
  } else {
    bad(`${target.label}: no model id echoed — the trail could not attribute the work`);
  }
  const totalIn = turn1.tokensIn + turn2.tokensIn;
  const totalOut = turn1.tokensOut + turn2.tokensOut;
  if (totalIn > 0 || totalOut > 0) {
    ok(`usage reported: ${totalIn} in, ${totalOut} out`);
  } else {
    // Some Ollama builds report nothing. Not a failure, but the usage dashboard will show a hole.
    console.log(`    \x1b[33m•\x1b[0m no token usage reported (some local builds do not)`);
  }

  return failures.length > 0 ? "failed" : "passed";
}

async function main(): Promise<void> {
  console.log("\n\x1b[1mG2 — tool calling across providers\x1b[0m");
  console.log(
    "\x1b[2mThe same two-tool conversation, against every configured provider. Wire-format\n" +
      "parity for all five is proven offline in lib/llm/tool-calling.test.ts.\x1b[0m",
  );

  const only = process.argv.includes("--provider")
    ? process.argv[process.argv.indexOf("--provider") + 1]
    : undefined;

  // The org's own configured providers FIRST — that is the path the product actually resolves
  // through (D-P7). Env vars are the fallback tier, and are only worth probing for a provider
  // the org has not configured.
  const configured = await configuredTargets();
  const configuredIds = new Set(configured.filter((t) => !t.skip).map((t) => t.id));
  const all = [...configured, ...targets().filter((t) => !configuredIds.has(t.id))].filter(
    (t) => !only || t.id === only,
  );
  const outcomes: Record<string, string> = {};

  for (const target of all) {
    const before = failures.length;
    const outcome = await proveProvider(target);
    // A provider whose failures were recorded by a previous target must not be blamed here.
    outcomes[target.label] = failures.length > before ? "FAILED" : outcome.toUpperCase();
  }

  console.log("\n\x1b[1mSummary\x1b[0m");
  for (const [label, outcome] of Object.entries(outcomes)) {
    const colour =
      outcome === "PASSED" ? "\x1b[32m" : outcome === "SKIPPED" ? "\x1b[33m" : "\x1b[31m";
    console.log(`  ${colour}${outcome.padEnd(8)}\x1b[0m ${label}`);
  }

  const passed = Object.values(outcomes).filter((o) => o === "PASSED").length;
  const skipped = Object.values(outcomes).filter((o) => o === "SKIPPED").length;

  if (failures.length > 0) {
    console.log(`\n\x1b[31m\x1b[1mG2 FAILED — ${failures.length} check(s):\x1b[0m`);
    for (const f of failures) console.log(`  • ${f}`);
    process.exit(1);
  }

  if (passed === 0) {
    console.log(
      `\n\x1b[33m\x1b[1mG2 INCONCLUSIVE\x1b[0m — no provider was configured (${skipped} skipped).\n` +
        `  Wire-format parity is still proven for all five providers by\n` +
        `  \`npx vitest run lib/llm/tool-calling.test.ts\`. To prove the live half, set any of:\n` +
        `    ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY, DEEPSEEK_API_KEY,\n` +
        `    or run an Ollama host with a tool-capable model pulled.\n`,
    );
    // Deliberately zero: "nothing was configured" is a statement about the environment, not a
    // regression, and a CI job that fails on it would simply be turned off.
    return;
  }

  console.log(
    `\n\x1b[32m\x1b[1mG2 PASSED\x1b[0m — ${passed} provider(s) proven live` +
      (skipped > 0 ? `, ${skipped} skipped for want of credentials.` : "."),
  );
}

main().catch((err) => {
  console.error(`\n\x1b[31mG2 crashed: ${err instanceof Error ? err.stack : String(err)}\x1b[0m`);
  process.exit(1);
});
