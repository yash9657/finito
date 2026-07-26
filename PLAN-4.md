# PLAN-4 — The event-sourced harness

> Plan 4 turns FinFlow's workflow engine into a real agent harness: one typed event stream
> as the sole history, one action/observation loop every step passes through, a role registry
> that constrains what each agent may propose, deterministic verification ahead of execution,
> and Mastra as the durable DAG substrate.
>
> Locked decisions are **D-H1 … D-H18**. Read §0 first — the brief that commissioned this plan
> assumed a prototype that no longer matches the repo, and §0 records what is actually new.

---

## 0. Starting position (what the brief got wrong, and why it matters)

The commissioning brief describes FinFlow as "a sequential-API-call prototype" and asks for
several things as greenfield builds. Three of them already exist, shipped and tested:

| Brief asks for | Already in the repo |
| --- | --- |
| Part 2 — provider-agnostic router, one file per provider, BYOK | `lib/llm/router.ts` + `lib/llm/providers/{anthropic,openai,google,ollama,custom-endpoint}.ts`, `resolveProvider` order D-P7, AES-256-GCM key encryption, 5 providers |
| Part 5 — deterministic business-rule gate + hardcoded high-risk floor | `lib/approvals/{risk,engine,service,action-types}.ts` — risk taxonomy as a data table, `evaluateAction()` in fixed order ceilings → rules → human, non-overridable structural ceilings |
| Part 6 — settings UI, masked keys, test connection, usage from event data | `/settings/models`, `components/settings/*`, `app/api/llm/*` incl. `/test` and `/usage` |
| Part 4 — suspend/resume as the HITL primitive | `orchestrator.ts` suspends on `awaiting_approval`, persists pending items in `action_requests`, resumes idempotently from the last completed step |
| Part 3 — DAG of role invocations, concurrency, retries | `lib/agents/dag.ts` (validated graphs, cycle detection) + `orchestrator.ts` (ready-set scheduling, concurrent waves, 3 attempts w/ 1s/4s backoff) |

The orchestrator is **not** a sequential runner. It already schedules concurrent waves, already
gates consequential actions before they execute, and already survives a process restart —
because resume is driven by durable DB step status, not by an in-memory snapshot.

So what is genuinely new in Plan 4:

1. **The single event stream (Part 1).** Today history is split three ways: `workflow_steps`
   columns (provenance), `audit_log` (the authorization chain), and step `output` blobs. There is
   no one ordered, tamper-evident sequence you can replay. **This is the real work.**
2. **The formal propose → verify → execute → observe loop (Part 1).** Today's gate is
   propose → authorize → run. There is no *verification* stage distinct from *authorization*, and
   no `observation_received` as a first-class input to the next step.
3. **Role constraints as code (Part 3).** `StepRole` exists but is documented as
   "informational grouping" — it constrains nothing. A `writer` step could propose
   `book_journal_entry` today and nothing would stop it.
4. **Per-action-type verifiers (Part 5).** The approvals engine answers *"who may allow this?"*
   It never answers *"is this action even well-formed?"* — nothing checks that a journal entry
   balances.
5. **Realtime instead of polling (Part 7).** `lib/hooks/useWorkflowStatus.ts` polls.
6. **Mastra as the substrate (Parts 3/4).** Replaces a hand-rolled scheduler with a maintained
   one, and upgrades resume from step-status-driven to snapshot-driven.

**D-H1 — Extend, don't restart.** Where working tested code already satisfies the brief's
*structural* intent, Plan 4 extends it in place rather than rebuilding to match the brief's
literal file layout. Every such deviation is recorded in this plan (D-H7, D-H8, D-H16). The
150 existing tests stay green throughout; a milestone that breaks one is wrong until proven
otherwise.

---

## 1. Part 1 — the event-sourced core

### D-H2 — `harness_events` is the only history

One table, append-only, monotonic per workflow. Every other view of a run's past — the live
step cards, the Harness Trace, the audit certificate, the usage dashboard — becomes a query
over it. `workflow_steps` degrades to a *projection* (current status for cheap UI reads);
`audit_log` stays only for the legacy runner until it is deleted (D-H17).

