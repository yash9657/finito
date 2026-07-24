# FinFlow — Implementation Plan (for Claude Opus 4.8)

> **How to use this document.** This is the execution plan for building FinFlow, a
> multi-agent finance-automation platform. It resolves every architectural ambiguity in
> the product spec into a locked decision. Work milestone by milestone (M0 → M9), in
> order. After each milestone: run `npm run typecheck && npm run build`, verify the
> milestone's acceptance criteria, and commit (`git init` in M0; one commit per
> milestone). Do not re-litigate the Locked Decisions in §1 — they were made
> deliberately, with rationale recorded. If you hit something this plan genuinely does
> not cover, pick the simplest option consistent with §1 and leave a `// DECISION:`
> comment at the site.
>
> **Scope for the first pass:** M0–M7 (Phase 1 + Phase 2 of the product spec) — the
> reconciliation workflow working end-to-end with real Claude API calls, live execution
> view, review gate, and Excel report. M8 (AP + FP&A workflows) and M9 (polish) come
> after M7 is demonstrably working with the demo CSVs.

---

## 0. Product summary (one paragraph)

FinFlow lets a finance team run pre-built multi-step AI agent workflows
(reconciliation, AP invoice matching, FP&A variance commentary) against uploaded
CSV/Excel files. Each workflow is a sequence of steps grouped into parallel "tracks";
every step's inputs, outputs, and agent reasoning are persisted and rendered in a live,
terminal-like execution view; a human review gate approves or rejects the final output;
approved outputs are downloadable as an Excel report with a full audit certificate.
**The live step-by-step execution view is the hero interaction — everything else is
scaffolding.**

---

## 1. Locked decisions (do not revisit)

**D1 — Live updates via 2-second polling, not SSE.** The frontend polls
`GET /api/workflows/[id]/status` every 2s while the workflow status is `running`.
Polling is trivially reliable on Vercel serverless; SSE adds connection-lifetime
complexity for zero demo value at this scale. Structure the client as a
`useWorkflowStatus(id)` hook so SSE can be swapped in later. Do **not** build the
`/stream` route in this pass.

**D2 — Background execution via `waitUntil` + idempotent resumable runner.**
`POST /api/workflows/[id]/run` marks the workflow `running`, then calls
`waitUntil(runWorkflow(id))` from `@vercel/functions` and returns `202` immediately.
The route exports `export const maxDuration = 300`. The runner is **idempotent and
resumable**: it always starts from the first step whose status is not `complete`, so
re-POSTing `/run` after a crash continues rather than restarts. A step stuck in
`running` for > 3 minutes is treated as crashed: the status endpoint reports it, and a
re-run resets it to `pending` and re-executes it. No queue, no cron, no extra infra.

**D3 — Hybrid matching: deterministic code first, Claude for judgment + language.**
Exact-rule matching (equal amounts, date windows, duplicate detection, variance
arithmetic) is done in TypeScript — it is auditable, reproducible, and never
hallucinates. Claude is used where judgment or language is genuinely required:
adjudicating ambiguous candidate matches (fuzzy description similarity), classifying
*why* items are unmatched, and writing all human-readable explanations, summaries, and
commentary. Every number in the final report is **recomputed in code from the matched
sets** — Claude's arithmetic is never trusted, and every ID Claude returns is validated
against the real dataset (unknown IDs → one retry with the error appended, then step
`error`). The agent reasoning trace shown in the UI comes from Claude; the totals come
from code. This preserves the "watch the agent work" product experience while making
the audit trail defensible.

**D4 — Model + API usage.** Agent model is `claude-sonnet-4-6` (per product spec — it
is recorded in the audit trail, so keep it exact). Every call uses the official
TypeScript SDK (`@anthropic-ai/sdk`), non-streaming `client.messages.create` with:
`max_tokens: 16000`, `thinking: { type: "adaptive" }`, and **structured outputs** via
`output_config: { format: { type: "json_schema", schema } }` — never "respond ONLY in
JSON" prompting, never assistant-turn prefills (they 400 on Sonnet 4.6), never
`temperature`/`top_p`. Parse the first text block with `JSON.parse`, then validate with
Zod. Do not stream (outputs are small JSON; non-streaming under 16K tokens is safe).

**D5 — DB access pattern.** Two Supabase clients only:
- `lib/supabase/server.ts` — cookie-scoped `@supabase/ssr` client for Server
  Components and auth checks. Reads are protected by RLS.
- `lib/supabase/admin.ts` — service-role client (`SUPABASE_SERVICE_ROLE_KEY`), used
  **only inside API route handlers and the runner**, always after verifying the caller
  owns the workflow (org check). All writes and all Storage access go through API
  routes with this client. No client-side Supabase writes, no Storage RLS policies
  (the bucket is private; only the server touches it).

**D6 — `users` table is named `profiles`.** It references `auth.users(id)` and cannot
be named `users` without colliding with Supabase's auth schema conventions. A trigger
auto-creates a profile (role `admin`) in the single seeded "Demo Org" on signup. Multi-
org onboarding is out of scope for MVP; the schema supports it, the UI does not.

**D7 — Money is integer cents everywhere past the parser.** The CSV parser converts
`"1,234.50"` / `"$1234.5"` / `"(500.00)"` (negative) to integer cents. All arithmetic,
matching, and JSON payloads use cents; formatting to `$1,234.50` happens only at the UI
and report layer (`lib/format.ts`). This kills every floating-point reconciliation bug.

