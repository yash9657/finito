/**
 * Seed the demo org with ready-to-run workflows.
 *
 * FinFlow's agent reads whatever files the org has uploaded, so a fresh project can only answer
 * reconciliation questions — ask it about invoices and it correctly reports that there is no
 * invoice data. That is the right behaviour and a poor first experience, so this puts all six
 * demo files in place through exactly the path the upload route uses: the same Storage key
 * convention (`org/workflow/file_type/filename`), the same SHA-256, the same `workflow_files`
 * row shape. Nothing here is a shortcut around the app; it is the app's own upload, scripted.
 *
 * Creates three `idle` workflows — one per pipeline type — and deliberately does NOT run them,
 * so the run, the approval gate and the live view are all still yours to exercise.
 *
 * Usage:
 *   npx tsx scripts/seed-demo.ts          # create
 *   npx tsx scripts/seed-demo.ts --clean  # remove everything it created
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import type { FileType, WorkflowType } from "@/lib/types";

function loadEnvLocal(): void {
  let contents: string;
  try {
    contents = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
  } catch {
    return;
  }
  for (const line of contents.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[t.slice(0, eq).trim()] === undefined) process.env[t.slice(0, eq).trim()] = v;
  }
}
loadEnvLocal();

const BUCKET = "workflow-files";
const CLEAN = process.argv.includes("--clean");
/** Marks the rows this script owns, so --clean can find exactly them and nothing else. */
const TAG = "[demo seed]";

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const PLAN: { type: WorkflowType; name: string; files: { file: string; type: FileType }[] }[] = [
  {
    type: "reconciliation",
    name: `${TAG} Reconciliation — June 2026`,
    files: [
      { file: "erp_export_demo.csv", type: "erp_export" },
      { file: "bank_statement_demo.csv", type: "bank_statement" },
    ],
  },
  {
    type: "ap_matching",
    name: `${TAG} AP Matching — June 2026`,
    files: [
      { file: "purchase_orders_demo.csv", type: "po" },
      { file: "invoices_demo.csv", type: "invoice" },
    ],
  },
  {
    type: "fpa_commentary",
    name: `${TAG} FP&A Commentary — June 2026`,
    files: [
      { file: "budget_demo.csv", type: "budget" },
      { file: "actuals_demo.csv", type: "actuals" },
    ],
  },
];

async function main(): Promise<void> {
  const { data: org } = await db
    .from("organizations")
    .select("id, name")
    .limit(1)
    .maybeSingle<{ id: string; name: string }>();
  if (!org) throw new Error("No organization row found");

  if (CLEAN) {
    const { data: seeded } = await db
      .from("workflows")
      .select("id, name")
      .eq("org_id", org.id)
      .like("name", `${TAG}%`);
    for (const wf of seeded ?? []) {
      // Storage objects are not covered by the row cascade, so they go first.
      const { data: objects } = await db.storage.from(BUCKET).list(`${org.id}/${wf.id}`);
      for (const dir of objects ?? []) {
        const { data: files } = await db.storage.from(BUCKET).list(`${org.id}/${wf.id}/${dir.name}`);
        for (const f of files ?? []) {
          await db.storage.from(BUCKET).remove([`${org.id}/${wf.id}/${dir.name}/${f.name}`]);
        }
      }
      await db.from("workflows").delete().eq("id", wf.id);
      console.log(`  removed ${wf.name}`);
    }
    console.log(`\nRemoved ${(seeded ?? []).length} seeded workflow(s).`);
    return;
  }

  console.log(`\nSeeding demo data into "${org.name}"\n`);

  for (const spec of PLAN) {
    // Idempotent: re-running replaces rather than duplicating.
    const { data: existing } = await db
      .from("workflows")
      .select("id")
      .eq("org_id", org.id)
      .eq("name", spec.name)
      .maybeSingle<{ id: string }>();
    if (existing) {
      await db.from("workflows").delete().eq("id", existing.id);
    }

    const { data: workflow, error } = await db
      .from("workflows")
      .insert({ org_id: org.id, name: spec.name, type: spec.type, status: "idle" })
      .select("id")
      .single<{ id: string }>();
    if (error || !workflow) throw new Error(`Could not create ${spec.type}: ${error?.message}`);

    for (const { file, type } of spec.files) {
      const buffer = readFileSync(resolve(process.cwd(), "demo-data", file));
      const storagePath = `${org.id}/${workflow.id}/${type}/${file}`;

      const { error: uploadError } = await db.storage
        .from(BUCKET)
        .upload(storagePath, buffer, { upsert: true, contentType: "text/csv" });
      if (uploadError) throw new Error(`Storage upload failed: ${uploadError.message}`);

      const { error: rowError } = await db.from("workflow_files").insert({
        workflow_id: workflow.id,
        file_type: type,
        storage_path: storagePath,
        filename: file,
        size_bytes: buffer.byteLength,
        sha256: createHash("sha256").update(buffer).digest("hex"),
      });
      if (rowError) throw new Error(`Could not record ${file}: ${rowError.message}`);
    }

    console.log(
      `  ✓ ${spec.name}\n      ${spec.files.map((f) => f.type).join(" + ")} → /workflows/${workflow.id}`,
    );
  }

  console.log(
    `\nDone. Three workflows are ready to Run, and the investigator can now see all six\n` +
      `datasets. Undo with:  npx tsx scripts/seed-demo.ts --clean\n`,
  );
}

main().catch((err) => {
  console.error(`\nSeeding failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