Columns exactly as the brief specifies: `id, workflow_id, step_id, sequence_number,
event_type, actor, payload, provider_used, model_used, input_hash, created_at`.

### D-H3 — Sequence allocation is atomic in Postgres, not in Node

`sequence_number` must be gapless and monotonic *per workflow*, but the harness writes events
from concurrently running parallel steps. Allocating in Node (read max, add one, insert) races
and produces duplicates under exactly the parallelism Part 7 wants to show off.

So the append path is a single `plpgsql` function, `public.append_harness_event(...)`, which
takes a row lock on the parent `workflows` row, allocates `max(sequence_number)+1`, and inserts
— one round trip, serialized per workflow, concurrent across workflows. A
`unique (workflow_id, sequence_number)` constraint makes a bug here loud rather than silent.

`lib/harness/events.ts` is the only module that calls it. Nothing else inserts into the table.

### D-H4 — Append-only is enforced by the database

No `UPDATE` or `DELETE` policy exists on `harness_events`, and `update`/`delete` are revoked
from `anon` and `authenticated`. The service role can insert (via the function) and read.
Tamper-evidence is not a convention here; it is a missing grant.

`input_hash` is the SHA-256 of the canonical JSON of whatever input the event consumed, via the
existing `sha256Json` (`lib/audit.ts`) — key-sorted, so the same logical input always hashes
identically.

### D-H5 — Org-scoped SELECT, because Part 7 reads it from the browser

Realtime needs authenticated clients to subscribe. `harness_events` gets a SELECT policy
scoped through `workflows.org_id = public.auth_org_id()`, matching the 003 pattern for
`action_requests`. This makes payload hygiene load-bearing: **D-H6**.

### D-H6 — Payloads are redacted at the boundary, and keys are structurally absent

An API key cannot reach a payload, because payloads are built in `lib/harness/loop.ts` and
`lib/harness/events.ts`, neither of which can see one — decrypted keys live only inside
`resolveProvider → invoke → provider` frames (Plan 2 §9), and `ResolvedProvider` is never
serialized. Raw provider responses pass through the existing `redactAndCap` before storage.
`events.ts` additionally strips any key whose name matches the redaction denylist as a
defence-in-depth backstop, and a unit test asserts a planted key never survives an append.

### D-H7 — The event vocabulary adds one type the brief omits

The brief lists eleven event types and separately requires an
`action_failed_verification` event in Part 1 step 2. That makes twelve, and the twelfth is the
one that proves the safety story, so it is in the enum:

```
step_started | action_proposed | action_verified | action_failed_verification |
action_executed | observation_received | step_completed | step_failed |
human_review_requested | human_decision | workflow_paused | workflow_resumed
```

### D-H8 — `executeStep()` owns the lifecycle; roles own only the work

`lib/harness/loop.ts` exports one function. Its contract:

```
executeStep({ workflowId, orgId, stepId, role, stepKey, input })
  → step_started
  → role.propose(input)                     → action_proposed  (one per action)
  → verify(action)                           → action_verified | action_failed_verification
  → (high risk or unresolved) ⇒ human_review_requested + suspend
  → role.execute(action, decisions)          → action_executed
  → observe(result)                          → observation_received
  → step_completed | step_failed
```

Two invariants, both enforced in code rather than by convention:

- **No LLM call happens outside this loop.** `lib/harness/roles/*` receive a `dispatch` closure
  from the loop; they never import the router, and the router is not reachable from workflow
  code. (Enforced by an ESLint `no-restricted-imports` rule so a future step cannot regress it.)
- **Nothing executes before it verifies.** `verify` is a pure function call between
  `propose` and `execute` in a single function body — there is no code path that reaches
  `role.execute` without a passing verdict, because the verdict is the argument.

### D-H9 — Verification and authorization are two distinct stages, in that order

This is the distinction the brief's Part 1 step 2 and the existing `lib/approvals/` layer each
capture half of:

| Stage | Question | Owner | Verdict |
| --- | --- | --- | --- |
| **Verification** (new) | Is this action well-formed and legal? Does the entry balance? Is the amount within PO tolerance? Is this transaction already matched? | `lib/harness/verifiers/*` | `{ pass, reason?, riskLevel }` |
| **Authorization** (exists) | Given it is legal — who is permitted to allow it? A standing rule, a human, or nobody? | `lib/approvals/engine.ts` | ceilings → rules → human |

Verification runs first and can hard-fail an action before anyone is asked to approve it. A
malformed action is never put in front of a reviewer — that is the point: reviewers must not be
trained to rubber-stamp things the machine could have rejected itself.

### D-H10 — `riskLevel: 'high'` from a verifier forces human review, non-negotiably

A high verdict emits `human_review_requested` and suspends, **regardless of org config,
standing rules, or the agent's own confidence**. It is a floor, not a default: there is no
org setting, no env var, and no function parameter that disables it. This mirrors the existing
`hard_deny_above_cents` ceiling (D-A4), which is likewise not overridable by an in-band click.
Both facts are commented as intentional at their definition sites.

---

## 2. Part 2 — the provider router

### D-H11 — `testConnection()` moves onto the provider interface

The brief's `LLMProvider` requires it. Today the equivalent lives in
`lib/llm/config-service.ts:testProviderConnection()` — which, checked rather than assumed, is
already provider-agnostic: it calls `provider.complete` with a minimal prompt and does not
branch on provider id. So the brief's "one new file, nothing else changes" property already
held, and moving the probe would only have duplicated one generic implementation five times.

What the interface method actually buys is the ability to **override**. So: `testConnection` is
on the interface, its generic body lives once as `defaultTestConnection` in `provider.ts`, and
four providers delegate to it. **Ollama overrides it** — `/api/tags` lists the models actually
pulled on the host, which answers the real question ("is this model present on my box?"), costs
no tokens, and avoids the spurious timeouts a cold-start local model produces against a
completion probe. That is the case that justifies the method existing at all.

### D-H12 — The interface stays a superset of the brief's

The brief's `complete()` signature drops `jsonSchema` (native structured-output enforcement,
D-P9) and `reasoningNative` (Anthropic thinking blocks), both of which the current providers use
and tests cover. Narrowing to the brief's literal interface would be a capability regression, so
the existing shape is kept and `testConnection` added. The brief's *structural* requirement —
one file per provider, nothing else imports an SDK — already holds and is now lint-enforced.

### D-H13 — `dispatch()` is the named entry point, resolving by `(org, role)`

`router.dispatch({ orgId, workflowType, role, stepKey, system, user, schema })` wraps the
existing `resolveProvider` + `invoke`. Resolution order is unchanged (D-P7: per-step pin → org
default → env fallback → throw); `role` is added as a resolution key so the brief's
"matcher on Claude, commentary on local Ollama, same run" works without touching step code.
`invoke()` stays exported for the legacy runner until it is deleted.

Mid-run model swapping is a property of resolving per step rather than per run, which is already
true — Plan 4 only makes `role` a first-class key and surfaces `provider_used`/`model_used`
on every LLM-generating event so the swap is visible in the trace.

### D-H14 — Provider files stay at `lib/llm/providers/`

The brief specifies `lib/harness/providers/`. Moving five tested files plus their registry and
three test files to satisfy a path string is churn with no functional gain; `lib/harness/` holds
what is actually new (`events`, `loop`, `roles`, `verifiers`). **Flagged for objection** — if the
single-directory reading matters, it is a mechanical `git mv` plus an import rewrite and can be
done at any point.

---

## 3. Part 3 — roles as enforced constraints

### D-H15 — A role is a registry row, and its allowed action types are a closed set

`lib/harness/roles/{parser,matcher,classifier,writer}.ts`, each declaring: a fixed system-prompt
template, a zod output schema, and `allowedActionTypes: readonly string[]`. `executeStep()`
rejects a proposed action whose type is outside the proposing role's set — before verification,
as a programming error (`action_failed_verification` with an `illegal_action_type` reason), not
a business-rule failure. `writer` cannot propose `book_journal_entry` because the array does not
contain it, and the check is in the loop, not in a prompt.