**D8 — Stable synthetic row IDs at parse time.** The parser assigns `erp-001…`,
`bank-001…`, `inv-001…`, `po-001…` in file order. These IDs are what Claude references,
what the UI displays, and what makes LLM output verifiable (every returned ID must
exist in the input set).

**D9 — Status vocabulary (adds `error` to the spec).** Workflows:
`idle | running | awaiting_review | approved | rejected | error`. Steps:
`pending | running | complete | error`. The spec omitted a workflow error state; it is
required for honest UX when a Claude call fails after retries.

**D10 — Column named `created_at`, not `timestamp`,** in `audit_log` (reserved-word
adjacent, and consistent with every other table). This is the only schema rename
besides D6; everything else follows the spec.

---

## 2. Prerequisites & environment

Assume these exist before coding (surface clearly in README if missing):

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=          # server-only, never NEXT_PUBLIC
ANTHROPIC_API_KEY=                  # server-only
```

`.env.local` is gitignored; commit `.env.example` with the four names. If the Supabase
project doesn't exist yet, the migration SQL in §4 is written to be pasted into the
Supabase SQL editor (or run via `supabase db push` if the CLI is configured) — put it
in `supabase/migrations/001_init.sql` either way and document both paths in README.

### Dependencies (exact set — do not add others without need)

```
next@15  react  react-dom  typescript
@supabase/supabase-js  @supabase/ssr
@anthropic-ai/sdk
zod
papaparse  @types/papaparse
xlsx                                # SheetJS
tailwindcss  (v4, via @tailwindcss/postcss)
shadcn/ui components as needed (badge, button, card, dialog, textarea, table, skeleton)
lucide-react                        # icons
```

No state-management library (React state + the polling hook suffice), no react-query
(a 30-line hook is clearer), no ORM (typed Supabase queries).

---

## 3. Repository layout (final)

```
supabase/migrations/001_init.sql
demo-data/                          # committed generated CSVs + expected-results JSON
scripts/generate-demo-data.ts       # deterministic generator (run with tsx)
app/
  layout.tsx  globals.css
  (auth)/login/page.tsx
  (app)/layout.tsx                  # auth guard + app shell (sidebar/topbar)
  (app)/dashboard/page.tsx
  (app)/workflows/new/page.tsx
  (app)/workflows/[id]/page.tsx
  (app)/workflows/[id]/report/page.tsx
  (app)/settings/page.tsx
  api/workflows/route.ts                       # POST create
  api/workflows/[id]/upload/route.ts           # POST multipart upload
  api/workflows/[id]/run/route.ts              # POST trigger (waitUntil)
  api/workflows/[id]/status/route.ts           # GET poll target
  api/workflows/[id]/review/route.ts           # POST decision
  api/workflows/[id]/report/route.ts           # GET ?format=xlsx
components/
  workflow/StepCard.tsx  WorkflowTrack.tsx  LiveWorkflowView.tsx
  workflow/ReviewBanner.tsx  OutputPanel.tsx  AuditTrail.tsx  FileDropzone.tsx
  ui/…                               # shadcn
lib/
  types.ts                           # all domain types + Zod schemas
  format.ts                          # cents→$, date, hash display helpers
  audit.ts                           # writeAudit() helper
  csv/parser.ts
  excel/writer.ts
  agents/client.ts                   # callClaude<T>() wrapper
  agents/runner.ts                   # generic executor
  agents/reconciliation.ts  ap-matching.ts  fpa-commentary.ts
  agents/matching.ts                 # deterministic match algorithms (pure, unit-testable)
  supabase/server.ts  admin.ts  middleware.ts
middleware.ts                        # Supabase session refresh + route protection
```

---

## 4. Database schema — `supabase/migrations/001_init.sql` (complete)

```sql
create extension if not exists pgcrypto;

create table public.organizations (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_at timestamptz not null default now()
);

create table public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text not null,
  org_id     uuid not null references public.organizations(id),
  role       text not null default 'admin'
             check (role in ('admin','analyst','reviewer')),
  created_at timestamptz not null default now()
);

create table public.workflows (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id),
  created_by    uuid references public.profiles(id),
  name          text not null,
  type          text not null
                check (type in ('reconciliation','ap_matching','fpa_commentary')),
  status        text not null default 'idle'
                check (status in ('idle','running','awaiting_review',
                                  'approved','rejected','error')),
  error_message text,
  created_at    timestamptz not null default now(),
  started_at    timestamptz,
  completed_at  timestamptz
);

create table public.workflow_steps (
  id              uuid primary key default gen_random_uuid(),
  workflow_id     uuid not null references public.workflows(id) on delete cascade,
  step_number     int  not null,
  track           text not null check (track in ('A','B','C','main')),
  name            text not null,
  status          text not null default 'pending'
                  check (status in ('pending','running','complete','error')),
  input_snapshot  jsonb,
  output          jsonb,
  agent_reasoning text,
  sources         jsonb,           -- e.g. [{"file":"erp_export.csv","rows":"all"}]
  model           text,            -- 'claude-sonnet-4-6' for LLM steps, null for deterministic
  input_hash      text,            -- sha256 of canonical JSON of input_snapshot
  error_message   text,
  started_at      timestamptz,
  completed_at    timestamptz,
  unique (workflow_id, step_number)
);

create table public.workflow_files (
  id           uuid primary key default gen_random_uuid(),
  workflow_id  uuid not null references public.workflows(id) on delete cascade,
  file_type    text not null
               check (file_type in ('bank_statement','erp_export','invoice','po',
                                    'budget','actuals')),
  storage_path text not null,
  filename     text not null,
  size_bytes   bigint not null,
  sha256       text not null,
  uploaded_at  timestamptz not null default now()
);

