# FinFlow — Handoff (competitive-edge build plan)

> Written at the end of a session so a **fresh session with zero prior context** can pick up.
> Read this top-to-bottom first. It captures (a) where the project stands, (b) a competitive
> analysis vs. Andrew Ng's OpenWorker harness, and (c) a ranked, concretely-scoped build plan
> for the features that turn "trustworthy finance output" into a real moat.
>
> **UPDATE (session 2):** Edges **#1, #3 and #4 are BUILT** — see `PLAN-3.md` (locked decisions
> D-A1–D-A16, milestones A0–A6, all committed and green: typecheck + build + 150 vitest tests).
> §3 below is preserved as the original analysis; read §1.1 for what changed and what is left.
> **Remaining, in order: Edge #2 (typed learned rules — the durable moat), then Edge #5
> (provider polish).** One operational prerequisite before anything runs live:
> **apply `supabase/migrations/003_approvals.sql`** to the Supabase project (see §1.1).

---

## 0. What this project is (30-second orientation)

FinFlow is a **vertical, deterministic finance-workflow agent platform**. Three workflows —
**reconciliation** (flagship), **AP invoice↔PO matching**, **FP&A budget-vs-actual commentary**.
Core discipline (PLAN.md **D3**): **all arithmetic/matching runs in TypeScript; the LLM only
adjudicates ambiguity and writes prose; every ID the model returns is validated against source
data; every number is recomputed in code.** This correctness layer is our differentiator — do
not dilute it.

Two execution plans already shipped:
- `PLAN.md` — original M0–M9 app (auth, upload, workflows, review gate, report, audit certificate).
- `PLAN-2.md` — multi-provider LLM layer + DAG orchestrator (this is fully implemented; see §1).

Stack: Next.js 15 (App Router, Turbopack) · React 19 · TypeScript · Tailwind v4 · Supabase
(Postgres + Auth + Storage, RLS) · Zod · `@anthropic-ai/sdk` (other providers are raw `fetch`).
Tests: Vitest (79 passing). Dark theme only.

---

## 1. Current state (as of this handoff)

- **Branch/remote:** everything is committed on `main`, pushed to **`github.com/yash9657/finito`**
  (private). Working tree clean. Last commits: N0–N6 (Plan 2) + two UI passes.
- **Plan 2 is DONE and green:** `npm run typecheck && npm run build && npm test` all pass (79 tests).
- **Supabase backend is DEPLOYED** to project `lveaycbnqnphgbszrogn` (URL
  `https://lveaycbnqnphgbszrogn.supabase.co`). Both migrations applied via `psql`
  (`001_init.sql`, `002_llm_providers.sql`); tables verified, Demo Org seeded, `workflow-files`
  bucket private, RLS on (config tables have **no** SELECT policy by design — D-P3).
- **`.env.local`** (gitignored) is populated for that project: `NEXT_PUBLIC_SUPABASE_URL`,
  `NEXT_PUBLIC_SUPABASE_ANON_KEY` (publishable key), `SUPABASE_SERVICE_ROLE_KEY` (`sb_secret_…`),
  `LLM_KEY_ENCRYPTION_SECRET` (generated), `ANTHROPIC_API_KEY`.
- **Dev server:** run `npm run dev -- -p 3000` → http://localhost:3000.
- ⚠️ **Security debt:** the Supabase DB password and secret API key were pasted into the prior
  chat. Rotate both (Dashboard → Database → reset password; API Keys → roll secret) and re-set
  `.env.local` before this holds anything real.

### Plan 2 architecture already in place (know these before building)
- `lib/llm/router.ts` — `resolveProvider(db,{orgId,workflowType,stepKey})` implements provider
  resolution order **D-P7**: per-step pin → org default → env-var Anthropic fallback → throw.
  `invoke<T>()` is the provider-agnostic call: build JSON schema once, call provider, `JSON.parse`
  + `zod.safeParse`, one corrective retry. Keys are decrypted in-memory only.
- `lib/llm/provider.ts` + `lib/llm/providers/*` — transport-only providers (anthropic via SDK;
  openai/google/ollama/custom via `fetch`). `withTransportRetry` = 429/5xx only.
- `lib/llm/crypto.ts` — AES-256-GCM key encryption (D-P2), keyed off `LLM_KEY_ENCRYPTION_SECRET`.
- `lib/agents/dag.ts` — three workflow graphs (`DagStepDefinition[]`) + `validateDag` (cycle/dup/
  unknown-dep) + `llmStepsForMatrix()`.
