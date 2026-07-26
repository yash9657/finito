/**
 * Milestone H3 — the proof that the harness architecture works (Plan 4 §5).
 *
 * Runs three real reconciliation steps through `executeStep` against the LIVE Supabase
 * project and a REAL provider call, then verifies the event trail. Nothing here is mocked:
 * that is the entire point. The brief's instruction was to prove one trivial step
 * end-to-end before investing in the rest, and this is that gate.
 *
 * What it proves, in order of what could not be proven any other way:
 *
 *   1. **Gapless sequencing under real concurrency (D-H3).** `parse_erp` and `parse_bank`
 *      are launched with `Promise.all`, so two step lifecycles append to one workflow's
 *      stream simultaneously. The unit tests explicitly cannot cover this — a fake that
 *      allocates sequence numbers correctly only proves the fake does. Here the allocation
 *      is the plpgsql function under a real row lock.
 *   2. **A real model call lands on the trail with provider and model attributed.** The
 *      `match` step is an LLM step; it routes through `router.dispatch` and its events must
 *      carry `provider_used`/`model_used`.
 *   3. **The full lifecycle is emitted for every step**, deterministic and LLM alike.
 *   4. **No credential survives into the trail (D-H6)**, checked by scanning every stored
 *      payload for the live key's own characters.
 *
 * Usage:  npx tsx scripts/harness-proof.ts [--keep]
 *   --keep   leave the created workflow row behind for inspection in the UI
 *
 * Requires `.env.local` with NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and
 * ANTHROPIC_API_KEY, and migrations 004/005 applied.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { Mastra } from "@mastra/core";
import { PostgresStore } from "@mastra/pg";
import { parseFile } from "@/lib/csv/parser";
import { executeStep } from "@/lib/harness/loop";
import { readEvents, verifySequence } from "@/lib/harness/events";
import { primeWorkflowFiles } from "@/lib/harness/inputs";
import { reconciliationHarnessWorkflow } from "@/lib/harness/workflows/reconciliation";
import { workflowDefinitions } from "@/lib/agents/dag";
import type { HarnessEvent, ParsedFile } from "@/lib/types";

/* -------------------------------------------------------------------------- */
/* Setup                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Load `.env.local` into `process.env`.
 *
 * Next.js does this automatically; a standalone `tsx` script does not, and requiring callers to
 * remember `set -a && . ./.env.local` is a papercut that makes the documented command wrong.
 * Existing environment variables win, so an explicit override on the command line still applies.
 */
function loadEnvLocal(): void {
  let contents: string;
  try {
    contents = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
  } catch {
    return; // Fine — the variables may already be exported.
  }
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    // Values are taken verbatim apart from one layer of surrounding quotes — a Postgres URL
    // can contain '#' and '=', so this must not try to be clever about comments.
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

const db = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false },
});

const ok = (m: string) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m: string) => {
  console.log(`  \x1b[31m✗ ${m}\x1b[0m`);
  failures.push(m);
};
const failures: string[] = [];