create table public.audit_log (
  id          bigint generated always as identity primary key,
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  step_id     uuid references public.workflow_steps(id) on delete set null,
  actor_type  text not null check (actor_type in ('agent','human','system')),
  actor_id    text not null,       -- model id, profile uuid, or 'system'
  action      text not null,       -- 'step_started','step_completed','file_uploaded',
                                   -- 'workflow_launched','review_submitted', ...
  detail      jsonb,
  created_at  timestamptz not null default now()
);

create table public.review_decisions (
  id          uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  reviewer_id uuid not null references public.profiles(id),
  decision    text not null
              check (decision in ('approved','rejected','revision_requested')),
  comment     text,
  decided_at  timestamptz not null default now()
);

create index on public.workflows (org_id, created_at desc);
create index on public.workflow_steps (workflow_id, step_number);
create index on public.workflow_files (workflow_id);
create index on public.audit_log (workflow_id, created_at desc);
create index on public.review_decisions (workflow_id);

-- ---- RLS: org-scoped SELECT for signed-in users; all writes via service role ----
alter table public.organizations    enable row level security;
alter table public.profiles         enable row level security;
alter table public.workflows        enable row level security;
alter table public.workflow_steps   enable row level security;
alter table public.workflow_files   enable row level security;
alter table public.audit_log        enable row level security;
alter table public.review_decisions enable row level security;

create function public.auth_org_id() returns uuid
language sql stable security definer set search_path = public as
$$ select org_id from public.profiles where id = auth.uid() $$;

create policy "own org"        on public.organizations for select
  using (id = public.auth_org_id());
create policy "org profiles"   on public.profiles for select
  using (org_id = public.auth_org_id());
create policy "org workflows"  on public.workflows for select
  using (org_id = public.auth_org_id());
create policy "org steps"      on public.workflow_steps for select
  using (exists (select 1 from public.workflows w
                 where w.id = workflow_id and w.org_id = public.auth_org_id()));
create policy "org files"      on public.workflow_files for select
  using (exists (select 1 from public.workflows w
                 where w.id = workflow_id and w.org_id = public.auth_org_id()));
create policy "org audit"      on public.audit_log for select
  using (exists (select 1 from public.workflows w
                 where w.id = workflow_id and w.org_id = public.auth_org_id()));
create policy "org reviews"    on public.review_decisions for select
  using (exists (select 1 from public.workflows w
                 where w.id = workflow_id and w.org_id = public.auth_org_id()));
-- No insert/update/delete policies: service role bypasses RLS; anon/auth cannot write.

-- ---- Seed org + auto-profile trigger ----
insert into public.organizations (id, name)
values ('00000000-0000-0000-0000-000000000001', 'Demo Org');

create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, org_id, role)
  values (new.id, new.email, '00000000-0000-0000-0000-000000000001', 'admin');
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---- Private storage bucket ----
insert into storage.buckets (id, name, public) values ('workflow-files','workflow-files', false);
-- No storage policies: only the service-role server client reads/writes it.
```

Storage path convention: `{org_id}/{workflow_id}/{file_type}/{original_filename}`.

---

## 5. Core types & LLM plumbing (`lib/types.ts`, `lib/agents/client.ts`)

### 5.1 Domain types (representative — implement completely)

```ts
// cents-based money everywhere
export interface ErpTxn  { id: string; date: string; description: string;
                           amountCents: number; referenceNumber: string }
export interface BankTxn { id: string; date: string; description: string;
                           amountCents: number; transactionId: string }

export type WorkflowType   = 'reconciliation' | 'ap_matching' | 'fpa_commentary';
export type WorkflowStatus = 'idle'|'running'|'awaiting_review'|'approved'|'rejected'|'error';
export type StepStatus     = 'pending'|'running'|'complete'|'error';
export type Track          = 'A'|'B'|'C'|'main';
```

### 5.2 Step engine contract (`lib/agents/runner.ts`)

```ts
export interface StepContext {
  workflowId: string;
  db: SupabaseClient;                      // admin client
  files: Record<string, ParsedFile>;       // keyed by file_type
  priorOutputs: Record<number, unknown>;   // step_number -> output (validated)
}
export interface StepDefinition {
  stepNumber: number;
  track: Track;
  name: string;
  kind: 'deterministic' | 'llm';
  run(ctx: StepContext): Promise<{
    output: unknown;                       // stored in workflow_steps.output
    reasoning: string;                     // Claude's reasoning, or generated summary
    sources: Array<{ file: string; note: string }>;
  }>;
}
```

`runWorkflow(workflowId)` (the function passed to `waitUntil`):
1. Load workflow + files; download files from Storage; parse them once.
2. Load existing steps; if none, insert all step rows as `pending` (one insert).
3. For each step in order, skipping `complete` ones:
   - Steps 1 and 2 (the two Track-A/B parse steps) run concurrently via
     `Promise.all`; everything else is sequential. Implement as: group consecutive
     steps that share no dependency (hardcode: recon/AP steps 1+2 are the only
     parallel group; FP&A is fully sequential).
   - Set step `running` + `started_at`; audit `step_started`.
   - Compute `input_hash` = sha256 of `JSON.stringify` of the step's input snapshot
     (store snapshot **truncated to first 20 rows + row count** for big datasets —
     the hash is over the full canonical input, the stored snapshot is for display).
   - Execute `run(ctx)`. On throw: retry the whole step once; on second throw mark
     step `error`, workflow `error` (+ `error_message`), audit `step_failed`, stop.
   - Set step `complete`, persist output/reasoning/sources/model, audit
     `step_completed` with `{ input_hash, duration_ms, model }`.
4. After the last step: workflow → `awaiting_review`, `completed_at` = now, audit
   `workflow_awaiting_review`.

Every DB write in the runner uses the admin client. The runner never throws to the
platform — top-level try/catch marks the workflow `error`.

### 5.3 Claude wrapper (`lib/agents/client.ts`)

```ts
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