`verifier` is **not** a role in this registry — it is not an LLM and proposes nothing. It lives
in `lib/harness/verifiers/` (§4). Putting it in `roles/` would imply it can be dispatched to a
provider.

### D-H16 — Existing step definitions keep their prompts byte-identical

`lib/agents/{reconciliation,ap-matching,fpa-commentary}.ts` prompt strings are tested product
surface (Plan 2, and PLAN-3 held them byte-identical through the approvals migration). Porting a
step to a role means moving the same string into the role's template, unchanged. Any deliberate
prompt revision is a separate commit with its own justification.

---

## 4. Parts 4 & 5 — Mastra substrate, verifiers, and the resume story

### D-H17 — Mastra owns orchestration mechanics only

Verified against the installed `@mastra/core@1.52.1` (not the docs prose): `createWorkflow`
+ `createStep` with `.then()/.parallel()/.branch()/.map()/.commit()`, `retries` per step,
`createRun({ runId })` → `run.start()/.resume({ step, resumeData })`,
`workflow.getWorkflowRunById(runId)` for cross-process recovery, and `.watch()`/`.observeStream()`
for progress.

The split: Mastra handles the DAG, concurrency, retries, and snapshotting. The harness layer
handles verification, the event stream, provider routing, and authorization. Each Mastra step's
`execute` is a thin wrapper that calls `executeStep()` — so **Mastra never becomes the history**.
Its snapshot is execution state for resuming; `harness_events` remains the audit truth. Two
stores, one authority, stated deliberately (a snapshot is mutable and Mastra-versioned; an audit
trail can be neither).

Human gates map onto Mastra's native `suspend()`/`resumeSchema`, replacing the custom
`awaiting_approval` status flag — per the brief's explicit instruction not to hand-roll polling.

### D-H18 — Mastra durable storage needs a credential the repo does not have

`PostgresStore` from `@mastra/pg` needs a direct Postgres connection string.
`.env.local` holds only Supabase REST credentials (`NEXT_PUBLIC_SUPABASE_URL`, anon key,
service-role key) — there is no `DATABASE_URL`, and the project's DB password is
outstanding-for-rotation per HANDOFF §1.1.

**Required from the user before Part 4:** a `DATABASE_URL` (Supabase → Settings → Database →
connection string, pooler host, port 6543 for serverless). Parts 1–3 do not need it. Until it
exists, Mastra work runs on `@mastra/libsql` locally, which is sufficient for the kill-and-resume
test but **not** for deployment — a file-backed snapshot store on serverless is not durable.

### Verifiers (Part 5)

`lib/harness/verifiers/{journal-entry,reconciliation-match,ap-match}.ts`, each
`(action, context) => { pass, reason?, riskLevel }`, pure and non-LLM:

- **journal-entry** — debits equal credits to the cent (integer cents, never floats); account
  codes present in the supplied chart of accounts; over the org threshold ⇒ `high`.
- **reconciliation-match** — amounts within org tolerance; dates within org window; target not
  already matched (the double-match check reads committed matches, so it is resume-safe).
- **ap-match** — invoice-to-PO within the configured percentage band.

Registered by `action_type` in one table, so an unregistered action type fails closed with
"no verifier registered" rather than passing unverified.

---

## 5. Sequencing (the brief's Part 8, with the gate made explicit)

| # | Milestone | Gate |
| --- | --- | --- |
| **H0** | ✅ Mastra installed alongside; nothing deleted | typecheck + build + 150 tests green |
| **H1** | ✅ `004_harness_events.sql` + `lib/harness/events.ts` | 20 unit tests; DB-side guarantees verified against real Postgres (below) |
| **H2** | ✅ `dispatch()` + role resolution tier + `testConnection()` on the interface | 12 router tests, incl. two roles resolving to different providers in one run |
| **H3** | ✅ **PROOF PASSED** — `npm run harness-proof` against live Supabase + a real Claude call | 18 events, gapless, parse steps genuinely interleaved, correct attribution, no key material |
| **H4** | ✅ (built early — the loop cannot be uniform without them) Verifiers + role registry with enforced action-type sets | unbalanced journal entry rejected pre-execution; writer cannot propose a ledger post |
| **H5** | ✅ Reconciliation on Mastra, side by side with the old runner | 9 tests: resume-from-last-completed-step, provider swap (Claude vs mocked local, both valid, both audited), identical event shape across providers |
| **H6** | Realtime live view + Harness Trace | parallel steps visibly concurrent |
| **H7** | Port AP matching + FP&A commentary | per-workflow parity |
| **H8** | Delete the old sequential runner and `audit_log` | full suite green on the new path only |

