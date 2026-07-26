/**
 * Milestone G3/G6 — a real investigation, end to end, against LIVE Supabase (Plan 5 §8).
 *
 * What this proves that a unit test cannot:
 *
 *   1. The event trail is written by the real `append_harness_event` — gapless sequencing, and
 *      `caused_by` enforced by the database (a cross-workflow cause is rejected in SQL, not in
 *      TypeScript).
 *   2. `caused_by` genuinely pairs each `tool_returned` with its `tool_called`, including when a
 *      turn issues parallel calls — the case ordering alone cannot express.
 *   3. A recommendation reaches the SAME `action_requests` table the existing approval panel
 *      reads. No parallel queue (D-G21).
 *   4. The final answer's figures are recomputed from cited rows, and every citation resolves.
 *   5. Provider resolution works through the real router: an `org_role_configs` pin for the
 *      `investigator` role, with an AES-encrypted BYOK key, resolves and is used.
 *
 * ## The model
 *
 * `.env.local` holds no vendor credential, so this drives the loop with a LOCAL
 * OpenAI-compatible server that plays a scripted investigation, reached through the real `custom`
 * provider over real HTTP. That is a deliberate, stated substitution: it proves the harness, the
 * event stream, the approval path and the answer validator — everything FinFlow owns — while
 * proving nothing about any particular model's judgement. The model-facing half is covered by
 * `scripts/tool-calling-proof.ts` (live, per provider) and `lib/llm/tool-calling.test.ts` (wire
 * format, all five, every commit).
 *
 * Set PROOF_USE_CONFIGURED_PROVIDER=1 to skip the stub and run against whatever the org has
 * configured instead — which is what turns this into the G4 provider-swap proof.
 *
 * Usage:  npx tsx scripts/investigation-proof.ts [--keep]
 */