const anthropic = new Anthropic();          // reads ANTHROPIC_API_KEY
export const AGENT_MODEL = 'claude-sonnet-4-6';

export async function callClaude<T>(opts: {
  system: string;
  user: string;
  schema: z.ZodType<T>;
}): Promise<{ data: T; reasoning: string }> { ... }
```

Behavior:
- `client.messages.create({ model: AGENT_MODEL, max_tokens: 16000,
  thinking: { type: 'adaptive' }, output_config: { format: zodOutputFormat(schema) },
  system, messages: [{ role: 'user', content: user }] })`.
- Concatenate `thinking`-type blocks into `reasoning` (may be empty — that's fine; if
  empty, fall back to the schema's own `reasoning` field, see below).
- Every schema includes a top-level `reasoning: z.string()` field where the model
  explains its work in 2–5 sentences — this guarantees a displayable trace even when
  thinking summaries are absent, and doubles as the persisted `agent_reasoning`.
- Parse first `text` block with `JSON.parse`, validate with the Zod schema. On parse
  or validation failure: one retry with a second user message appended: *"Your
  previous response failed validation: <zod error>. Return corrected JSON."* Then
  throw (runner handles step-level retry/error).
- Typed error handling per SDK: catch `Anthropic.RateLimitError` → wait
  `retry-after` (max 60s) and retry once; `Anthropic.APIError` 5xx → retry once with
  2s backoff; everything else rethrows.

Keep zod schemas simple: objects/arrays/strings/ints/enums, `additionalProperties`
handled by `zodOutputFormat`. **No recursive schemas, no min/max constraints** (not
supported by structured outputs — validate ranges client-side after parse).

---

## 6. CSV parsing (`lib/csv/parser.ts`)

Papa Parse with `header: true, skipEmptyLines: true`, then per-workflow-type column
mapping. Normalization rules (unit-test these):
- **Headers:** lowercase, trim, collapse internal whitespace to `_`. Accept aliases:
  `amount|amt|value`, `date|txn_date|transaction_date`, `description|desc|memo|details`.
- **Dates:** accept `YYYY-MM-DD`, `MM/DD/YYYY`, `M/D/YY`, `DD-Mon-YYYY`; output
  ISO `YYYY-MM-DD`. Unparseable date → row-level error.
- **Amounts:** strip `$`, `,`, whitespace; `(x)` → negative; parse to **integer
  cents** via string math (`Math.round(parseFloat(clean) * 100)` is acceptable —
  values fit safely in double for realistic magnitudes).
- **Row IDs:** `erp-001`, `bank-001`, … assigned in file order (D8).
- Excel: if extension is `.xlsx/.xls`, read with SheetJS
  (`XLSX.read(buffer)` → first sheet → `sheet_to_json`) then run the same normalizer.
- Return `{ rows, errors }`; if `errors.length > 0` the parse **step succeeds** but
  lists skipped rows in its output (finance users expect dirty files); if
  `rows.length === 0` the step errors.

The parse steps (Track A/B) are `deterministic` kind. Their `reasoning` is generated
text, e.g. `"Parsed 50 rows from erp_export_demo.csv. Normalized 50 dates and 50
amounts to integer cents. 0 rows skipped."` Their `sources` cite the file + sha256.

---

## 7. Workflow 1 — Reconciliation (the flagship; M4–M5)

Step table (persisted names shown verbatim in the UI):

| # | Track | Name | Kind |
|---|-------|------|------|
| 1 | A | Parse ERP export | deterministic |
| 2 | B | Parse bank statement | deterministic |
| 3 | main | Match transactions | deterministic + llm (hybrid) |
| 4 | main | Flag exceptions | llm |
| 5 | main | Generate reconciliation report | deterministic + llm |
| 6 | main | Human review | gate (no execution — represented by workflow status `awaiting_review`; do **not** create a step row for it) |

### Step 3 — Match transactions (`lib/agents/matching.ts` + adjudication)

Deterministic pass (pure function, unit-tested):
1. **Exact match:** same `amountCents` AND date within ±3 calendar days AND
   normalized-description token overlap (Jaccard over lowercased word sets, stopwords
   `{payment,to,from,the,inc,llc,corp,co}` removed) ≥ 0.5. Greedy one-to-one, ordered
   by (amount, date proximity). Confidence `1.0`, reason `"exact amount + date within
   3 days"`.
2. **Candidate pairs** for the residual: any ERP↔bank pair with (same amount, any
   date) OR (description Jaccard ≥ 0.4 and |amount diff| ≤ 5% of the larger). These go
   to Claude.
3. Detect **duplicates** within the bank set (same amount + same date + same
   description, different row): mark all-but-first as `duplicate_of: <id>` before
   matching, exclude duplicates from matching.

LLM adjudication (skip the call entirely if there are no candidate pairs):

