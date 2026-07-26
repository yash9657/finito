/**
 * The child process for the kill-and-resume proof (Plan 4, milestone H5).
 *
 * Starts a real reconciliation run on Mastra against durable Postgres snapshots, then waits to be
 * killed. It exists as a separate process because that is the only way to prove the thing the
 * brief asks for: the in-process tests can rewrite a snapshot to look post-crash, but only an
 * actual `SIGKILL` leaves one behind for real, with no chance to write a terminal status.
 *
 * Invoked by `scripts/harness-proof.ts`; not useful on its own.
 *
 * Usage: tsx scripts/harness-kill-child.ts <workflowId> <orgId> <runId>
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Mastra } from "@mastra/core";
import { PostgresStore } from "@mastra/pg";
import { parseFile } from "@/lib/csv/parser";
import { primeWorkflowFiles } from "@/lib/harness/inputs";
import { reconciliationHarnessWorkflow } from "@/lib/harness/workflows/reconciliation";

const [workflowId, orgId, runId] = process.argv.slice(2);
if (!workflowId || !orgId || !runId) {
  console.error("usage: tsx scripts/harness-kill-child.ts <workflowId> <orgId> <runId>");
  process.exit(2);
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is required for a durable snapshot store");
  process.exit(2);
}

// Read the demo files from disk and seed the loader cache, so the run needs no Storage objects.
const read = (name: string) => readFileSync(join(process.cwd(), "demo-data", name));
primeWorkflowFiles(workflowId, {
  erp_export: parseFile(read("erp_export_demo.csv"), "erp_export", {
    filename: "erp_export_demo.csv",
  }),
  bank_statement: parseFile(read("bank_statement_demo.csv"), "bank_statement", {
    filename: "bank_statement_demo.csv",
  }),
});

const mastra = new Mastra({
  storage: new PostgresStore({ id: "finito-harness-kill", connectionString }),
  workflows: { reconciliation: reconciliationHarnessWorkflow },
});

async function main(): Promise<void> {
  const workflow = mastra.getWorkflow("reconciliation");
  const run = await workflow.createRun({ runId });

  // The parent watches `harness_events` and kills this process once `match` starts — which is
  // both proof that the parallel parse steps' results are persisted, and a comfortable window,
  // since `match` is a real provider call taking seconds.
  console.log("CHILD_READY");

  const result = await run.start({ inputData: { workflowId, orgId } });

  // Reaching here means the parent was too slow to kill us. Say so plainly rather than
  // exiting 0 and letting the parent read that as a successful interruption.
  console.log(`CHILD_FINISHED_UNKILLED status=${result.status}`);
}

main().catch((err) => {
  console.error(`CHILD_ERROR ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
