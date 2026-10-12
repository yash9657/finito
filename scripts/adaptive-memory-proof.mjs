/** Live synthetic acceptance proof. Requires a running local app and configured Fireworks.
 * Creates an isolated QA account/workspace, incurs model usage, and removes its own records.
 * Run: node scripts/adaptive-memory-proof.mjs
 * Optional FINFLOW_EVAL_SCREENSHOTS=1 captures the responsive workspace for visual review.
 */
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import * as XLSX from "xlsx";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import nextEnv from "@next/env";
nextEnv.loadEnvConfig(process.cwd());
const base = "http://localhost:3000";
const archivedAt = "2026-05-12T12:00:00.000Z";
const fail = (condition, message) => {
  if (!condition) throw new Error(message);
};
function policyPdf() {
  const lines = [
    "Synthetic policy. Amounts are USD.",
    "Variance means booked minus approved envelope.",
    "No exchange conversion is needed.",
  ];
  const stream = `BT /F1 12 Tf 50 740 Td 18 TL ${lines.map((line, i) => `${i ? "T* " : ""}(${line}) Tj`).join(" ")} ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let doc = "%PDF-1.4\n";
  const offsets = objects.map((object, i) => {
    const offset = Buffer.byteLength(doc);
    doc += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(doc);
  doc += `xref\n0 6\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(doc);
}
async function main() {
  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  );
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  let userId;
  let ownedOrg;
  const sources = [];
  const sourceRecords = new Map();
  const runs = [];
  async function api(route, method = "GET", data) {
    const res = await page.request.fetch(base + route, {
      method,
      data,
      timeout: 120000,
    });
    const body = await res.json();
    fail(res.ok(), `${method} ${route}: ${body.error ?? res.status()}`);
    return body;
  }
  async function ask(question, sourceIds = [], parentId, fullBudget = false) {
    const started = Date.now();
    const created = await api("/api/investigations", "POST", {
      question,
      sourceIds,
      parentId,
      budget: fullBudget
        ? { maxTurns: 20, maxTokens: 300000, maxWallClockMs: 300000 }
        : { maxTurns: 12, maxTokens: 80000, maxWallClockMs: 180000 },
    });
    runs.push(created.id);
    let detail;
    const end = Date.now() + (fullBudget ? 330000 : 210000);
    while (Date.now() < end) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      detail = await api(`/api/investigations/${created.id}`);
      if (detail.investigation.status !== "running") break;
    }
    const inv = detail?.investigation;
    const evidenceDir = path.join(process.cwd(), ".impeccable/review/proofs");
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(
      path.join(evidenceDir, `${created.id}.json`),
      JSON.stringify(detail, null, 2),
      { mode: 0o600 },
    );
    fail(
      inv?.status === "answered" && inv.answer && inv.answer.partial === false,
      `Question ${runs.length} did not complete: ${inv?.status}/${inv?.termination_reason}`,
    );
    const toolNames = [
      ...new Set(
        detail.events
          .filter((event) => event.event_type === "tool_called")
          .map((event) => event.payload.tool),
      ),
    ];
    const modelUsage = detail.events.filter(
      (event) => event.payload?.kind === "model_usage",
    );
    const calls = detail.events.filter((event) => event.event_type === "tool_called");
    const activated = [...new Set(calls.filter((event) => event.payload.tool === "load_historical_source")
      .flatMap((event) => event.payload.arguments?.sourceIds ?? [event.payload.arguments?.sourceId]))];
    const memoryContext = detail.events.find(
      (event) => event.payload?.memory_context,
    )?.payload.memory_context;
    if (memoryContext)
      fail(
        memoryContext.utf8_bytes <= 3000,
        "Automatic memory exceeded its aggregate byte budget.",
      );
    console.log(
      JSON.stringify({
        check: `live answer ${runs.length}`,
        proofId: created.id,
        status: inv.status,
        turns: inv.turns_used,
        tokens: inv.tokens_in + inv.tokens_out,
        inputTokens: inv.tokens_in,
        outputTokens: inv.tokens_out,
        modelCalls: modelUsage.length,
        finalizationCalls: modelUsage.filter(event => event.payload.step_key === "investigate_answer").length,
        models: [...new Set(modelUsage.map(event => event.model_used))],
        toolCalls: calls.length,
        activatedFiles: activated.map(id => sourceRecords.get(id)?.filename ?? "unknown source"),
        elapsedMs: Date.now() - started,
        tools: toolNames,
        memoryContext,
        cachedInputTokens:
          modelUsage.length &&
          modelUsage.every(
            (event) => typeof event.payload.cached_tokens_in === "number",
          )
            ? modelUsage.reduce(
                (total, event) => total + event.payload.cached_tokens_in,
                0,
              )
            : null,
      }),
    );
    return { ...detail, toolNames };
  }
  try {
    const email = `finflow-eval-${randomUUID()}@example.invalid`,
      password = `${randomUUID()}Aa1!`;
    const created = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (created.error) throw created.error;
    userId = created.data.user.id;
    const profile = await admin
      .from("profiles")
      .select("org_id")
      .eq("id", userId)
      .single();
    fail(
      profile.data?.org_id &&
        profile.data.org_id !== "00000000-0000-0000-0000-000000000001",
      "QA account did not get a private workspace; cleanup will not touch an existing workspace.",
    );
    ownedOrg = profile.data.org_id;
    await page.goto(`${base}/login`, {
      waitUntil: "networkidle",
      timeout: 120000,
    });
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page
      .getByRole("button", { name: "Sign in", exact: true })
      .last()
      .click();
    await page.waitForURL("**/dashboard", { timeout: 120000 });

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["Helios operating review — synthetic"],
        ["Amounts in USD; one entity"],
        [],
        ["Cost centre", "Booked", "Window"],
        ["Research", "1250.10", "2026-04"],
        ["Sales", "900.20", "2026-04"],
      ]),
      "Realized",
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["Owner unit", "Envelope", "Window"],
        ["Research", "1000.00", "2026-04"],
        ["Sales", "800.00", "2026-04"],
      ]),
      "Approved envelope",
    );
    const files = [
      [
        "helios-close.xlsx",
        XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }),
      ],
      [
        "helios-owners.json",
        Buffer.from(
          JSON.stringify({
            reportingCurrency: "USD",
            owners: [
              { unit: "Research", owner: "Maya" },
              { unit: "Sales", owner: "Leo" },
            ],
          }),
        ),
      ],
      ["helios-policy.pdf", policyPdf()],
      [
        "pipe-export.csv",
        Buffer.from(
          "Vendor code|Net booked|Status\n0019|10.49|open\n0020|20.50|closed\n",
        ),
      ],
    ];
    for (const [name, buffer] of files) {
      const response = await page.request.post(`${base}/api/data-sources`, {
        multipart: {
          file: { name, mimeType: "application/octet-stream", buffer },
        },
        timeout: 120000,
      });
      const body = await response.json();
      fail(response.ok(), `Upload ${name}: ${body.error}`);
      sources.push(body.source.id);
      sourceRecords.set(body.source.id, body.source);
      await api(
        `/api/data-sources/${body.source.id}?preview=1&tableId=t0&limit=2`,
      );
      console.log(`PASS upload, integrity and preview: ${name}`);
    }
    if (process.env.FINFLOW_EVAL_MODE === "history") {
      const id = randomUUID();
      const workflow = await admin.from("workflows").insert({
        id,
        org_id: ownedOrg,
        created_by: userId,
        type: "investigation",
        name: "Synthetic historical Helios question",
        status: "approved",
        created_at: archivedAt,
      });
      fail(!workflow.error, "Could not seed historical QA question workflow.");
      const historicalFixture = await admin.from("investigations").insert({
        workflow_id: id,
        org_id: ownedOrg,
        created_by: userId,
        question:
          "Review the Helios close workbook and identify the cost-centre owners.",
        status: "answered",
        conversation_id: id,
        source_ids: sources.slice(0, 3),
        budget: {},
        created_at: archivedAt,
        answer: {
          prose:
            "Synthetic prior context: we reviewed the Helios files. Reopen the original sources to determine the variances; this record is not a new calculation.",
          citations: [],
          figures: [],
          partial: false,
        },
      });
      fail(
        !historicalFixture.error,
        "Could not seed historical QA conversation.",
      );
      runs.push(id);
      console.log(
        "Seeded an explicitly synthetic historical question; no new-analysis or follow-up proof claimed in history-only mode.",
      );
    } else {
      const first = await ask(
        "For the Helios close, inspect the workbook, owners JSON and policy PDF. Join the two sheets by cost centre, calculate booked minus approved envelope using exact decimals, and identify each owner. Show a computed table, method and citations.",
        sources.slice(0, 3),
      );
      const output = JSON.stringify(
        first.investigation.answer.analyses?.map((analysis) => analysis.output),
      );
      fail(
        output?.includes("250.1") &&
          output.includes("100.2") &&
          output.includes("Maya") &&
          output.includes("Leo"),
        "Custom join/variance output did not match the golden values.",
      );
      const followup = await ask(
        "Which owner has the larger absolute variance? Recheck the rows, keep the answer concise, and explain what further evidence is needed to know why it happened.",
        sources.slice(0, 3),
        first.investigation.workflow_id,
      );
      fail(
        followup.investigation.answer.prose.includes("Maya") &&
          followup.investigation.parent_workflow_id ===
            first.investigation.workflow_id,
        "Follow-up lost the correct owner or conversation parent.",
      );
      console.log(
        "PASS unfamiliar-format calculation and context-aware follow-up",
      );
    }

    // Manufacture historical timestamps only in this throwaway workspace. No production
    // identity trigger is disabled: delete/reinsert the synthetic metadata, then reindex.
    for (const id of sources.slice(0, 3)) {
      const stored = await admin
        .from("data_sources")
        .select("*")
        .eq("org_id", ownedOrg)
        .eq("id", id)
        .single();
      fail(
        !stored.error,
        "Could not read synthetic source for historical fixture.",
      );
      const removed = await admin
        .from("data_sources")
        .delete()
        .eq("org_id", ownedOrg)
        .eq("id", id);
      fail(!removed.error, "Could not reset synthetic source timestamp.");
      const { memory_search: _generated, ...record } = stored.data;
      void _generated;
      const inserted = await admin.from("data_sources").insert({
        ...record,
        created_at: archivedAt,
        search_index_status: "pending",
        search_index_chunks: 0,
        search_indexed_at: null,
      });
      fail(
        !inserted.error,
        `Historical source fixture: ${inserted.error?.message}`,
      );
    }
    const aged = await admin
      .from("investigations")
      .update({ created_at: archivedAt })
      .eq("org_id", ownedOrg)
      .in("workflow_id", runs);
    fail(!aged.error, "Could not date synthetic question history.");
    await api("/api/memory/reindex", "POST", {
      sourceIds: sources.slice(0, 3),
    });
    const preference = await api("/api/memory/preferences", "POST", {
      content: "Use concise explanations with the key finding first.",
    });
    await api(`/api/memory/preferences/${preference.preference.id}`, "PATCH", {
      content:
        "Keep answers concise; state the key finding first and cite the source.",
    });
    const searched = await api(
      "/api/memory/search?q=Helios&until=2026-06-01T00%3A00%3A00Z&kinds=question,source",
    );
    fail(
      searched.results.some((hit) => hit.kind === "question") &&
        searched.results.some((hit) => hit.kind === "source"),
      "Date-scoped history search missed old questions or sources.",
    );
    const historical = await ask(
      "Revisit the Helios close we discussed in May 2026. Find the old workbook and owner mapping, reopen the sources, and recalculate which owner had the larger booked-minus-envelope variance. Do not rely on the old answer alone.",
      [],
      undefined,
      true,
    );
    fail(
      historical.toolNames.includes("load_historical_source") &&
        historical.toolNames.includes("run_analysis"),
      "Historical recall did not reopen and recompute the source.",
    );
    fail(
      historical.investigation.answer.prose.includes("Maya"),
      "Historical answer named the wrong owner.",
    );
    const analyses = historical.investigation.answer.analyses ?? [];
    function hasScalar(value, predicate) {
      if (predicate(value)) return true;
      if (Array.isArray(value)) return value.some(item => hasScalar(item, predicate));
      return value !== null && typeof value === "object" && Object.values(value).some(item => hasScalar(item, predicate));
    }
    fail(analyses.some(analysis =>
      hasScalar(analysis.output, value => value === "Maya") &&
      hasScalar(analysis.output, value => (typeof value === "number" || typeof value === "string" && /^\d+(\.\d+)?$/.test(value)) && Number(value) === 250.10)),
    "Historical analysis did not retain the expected owner and exact-decimal variance result.");
    fail(analyses.every(analysis => analysis.inputs.every(input =>
      sourceRecords.get(input.sourceId)?.sha256 === input.sha256)),
    "Historical analysis provenance differs from the uploaded original hashes.");
    console.log(
      "PASS five-month synthetic recall with no files selected, original-source reopening and fresh computation",
    );
    await api("/api/memory", "PATCH", { enabled: false });
    const off = await api("/api/memory");
    fail(off.enabled === false, "Memory toggle did not persist.");
    const manual = await api("/api/memory/search?q=Helios");
    fail(
      manual.results.length > 0,
      "Explicit history search stopped when automatic recall was disabled.",
    );
    await api("/api/memory", "PATCH", { enabled: true });
    await api(`/api/memory/preferences/${preference.preference.id}`, "DELETE");
    fail(
      !(await api("/api/memory")).preferences.some(
        (item) => item.id === preference.preference.id,
      ),
      "Deleted preference remained active.",
    );
    console.log("PASS preference create/edit/delete and recall toggle");
    const eventId = randomUUID();
    await api("/api/memory/events", "POST", {
      id: eventId,
      action: "page_view",
      route: "/settings/memory",
    });
    fail(
      (
        await api("/api/memory/events", "POST", {
          id: eventId,
          action: "page_view",
          route: "/settings/memory",
        })
      ).duplicate === true,
      "A retried page visit was not idempotent.",
    );
    const activity = await api("/api/memory/events?limit=100");
    fail(
      activity.events.some((event) => event.id === eventId),
      "A saved page visit was missing from personal activity.",
    );
    fail(
      !JSON.stringify(activity).includes("Keep answers concise"),
      "Interaction metadata duplicated private preference content.",
    );
    console.log(
      "PASS private interaction history, idempotent page visits and content minimization",
    );

    if (process.env.FINFLOW_EVAL_SCREENSHOTS === "1") {
      await api("/api/memory/preferences", "POST", {
        content:
          "Keep answers concise; start with the key finding and cite the source.",
      });
      const dir = path.join(process.cwd(), ".impeccable/review/adaptive");
      fs.mkdirSync(dir, { recursive: true });
      const routes = [
        ["data", `/data?source=${sources[0]}`],
        ["chat", "/investigations"],
        [
          "conversation",
          `/investigations/${historical.investigation.workflow_id}`,
        ],
        ["settings", "/settings"],
        ["models", "/settings/models"],
        ["controls", "/settings/approvals"],
        ["memory", "/settings/memory"],
        ["dashboard", "/dashboard"],
        ["new-workflow", "/workflows/new"],
      ];
      for (const width of [1440, 768, 390, 320])
        for (const [name, route] of routes) {
          await page.setViewportSize({ width, height: 1000 });
          const res = await page.goto(base + route, {
            waitUntil: "networkidle",
            timeout: 120000,
          });
          fail(res.status() === 200, `${name} returned ${res.status()}`);
          if (name === "memory") {
            await page
              .getByLabel("Search your history", { exact: true })
              .fill("Helios");
            await page
              .getByRole("button", { name: "Search history", exact: true })
              .click();
            await page
              .getByText(/matches? for “Helios”/)
              .waitFor({ timeout: 30000 });
            await page
              .getByText("Your recent activity", { exact: true })
              .click();
            await page
              .getByRole("button", {
                name: "Load recent activity",
                exact: true,
              })
              .click();
            await page
              .getByRole("button", { name: "Loading activity…", exact: true })
              .waitFor({ state: "hidden", timeout: 30000 });
          }
          await page.evaluate(() => {
            if (document.activeElement instanceof HTMLElement)
              document.activeElement.blur();
            window.scrollTo({ top: 0, behavior: "instant" });
          });
          await page.evaluate(() => new Promise((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(resolve));
          }));
          fail(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
            `${name} overflows at ${width}px`,
          );
          if (width === 1440 || width === 390)
            await page.screenshot({
              path: path.join(dir, `${name}-${width}.png`),
              fullPage: true,
            });
          console.log(`PASS responsive ${name} ${width}px`);
        }
      fail(
        browserErrors.length === 0,
        `Browser errors: ${browserErrors.join("; ")}`,
      );
    }
  } finally {
    if (ownedOrg) {
      const objects = await admin
        .from("data_sources")
        .select("storage_path")
        .eq("org_id", ownedOrg);
      if (objects.data?.length)
        await admin.storage
          .from("analysis-sources")
          .remove(objects.data.map((item) => item.storage_path));
      await admin.from("workflows").delete().eq("org_id", ownedOrg);
      await admin.from("data_sources").delete().eq("org_id", ownedOrg);
    }
    if (userId) await admin.auth.admin.deleteUser(userId);
    if (ownedOrg) await admin.from("organizations").delete().eq("id", ownedOrg);
    await browser.close();
    console.log("Synthetic account/workspace cleanup complete");
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