*System prompt:*
> You are a professional accountant performing a bank reconciliation. You are given
> unmatched ERP transactions, unmatched bank transactions, and candidate pairs a
> deterministic matcher flagged as possibly related. Decide which candidate pairs are
> true matches. A true match is the same underlying economic transaction — allow for
> settlement delays (dates differing by more than 3 days) and small bank fees (amount
> differing by a fee-sized value). Never match two transactions that are clearly
> different payments that coincidentally share an amount. Only reference IDs that
> appear in the data provided.

*User message:* the residual sets + candidates as compact JSON (IDs, ISO dates,
amounts as decimal strings for readability, descriptions).

*Zod schema:*
```ts
z.object({
  reasoning: z.string(),
  confirmedMatches: z.array(z.object({
    erpId: z.string(), bankId: z.string(),
    confidence: z.enum(['high','medium','low']),
    matchReason: z.string(),          // one sentence
  })),
  rejectedPairs: z.array(z.object({
    erpId: z.string(), bankId: z.string(), whyNot: z.string(),
  })),
})
```

Post-validation in code: every ID exists; no ERP or bank ID used twice; confirmed
matches merged with exact matches. Step output:
`{ matchedPairs, unmatchedErp, unmatchedBank, duplicates, stats }` — all recomputed
in code.

### Step 4 — Flag exceptions (llm)

Input: unmatched ERP items, unmatched bank items, duplicates, plus for each unmatched
item its **nearest-miss context** (closest candidate by amount/description, computed in
code) so Claude can classify well.

*System prompt:*
> You are a professional accountant classifying reconciliation exceptions. For every
> unmatched item, choose the most likely reason and write one clear sentence a
> reviewer can act on. Categories: `timing_difference` (a near-identical counterpart
> exists but dates differ by more than 3 days), `amount_mismatch` (same counterparty
> and date but a different amount — often a bank fee), `missing_from_erp` (in the bank
> statement only — possibly an unrecorded transaction), `missing_from_bank` (in the
> ERP only — possibly an uncleared payment), `duplicate` (the same transaction appears
> twice in one source). Classify every item you are given; reference only provided IDs.

*Schema:* `{ reasoning, flags: [{ id, source: 'erp'|'bank', category: <enum above>,
explanation, recommendation }] }`. Code verifies every unmatched item received exactly
one flag (missing → retry once with the omission named).

### Step 5 — Generate reconciliation report (deterministic totals + llm summary)

Code computes the full summary object:

```ts
{
  totals: { erpCount, erpAmountCents, bankCount, bankAmountCents },
  matched: { count, amountCents },
  unmatchedErp:  [{ ...txn, flag }], unmatchedBank: [{ ...txn, flag }],
  duplicates: [...],
  netDifferenceCents,                 // erp total − bank total (excluding duplicates)
  status: 'CLEAN' | 'EXCEPTIONS_FOUND',
}
```

Claude writes only the 3–4 sentence executive narrative for the top of the report
(input: the computed summary; schema: `{ reasoning, narrative }`). The step output is
the summary object + narrative. This object is the single source for the right-hand
output panel, the report page, and the Excel export.

---

## 8. Workflow 2 — AP Matching (M8)

Files: `po` CSV (`po_number, vendor_name, line_item, amount, issued_date, approved_by`)
and `invoice` CSV (`invoice_number, vendor_name, line_item, amount, invoice_date,
due_date`). Steps mirror reconciliation:

1/2. Parse POs / Parse invoices (deterministic, Tracks A/B).
3. **Match invoices to POs** (hybrid): deterministic pass — vendor name normalized
   (lowercase, strip punctuation + `inc/llc/corp/co/ltd`) exact match AND amount within
   2% AND line-item Jaccard ≥ 0.3. Residual candidates (vendor fuzzy-equal via Jaccard
   ≥ 0.6 on name tokens OR amount within 2%) → Claude adjudication, same shape as §7.
4. **Flag** (llm): categories `no_matching_po` (potential unauthorized spend),
   `amount_variance` (matched vendor+line but >2% off — possible billing error),
   `duplicate_invoice` (same vendor + amount + invoice_date within 30 days — detected
   in code, explained by Claude), `past_due` (due_date < today — computed in code).
   An invoice can carry multiple flags.
5. **Approval queue** (deterministic + llm narrative): split into
   `autoApprove: [{ invoiceId, poId, amountCents, vendor, recommendedAction: 'approve' }]`
   (matched, within tolerance, no flags) and `holdForReview: [{ invoice, flags }]`.
   Claude writes the queue narrative.
6. Human gate (workflow status).

Review UX addition for AP: the ReviewBanner shows "Approve all N clean invoices" as
the primary action; flagged items are listed with their flags in the output panel.
(Individual per-invoice approval is out of scope — the decision applies to the
workflow output as a whole; note this in the UI copy.)

---

## 9. Workflow 3 — FP&A Commentary (M8)

Files: `budget` and `actuals` CSVs (`department, category, budgeted_amount|actual_amount,
period` as `YYYY-MM`). Steps (all `main` track, sequential):

1. **Parse & join** (deterministic): full outer join on (department, category, period).
   Missing side → treat missing value as 0 and mark the line `unjoined: true`.
2. **Compute variances** (deterministic): `varianceCents = actual − budget`,
   `variancePct = budget === 0 ? null : variance/budget*100`,
   `direction: 'over'|'under'|'on_track'` (on_track = |pct| ≤ 5 or null).