H3 is the load-bearing checkpoint the brief asks for, and it is deliberately placed before the
Mastra rewrite: if the event stream and router cannot carry one trivial step, no amount of DAG
substrate will save it.

### What has actually been verified against a real database

The DB-side guarantees cannot be proven by unit tests with a fake client, so all five
migrations were applied to a throwaway `postgres:17` container (with minimal `auth`/`storage`
stand-ins) and the invariants exercised directly:

| Claim | Result |
| --- | --- |
| 001–005 apply cleanly in order | ✅ all five, no errors |
| **D-H3** gapless per-workflow sequencing under concurrency | ✅ 12 concurrent writers × 20 appends on one workflow → 240 events, `min=1`, `max=240`, 240 distinct |
| Sequencing is per-workflow, not global | ✅ two workflows interleaved → `{1}` and `{1,2}` |
| **D-H4** append-only at the grant level | ✅ `anon`/`authenticated` hold **zero** privileges on `harness_events` |
| Unknown workflow is rejected, not silently orphaned | ✅ raises `unknown workflow <uuid>` |
| Event vocabulary is enforced by the DB | ✅ a bogus type violates `harness_events_event_type_check` |

The Realtime `alter publication` is guarded by an `if exists` check on `supabase_realtime`, so
it no-ops on vanilla Postgres and applies on Supabase — which is why the container run did not
need it stubbed.

### Mastra semantics worth knowing before touching H5 (all verified, not read off docs)

- **`restart()`, not `resume()`, is the crashed-run entry point.** `resume()` is for runs that
  suspended intentionally. `restart()` requires the snapshot status to be `running`/`waiting` and
  passes `stepResults: snapshot.context` through, which is what makes completed steps skip.
- **A cancel is not a crash.** `run.cancel()` writes status `canceled`, and `restart()` rejects
  that outright with "This workflow run was not active". A `SIGKILL` leaves `running`, because
  nothing gets to write a terminal status. Any test that cancels and then expects to restart is
  testing the wrong thing.
- **`start()` has no `abortSignal`.** Passing one type-errors, and would have been silently
  ignored at runtime. Nothing cancels a step already in flight either, so an "interrupted" run
  will happily finish the graph in the background — which silently made a step run twice while the
  H5 assertions were being written.
- **"Resume from the last completed step" means completed, not attempted.** A step interrupted
  mid-flight correctly re-runs; only steps with persisted results are skipped. The tests assert
  both halves of that.
- **`getStepResult` returns `null`, not `undefined`,** for a step that has not produced a result.
- **Prior outputs must be collected from every completed step, not just declared dependencies.**
  The old runner builds `priorOutputs` from all completed steps, and the real graph relies on it:
  `report` declares `dependsOn: ["flag"]` but reads `parse_erp`, `parse_bank` and `match` as well.
  Passing only declared dependencies would have broken it — caught by the H5 tests.

### Verified live (2026-07-25)

Migrations 004/005/006 are applied to `lveaycbnqnphgbszrogn` and recorded in
`supabase_migrations.schema_migrations` as 004/005/006 — so CI's `supabase db push` will not retry
them and hit "already exists" (the trap HANDOFF §1.1 described for 001/002).

`npm run harness-proof` passes both phases:

- **Phase 1 (H3).** `parse_erp ∥ parse_bank` concurrently plus a real `match` call on
  `anthropic/claude-sonnet-4-6` → 18 events, gapless, the two parse steps visibly interleaved in
  the stream, LLM events attributed and deterministic ones not, every step input-hashed, and a scan
  for the live key's own characters across all payloads finds nothing.
