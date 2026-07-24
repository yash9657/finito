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

Copy `.env.example` to `.env.local` and fill in the four values:

```bash
cp .env.example .env.local
```

```
NEXT_PUBLIC_SUPABASE_URL=        # your Supabase project URL
NEXT_PUBLIC_SUPABASE_ANON_KEY=   # Supabase anon/public key (browser auth)
SUPABASE_SERVICE_ROLE_KEY=       # server-only; never expose to the client
ANTHROPIC_API_KEY=               # server-only; used by the agent runner
```

`.env.local` is gitignored. The two `NEXT_PUBLIC_*` values are safe in the
browser; `SUPABASE_SERVICE_ROLE_KEY` and `ANTHROPIC_API_KEY` are used only in
server code (API route handlers + the runner) and must never be sent to the client.

## 3. Apply the database schema

The full schema lives in
[`supabase/migrations/001_init.sql`](./supabase/migrations/001_init.sql) (tables,
RLS policies, the `profiles` auto-provision trigger, the seeded "Demo Org", and the
private `workflow-files` Storage bucket). Apply it either way:

- **Supabase SQL editor** — open your project → SQL Editor → paste the contents of
  `001_init.sql` → Run.
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
then: **Dashboard → New workflow → pick a type → upload files → Run**. The live
view polls every 2s while the agents work; approve at the review gate to unlock the
report + audit certificate (Print / Save as PDF from there, or download the XLSX).

## 6. Useful scripts

| Command             | Purpose                                   |
| ------------------- | ----------------------------------------- |
| `npm run dev`       | Dev server (Turbopack)                    |
| `npm run build`     | Production build                          |
| `npm run typecheck` | `tsc --noEmit`                            |
| `npm run test`      | Unit tests (Vitest — CSV parser, matcher) |
| `npm run demo-data` | Regenerate `demo-data/` fixtures          |
| `npm run lint`      | ESLint                                     |

---

## Architecture notes (locked decisions, see PLAN.md)

- **D1 — Live updates via 2s polling, not SSE.** The frontend polls
  `GET /api/workflows/[id]/status` every 2s while the workflow is `running`,
  behind a single `useWorkflowStatus(id)` hook (so SSE can be swapped in later).
- **D2 — Background execution via `waitUntil` + an idempotent resumable runner.**
  `POST /api/workflows/[id]/run` marks the workflow `running`, kicks off
  `runWorkflow(id)` via `@vercel/functions` `waitUntil`, and returns `202`. The
  runner resumes from the first non-`complete` step; a step stuck `running` > 3 min
  is treated as crashed and re-executed on the next run.
- **D3 — Hybrid matching.** Exact-rule matching (equal amounts, date windows,
  duplicates, variance arithmetic) runs in deterministic TypeScript; Claude is used
  only for judgment (fuzzy adjudication, classification) and language (explanations,
  commentary). Every number in the report is recomputed in code from the matched
  sets and every ID Claude returns is validated against the real dataset.
- **D4 — Model + structured outputs.** Agents call `claude-sonnet-4-6` via the
  official SDK with `output_config` JSON-schema structured outputs (no
  "respond only in JSON" prompting, no prefills, no temperature), validated with Zod.
- **D5 — Two Supabase clients only.** `lib/supabase/server.ts` (cookie-scoped
  `@supabase/ssr`, RLS-protected, for Server Components + auth) and
  `lib/supabase/admin.ts` (service-role, used **only** inside API route handlers and
  the runner, always after an org-ownership check). No client-side writes or Storage
  access — everything mutating goes through the API routes.

### Layout

```
app/
  (auth)/login                  sign-in / sign-up
  (app)/dashboard               workflow list + launch cards
  (app)/workflows/new           upload wizard
  (app)/workflows/[id]          live agent view + review gate  (client, polls status)
  (app)/workflows/[id]/report   final report + audit certificate  (server, print)
  (app)/settings
  api/workflows/**              create / upload / run / status / review / report (xlsx)
components/workflow/            StepCard, WorkflowTrack, LiveWorkflowView, OutputPanel,
                                ReviewBanner, FileDropzone, AuditTrail, PrintButton
lib/agents/                     runner + reconciliation / AP / FP&A agents + matching
lib/supabase/                   server + admin + middleware clients
lib/{types,format,audit,csv,excel}
```