3. **Rank** (deterministic): sort by `|varianceCents|` desc; top 10 = material.
4. **Commentary** (llm): for each material variance Claude writes 1–2 sentences that
   (a) state the variance factually, (b) offer the most likely category-level driver,
   (c) flag it for management confirmation. *System prompt:*
   > You are a CFO-level financial analyst writing month-end budget-vs-actual
   > commentary for a board report. You do not have access to underlying business
   > context, so: state each variance factually with the amount and direction, offer
   > the most plausible category-level explanation (e.g. headcount timing, vendor
   > invoice timing, milestone payments), and explicitly flag that the specific driver
   > needs management confirmation. Professional, concise, no filler.

   *Schema:* `{ reasoning, varianceComments: [{ department, category,
   commentary }], overallStatus: 'favorable'|'unfavorable'|'mixed' }` — note the
   variance amounts/pcts are **joined back from code**, not echoed by the model.
5. **Board deck content** (llm): executive summary paragraph (3–4 sentences) +
   per-department one-liners. Schema: `{ reasoning, executiveSummary,
   departmentSummaries: [{ department, summary }] }`. Final output object combines
   computed variance table + commentary + summaries. (Cash/runway section: omit —
   demo data has no cash inputs; leave a typed-but-empty field.)
6. Human gate. The reviewer's comment box doubles as the "edited version" channel for
   MVP; inline editing of commentary is out of scope.

---

## 10. API routes (contracts)

All routes: verify session via server client → load workflow via admin client → check
`workflow.org_id === profile.org_id` → proceed. Errors as `{ error: string }` with
proper status codes.

**`POST /api/workflows`** — body `{ type, name? }` (default name:
`"Reconciliation — Jul 23"` style). Creates row (status `idle`), audits
`workflow_created`. → `201 { id }`.

**`POST /api/workflows/[id]/upload`** — `multipart/form-data`: `file`, `fileType`.
Validates: workflow is `idle`; `fileType` legal for the workflow type; extension
`.csv/.xlsx/.xls`; size ≤ 10 MB. Computes sha256 (`node:crypto` over the buffer),
uploads to Storage (upsert), inserts `workflow_files` (replacing any prior row of the
same `file_type`), audits `file_uploaded` `{ filename, size, sha256 }`.
→ `200 { fileId, sha256 }`.

**`POST /api/workflows/[id]/run`** — validates all required files present
(recon: `erp_export`+`bank_statement`; AP: `po`+`invoice`; FP&A: `budget`+`actuals`)
and status is `idle` or `error` (re-run after failure = resume, per D2). Sets
`running` + `started_at`, audits `workflow_launched`, `waitUntil(runWorkflow(id))`.
→ `202 { status: 'running' }`. `export const maxDuration = 300`.

**`GET /api/workflows/[id]/status`** — returns
`{ workflow: { id, name, type, status, error_message, created_at, completed_at },
   steps: [ { id, step_number, track, name, status, agent_reasoning, input_snapshot,
              output, sources, model, input_hash, started_at, completed_at } ],
   review: latestDecision | null }`.
Include full step outputs — payloads are small (≤ a few hundred KB) and it keeps the
client dumb. Also performs the stale-step check (D2): a step `running` > 3 min flips
step + workflow to `error` before responding.

**`POST /api/workflows/[id]/review`** — body `{ decision, comment? }`. Requires status
`awaiting_review`. Inserts `review_decisions`, sets workflow status
(`approved` / `rejected` / for `revision_requested` set status back to
`awaiting_review` and just record the decision), audits `review_submitted`
`{ decision, reviewer: profile.id }`. → `200`.

**`GET /api/workflows/[id]/report?format=xlsx`** — requires status `approved`.
Builds the workbook (§12) and returns it with
`Content-Disposition: attachment; filename="finflow-<type>-<id-prefix>.xlsx"`.

---

## 11. Frontend

### 11.1 Theme (Tailwind tokens in `globals.css`)

```
--background:#0a0a0a  --card:#111111  --border:#1f1f1f
--foreground:#ededed  --muted:#666666
--accent:#3ecf8e  --warning:#f59e0b  --error:#ef4444  --running:#3b82f6
```
Sans: system stack or Geist. Mono (data tables, agent output, hashes):
`ui-monospace, 'SF Mono', Menlo, monospace`. Dark theme only — set
`<html class="dark">`, don't build a toggle.

### 11.2 Auth + shell

`/login`: email/password sign-in + sign-up tabs (Supabase `signInWithPassword` /
`signUp` via a client component using the browser client from `@supabase/ssr`).
`middleware.ts` refreshes the session and redirects unauthenticated `(app)` routes to
`/login`. `(app)/layout.tsx`: slim left sidebar (logo, Dashboard, New workflow,
Settings, sign-out) — keep it minimal.

### 11.3 Dashboard (`/dashboard`)

Server component. Three quick-launch cards (one per workflow type, each a link to
`/workflows/new?type=…`), a table of workflows (name, type badge, status badge,
created, link), and a "Recent activity" feed — last 15 `audit_log` rows across the
org rendered as monospace lines:
`14:32:07  agent   step_completed   Match transactions   recon — Jul 23`.
Status badge colors: idle=muted, running=blue pulsing dot, awaiting_review=warning,
approved=accent, rejected/error=error.

### 11.4 Creation wizard (`/workflows/new`)

Single client page, three inline stages (not routes):
1. Type picker (three cards; preselected from `?type=`), showing each type's required
   files.
2. Uploads: one `FileDropzone` per required file type (drag-drop + click, shows
   filename/size/sha256 short-hash + green check after upload). Creates the workflow
   row on entering stage 2 (so uploads have an id).