- **Phase 2 (H5, the brief's kill test).** A child process starts a real run on durable Postgres
  snapshots; the parent SIGKILLs its **process group** once `match` begins, waits for the event
  stream to go quiet, confirms the snapshot survived at status `running` carrying the completed
  parse results, then restarts the run in a different process. `parse_erp`/`parse_bank` do not
  re-run; `match` shows two `step_started` and one `step_completed`, which is the correct
  completed-vs-attempted distinction; the run finishes with `report` running once.

Two bugs in the proof itself, both worth remembering because each produced a **false pass**:

- **Signal the process group, not the child.** `spawn("npx", …)` does the work in a grandchild, so
  `child.kill()` killed only the wrapper. The orphan kept running and kept appending to the same
  event stream, so two runs raced and a contaminated run read as a clean resume (`flag` and
  `report` each executed twice, interleaved). Fixed with `detached: true` + `process.kill(-pid)`.
- **Assert the stream goes quiet.** The guard that now catches the above: if any event arrives in
  the second after the kill, a survivor is still writing and the phase fails rather than proceeding.
  "Nothing new was written" is the observable that separates a dead process from an unwatched one.

### Security finding: TRUNCATE was granted to client roles (fixed in 006)

Found by checking grants on the live project after applying 004 — **not reproducible locally**,
because Supabase grants `ALL` on new `public` tables to `anon`/`authenticated` by default while a
vanilla Postgres gives those roles nothing. Every table in the schema, including `audit_log` and
the Plan 3 authorization tables, carried INSERT/UPDATE/DELETE/TRUNCATE/TRIGGER/REFERENCES.

Severity, stated precisely rather than dramatically:

- INSERT/UPDATE/DELETE were already inert — RLS is on everywhere and there is not one write policy
  in the schema (every policy is SELECT-only; all writes go through the service role, D5).
- **TRUNCATE is the real finding: Postgres RLS does not apply to TRUNCATE.** A role holding it can
  empty a table whatever the policies say, which for `audit_log`/`harness_events` is the difference
  between an append-only trail and one a client role may erase.
- It was latent, not live: PostgREST exposes no TRUNCATE verb, so there was no route to it through
  the API. But "append-only because the API happens not to offer that verb" is a far weaker claim
  than "append-only because the grant does not exist", and it stops holding the moment someone adds
  a `SECURITY DEFINER` helper or a SQL-executing RPC.

`006_revoke_client_write_grants.sql` revokes every write verb from both client roles on all tables
(keeping SELECT, which the UI and Realtime need) and changes the schema's default privileges so new
tables deny by default. Verified after applying: the only client-role privilege left anywhere in
`public` is SELECT, on 14 tables.

### Remaining before deploy

**`DATABASE_URL` currently points at the direct connection** (`db.<ref>.supabase.co:5432`), which
resolves **AAAA-only** — IPv6 with no A record. That works from a developer machine with IPv6
egress, and it is what the migrations and the proof script ran over. It will likely **fail from
Vercel**, whose functions have historically had no IPv6 egress. Before deploying, switch it to the
transaction pooler (`aws-0-<region>.pooler.supabase.com:6543`, user `postgres.<ref>`), which is
dual-stack. `hasDurableSnapshotStore` in `lib/harness/mastra.ts` reports whether a durable store is
configured, but it cannot tell whether the host is reachable from the runtime — so this needs a
deploy-time check, not a code one.

Also note: the password contains an `@`, and it **must stay percent-encoded as `%40`**.
`node-postgres` splits userinfo on the last `@` and tolerated the raw form; **libpq splits on the
first**, so `psql` and `supabase db push` failed with
`could not translate host name "2001@db.…"`. Anything that regenerates this value needs to encode it.

HANDOFF §1.1's blocker #1 is **stale**: 003 was already applied, and the CI workflow has both
secrets set with a successful manual run on 2026-07-25.

### Open item carried into H5

Whether Mastra replaces `orchestrator.ts` wholesale or wraps it. The brief says replace, and H5
does that. But §0 is the honest counterweight: the existing executor is tested, already
concurrent, and already restart-safe, so the win is a maintained scheduler and snapshot-based
resume rather than a capability FinFlow lacks. Worth re-confirming at H5 rather than assuming.