/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  console.log("\n\x1b[1mH3 — harness proof (live Supabase + real provider call)\x1b[0m\n");

  /* ---- 0. Preconditions ------------------------------------------------- */
  console.log("Preconditions");

  const { error: tableError } = await db.from("harness_events").select("id").limit(1);
  if (tableError) {
    console.error(
      `\n\x1b[31mharness_events is not reachable: ${tableError.message}\x1b[0m\n\n` +
        `Apply the migrations first. Either:\n` +
        `  • merge supabase/migrations/004_harness_events.sql + 005_role_model_configs.sql\n` +
        `    to main — .github/workflows/supabase-migrations.yml applies them, or\n` +
        `  • psql "$DATABASE_URL" -f supabase/migrations/004_harness_events.sql \\\n` +
        `      -f supabase/migrations/005_role_model_configs.sql\n`,
    );
    process.exit(1);
  }
  ok("harness_events exists and is readable");

  const { data: org, error: orgError } = await db
    .from("organizations")
    .select("id, name")
    .limit(1)
    .maybeSingle<{ id: string; name: string }>();
  if (orgError || !org) throw new Error(`No organization row found: ${orgError?.message ?? "empty"}`);
  ok(`org "${org.name}"`);

  /* ---- 1. A workflow to hang the events off ----------------------------- */
  const { data: workflow, error: wfError } = await db
    .from("workflows")
    .insert({
      org_id: org.id,
      name: `H3 harness proof — ${new Date().toISOString()}`,
      type: "reconciliation",
      status: "running",
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single<{ id: string }>();
  if (wfError || !workflow) throw new Error(`Could not create workflow: ${wfError?.message}`);
  const workflowId = workflow.id;
  ok(`workflow ${workflowId}`);

  /* ---- 2. Real demo data, parsed from disk ------------------------------ */
  const files: Record<string, ParsedFile> = {
    erp_export: parseFile(
      readFileSync(resolve(process.cwd(), "demo-data/erp_export_demo.csv")),
      "erp_export",
      { filename: "erp_export_demo.csv" },
    ),
    bank_statement: parseFile(
      readFileSync(resolve(process.cwd(), "demo-data/bank_statement_demo.csv")),
      "bank_statement",
      { filename: "bank_statement_demo.csv" },
    ),
  };
  ok(
    `parsed ${files.erp_export.meta.rowCount} ERP rows + ` +
      `${files.bank_statement.meta.rowCount} bank rows`,
  );

  const defs = workflowDefinitions.reconciliation.steps;
  const stepDef = (key: string) => {
    const d = defs.find((s) => s.key === key);
    if (!d) throw new Error(`No step "${key}" in the reconciliation graph`);
    return d;
  };

  const base = {
    db,
    workflowId,
    orgId: org.id,
    workflowType: "reconciliation" as const,
    stepId: null,
    files,
  };

  /* ---- 3. Two deterministic steps, CONCURRENTLY ------------------------- */
  // The sequencing test the unit suite cannot do (D-H3).
  console.log("\nStep 1+2 — parse_erp ∥ parse_bank (concurrent, real Postgres sequencing)");

  const [erpOutcome, bankOutcome] = await Promise.all([
    executeStep({ ...base, def: stepDef("parse_erp"), priorOutputs: {} }),
    executeStep({ ...base, def: stepDef("parse_bank"), priorOutputs: {} }),
  ]);

  for (const [key, outcome] of [
    ["parse_erp", erpOutcome],
    ["parse_bank", bankOutcome],
  ] as const) {
    if (outcome.status === "completed") {
      ok(`${key}: ${outcome.observation.summary}`);
    } else {
      bad(`${key} did not complete: ${JSON.stringify(outcome)}`);
    }
  }
  if (erpOutcome.status !== "completed" || bankOutcome.status !== "completed") {
    await finish(workflowId);
    return;
  }

  /* ---- 4. An LLM step — a real provider call through dispatch ----------- */
  console.log("\nStep 3 — match (LLM step, matcher role, real provider call)");

  const matchOutcome = await executeStep({
    ...base,
    def: stepDef("match"),
    priorOutputs: {
      parse_erp: erpOutcome.output,
      parse_bank: bankOutcome.output,
    },
  });

  if (matchOutcome.status === "completed") {
    ok(`match: ${matchOutcome.observation.summary}`);
    ok(
      `via ${matchOutcome.llmMeta?.providerId ?? "?"} / ${matchOutcome.llmMeta?.modelUsed ?? "?"} ` +
        `(${matchOutcome.llmMeta?.tokensIn ?? 0} in, ${matchOutcome.llmMeta?.tokensOut ?? 0} out)`,
    );
  } else {
    bad(`match did not complete: ${JSON.stringify(matchOutcome).slice(0, 400)}`);
  }

  /* ---- 5. Verify the trail --------------------------------------------- */
  console.log("\nTrail verification");
  const events = await readEvents(db, workflowId);

  const sequence = verifySequence(events);
  if (sequence.intact) {
    ok(`${events.length} events, gapless 1..${events.length} despite concurrent appends`);
  } else {
    bad(`sequence broken: ${sequence.reason}`);
  }

  // Every step emitted the full lifecycle.
  const LIFECYCLE = [
    "step_started",
    "action_proposed",
    "action_verified",
    "action_executed",
    "observation_received",
    "step_completed",
  ];
  for (const key of ["parse_erp", "parse_bank", "match"]) {
    const forStep = events.filter((e) => e.step_key === key).map((e) => e.event_type);
    const missing = LIFECYCLE.filter((t) => !forStep.includes(t as HarnessEvent["event_type"]));
    if (missing.length === 0) ok(`${key} emitted the full lifecycle (${forStep.length} events)`);
    else bad(`${key} is missing: ${missing.join(", ")}`);
  }

  // Concurrency was real: the two parse steps interleaved rather than running back to back.
  const parseEvents = events.filter((e) => e.step_key === "parse_erp" || e.step_key === "parse_bank");
  let interleaved = false;
  for (let i = 1; i < parseEvents.length; i++) {
    if (parseEvents[i].step_key !== parseEvents[i - 1].step_key) {
      interleaved = true;
      break;
    }
  }
  if (interleaved) ok("the two parse steps genuinely interleaved in the stream");
  else
    console.log(
      "  \x1b[33m•\x1b[0m parse steps did not interleave this run — they are fast enough to " +
        "serialize; sequencing is still proven by the gapless check",
    );

  // Provenance: the LLM step's events name a provider and model; deterministic ones do not.
  const llmEvents = events.filter((e) => e.step_key === "match" && e.provider_used !== null);
  if (llmEvents.length > 0) {
    ok(
      `${llmEvents.length} match events attributed to ` +
        `${llmEvents[0].provider_used}/${llmEvents[0].model_used}`,
    );
  } else {
    bad("no match event carries provider_used — the model swap would be invisible in the trace");
  }

  const misattributed = events.filter(
    (e) => (e.step_key === "parse_erp" || e.step_key === "parse_bank") && e.provider_used !== null,
  );
  if (misattributed.length === 0) ok("deterministic steps carry no provider — usage stays accurate");
  else bad(`${misattributed.length} deterministic events claim a provider`);

  // input_hash present and consistent per step.
  const hashedSteps = new Set(events.filter((e) => e.input_hash).map((e) => e.step_key));
  if (hashedSteps.size === 3) ok("every step stamped an input hash");
  else bad(`only ${hashedSteps.size}/3 steps stamped an input hash`);

  /* ---- 6. No credential reached the trail (D-H6) ----------------------- */
  const key = env("ANTHROPIC_API_KEY");
  const serialized = JSON.stringify(events);
  // Check the key itself and its distinctive tail, so a partial leak is caught too.
  const leaked = serialized.includes(key) || serialized.includes(key.slice(-12));
  if (!leaked) ok("no API key material anywhere in the stored payloads");
  else bad("API KEY MATERIAL FOUND IN THE EVENT TRAIL");

  /* ---- 7. Print it ----------------------------------------------------- */
  console.log("\n\x1b[1mThe trail\x1b[0m");
  printTrail(events);

  /* ---- 8. Kill-and-resume, across a real process boundary -------------- */
  await killAndResumePhase();
  await finish(workflowId);
}

function printTrail(events: HarnessEvent[]): void {
  for (const e of events) {
    const model = e.model_used ? ` \x1b[2m[${e.provider_used}/${e.model_used}]\x1b[0m` : "";
    const seq = String(e.sequence_number).padStart(2, " ");
    console.log(
      `  ${seq}  \x1b[2m${(e.step_key ?? "—").padEnd(11)}\x1b[0m ` +
        `${e.event_type.padEnd(22)} \x1b[2m${e.actor}\x1b[0m${model}`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Phase 2 — kill a real process mid-workflow and resume it (H5)               */
/* -------------------------------------------------------------------------- */

/**
 * The brief's explicit requirement: "kills the process mid-workflow and confirms it resumes
 * correctly from the last completed step, not from zero."
 *
 * The in-process tests in `lib/harness/workflows/reconciliation.test.ts` can only REPRODUCE a
 * post-crash snapshot (they rewrite its status). This causes one. A child process starts a real
 * run against durable Postgres snapshots; this process watches the event stream, `SIGKILL`s the
 * child the moment `match` begins — which proves the parallel parse steps' results are already
 * persisted — and then restarts the run here. The parse steps must not execute a second time.
 */
async function killAndResumePhase(): Promise<void> {
  console.log("\n\x1b[1mPhase 2 — kill a real process mid-workflow, then resume\x1b[0m");

  if (!process.env.DATABASE_URL) {
    console.log(
      "  \x1b[33m•\x1b[0m skipped: DATABASE_URL is not set, so snapshots would not survive a " +
        "process boundary. This phase requires it.",
    );
    return;
  }

  const { data: org } = await db
    .from("organizations")
    .select("id")
    .limit(1)
    .maybeSingle<{ id: string }>();
  if (!org) {
    bad("phase 2: no organization row");
    return;
  }

  const { data: workflow } = await db
    .from("workflows")
    .insert({
      org_id: org.id,
      name: `H5 kill-and-resume — ${new Date().toISOString()}`,
      type: "reconciliation",
      status: "running",
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single<{ id: string }>();
  if (!workflow) {
    bad("phase 2: could not create workflow");
    return;
  }
  const workflowId = workflow.id;
  const runId = randomUUID();

  // `detached: true` puts the child in its own process GROUP, so it can be killed together with
  // everything it spawns. This matters and was a real bug: `npx tsx …` runs the actual work in a
  // grandchild, so signalling the immediate child only kills the wrapper — the orphan kept
  // running, kept writing events, and made a contaminated run look like a clean resume.
  const child = spawn(
    "npx",
    ["tsx", "scripts/harness-kill-child.ts", workflowId, org.id, runId],
    { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  let childOutput = "";
  child.stdout.on("data", (d: Buffer) => (childOutput += d.toString()));
  child.stderr.on("data", (d: Buffer) => (childOutput += d.toString()));

  const started = Date.now();
  const KILL_TIMEOUT_MS = 90_000;

  // Watch for `match` starting: it can only start after both parse steps persisted their results.
  let killed = false;
  while (Date.now() - started < KILL_TIMEOUT_MS) {
    const events = await readEvents(db, workflowId);
    const matchStarted = events.some(
      (e) => e.step_key === "match" && e.event_type === "step_started",
    );
    if (matchStarted) {
      killProcessGroup(child.pid);
      killed = true;
      break;
    }
    if (child.exitCode !== null) break;
    await sleep(150);
  }

  if (!killed) {
    bad(
      `phase 2: never reached the match step to kill (child said: ${childOutput.trim().slice(0, 200)})`,
    );
    await db.from("workflows").delete().eq("id", workflowId);
    return;
  }
  if (childOutput.includes("CHILD_FINISHED_UNKILLED")) {
    bad("phase 2: the child completed before it could be killed — nothing was interrupted");
    await db.from("workflows").delete().eq("id", workflowId);
    return;
  }
  ok(`killed the child process (SIGKILL) once "match" began`);

  // Confirm the stream has actually gone QUIET before resuming.
  //
  // This guard exists because its absence hid the process-group bug above: a surviving orphan
  // kept appending, two runs raced on one event stream, and the resume assertions passed for the
  // wrong reason. "Nothing new was written for a full second" is the observable that distinguishes
  // a dead process from one we merely stopped watching.
  let quiet = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    const before = (await readEvents(db, workflowId)).length;
    await sleep(1_000);
    const after = (await readEvents(db, workflowId)).length;
    if (before === after) {
      quiet = true;
      break;
    }
  }
  if (quiet) {
    ok("the event stream went quiet — the killed process is genuinely gone");
  } else {
    bad("phase 2: events kept arriving after the kill — a survivor is still writing");
    await db.from("workflows").delete().eq("id", workflowId);
    return;
  }

  const beforeResume = await readEvents(db, workflowId);
  const parseStartsBefore = beforeResume.filter(
    (e) =>
      (e.step_key === "parse_erp" || e.step_key === "parse_bank") &&
      e.event_type === "step_started",
  ).length;
  const parseCompletedBefore = beforeResume.filter(
    (e) =>
      (e.step_key === "parse_erp" || e.step_key === "parse_bank") &&
      e.event_type === "step_completed",
  ).length;
  if (parseStartsBefore === 2 && parseCompletedBefore === 2) {
    ok("both parse steps had completed before the kill");
  } else {
    bad(
      `phase 2: expected 2 parse starts + 2 completions before the kill, ` +
        `saw ${parseStartsBefore}/${parseCompletedBefore}`,
    );
  }

  // ---- Resume, in THIS process, from the snapshot the killed one left behind. ----
  const mastra = new Mastra({
    storage: new PostgresStore({
      id: "finito-harness-proof",
      connectionString: process.env.DATABASE_URL,
    }),
    workflows: { reconciliation: reconciliationHarnessWorkflow },
  });

  // The killed process wrote no terminal status, so the snapshot should still say `running` —
  // which is exactly the state `restart()` accepts, and what distinguishes a crash from a cancel.
  const store = await mastra.getStorage()?.getStore("workflows");
  const snapshot = await store?.loadWorkflowSnapshot({
    workflowName: "reconciliation",
    runId,
  });
  if (!snapshot) {
    bad("phase 2: no durable snapshot survived the kill");
    await db.from("workflows").delete().eq("id", workflowId);
    return;
  }
  ok(`snapshot survived the kill with status "${snapshot.status}"`);
  const persisted = Object.keys(snapshot.context ?? {});
  if (persisted.includes("parse_erp") && persisted.includes("parse_bank")) {
    ok(`snapshot carries the completed steps: ${persisted.join(", ")}`);
  } else {
    bad(`phase 2: snapshot is missing completed parse results (has: ${persisted.join(", ")})`);
  }

  // The demo files again — a fresh process has an empty loader cache.
  const read = (name: string) => readFileSync(resolve(process.cwd(), "demo-data", name));
  primeWorkflowFiles(workflowId, {
    erp_export: parseFile(read("erp_export_demo.csv"), "erp_export", {
      filename: "erp_export_demo.csv",
    }),
    bank_statement: parseFile(read("bank_statement_demo.csv"), "bank_statement", {
      filename: "bank_statement_demo.csv",
    }),
  });

  const resumedRun = await mastra.getWorkflow("reconciliation").createRun({ runId });
  const result = await resumedRun.restart();

  const afterResume = await readEvents(db, workflowId);
  const countStarts = (key: string) =>
    afterResume.filter((e) => e.step_key === key && e.event_type === "step_started").length;

  // ---- The assertion the brief asks for. ----
  if (countStarts("parse_erp") === 1 && countStarts("parse_bank") === 1) {
    ok("parse_erp and parse_bank did NOT re-run — resumed from the last completed step");
  } else {
    bad(
      `phase 2: parse steps re-ran (parse_erp ×${countStarts("parse_erp")}, ` +
        `parse_bank ×${countStarts("parse_bank")}) — this is resume-from-zero`,
    );
  }
  if (result.status === "success") {
    ok(`the resumed run completed (report ran ×${countStarts("report")})`);
  } else {
    bad(`phase 2: resumed run ended "${result.status}"`);
  }

  console.log("\n  \x1b[1mThe trail across the crash\x1b[0m");
  printTrail(afterResume);

  if (KEEP) {
    await db.from("workflows").update({ status: "awaiting_review" }).eq("id", workflowId);
    console.log(`\n  Kept kill-and-resume workflow ${workflowId} (--keep).`);
  } else {
    await db.from("workflows").delete().eq("id", workflowId);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * SIGKILL an entire process group.
 *
 * `process.kill(-pid)` signals the group rather than the single process, which is the only way to
 * take down `npx`'s grandchild along with it. Requires the child to have been spawned `detached`.
 */
function killProcessGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The group may already be gone; fall back to the single process.
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Nothing left to kill.
    }
  }
}

async function finish(workflowId: string): Promise<void> {
  if (KEEP) {
    await db.from("workflows").update({ status: "awaiting_review" }).eq("id", workflowId);
    console.log(`\nKept workflow ${workflowId} (--keep).`);
  } else {
    // Cascade removes the events with it.
    await db.from("workflows").delete().eq("id", workflowId);
    console.log(`\nCleaned up workflow ${workflowId}. Pass --keep to retain it.`);
  }

  if (failures.length > 0) {
    console.log(`\n\x1b[31m\x1b[1mH3 FAILED — ${failures.length} check(s):\x1b[0m`);
    for (const f of failures) console.log(`  • ${f}`);
    process.exit(1);
  }
  console.log("\n\x1b[32m\x1b[1mH3 PASSED\x1b[0m — the harness carries a real step end to end.\n");
}

main().catch((err) => {
  console.error(`\n\x1b[31mH3 crashed: ${err instanceof Error ? err.stack : String(err)}\x1b[0m`);
  process.exit(1);
});