3. Confirm & launch: file list recap → POST `/run` → `router.push('/workflows/[id]')`.

### 11.5 Live workflow view (`/workflows/[id]`) — **the hero screen**

Client component wrapping `useWorkflowStatus(id)`:

```ts
// SWR-style: fetch immediately, then every 2000ms while status === 'running';
// stop polling on terminal/awaiting states; refetch once after review actions.
```

Layout: `grid grid-cols-[420px_1fr]`, full height.

**Left panel — execution trace.** Steps grouped by track: parallel tracks A/B render
side-by-side as two mini-columns joined by a connector into the main column below
(simple flex, no graph library). Each `StepCard`:
- Header row: status glyph (pending: hollow gray circle · running: blue dot with
  `animate-ping` halo · complete: green check · error: red ✕), step name, track chip
  (`A`/`B`/`main`), completion time (`14:32:07`) when done.
- Collapsed by default; running step auto-expands; chevron toggles. Expanded body
  (mono, 12px): **Reasoning** (agent_reasoning), **Input** (pretty-printed
  input_snapshot, capped height with scroll), **Output** (pretty-printed JSON, capped),
  **Sources** (file + note lines), **Model + input hash** footer for llm steps.
- New steps appearing / transitioning should feel terminal-like: subtle fade+slide-in
  on status change (CSS transitions keyed on status).

**Right panel — `OutputPanel`.** Renders the *final deliverable so far*, by type:
- Reconciliation: summary stat row (ERP total, bank total, matched, net difference —
  formatted from cents), then tables: Matched (collapsed by default), Unmatched ERP
  with flag chips, Unmatched bank with flag chips, Duplicates. Before step 5 exists,
  render whatever prior steps produced (e.g. after step 3, the match tables) —
  progressive build-up is the point.
- AP: Auto-approve table + Hold-for-review table with flag chips.
- FP&A: executive summary block, variance table (top 10, red/green pct), department
  summaries.
- Empty/loading states: skeleton rows while `running` with no output yet.

**Bottom — `ReviewBanner`.** Renders only when status is `awaiting_review`: prominent
bar (warning border) with comment textarea + three buttons: Approve (accent),
Request revision (warning), Reject (error). On approve → banner swaps to "Approved by
{email} at {time}" + "View report →" link. Error status renders an error banner with
`error_message` and a "Re-run" button (POSTs `/run` again — resume semantics).

### 11.6 Report page (`/workflows/[id]/report`)

Server component; requires `approved` (else redirect to the workflow). Renders the
final output (same components as OutputPanel, print-friendly), then an **Audit
Certificate** section (§12), then buttons: "Download Excel" (hits the report API) and
"Print / Save as PDF" (`window.print()` + a `@media print` stylesheet that forces
white background/black text). Puppeteer is out of scope.

### 11.7 Settings

Minimal: org name, member list (email, role) from `profiles`. Read-only for MVP plus
sign-out. Don't build invitations.

---

## 12. Excel report + audit certificate (`lib/excel/writer.ts`)

`buildWorkbook(workflow, steps, files, decision, reviewerProfile)` → SheetJS workbook:

- **Sheet "Summary"** — title, run date, status; type-specific summary block
  (recon: totals/matched/net difference; AP: queue counts+amounts; FP&A: exec summary
  text + overall status).
- **Type-specific detail sheets** — recon: `Matched`, `Unmatched ERP`, `Unmatched
  Bank`, `Duplicates`; AP: `Auto-Approve`, `Hold for Review`; FP&A: `Variances`
  (all lines, material flagged), `Commentary`.
- **Sheet "Audit Certificate"** — exactly:
  - Workflow: id, type, launched at, completed at.
  - Files: one row each — filename, size bytes, **SHA-256** (full hex).
  - Steps: one row each — number, name, track, model (or `deterministic`), input
    hash, started_at, completed_at, duration.
  - Review: reviewer email, decision, timestamp, comment.
  - Footer line: `Generated by FinFlow · agent model claude-sonnet-4-6 · all step
    inputs hashed with SHA-256 at execution time`.

Amounts written as numbers (dollars, 2dp) with `z: '#,##0.00'` number format; dates as
ISO strings. Set column widths (`!cols`) so nothing renders truncated.

The same data drives the on-page Audit Certificate component (`AuditTrail.tsx`).

---

## 13. Demo data (`scripts/generate-demo-data.ts` → `demo-data/`)

A deterministic script (fixed seed, no `Math.random` without a seeded PRNG — implement
a tiny mulberry32) that writes the six CSVs **and**
`demo-data/expected-results.json` containing the counts below. Commit the outputs.
Script asserts its own expectations before writing (fail loudly if the planted
anomalies drift).

**Reconciliation** — `erp_export_demo.csv` (50 rows), `bank_statement_demo.csv`
(50 rows), June 2026 dates, realistic vendor/payroll/SaaS descriptions:
- 44 clean pairs: identical amounts, bank date = ERP date + 0–2 days, near-identical
  descriptions.
- 2 timing differences: identical amount/description, bank date = ERP date + 5–6 days.
- 1 fee mismatch: `Wire transfer — Meridian Supply Co` ERP $12,500.00 vs bank
  $12,485.00 (same date).
- 3 ERP-only rows (missing from bank).
- Bank side: 44 + 2 + 1 = 47 counterparts, + 1 exact duplicate of one clean row,
  + 2 bank-only rows = 50.

