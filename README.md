# FinFlow

Multi-agent finance automation — reconciliation, AP invoice matching, and FP&A
variance commentary. Upload your ledgers, watch a team of Claude agents work the
data live, approve at a human review gate, and export an auditable report.

Built with Next.js 15 (App Router), React 19, Tailwind v4 (dark-only), Supabase
(Postgres + Auth + Storage), and the Anthropic TypeScript SDK. See
[`PLAN.md`](./PLAN.md) for the full product/architecture spec.

---

## 1. Prerequisites

- Node.js 20+
- A [Supabase](https://supabase.com) project (Postgres + Auth + Storage)
- An [Anthropic API key](https://console.anthropic.com)

## 2. Environment variables (§2)

Copy `.env.example` to `.env.local` and fill in the values:

```bash
cp .env.example .env.local
```

```
NEXT_PUBLIC_SUPABASE_URL=        # your Supabase project URL
NEXT_PUBLIC_SUPABASE_ANON_KEY=   # Supabase anon/public key (browser auth)
SUPABASE_SERVICE_ROLE_KEY=       # server-only; never expose to the client
LLM_KEY_ENCRYPTION_SECRET=       # required to SAVE provider API keys (AES-256-GCM, D-P2)
LLM_BLOCK_PRIVATE_URLS=          # OPTIONAL SSRF guard for custom base_urls (D-P13)
ANTHROPIC_API_KEY=               # OPTIONAL self-host/dev fallback (D-P4)
```

`.env.local` is gitignored. The two `NEXT_PUBLIC_*` values are safe in the
browser; every other value is used only in server code (API route handlers + the
orchestrator) and must never be sent to the client.

- **`LLM_KEY_ENCRYPTION_SECRET`** — a random 32+ character string. Provider API
  keys are encrypted at rest with AES-256-GCM using a SHA-256 derivation of this
  secret (Plan 2, D-P2). Config-save routes **fail closed (500)** if it is unset.
  ⚠️ Rotating it invalidates every stored key — users must re-enter them under
  Settings → Models.
- **`LLM_BLOCK_PRIVATE_URLS`** — set to `1` to reject private/localhost `base_url`
  hosts at config-save time, but **only** when `NODE_ENV=production` (D-P13).
  Default off, so self-hosters can point at `http://localhost:11434` (Ollama) or a
  VPC endpoint.
- **`ANTHROPIC_API_KEY`** — optional. When an org has **zero** active model configs,
  the router treats this key as an implicit Anthropic config
  (`default_model = claude-sonnet-4-6`), so `next dev` demos work with nothing but
  this env var (D-P4). On a shared/public deployment, prefer real org configs under
  Settings → Models instead.

## 3. Apply the database schema

The schema lives in
[`supabase/migrations/001_init.sql`](./supabase/migrations/001_init.sql) (tables,
RLS policies, the `profiles` auto-provision trigger, the seeded "Demo Org", and the
private `workflow-files` Storage bucket) followed by
[`supabase/migrations/002_llm_providers.sql`](./supabase/migrations/002_llm_providers.sql)
(the `org_model_configs` / `workflow_step_configs` tables and the provenance columns
on `workflow_steps`). Apply them **in order**, either way:

- **Supabase SQL editor** — open your project → SQL Editor → paste the contents of
  `001_init.sql` → Run, then do the same for `002_llm_providers.sql`.
- **Supabase CLI** — with the CLI linked to your project:

  ```bash
  supabase db push
  ```

## 4. Generate demo data (optional)

Deterministic sample CSVs with planted anomalies (already committed under
`demo-data/`, regenerate any time):

```bash
npm run demo-data
```

This writes the six input CSVs (ERP export, bank statement, invoices, purchase
orders, budget, actuals) plus `demo-data/expected-results.json`. Upload these in
the wizard to exercise each workflow type.

## 5. Run

```bash
npm install
npm run dev
```

Open <http://localhost:3000>. Sign up (a profile is auto-created in the Demo Org),
then **configure an LLM provider first** under **Settings → Models → Add provider**
(pick a provider, paste a key or set a base URL, "Test connection", Save; tick
"Set as organization default"). For a zero-config dev run you can instead just set
`ANTHROPIC_API_KEY` in `.env.local` — the router uses it as an implicit Anthropic
default (D-P4).

Then: **Dashboard → New workflow → pick a type → upload files → Run**. The live
view polls every 2s while the agents work; approve at the review gate to unlock the
report + audit certificate (Print / Save as PDF from there, or download the XLSX).

> If no provider resolves for the org, the wizard's **Launch** and the error
> banner's **Re-run** surface the run route's inline "No LLM provider configured"
> notice, linking to **Settings → Models**.

## Multi-provider LLM architecture (Plan 2)

Every organization configures its **own** LLM provider(s), key(s), and per-step
model choices. Agent steps never touch a provider SDK — they call a role- and
org-aware **router** (`lib/llm/router.ts`), so the same workflow can run on
Anthropic, OpenAI, Google Gemini, Ollama, or any OpenAI-compatible endpoint.

**Provider resolution order (D-P7).** For each LLM step, given
`(org_id, workflow_type, step_key)`:

1. A per-step pin in `workflow_step_configs` (if the assigned config is active).
2. Else the org's active default config (`org_model_configs.is_default`).
3. Else the env-var implicit Anthropic config — `ANTHROPIC_API_KEY` with
   `default_model = claude-sonnet-4-6` (D-P4), for `next dev` / self-host.
4. Else the run route fails fast with `400 "No LLM provider configured"`.

Pin a step to a specific model by creating a config with that `default_model` and
assigning the step to it under **Settings → Models → Per-step model assignment**
("matching uses GPT-4.1, commentary uses Claude"). The model recorded per step is
the exact string the provider returns; the audit certificate and Excel footer list
the distinct `provider:model` pairs actually used.

**Key encryption (D-P2/D-P3).** Keys are encrypted with **AES-256-GCM in the Node
API-route process** (never `pgp_sym_encrypt`, which would put plaintext into SQL
statement logs) using a SHA-256 derivation of `LLM_KEY_ENCRYPTION_SECRET`, and
stored as `v1:<iv>:<tag>:<ciphertext>`. `org_model_configs` has **no RLS SELECT
policy** — the browser can never read it. `GET /api/llm/configs` returns everything
**except** the ciphertext, exposing only `key_last4` for display; there is no
"reveal key" path. Rotation = submit a new key for the same config. Deletion is
soft (`is_active = false`) and wipes the ciphertext (D-P15). Decrypted keys live
only inside `resolveProvider → invoke → provider` call frames — never logged,
serialized, or stored; each LLM step's raw response is redacted + capped before it
lands in `workflow_steps.llm_raw` (D-P11), which is never sent to the browser.

**Local models & the connector pattern (D-P13).** Ollama and custom endpoints must
be reachable **from the FinFlow server process**. Local dev and a self-hosted
FinFlow can point at `http://localhost:11434` (Ollama) or a VPC vLLM; the hosted
product cannot reach a customer's laptop — the Add-provider dialog says so. When
`NODE_ENV=production` **and** `LLM_BLOCK_PRIVATE_URLS=1`, config-save rejects
private/loopback `base_url` hosts (SSRF guard; default off so self-hosters work).
To use a local model behind the hosted product later, the intended extension is a
reverse proxy inside the customer network exposed via the `custom` provider's
`base_url` — an on-prem connector/webhook that is **out of scope** for this pass.

## 6. Useful scripts

| Command             | Purpose                                   |
| ------------------- | ----------------------------------------- |
| `npm run dev`       | Dev server (Turbopack)                    |
| `npm run build`     | Production build                          |
| `npm run typecheck` | `tsc --noEmit`                            |
| `npm run test`      | Unit tests (Vitest — parser, matcher, crypto, provider layer, router, DAG, orchestrator) |
| `npm run demo-data` | Regenerate `demo-data/` fixtures          |
| `npm run lint`      | ESLint                                     |

---

## Architecture notes (locked decisions, see PLAN.md)

- **D1 — Live updates via 2s polling, not SSE.** The frontend polls
  `GET /api/workflows/[id]/status` every 2s while the workflow is `running`,
  behind a single `useWorkflowStatus(id)` hook (so SSE can be swapped in later).
- **D2 / D-P6 — Background execution via `waitUntil` + a resumable DAG orchestrator.**
  `POST /api/workflows/[id]/run` verifies a provider resolves for every LLM step,
  marks the workflow `running`, kicks off `runWorkflow(id)` (`lib/agents/orchestrator.ts`)
  via `@vercel/functions` `waitUntil`, and returns `202`. The orchestrator schedules
  the **ready set** (steps whose `dependsOn` are all `complete`) concurrently, retries
  a failing step up to 3× (1s/4s backoff), and on final failure pauses the workflow —
  in-flight siblings still persist. Re-POSTing `/run` on an `error` workflow resets
  errored steps to `pending` and resumes; `complete` steps never re-run. A step stuck
  `running` > 3 min is treated as crashed.
- **D3 — Hybrid matching.** Exact-rule matching (equal amounts, date windows,
  duplicates, variance arithmetic) runs in deterministic TypeScript; Claude is used
  only for judgment (fuzzy adjudication, classification) and language (explanations,
  commentary). Every number in the report is recomputed in code from the matched
  sets and every ID Claude returns is validated against the real dataset.
- **D4 / D-P1 — Provider-agnostic structured outputs.** Steps call `ctx.llm({system,
  user, schema})`; the router resolves the org's provider, requests JSON via each
  provider's strongest native mechanism (D-P9 — Anthropic `output_config`, OpenAI
  strict `json_schema`, Gemini `responseSchema`, Ollama/custom `json` + schema-in-prompt),
  then validates with Zod and retries once with the error appended. Transport is
  HTTP-first (`fetch`); only Anthropic keeps its SDK (D-P10).
- **D5 — Two Supabase clients only.** `lib/supabase/server.ts` (cookie-scoped
  `@supabase/ssr`, RLS-protected, for Server Components + auth) and
  `lib/supabase/admin.ts` (service-role, used **only** inside API route handlers and
  the orchestrator, always after an org-ownership check). No client-side writes or Storage
  access — everything mutating goes through the API routes.

### Layout

```
app/
  (auth)/login                  sign-in / sign-up
  (app)/dashboard               workflow list + launch cards
  (app)/workflows/new           upload wizard
  (app)/workflows/[id]          live agent view + review gate  (client, polls status)
  (app)/workflows/[id]/report   final report + audit certificate  (server, print)
  (app)/settings                org + members
  (app)/settings/models         LLM providers, per-step matrix, usage  (Plan 2)
  api/workflows/**              create / upload / run / status / review / report (xlsx)
  api/llm/**                    provider configs / test / step-configs / usage  (Plan 2)
components/workflow/            StepCard, WorkflowTrack, LiveWorkflowView, OutputPanel,
                                ReviewBanner, FileDropzone, AuditTrail, PrintButton
components/settings/            ModelsManager, ProviderConfigList, AddProviderDialog,
                                StepModelMatrix, UsagePanel
lib/agents/                     dag + orchestrator + reconciliation / AP / FP&A + matching
lib/llm/                        provider.ts, router.ts, providers/*, crypto, json-schema,
                                redact, url-guard, config-service  (Plan 2)
lib/supabase/                   server + admin + middleware clients
lib/{types,format,audit,csv,excel}
```