- `lib/agents/orchestrator.ts` — **DAG executor (D-P6)**: ready-set scheduling, concurrent waves,
  3 attempts w/ 1s/4s backoff, **pause-on-error with siblings persisted**, resume resets errored
  steps. Persists provenance per step (provider/model/tokens/latency/redacted raw).
- `lib/agents/{reconciliation,ap-matching,fpa-commentary}.ts` — step `run()` bodies; call
  `ctx.llm({system,user,schema})`; prompts are tested product surface (don't casually rewrite).
- `lib/types.ts` — single source of truth (StepContext, DagStepDefinition, all zod schemas,
  DB row types incl. `OrgModelConfig`, `WorkflowStep` with provenance columns).
- `app/api/llm/*` — config CRUD, `/test`, `/step-configs`, `/usage`.
- `app/(app)/settings/models/` + `components/settings/*` — provider config UI.
- Review gate: `components/workflow/ReviewBanner.tsx` + `app/api/workflows/[id]/review/route.ts`
  — **currently a single coarse end-of-run approve/reject.** This is what §3 Edge #1 replaces.
- Audit: `lib/audit.ts` (`writeAudit`, `sha256Json`) → `audit_log` table (workflow-scoped,
  `workflow_id NOT NULL`). Audit certificate UI: `components/workflow/AuditTrail.tsx`;
  Excel: `lib/excel/writer.ts`.

---

## 1.1 What session 2 built (Plan 3 — Edges #1 + #3 + #4)

`PLAN-3.md` is the plan; it was followed milestone by milestone with one commit each. The
shape of it:

- **`lib/approvals/`** is the new layer. `risk.ts` — the finance risk taxonomy as a **data
  table** (`read | writes_ledger | moves_money | external_filing`). `engine.ts` — pure
  `evaluateAction()` in a fixed order **ceilings → rules → human**, plus
  `validateRuleInput()`. `service.ts` — persistence: idempotent proposal by
  `(workflow_id, action_key)`, resolve-exactly-once via a conditional UPDATE,
  `reevaluatePending`, commit bookkeeping. `action-types.ts` — the action-type registry.
  `report.ts` — the authorization-chain presentation helpers shared by the certificate and
  the workbook.
- **Orchestrator gate.** A step declaring a non-`read` risk proposes its consequential
  actions deterministically (`proposeActions(ctx)`), they are evaluated + persisted, and the
  step either **suspends** (`awaiting_approval` on both step and workflow, nothing
  committed, `error_message` null — suspension is a third outcome, not failure) or runs with
  `ctx.approvals` and commits only what is authorized. Resume is the same idempotent
  `runWorkflow`; `awaiting_approval` steps reset to `pending` on entry.
- **AP is wired.** `approval_queue` is `risk: 'moves_money'` and proposes one
  `approve_invoice_payment` per payable invoice. `splitApprovalQueue()` is shared by the
  proposal and the commit so they cannot diverge. **Every prompt string is byte-identical.**
- **Routes/UI.** `POST /api/workflows/[id]/approvals` (decide + optional tiered grant +
  auto-resume), `GET|PUT /api/approvals/policy`, `GET|POST /api/approvals/rules`,
  `DELETE /api/approvals/rules/[id]`; `/status` gained `actions`.
  `components/workflow/ApprovalPanel.tsx` + `/settings/approvals` (ceilings, allowlist,
  four-eyes, standing rules).
- **Audit (Edge #4).** `action_proposed → approval_requested → action_auto_approved /
  approval_resolved / action_denied_by_ceiling → action_committed | action_withheld`, plus
  `workflow_suspended`/`workflow_resumed`/`standing_rule_minted`. Rendered as the
  "Authorization chain" in `AuditTrail.tsx` and an **Authorization** sheet in the workbook,
  with the certificate footer counting authorized-by-rule vs by-reviewer vs denied.
- **Tests.** 150 total. Notably `lib/agents/ap-gate.e2e.test.ts` walks the whole story
  against the **real** AP graph + orchestrator + engine and the committed demo CSVs (only
  Supabase and the LLM transport are faked): fresh org suspends → approve one + mint a
  bounded standing rule → covered payments auto-clear → approve the rest → run completes
  with only authorized payments committed; and a hard ceiling denies un-overridably while
  the run still finishes.

### ⚠️ Not yet verified live (the PLAN-3 §8 human checkpoint)

1. **`supabase/migrations/003_approvals.sql` has NOT been applied** to project
   `lveaycbnqnphgbszrogn` — verified over the REST API: `organizations` and
   `org_model_configs` answer 200, while `action_requests` / `approval_rules` /
   `org_approval_policies` 404. Until it is applied every approval query fails on missing
   tables. It also widens the `workflows` / `workflow_steps` status check constraints.

   Migrations now deploy from CI —
   [`.github/workflows/supabase-migrations.yml`](./.github/workflows/supabase-migrations.yml)
   runs `supabase db push` on merges to `main` touching `supabase/` (this needed
   `supabase/config.toml`, whose absence was why the repo-linked project deployed nothing).
   **Two one-time setup steps remain, both needing credentials no agent session has:**
   add the `SUPABASE_ACCESS_TOKEN` and `SUPABASE_DB_PASSWORD` repository secrets, then run
   the workflow manually once with **repair_legacy_history** checked — `001`/`002` were
   applied by hand with `psql`, so the remote migration-history table has no record of them
   and a plain push would retry `001` and fail on "relation already exists". Tidy moment to
   fold in the credential rotation below: reset the DB password in the dashboard and put the
   new one straight into the secret.
2. Then run the AP demo end-to-end in the browser and confirm: the run suspends with the
   Authorization panel populated; approving one payment with "Approve and create a rule…"
   auto-clears the rest on resume; a low `hard_deny_above_cents` denies an oversized payment
   with no approve control; the downloaded workbook's Authorization sheet tells that story.
3. The security debt from session 1 (rotate the DB password + secret API key that were
   pasted into a chat) is **still outstanding**.

### Behaviour change to expect

On a fresh org (no policy row, no rules) an **AP run now stops for authorization on every
payable invoice** — that is the intended fail-closed default, and it shifts PLAN.md §13's AP
expectations (the run reaches `awaiting_review` only after its payments are authorized). The
sanctioned way to make it flow is minting a bounded standing rule; there is deliberately no
"skip approvals" flag.

### Seams left for Edge #2 (read before starting it)

- **Vendor-name matching is exact-after-normalization only** (case + collapsed whitespace) in
  `engine.ts`'s `normalizeCounterparty`. "Acme Inc" vs "ACME, Inc." correctly falls through to
  a human. Edge #2's typed `vendor_alias` rows are the right place to fix that — do **not**
  bolt a fuzzy matcher into the permission engine, where a loose match silently widens an
  authorization.
- **Learn-path vs apply-path is already separated** (D-A7): resolving an action never creates
  a rule as a side effect; minting is explicit, attributed, and revocable. `approval_rules` is
  a working precedent for what Edge #2's typed store should feel like (scoped, typed,
  provenance-carrying, deterministically applied in code rather than prompt-injected).
- `lib/approvals/action-types.ts` is where a new consequential action type registers; adding
  `writes_ledger`/`external_filing` behaviour is a registry row + a `proposeActions` body, not
  a redesign.

---

## 2. The reference we studied: OpenWorker (Andrew Ng)

Repo lives at **`/Users/yashbhalgat/code/openworker`** (Python; general-purpose desktop coworker;
BYOK; 25+ connectors; MCP). We read its harness in depth. **Key mental model:** OpenWorker is a
*horizontal, free-roaming tool-calling agent* — the opposite of our deterministic core. Do **not**
adopt its "let the model freely drive tools / no structured output" philosophy. **Do** steal its
*harness maturity*: approval, audit, memory, provider handling. Concrete file:line references are
embedded in §3 so a new session can go read the exact patterns.

**What OpenWorker notably LACKS that we already have (our edge — protect it):**
- No structured/JSON output and no schema validation anywhere — pure tool-calling; it even needs a
  "salvage layer" to recover malformed tool calls. Our hybrid determinism + zod validation is a
  real correctness advantage.
- No context compaction/token management (a gap we'd eventually need for long threads — but solve
  it ourselves, don't copy).

---

## 3. The build plan — 5 edges, ranked by leverage

Each edge: the pattern (with OpenWorker refs), our current gap, the concrete move mapped to our
files, and why it's competitive edge / moat.

### Edge #1 — Per-action approval gating + a finance risk taxonomy  ★ highest leverage
**Pattern (OpenWorker):** `coworker/risk.py` (`RiskClass` enum READ/WRITE_LOCAL/EXEC/EXTERNAL as a
data table, `classify()`, `is_consequential()`); `coworker/permissions.py`
(`PermissionEngine.evaluate()` returns `needs_user` per call; **path/argument scoping**;
shell-operator guard so allowlists can't be tricked; tiered grants once/session/durable
target-bound standing rule via `mint_task_rule`); `coworker/engine.py` `_authorize()` (out-of-band
approver, audits every stage).
**Our gap:** we approve the **whole workflow at the end** (`ReviewBanner`), after every consequential
action already ran. We do not gate individual actions.
**Move (in our code):**
- Add a finance risk taxonomy to `DagStepDefinition` (or per-action within a step): e.g.
  `READ | WRITES_LEDGER | MOVES_MONEY | EXTERNAL_FILING`. Data table, not inline name checks.
- In `orchestrator.ts`, before executing a consequential action, evaluate a permission decision;
  if it needs a human, **suspend** (see Edge #3) instead of proceeding.
- **Bind approvals to arguments** (this counterparty, this amount band) — never "approve the tool."
  Add hard **structural ceilings** (amount caps, approved-counterparty allowlists) that no in-band
  human click can override — analog of OpenWorker's "writes outside a sanctioned root are denied
  regardless of approval."
- Tiered grants: once / this-run / durable standing rule (`tool→exact target`, server-validated).
**Why it's edge:** the compliance/segregation-of-duties story. An end-gate can never answer "who
approved *this* payment, under which standing rule." Enables "auto-approve reconciliations < $X for
vendor Y; always ask for new payees."

### Edge #3 — Durable suspend-and-resume as the HITL primitive  (ships with #1)
**Pattern (OpenWorker):** `coworker/engine.py` (`_interruptible`, `_handle_ask_user`,
`resume()`), `coworker/inbox.py` (`InboxStore.wait/resolve` — resolve-exactly-once,
first-responder-wins; durable pending items answerable from any surface), `coworker/selfwake.py`
(suspend at ~zero idle cost). Invariant: **every pending tool_call always gets a result** even on
interrupt, so history/resume never breaks.
**Our gap:** orchestrator pauses only on **error** and resumes; it can't pause for **approval**.
**Move:** generalize the orchestrator's pause/resume from "error" to "awaiting-approval." Persist a
durable pending-approval item keyed by (workflow, step, action); resume idempotently with the
human's decision. This is what makes Edge #1 operationally viable (don't block a live run).
**Why it's edge:** long-running, human-gated finance jobs that survive restarts and are resolvable
from web/Slack/email.

### Edge #4 — Stage-by-stage immutable audit of the *decision*  (small delta on #1)
**Pattern (OpenWorker):** `coworker/audit.py` — append-only SQLite, logs
`proposed → approval_requested → approval_resolved (who/what/which rule) → finished`, **redacts**
secrets/bodies but preserves the target `resource`.
**Our gap:** `lib/audit.ts` records what shipped + input hashes + model; not the authorization chain.
**Move:** extend `writeAudit`/`audit_log` usage to record the full per-action authorization chain
(proposed → approval requested → resolved with approver + rule → finished). Surface it in
`AuditTrail.tsx` and the Excel certificate. Note: `audit_log.workflow_id` is currently `NOT NULL` —
fine for workflow-scoped actions.
**Why it's edge:** produces the exact artifact auditors want ("payment auto-approved under standing
rule R minted by U on D").

### Edge #2 — Typed, org-scoped "learned rules" layer  ★ the durable moat (bigger build)
**Pattern (OpenWorker):** `coworker/memory/{base.py,sqlite_store.py,tools.py}` — scoped store
behind a swappable adapter (`MemoryStore` ABC), **auto-recall injected at session start**
(`agent.py` builds a "Known memories" block), stable `[#id]`s so the agent revises rather than
duplicates, strict "what to remember" guidance. `coworker/skills/base.py` — progressive disclosure
(inject a catalog of one-liners; `load_skill(name)` pulls full detail on demand).
**Our gap:** we are **stateless between runs** — no memory of org-specific matching rules, vendor
normalizations, materiality thresholds, or past reconciliations.
**Move (improve on them — theirs is opaque free-text with unranked full-dump recall, which does not
scale):**
- Scoped store behind an adapter interface; scope by **org/tenant + entity** (not workspace path).
- **Typed rows**, not free text: `kind ∈ {matching_rule, vendor_alias, materiality_threshold,
  recon_precedent}`, structured JSON payload, `confidence`, `provenance`, `created_at/updated_at`.
  Typed = you can **apply rules deterministically in the code path** (matching.ts), not just prompt-inject.
- **Auto-recall at run start** (load the org's rules into context / into the deterministic matcher).
- **Progressive disclosure** at scale: inject a compact index, `load_rules(vendor|category)` on demand.
  Plan for typed lookup/indexing (or embeddings) from day one — do NOT dump all rules into the prompt.
- **Separate the learn-path from the apply-path:** a one-off human correction requires an explicit
  "promote to standing org rule?" step (approver + timestamp). Deliberate accretion = lock-in + audit.
**Why it's moat:** once an org's rules/aliases/thresholds/history live here and the matcher learns
them, switching cost is high and accuracy compounds. This is the durable defensibility.

### Edge #5 — Selective provider-layer upgrades  (polish; do after #1–#4)
We're ahead on some things, behind on others.
**Adopt (OpenWorker refs):**
- **Capability model + graceful degradation:** `coworker/providers/capabilities.py` + `matrix.py`
  (curated per-model caps; PDFs/images re-adapted to the active model per call). We have no
  capability model.
- **Surgical, error-message-driven param-fix retries:** `openai_provider.py` reads the vendor's
  actual complaint and fixes exactly that (vs. our blind "retry once" in `router.ts`).
- **Tool-call/JSON salvage for weak local models:** `openai_provider.py` recovers malformed
  output validated against the schema — important for our BYO-local-model (Ollama) story.
- **Pre-save credential verification:** `registry.py verify_provider_key` does a cheap read-only
  call before saving. We have `/api/llm/configs/[id]/test`; make the Add-provider flow verify pre-save.
**Lower priority:** canonical-message **sidecars** (Anthropic thinking / Gemini thought signatures)
for lossless mid-run model switching.
**We already match/beat them on:** structured JSON + schema validation, per-vendor key isolation,
AES key encryption.

---

## 4. Suggested build order
1. ~~**Edge #1 + #3 together**~~ — **DONE** (session 2, `PLAN-3.md` A0–A6; see §1.1).
2. ~~**Edge #4** (full authorization-chain audit)~~ — **DONE** (folded into Plan 3, A6).
3. **Edge #2** (typed org-scoped learned-rules layer) — **next**; the durable moat, larger
   build. Read §1.1's "Seams left for Edge #2" first.
4. **Edge #5** (provider polish: param-fix retries, capability degradation, salvage, pre-save verify).

Each should follow the existing plan discipline: land behind typecheck + build + tests, one focused
commit per unit, prompts unchanged unless deliberately revising.

---

## 5. Moat summary (the "why" behind all of this)
Orchestration itself is **not** a moat (copyable in weeks). Our defensibility =
**"finance output you can trust, prove, and can't easily leave":**
- **Trust/correctness** — hybrid determinism + schema validation (already ours; protect it).
- **Prove** — per-action approval + full authorization-chain audit (Edges #1/#3/#4).
- **Can't leave** — typed org-specific learned rules + integrations + historical data (Edge #2).
OpenWorker sets the *harness maturity* bar; our edge is pairing that maturity with our deterministic
core, which a horizontal agent wrapper cannot replicate.

---

## 6. First moves for the new session
1. `cd /Users/yashbhalgat/code/finito`, read `PLAN.md` (D1–D10), `PLAN-2.md` (D-P1–D-P15) and
   `PLAN-3.md` (D-A1–D-A16) — the locked-decision style you should keep.
2. **Operational first:** get `003_approvals.sql` applied (two setup steps in §1.1 — repo
   secrets, then one manual workflow run with `repair_legacy_history`), then run the PLAN-3 §8
   live checkpoint. Nothing approval-related works against the live DB until then.
3. For Edge #2, skim `lib/approvals/{engine,service}.ts` (the precedent for a typed, scoped,
   deterministically-applied store) and `lib/agents/matching.ts` (where learned matching rules
   and vendor aliases must be applied in code, not prompt-injected).
4. Optionally open `/Users/yashbhalgat/code/openworker/coworker/memory/{base,sqlite_store,tools}.py`
   and `skills/base.py` for the memory/progressive-disclosure patterns (read-only; different
   language/product).
5. Propose a locked-decision plan for Edge #2 (a "PLAN-4") before coding, then implement
   milestone by milestone with the typecheck+build+test gate.