**Expected outcome** (this is the acceptance oracle): matched = 44 exact + 2
Claude-confirmed timing + 1 Claude-confirmed fee match *or* those 3 flagged unmatched —
either is acceptable, but the flags must be: 2 × `timing_difference`, 1 ×
`amount_mismatch`, 3 × `missing_from_bank`, 2 × `missing_from_erp`, 1 × `duplicate`.
Status: `EXCEPTIONS_FOUND`. Net difference must equal the code-computed value exactly.

**AP** — `purchase_orders_demo.csv` (18), `invoices_demo.csv` (20):
15 clean matches within 2% (one at exactly 1.9% variance), 3 invoices with no PO,
1 duplicate invoice pair (same vendor+amount, 12 days apart — counts inside the 20),
1 matched invoice at 8% variance. Expected: auto-approve 14–15, hold 5–6 (the 1.9%
edge case may legitimately land either side if it also carries no flag — pin it: no
other flags, so it must auto-approve; expected = 15 / 5).

**FP&A** — `budget_demo.csv` + `actuals_demo.csv`: 8 departments × 6 categories,
period `2026-06` (48 lines each). 3 material variances: R&D/Payroll +$150,000 over;
Marketing/Advertising −$80,000 under; Operations/Cloud Infrastructure +$45,000 over.
All other lines within ±4%. Expected: those 3 are ranks 1–3 by |variance|;
`overallStatus: 'unfavorable'` (net over budget).

Add an npm script `npm run demo-data` (tsx). The wizard's empty state links to the
demo files' names so a demo is: sign up → new workflow → drop the two demo CSVs → run.

---

## 14. Milestones & acceptance criteria

**M0 — Scaffold.** `create-next-app` (TS, App Router, Tailwind), shadcn init (dark),
deps, `.env.example`, `lib/format.ts`, theme tokens, git init + first commit.
✓ `npm run build` passes; `/` renders a dark placeholder.

**M1 — Database + auth.** Migration file (§4) applied; supabase clients + middleware;
login page; auth guard; profile auto-created on signup.
✓ Sign up → land on `/dashboard`; `profiles` row exists; signed-out hit on
`/dashboard` redirects.

**M2 — Demo data + parser.** §13 script + committed CSVs; `lib/csv/parser.ts` with
unit tests (vitest) for amount/date/header normalization and the demo files parsing to
exactly 50/50, 18/20, 48/48 rows.
✓ `npm test` green; `npm run demo-data` idempotent.

**M3 — Create + upload.** Dashboard shell with quick-launch; wizard; upload route with
sha256; files land in Storage under the D5 path convention; audit rows written.
✓ Create a reconciliation workflow, upload both demo CSVs, see them checked in stage 3;
`workflow_files` rows carry correct sha256 (verify against `shasum -a 256`).

**M4 — Agent engine + reconciliation steps.** `matching.ts` (unit tests: on demo data
the deterministic pass yields exactly 44 exact matches, 3 candidate pairs, 1 bank
duplicate), `client.ts`, `runner.ts`, `reconciliation.ts`, run/status routes.
✓ POST `/run` on the M3 workflow → within ~60s status is `awaiting_review`, 5 step
rows `complete`, flags match §13 expectations, audit_log has start/complete pairs per
step with input hashes.

**M5 — Live view.** `useWorkflowStatus`, StepCard/WorkflowTrack/LiveWorkflowView/
OutputPanel. ✓ Launch from the wizard and *watch* steps go pending→running→complete
with reasoning expandable; right panel builds up progressively; stale/crash path shows
the error banner with working Re-run.

**M6 — Review gate.** ReviewBanner + review route + decision states.
✓ Approve writes `review_decisions` + audit row and flips status; reject path works;
report link appears on approval.

**M7 — Report + Excel + audit certificate.** Report page, print stylesheet, xlsx
route, AuditTrail component. ✓ Downloaded workbook opens in Excel/Numbers with all
sheets, correct number formats, full SHA-256 hashes and reviewer signature line.
**⛔ Checkpoint: end of first pass — demo the full loop before continuing.**

**M8 — AP + FP&A.** §8 + §9 agents, wizard/file-type wiring, OutputPanel variants,
report sheets. ✓ Both run end-to-end on demo data hitting §13 expected results.

**M9 — Polish.** Dashboard activity feed live-ish (refresh on focus), empty states,
loading skeletons, favicon/title, README (setup, env, migration, demo script,
architecture notes referencing this plan's locked decisions).

---

## 15. Known risks & handling

- **Vercel duration:** whole recon run ≈ 3 Claude calls ≈ well under 300s. FP&A step 4
  is the longest single call; if any call would need > 16000 output tokens, tighten the
  prompt instead of streaming.
- **Claude returns an unknown ID / misses an item:** handled by validate-retry-error
  (§5.3, §7); the workflow-level `error` + resume keeps the demo recoverable.
- **Local dev has no `waitUntil`:** `@vercel/functions` `waitUntil` works under
  `next dev`; if it ever doesn't, fall back to firing `runWorkflow(id)` without await
  and `catch`-logging — same semantics.
- **Structured outputs schema limits:** no min/max/length constraints in Zod schemas
  destined for `zodOutputFormat` (the SDK strips + client-validates, but keep schemas
  plain anyway); no recursion.
- **Duplicate demo bank row vs matching:** duplicates are excluded before matching
  (§7 step 3) — otherwise the duplicate steals the match and the expected counts break.
- **RLS + service role:** never import `admin.ts` into anything under `components/`
  or a client component; it must only be referenced from `app/api/**` and `lib/agents/**`.

---

*End of plan. Build M0 first.*
