/**
 * The Mastra instance (Plan 4 §4, D-H17).
 *
 * Mastra owns orchestration MECHANICS only: the DAG, concurrency, per-step retries, and
 * snapshotting for suspend/resume. It does not own history — `harness_events` does. Those are
 * two stores with one authority, stated deliberately:
 *
 *   - A Mastra snapshot is mutable execution state, versioned by Mastra, and exists so a run
 *     can pick up where it left off. It is a means.
 *   - `harness_events` is append-only, has no UPDATE grant, and is what an auditor reads. It
 *     is the record.
 *
 * Deriving the audit trail from a framework's checkpoint format would tie the thing FinFlow
 * sells to a dependency's internal schema, and would make "the trail is append-only" false
 * the moment that framework compacted a snapshot.
 *
 * ## Storage selection
 *
 * `PostgresStore` needs a direct Postgres connection string, which is NOT the Supabase REST
 * credential the rest of the app uses (D-H18). So:
 *
 *   - `DATABASE_URL` set  → PostgresStore. The only deployable configuration.
 *   - otherwise            → LibSQLStore against a local file, which is durable across a
 *                            process restart (so the kill-and-resume test is honest) but NOT
 *                            across serverless invocations. Development and tests only.
 *
 * The fallback logs a warning rather than throwing, because a missing DATABASE_URL must not
 * stop the test suite or a local dev server — but it is never silent, because a production
 * deploy running on a file-backed snapshot store would lose suspended runs.
 */

import { Mastra } from "@mastra/core";
import { PostgresStore } from "@mastra/pg";
import { LibSQLStore } from "@mastra/libsql";
import { reconciliationHarnessWorkflow } from "@/lib/harness/workflows/reconciliation";

/** Where LibSQL keeps snapshots when no DATABASE_URL is configured. */
const LOCAL_SNAPSHOT_URL = "file:.mastra/finito-snapshots.db";

function createStorage() {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString && connectionString.length > 0) {
    return new PostgresStore({ id: "finito-harness", connectionString });
  }

  // Not an error, but never silent — see the module note.
  if (process.env.NODE_ENV === "production") {
    console.warn(
      "[harness] DATABASE_URL is not set. Falling back to a file-backed LibSQL snapshot " +
        "store, which does NOT survive serverless invocations — suspended workflow runs " +
        "will be lost. Set DATABASE_URL to a Supabase pooler connection string.",
    );
  }
  return new LibSQLStore({ id: "finito-harness-local", url: LOCAL_SNAPSHOT_URL });
}

/** True when snapshots are durable enough to deploy on. Surfaced in health checks. */
export const hasDurableSnapshotStore = Boolean(
  process.env.DATABASE_URL && process.env.DATABASE_URL.length > 0,
);

export const mastra = new Mastra({
  storage: createStorage(),
  workflows: {
    reconciliation: reconciliationHarnessWorkflow,
  },
});