import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { encryptApiKey } from "@/lib/llm/crypto";
import { readEvents, verifySequence } from "@/lib/harness/events";
import { loadFixtureDatasets } from "@/lib/harness/agent/fixtures";
import { createInvestigation, executeInvestigation } from "@/lib/harness/agent/service";
import { resolveSourceIds } from "@/lib/harness/agent/datasets";
import type { HarnessEvent } from "@/lib/types";

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

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — populate .env.local`);
  return value;
}

const KEEP = process.argv.includes("--keep");
const USE_CONFIGURED = process.env.PROOF_USE_CONFIGURED_PROVIDER === "1";
const STUB_PORT = 8934;

const db = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false },
});

const failures: string[] = [];
const ok = (m: string) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m: string) => {
  console.log(`  \x1b[31m✗ ${m}\x1b[0m`);
  failures.push(m);
};
const note = (m: string) => console.log(`  \x1b[2m${m}\x1b[0m`);

/* -------------------------------------------------------------------------- */
/* The scripted provider                                                       */
/* -------------------------------------------------------------------------- */

const datasets = loadFixtureDatasets();
const invoiceRow = datasets.rows.find(
  (r) => r.dataset === "invoice" && (r.counterparty ?? "").includes("Meridian"),
)!;
const erpRows = datasets.rows.filter((r) => r.dataset === "erp_export").slice(0, 2);

/**
 * A local OpenAI-compatible endpoint that plays a fixed investigation:
 *
 *   turn 1  two PARALLEL tool calls (this is what exercises `caused_by`)
 *   turn 2  a recommendation
 *   turn 3  no tool calls — ready to answer
 *   turn 4  the cited answer
 */
function startStub(): Server {
  let turn = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      turn += 1;
      const reply = (message: Record<string, unknown>, finish: string) => ({
        model: "scripted-investigator",
        choices: [{ finish_reason: finish, message }],
        usage: { prompt_tokens: 400, completion_tokens: 60 },
      });

      let payload: unknown;
      if (turn === 1) {
        payload = reply(
          {
            role: "assistant",
            content: "Let me see what data exists and check the ERP totals.",
            tool_calls: [
              {
                id: "call_a",
                type: "function",
                function: { name: "list_datasets", arguments: "{}" },
              },
              {
                id: "call_b",
                type: "function",
                function: {
                  name: "query_ledger",
                  arguments: JSON.stringify({ datasets: ["erp_export"], groupBy: "period" }),
                },
              },
            ],
          },
          "tool_calls",
        );
      } else if (turn === 2) {
        payload = reply(
          {
            role: "assistant",
            content: "This invoice matches its PO exactly; I will recommend it for payment.",
            tool_calls: [
              {
                id: "call_c",
                type: "function",
                function: {
                  name: "recommend_action",
                  arguments: JSON.stringify({
                    actionType: "approve_invoice_payment",
                    sourceId: invoiceRow.sourceId,
                    summary: `Approve payment for ${invoiceRow.reference}`,
                    rationale:
                      "The invoice amount equals its purchase order and the vendor is established.",
                  }),
                },
              },
            ],
          },
          "tool_calls",
        );
      } else if (turn === 3) {
        payload = reply(
          { role: "assistant", content: "I have what I need." },
          "stop",
        );
      } else {
        payload = reply(
          {
            role: "assistant",
            content: JSON.stringify({
              prose:
                "The ERP export covers June 2026. The two largest entries total {{top_two}}, " +
                "and one invoice is ready for payment.",
              findings: [
                {
                  statement: "The two largest ERP entries dominate the month",
                  sourceIds: erpRows.map((r) => r.sourceId),
                },
              ],
              figures: [
                {
                  ref: "top_two",
                  label: "Two largest ERP entries",
                  operation: "sum",
                  sourceIds: erpRows.map((r) => r.sourceId),
                },
              ],
              citations: erpRows.map((r) => ({ sourceId: r.sourceId, note: r.description })),
            }),
          },
          "stop",
        );
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });
  server.listen(STUB_PORT);
  return server;
}

/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  console.log("\n\x1b[1mG3/G6 — a real investigation against live Supabase\x1b[0m\n");

  /* ---- Preconditions ---------------------------------------------------- */
  const { error: tableError } = await db.from("investigations").select("workflow_id").limit(1);
  if (tableError) {
    console.error(
      `\n\x1b[31minvestigations is not reachable: ${tableError.message}\x1b[0m\n\n` +
        `Apply supabase/migrations/007_agent_events.sql first.\n`,
    );
    process.exit(1);
  }
  ok("migration 007 is applied");

  const { data: org } = await db
    .from("organizations")
    .select("id, name")
    .limit(1)
    .maybeSingle<{ id: string; name: string }>();
  if (!org) throw new Error("No organization row found");
  ok(`org "${org.name}"`);

  /* ---- Point the investigator role at the scripted provider -------------- */
  let stub: Server | null = null;
  let configId: string | null = null;

  if (!USE_CONFIGURED) {
    stub = startStub();
    note(`scripted OpenAI-compatible provider on :${STUB_PORT} (see the module note)`);

    const { data: config, error } = await db
      .from("org_model_configs")
      .insert({
        org_id: org.id,
        provider: "custom",
        display_name: "Investigation proof (scripted)",
        // Encrypted with the real AES path, so BYOK decryption is exercised rather than skipped.
        api_key_ciphertext: encryptApiKey("proof-key-not-a-real-credential"),
        key_last4: "ceed",
        base_url: `http://localhost:${STUB_PORT}`,
        default_model: "deepseek-v4-flash",
        is_default: false,
        is_active: true,
      })
      .select("id")
      .single<{ id: string }>();
    if (error || !config) throw new Error(`Could not create provider config: ${error?.message}`);
    configId = config.id;

    // The tier-2 pin: this is the mechanism that makes "point the investigator at your own box"
    // work, so the proof uses it rather than the org default.
    const { error: pinError } = await db.from("org_role_configs").upsert({
      org_id: org.id,
      step_role: "investigator",
      assigned_provider_config_id: config.id,
    });
    if (pinError) throw new Error(`Could not pin the investigator role: ${pinError.message}`);
    ok("investigator role pinned to the scripted provider (org_role_configs, tier 2)");
  } else {
    note("PROOF_USE_CONFIGURED_PROVIDER=1 — using the org's configured provider");
  }

  /* ---- Run it ------------------------------------------------------------ */
  const question = "What does the ERP export cover, and is anything ready for payment?";
  const { workflowId, budget } = await createInvestigation({
    db,
    orgId: org.id,
    createdBy: null,
    question,
  });
  ok(`investigation ${workflowId} created (budget: ${budget.maxTurns} turns)`);

  const started = Date.now();
  const outcome = await executeInvestigation({
    db,
    workflowId,
    orgId: org.id,
    question,
    // Injected so the proof does not need files in Storage; dataset loading itself is covered by
    // the unit tests. Everything downstream of here is the real path.
    datasets,
  });
  const elapsed = Date.now() - started;

  console.log(
    `\n  status=${outcome.status} reason=${outcome.reason} turns=${outcome.turnsUsed} ` +
      `tokens=${outcome.tokensIn}/${outcome.tokensOut} in ${elapsed}ms\n`,
  );

  if (outcome.status === "answered") ok("the investigation answered");
  else bad(`the investigation did not answer: ${outcome.reason} — ${outcome.error ?? ""}`);

  /* ---- 1. The trail ------------------------------------------------------ */
  console.log("Trail");
  const events = await readEvents(db, workflowId);
  const sequence = verifySequence(events);
  if (sequence.intact) ok(`${events.length} events, gapless 1..${events.length}`);
  else bad(`sequence broken: ${sequence.reason}`);

  const types = new Set(events.map((e) => e.event_type));
  for (const required of [
    "agent_turn_started",
    "agent_reasoning",
    "tool_called",
    "tool_returned",
    "action_proposed",
    "agent_answered",
  ] as const) {
    if (types.has(required)) ok(`emitted ${required}`);
    else bad(`no ${required} event`);
  }

  /* ---- 2. caused_by pairs observations with actions (D-G9) --------------- */
  const called = events.filter((e) => e.event_type === "tool_called");
  const returned = events.filter((e) => e.event_type === "tool_returned");
  const byId = new Map(events.map((e) => [e.id, e]));

  let paired = 0;
  for (const ret of returned) {
    const cause = ret.caused_by ? byId.get(ret.caused_by) : undefined;
    if (!cause) {
      bad(`a tool_returned (seq ${ret.sequence_number}) has no resolvable caused_by`);
      continue;
    }
    if (cause.event_type !== "tool_called") {
      bad(`tool_returned seq ${ret.sequence_number} cites a ${cause.event_type}`);
      continue;
    }
    const a = (cause.payload as { tool_call_id?: string }).tool_call_id;
    const b = (ret.payload as { tool_call_id?: string }).tool_call_id;
    if (a !== b) {
      bad(`tool_returned seq ${ret.sequence_number} is paired with the WRONG call (${a} vs ${b})`);
      continue;
    }
    paired++;
  }
  if (paired === returned.length && returned.length > 0) {
    ok(`all ${paired} observations pair with their action via caused_by`);
  }

  // The case ordering cannot express: two calls in ONE turn.
  const turn1Calls = called.filter((e) => e.turn_number === 1);
  if (turn1Calls.length >= 2) {
    ok(`turn 1 issued ${turn1Calls.length} parallel calls, each separately paired`);
  } else {
    bad(`expected parallel calls on turn 1, saw ${turn1Calls.length}`);
  }

  // And the DB itself refuses a cross-workflow cause.
  const { error: crossError } = await db.rpc("append_harness_event", {
    p_workflow_id: workflowId,
    p_event_type: "tool_returned",
    p_actor: "system",
    p_caused_by: "00000000-0000-0000-0000-0000000000ff",
  });
  if (crossError) ok("the database rejects a caused_by from another workflow");
  else bad("a cross-workflow caused_by was ACCEPTED — the linkage is not enforced");

  /* ---- 3. The recommendation reached the approval queue (D-G21) ---------- */
  console.log("\nRecommendations");
  const { data: actions } = await db
    .from("action_requests")
    .select("action_type, status, amount_cents, counterparty, summary")
    .eq("workflow_id", workflowId);

  if ((actions ?? []).length > 0) {
    const action = actions![0];
    ok(`queued in action_requests: ${action.action_type} → ${action.status}`);
    if (action.amount_cents === invoiceRow.amountCents) {
      ok(`the amount came from the source row (${action.amount_cents}c), not from the model`);
    } else {
      bad(`amount ${action.amount_cents}c does not match the row's ${invoiceRow.amountCents}c`);
    }
  } else if (!USE_CONFIGURED) {
    bad("no recommendation reached action_requests");
  } else {
    note("no recommendation this run (the configured model chose not to make one)");
  }

  /* ---- 4. The answer's numbers are recomputed and cited ------------------ */
  console.log("\nAnswer");
  if (outcome.answer) {
    const { unresolved } = resolveSourceIds(
      datasets.rows,
      outcome.answer.citations.map((c) => c.sourceId),
    );
    if (unresolved.length === 0) ok(`all ${outcome.answer.citations.length} citations resolve`);
    else bad(`${unresolved.length} citation(s) do not resolve: ${unresolved.join(", ")}`);

    for (const figure of outcome.answer.figures) {
      const { resolved } = resolveSourceIds(datasets.rows, figure.sourceIds);
      const expected =
        figure.operation === "count"
          ? resolved.length
          : resolved.reduce((s, r) => s + r.amountCents, 0);
      const actual = figure.operation === "count" ? figure.value : figure.valueCents;
      if (actual === expected) {
        ok(`figure "${figure.ref}" = ${actual} recomputed from ${figure.sourceIds.length} row(s)`);
      } else {
        bad(`figure "${figure.ref}" is ${actual}, recomputation says ${expected}`);
      }
    }

    // The placeholder must be gone, replaced by a code-computed value.
    if (!/\{\{[a-z_]+\}\}/i.test(outcome.answer.prose)) {
      ok("every placeholder was substituted with a computed figure");
    } else {
      bad("an unsubstituted placeholder survived into the answer");
    }
    console.log(`\n  \x1b[1mAnswer:\x1b[0m ${outcome.answer.prose}\n`);
  } else {
    bad("no answer was produced");
  }

  /* ---- 5. Attribution ---------------------------------------------------- */
  const attributed = events.filter((e) => e.provider_used !== null);
  if (attributed.length > 0) {
    ok(
      `${attributed.length} events attributed to ` +
        `${attributed[0].provider_used}/${attributed[0].model_used}`,
    );
  } else {
    bad("no event carries a provider — the model swap would be invisible in the trace");
  }

  // Token counts must be readable — they were silently redacted before Plan 5 fixed the
  // over-broad denylist, which made the usage dashboard impossible.
  const terminal = events.find(
    (e) => e.event_type === "agent_answered" || e.event_type === "agent_terminated",
  );
  const storedTokens = (terminal?.payload as { tokens_in?: unknown })?.tokens_in;
  if (typeof storedTokens === "number") ok(`token counts stored as numbers (${storedTokens} in)`);
  else bad(`token counts are not readable on the trail (got ${JSON.stringify(storedTokens)})`);

  /* ---- The trail, printed ------------------------------------------------ */
  console.log("\n\x1b[1mThe trail\x1b[0m");
  printTrail(events);

  /* ---- Cleanup ----------------------------------------------------------- */
  stub?.close();
  if (configId) {
    await db.from("org_role_configs").delete().eq("org_id", org.id).eq("step_role", "investigator");
    await db.from("org_model_configs").delete().eq("id", configId);
  }
  if (KEEP) {
    console.log(`\nKept investigation ${workflowId} (--keep).`);
  } else {
    // Cascades the events, the investigation row and the action requests.
    await db.from("workflows").delete().eq("id", workflowId);
    console.log(`\nCleaned up ${workflowId}. Pass --keep to retain it.`);
  }

  if (failures.length > 0) {
    console.log(`\n\x1b[31m\x1b[1mFAILED — ${failures.length} check(s):\x1b[0m`);
    for (const f of failures) console.log(`  • ${f}`);
    process.exit(1);
  }
  console.log("\n\x1b[32m\x1b[1mPASSED\x1b[0m — a real investigation, end to end.\n");
}

function printTrail(events: HarnessEvent[]): void {
  for (const e of events) {
    const seq = String(e.sequence_number).padStart(3, " ");
    const turn = e.turn_number === null ? "  " : `T${e.turn_number}`;
    const cause = e.caused_by ? " \x1b[2m←\x1b[0m" : "  ";
    const model = e.model_used ? ` \x1b[2m[${e.provider_used}/${e.model_used}]\x1b[0m` : "";
    const detail = describeEvent(e);
    console.log(
      `  ${seq} ${turn}${cause} ${e.event_type.padEnd(24)} \x1b[2m${e.actor}\x1b[0m${model} ${detail}`,
    );
  }
}

function describeEvent(e: HarnessEvent): string {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  if (e.event_type === "tool_called") return `\x1b[36m${String(p.tool)}\x1b[0m`;
  if (e.event_type === "tool_returned") {
    return `\x1b[2m${String(p.summary ?? "").slice(0, 70)}\x1b[0m`;
  }
  if (e.event_type === "agent_reasoning") {
    return `\x1b[2m${String(p.text ?? "").slice(0, 70)}\x1b[0m`;
  }
  if (e.event_type === "action_proposed") return `\x1b[33m${String(p.action_type)}\x1b[0m`;
  if (e.event_type === "agent_answered" || e.event_type === "agent_terminated") {
    return `\x1b[2m${String(p.reason)}\x1b[0m`;
  }
  return "";
}

main().catch((err) => {
  console.error(`\n\x1b[31mCrashed: ${err instanceof Error ? err.stack : String(err)}\x1b[0m`);
  process.exit(1);
});
