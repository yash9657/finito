# PLAN-5 — The open-ended investigator agent

> Plan 5 adds the first place in FinFlow where the **model chooses what happens next**: an agent that
> can be pointed at whatever financial data an org has and asked an open-ended question — *"why
> doesn't this account tie out?"*, *"what changed in COGS this quarter?"* — and that investigates it.
>
> Locked decisions are **D-G1 … D-G22**. Read §1 first: it is the one architectural constraint that,
> if you get it wrong, makes everything else worthless.

---

## 0. Starting position

Plans 1–4 shipped. What Plan 5 builds on, and does not rebuild:

| Thing | Where | Role in Plan 5 |
| --- | --- | --- |
| Event stream | `lib/harness/events.ts`, `harness_events` | The investigation's entire history. Extended (§3), not replaced. |
| Action/observation loop | `lib/harness/loop.ts` | Unchanged. The agent loop is a *sibling* primitive (§5), not a fork of it. |
| Verifiers | `lib/harness/verifiers/` | Every recommendation passes through `verifyAction` before it can be queued. |
| Role registry | `lib/harness/roles/index.ts` | Gains a fifth role, `investigator`, with a closed action-type set. |
| Authorization | `lib/approvals/{risk,engine,service}.ts` | `recommend_action` calls `gateStepActions` — no new approval mechanism. |
| Provider layer | `lib/llm/*` | Gains tool calling, capabilities, and a salvage layer (§4). The biggest build. |
| Mastra | `lib/harness/mastra.ts` | **Not used by the agent.** See D-G6. |

`npm test` → 240 passing at the start of Plan 5. Supabase project `lveaycbnqnphgbszrogn`, migrations
001–006 applied and recorded.

---

## 1. THE CONSTRAINT

`PLAN.md` D3, defended through four build passes:

> All arithmetic and matching runs in TypeScript. The LLM only adjudicates ambiguity and writes
> prose. Every ID the model returns is validated against source data. Every number is recomputed in
> code.

An open-ended agent appears to contradict this. It does not, if one line holds:

### D-G1 — The agent may decide what to LOOK AT. It may never decide what to CHANGE.

- **Read tools** are the entire investigative surface. The agent calls them freely, as many times as
  it likes, in whatever order it decides. `read` risk class, no approval, every call on the trail.
- **Write actions are not tools.** There is no execute path from the agent to a mutation. The agent
  emits a *recommendation*, which becomes a `ProposedAction` that goes through `verifyAction()` and
  then `lib/approvals/engine.ts` and lands in the existing approval panel for a human.
- **Numbers in the answer are recomputed in code.** The agent writes prose around *placeholders*; the
  figures are computed from cited source rows by TypeScript and substituted in (D-G14). A bare
  monetary literal in the prose is a validation failure, not a stylistic preference.

Everything below is a consequence of this decision.

---

## 2. Decisions carried from HANDOFF-AGENT.md §11

### D-G2 — `investigator` is a fifth `StepRole`

`STEP_ROLES` becomes `['parser','matcher','classifier','writer','investigator']`. Migration 007
widens the `org_role_configs.step_role` check constraint to match.

Why: per-role model assignment then works for the agent **for free**, through the existing
`resolveProvider` tier 2. An org points the `investigator` role at DeepSeek or its own Ollama box in
Settings → Models and nothing else changes. That is precisely the seamless-swap requirement, and
building a parallel assignment mechanism for one role would be the wrong kind of special case.

Cost: the DB check constraint on `org_role_configs.step_role`, and the `STEP_ROLES` array. Checked
rather than assumed — no component or route reads `STEP_ROLES` today (the Settings matrix is keyed
by `step_key`, not by role), so widening it touches nothing in the UI. A role picker, when one is
built, gets `investigator` for free.

### D-G3 — An investigation is a `workflows` row of type `investigation`

`harness_events.workflow_id` is a FK to `workflows`, and the org-scoped SELECT policy, Realtime
publication, cascade delete and audit certificate all key off it. A separate table would mean
duplicating all four.

But `WorkflowType` is *also* the key of `workflowDefinitions` — the three DAGs — and widening that
union would demand a fourth DAG that does not exist. So the vocabulary splits, deliberately:

```ts
WORKFLOW_TYPES      = ['reconciliation','ap_matching','fpa_commentary']   // has a DAG
INVESTIGATION_TYPE  = 'investigation'                                      // has an agent loop
WORKFLOW_ROW_TYPES  = [...WORKFLOW_TYPES, INVESTIGATION_TYPE]              // the DB check constraint
```

`Workflow.type` widens to `WorkflowRowType`; `workflowDefinitions` stays keyed by `WorkflowType`.
`POST /api/workflows/[id]/run` rejects an investigation with a clear message rather than indexing
`workflowDefinitions` with a key it does not have. The `/workflows/new` page iterates
`WORKFLOW_TYPES` and is unchanged — an investigation is created from its own page, because it takes
a question rather than file uploads.

### D-G4 — `investigations` is a projection table, not a second history

One row per investigation: the question, the budget it ran under, the final answer, the termination
reason. Keyed `workflow_id uuid primary key references workflows(id) on delete cascade`.

This is the same relationship `workflow_steps` has to `harness_events` (Plan 4, D-H2): a cheap
current-state read for the UI, derived from and subordinate to the stream. The rule that makes it
safe is that **nothing reads `investigations` to decide what happens next** — the loop's state comes
from its in-memory conversation and, on resume, from the event stream. If the two ever disagree, the
stream is right.

### D-G5 — The default model for `investigator` is higher than for the pipelines

The agent is materially more sensitive to model quality than a fixed pipeline step: a weak parser
produces a bad row, a weak investigator produces a confident wrong narrative after 30 tool calls.
`DEFAULT_INVESTIGATOR_MODEL = 'claude-opus-5'` against `ENV_FALLBACK_MODEL = 'claude-sonnet-4-6'`
for everything else. This applies **only** to the env-fallback tier — an org that has configured a
provider still gets exactly what it configured, and the resolution order (D-P7/D-H13) is untouched.

### D-G6 — No Mastra Agent, and no Mastra workflow either

Mastra's `Agent` class runs its own tool loop with its own model layer, which would bypass the
router, the BYOK keys, the per-role resolution and the verifier gate. That is the reason Plan 4 did
not use it and it has not changed.

Plan 5 goes one step further: an investigation is not a Mastra *workflow* either. Mastra's value is
DAG scheduling and snapshot resume for a graph known in advance; an investigation's shape is decided
turn by turn, so there is no graph to schedule, and the resume story is replay from `harness_events`
(D-G17), which is strictly better than a snapshot because it is the audit record. The agent loop is
~250 lines of `lib/harness/agent/loop.ts` and we need control of every turn of it.

### D-G7 — The agent is stateless across investigations

No learned-rules layer, no memory of prior investigations beyond what `get_workflow_history` reads
from the durable record. The typed learned-rules layer (`HANDOFF.md` Edge #2) is a strong follow-on
and a genuinely different product surface with its own correctness and privacy questions. Shipping
it inside Plan 5 would conflate "the agent can investigate" with "the agent remembers", and the
first has to be trustworthy before the second is safe.

### D-G8 — Cost is estimated before the run and reported after it

The new-investigation form shows the ceiling: max turns × an estimated tokens-per-turn at the
resolved model, as a range, with the wording "up to". The transcript footer shows actual tokens and
the provider/model that produced them, aggregated from the events. No mid-run spend meter — it
would be a live-updating number that the user cannot act on, since the bounds already guarantee
termination.

---

## 3. Part A — event stream extensions (migration 007)

### D-G9 — `caused_by` is the OpenHands `cause` linkage

`harness_events` gains `caused_by uuid references public.harness_events(id)`. An observation points
at the action that produced it: a `tool_returned` cites its `tool_called`, an `agent_answered` cites
the turn that produced it. Without it, a 40-turn investigation is an undifferentiated wall of rows
and the UI cannot pair a call with its result.

Self-referential FK, `on delete cascade` deliberately **omitted** — a cascade path from the stream
to itself is how a single delete could unravel a trail. The parent workflow's cascade is the only
deletion route, and it removes everything at once.

### D-G10 — `turn_number` groups the stream

`turn_number int` on every event the agent writes; null for pipeline events. Index
`(workflow_id, turn_number)` because the trace view queries it constantly.

### D-G11 — Eight new event types, and why two of them are not in the brief

The handoff §4 lists six. Two more earn their place on the same grounds D-H7 used — an event that
only records successes proves nothing:

```
agent_turn_started | agent_reasoning | tool_called | tool_returned |
agent_answered | agent_terminated | context_compacted | provider_state_dropped
```

- `context_compacted` — required by §7 of the handoff. Compaction silently discarding a finding is
  exactly the failure the trail exists to make visible.
- `provider_state_dropped` — when a conversation moves between providers mid-investigation, the
  previous provider's opaque reasoning state (Anthropic thinking signatures, Gemini thought
  signatures) cannot travel with it. D-G13 says we drop it and say so. This is the saying-so.

A salvaged tool call is **not** a new event type — it is `tool_called` with `salvaged: true` and the
salvage strategy in the payload, per the handoff's own wording.

### D-G12 — `append_harness_event` is replaced, not overloaded

Two new parameters mean a new signature. `create or replace` with a different argument list creates
an *overload*, and two overloads reachable by PostgREST named-argument RPC is an ambiguity waiting to
surface at runtime. So 007 drops the 9-argument function and creates the 11-argument one, then
re-applies the `revoke` — a dropped function takes its grants with it, and re-granting by accident is
how the service-role-only property quietly stops being true.

`lib/harness/events.ts` remains the only caller. The gapless-sequence guarantee (proven under 12-way
concurrency, PLAN-4) depends on that.

---

## 4. Part B — tool calling in the provider layer

The bulk of the work. `LLMProvider` is text-in/JSON-out and has no concept of a tool; every provider
expresses tool calling differently and the differences are not cosmetic.

### D-G13 — One canonical message format, with a provider sidecar

`lib/llm/messages.ts` defines the single internal representation:

```ts
CanonicalMessage = { role: 'user'|'assistant'|'tool', content: string,
                     toolCalls?: ToolCall[], toolResults?: ToolResult[],
                     sidecar?: { providerId, data } }
```

Every provider converts to and from it; the agent loop only ever sees canonical messages. This is
OpenCode's transform layer as a named seam rather than scattered `if (provider === …)`.

`sidecar` carries opaque, non-portable provider reasoning state — Anthropic thinking blocks with
their signatures, Gemini parts with thought signatures. When the next turn goes to the **same**
provider they are replayed verbatim (Anthropic rejects a modified thinking block). When it goes to a
**different** provider they are dropped and a `provider_state_dropped` event is appended naming both
providers and the count.

That is the honest version of "seamless model swapping": the conversation continues correctly, with
a recorded, visible loss of provider-specific reasoning state. Silently dropping it is a debugging
nightmare; erroring is a worse product; saying it out loud in the trace is neither.

### D-G14 — `complete()` is extended, and the legacy path stays byte-identical

`LLMCompleteParams` gains optional `conversation`, `tools`, `toolChoice`; `LLMCompleteResult` gains
optional `toolCalls`, `stopReason`, `sidecar`. When all three inputs are absent, every provider
builds exactly the request body it built before — which the existing provider tests assert
byte-for-byte, so they are the regression gate rather than a formality.

Two guards apply in every provider: native JSON-schema output (`output_config`, `response_format`,
`responseSchema`, `format:'json'`) is **not** sent alongside tools. Forcing the model to emit a JSON
object while also offering it tool calls is contradictory, and providers respond to it
inconsistently — which would show up as "tool calling doesn't work on X" rather than as a bug here.

Per provider, the parts that actually differ:

| Provider | Declaration | Call | Result | The trap |
| --- | --- | --- | --- | --- |
| Anthropic | `tools:[{name,description,input_schema}]` | `tool_use` content block | user message of `tool_result` blocks | thinking signatures must be echoed verbatim; **all** parallel results go in ONE user message |
| OpenAI | `tools:[{type:'function',function:{…}}]` | `message.tool_calls[]` | one `role:'tool'` message per call | `function.arguments` is a JSON **string** — parse defensively, salvage on failure |
| Google | `tools:[{functionDeclarations}]` | part with `functionCall` | `functionResponse` parts in a user turn | **no call ids** — see D-G15 |
| Ollama | `/api/chat` `tools` | `message.tool_calls[]`, often malformed | OpenAI shape | support varies **by model**, not by server; salvage is mandatory |
| Custom | OpenAI-compatible | same | same | same as Ollama |

DeepSeek is reached through the `custom` provider (OpenAI-compatible base URL), which is what the
existing provider set already assumes. Its current models are `deepseek-v4-pro` / `deepseek-v4-flash`;
`deepseek-chat` / `deepseek-reasoner` were deprecated 2026-07-24 and are not hardcoded anywhere.

### D-G15 — Gemini's missing call ids are synthesized deterministically

Gemini returns `functionCall {name, args}` with no id, and matches results by name — which is
ambiguous the moment the model calls one tool twice in a turn. We synthesize
`` `${name}#${index}` `` from the call's position in the response, and when sending results back we
emit `functionResponse` parts **in the same order**. Position, not name, is the identity. If a turn
contains duplicate names, the synthesized ids stay distinct and the ordering is what preserves the
pairing; the ambiguity is recorded on the `tool_called` payload so the trace shows where a
provider-side limitation was worked around.

### D-G16 — Capabilities are a vendored table, never a runtime fetch

`lib/llm/capabilities.ts`: per (provider, model prefix) → `{contextWindow, maxOutputTokens,
toolCalling, parallelToolCalls, vision, source}`. Prefix matching, with a conservative per-provider
default for anything unknown, and `source: 'assumed'` when the answer is a default rather than a
vendored fact.

Vendored, not fetched: a runtime dependency on models.dev would make an investigation's start
contingent on a third party's uptime, and would mean the same model could be considered
tool-capable on Tuesday and not on Wednesday. A stale table is a known quantity; a flaky one is not.

The loop degrades on it: no parallel tool calls ⇒ serialize; no tool calling at all ⇒ **refuse to
start** with the model named and the Settings page pointed at, rather than looping uselessly and
terminating on max turns with an empty answer. An `assumed` capability that turns out to be wrong
surfaces as a first-turn provider error with the same clear message.

### D-G17 — Salvage is loud

`lib/llm/salvage.ts` recovers a tool call a weak model emitted as prose or malformed JSON, validated
against the tool's own JSON schema — fenced block, bare balanced-brace object, `<tool_call>` tags,
then argument coercion against the schema. Never silent: `tool_called` carries `salvaged: true` and
the strategy that worked.

This is the difference between "Ollama is supported" and "Ollama actually works". It is also a
metric: a salvage rate creeping up is the signal that a customer's local model is not fit for
purpose, and the usage dashboard can show it because the marker is on the event.

### D-G18 — `dispatch()` is extended, not forked

`dispatch()` gains optional `tools`/`toolChoice`/`conversation` and a `dispatchTools()` sibling that
returns the raw tool-call result instead of a schema-validated object. Resolution still happens per
(org, role, step), unchanged. Everything the agent gains — BYOK, per-role models, encrypted keys,
usage attribution — it gains because it goes through this one door.

---

## 5. Part C — the tool surface

### D-G19 — Seven tools, all read-only but one, all with the same envelope

SWE-agent's finding is that interface design mattered more than model choice. Its four principles map
directly:

1. **Minimal.** Seven tools, not thirty. Resist one-tool-per-question.
2. **Compact actions.** `query_ledger` filters, groups and aggregates in one call, so most questions
   are answerable without a five-turn client-side join.
3. **Informative feedback.** Every tool returns `{ok, data, summary, hint?}`. `summary` is one line
   the agent can reason over without re-parsing; `hint` says what to try next when a result is empty
   or suspicious. A tool that returns `{}` on no match is a dead end.
4. **Guardrails.** Bad arguments come back as a *correctable message*, never a thrown error.

| Tool | What it answers |
| --- | --- |
| `list_datasets` | What financial data exists for this org, with date ranges and row counts. The orientation step. |
| `query_ledger` | Filter / group / aggregate in ONE call. Should answer most questions alone. |
| `get_transactions` | The rows behind an aggregate, paginated, so the agent can drill into a number it just computed. |
| `compare_periods` | This period vs prior, variances computed in code. |
| `find_anomalies` | Runs the existing deterministic detectors and returns findings — tested logic, not the model eyeballing outliers. |
| `get_workflow_history` | Prior runs, their exceptions and resolutions. Where the agent learns this org's normal. |
| `recommend_action` | The ONLY tool with consequences, and it does not execute (§6). |

Every returned row carries a **stable source id** (`wf:<8>/<dataset>/<rowId>`) so the answer can cite
it and post-validation can check the citation resolves to a real row. Result sizes are capped and the
cap is stated: `{truncated: true, total: 4820, showing: 50}`. Silent truncation makes the agent
confidently wrong.

### D-G20 — Tool access is registered per role, mirroring action types

`ROLE_TOOLS: Record<StepRole, readonly string[]>`. `investigator` gets the seven; every other role
gets none, because no other role runs an agent loop. Same shape as `allowedActionTypes`, same
fail-closed default, and a tool the loop cannot find in its role's list is never offered to the model
in the first place.

---

## 6. Part D — recommendations

### D-G21 — `recommend_action` queues; it never executes

The tool's whole body:

1. Build a `ProposedAction` from the model's arguments — deterministically, with the target id and
   amount **read from source data**, not from what the model typed. A model-supplied amount that
   disagrees with the row is a validation failure.
2. `roleMayPropose('investigator', actionType)` — closed set: `book_journal_entry`,
   `approve_invoice_payment`. Anything else fails as an illegal action type.
3. `verifyAction(...)` — the same deterministic business rules the pipelines use. A failure returns a
   correctable message to the agent and **appends `action_failed_verification`**; nothing is queued,
   and no human is shown a machine-rejectable action.
4. `gateStepActions(...)` — the existing engine: ceilings → standing rules → human.
5. Return the queued state to the agent.

There is no step 6. The agent has no execute path, and `high` from a verifier still forces human
review regardless of org config (D-H10) — the agent is not consulted about that, so it cannot argue
its way past it.

Recommendations render in the **existing** approval panel. No parallel approval UI.

---

## 7. Part E — context, budget, termination

### D-G22 — The trail and the context window have different jobs

Full tool results go to `harness_events` (capped at the existing 64 KB by `redactAndCap`); the model
sees a bounded excerpt with the truncation stated. Sharing one size limit between an audit record and
a context window optimizes neither.

Compaction: at 70% of the model's context window (from D-G16), the oldest turns are summarized into a
structured digest — findings so far, ruled-out hypotheses, key figures **with their source ids**,
open questions — and the digest plus the last N turns are kept. `context_compacted` records what was
dropped. **Source citations are never compacted away**: every source id seen is carried forward
verbatim in the digest, because the final answer must still be able to prove its numbers.

Bounds, org-configurable within non-negotiable ceilings:

| Bound | Default | Ceiling |
| --- | --- | --- |
| turns | 20 | 40 |
| total tokens | 300 000 | 1 000 000 |
| wall clock | 5 min | 15 min |
| tool calls per turn | 5 | 8 |

Hitting one writes `agent_terminated` with the reason and returns what was found so far, labelled
partial. A silent stop is the failure mode this exists to prevent.

Loop detection: the same tool with the same arguments three times is a stuck agent. The third call is
refused with a correctable message explaining why, so the agent can change course; three *consecutive*
refusals terminate the run.

---

## 8. Milestones

| # | Milestone | Gate | Status |
| --- | --- | --- | --- |
| **G0** | This document | reviewed before code | ✅ |
| **G1** | `007_agent_events.sql` + canonical message format | migration applies to a throwaway `postgres:17` container before it is applied live | ✅ applied live, recorded as version 007 |
| **G2** | Tool calling across all providers + capabilities + salvage | `scripts/tool-calling-proof.ts` green on every **configured** provider; wire-format parity for all five in `npm test` | ✅ **live on `anthropic/claude-sonnet-4-6`**; 4 providers skipped for want of credentials |
| **G3** | The agent loop, bounded | a real investigation end-to-end with a full event trail | ✅ `npm run investigation-proof` passes against live Supabase |
| **G4** | Provider swap | the same investigation on each configured provider | 🟡 **1 of 5 proven live** — real Claude run passes end to end; the other four need a key each |
| **G5** | Full tool surface + compaction | compaction preserves every citation; results trimmed for the model, kept whole on the trail | ✅ unit-proven; the live run reached 6 turns / 47k tokens without needing compaction |
| **G6** | `recommend_action` → approval queue | a recommendation appears in the existing panel; unverified ones are rejected pre-queue | ✅ proven live |
| **G7** | Transcript UI + Realtime | parallel tool calls visibly concurrent | ✅ |

Every milestone green on `npm run typecheck && npm run build && npm test` (383 tests).

### Where the credentials actually live — and the proof bug that hid them

`.env.local` carries a **placeholder** `ANTHROPIC_API_KEY`, and both proof scripts originally read
env vars only. They therefore reported "no provider configured" for a project that had a perfectly
good working key sitting in `org_model_configs` — because FinFlow's primary credential path is
**BYOK**: a key entered in Settings → Models, AES-encrypted into the database, resolved through
D-P7 tiers 1–3. The env var is the *last-resort fallback*, tier 4.

That was a false negative about the one thing those scripts exist to establish. Both now resolve
the way the product does: the org's active configs first, with their keys decrypted, and env vars
only for providers the org has not configured.

With that fixed, on `anthropic/claude-sonnet-4-6`:

- **`npm run tool-calling-proof`** → PASSED live. Real tool call, real result round-trip, usage
  attributed.
- **`PROOF_USE_CONFIGURED_PROVIDER=1 npm run investigation-proof`** → PASSED live. 32 gapless
  events, 3 parallel tool calls on turn 1 each paired through `caused_by`, 5 recommendations
  queued (all pending a human, every amount from its own row), 20 citations all resolving, and 7
  figures — including two `difference` figures — recomputed in code.

The remaining four providers each need one credential; nothing else changes.

| Proven live | Proven offline, every commit | Still unproven |
| --- | --- | --- |
| Claude: tool calling, a full investigation, the approval path, the answer validator | The exact request bytes and response parsing for all five providers | That OpenAI / Gemini / DeepSeek / Ollama do this against a real endpoint |

### What the first real run exposed

Two of the three findings were bugs in the **proof script's assertions**, not the product, and are
worth recording because both were the same mistake — an assertion written around the scripted
fixture rather than around the property:

1. It compared `action_requests[0]` to one hard-coded invoice. A real model recommends whatever it
   likes, in whatever order. Now: *every* queued amount must equal its own row's amount.
2. It recomputed every figure as a `sum`. The scripted provider only ever emits `sum`, so this
   passed for months of fixtures and then reported a false failure the moment the real model used
   `difference` — the proof asserting one thing while the product correctly did another. Now it
   recomputes per operation, independently of `computeFigure` so the check is not tautological.

The third was real, and is why running it for real matters:

**D-G22 gains `maxRecommendations` (default 5, ceiling 10).** Asked "is anything ready for
payment?", the agent queued **fifteen** payment approvals across three turns. Nothing unsafe
happened — each was verified, each was left pending a human, each amount came from its own row, so
every safety property held exactly as designed. The problem is the reviewer: a queue of fifteen
near-identical approvals is precisely how people are trained to rubber-stamp, which is the failure
D-H9 exists to prevent, arriving through the front door. The other bounds cap what a run costs;
this one caps what it costs *a person*, which is the scarcer resource. It is enforced in the loop,
not the prompt — the prompt already asked for restraint and did not get it.

### Two decisions that changed on contact with the code

**`recommend_action` offers one action type, not two.** `ROLE_SPECS.investigator` permits both
`approve_invoice_payment` and `book_journal_entry`, but only the first is exposed. `verifyJournalEntry`
requires a chart of accounts to validate account codes against and correctly refuses to pass an
entry without one — and FinFlow has no chart of accounts. Offering it would invite the agent to
spend turns on something structurally guaranteed to be rejected. Adding it later is one enum entry
and one payload builder; the role and the verifier are already there.

**An investigation is not a Mastra workflow** (D-G6), which the plan already anticipated, and it is
also not resumable in this pass. The loop's state is its conversation; a crashed run leaves its
`investigations` row at `running` with a complete event trail up to the crash. Replay-from-events
is the design (the trail is the record), but it is not built — a run that dies mid-flight must be
re-asked. Worth doing before this is load-bearing for anyone.

### On G2 and G4 — what "green" can and cannot mean here

`.env.local` currently holds a **placeholder** `ANTHROPIC_API_KEY`, and no OpenAI, Google or DeepSeek
key, and no Ollama host. So the live half of G2 and all of G4 cannot execute in this environment, and
claiming otherwise would be the exact kind of false pass PLAN-4 §"two bugs in the proof itself"
warns about.

The split, stated so the gap is visible rather than papered over:

- **Wire-format correctness is proven offline, for all five providers**, by driving each
  `complete()` through a fake `fetch`/SDK transport: the exact request body is asserted, a recorded
  provider response is fed back, and the resulting canonical `toolCalls` and the round-tripped
  result body are asserted. This runs in `npm test` on every commit and is the stronger of the two
  checks for translation bugs, because it pins the bytes.
- **`scripts/tool-calling-proof.ts` runs the same two-tool conversation against every provider that
  is actually configured**, and reports each unconfigured provider as SKIPPED with the reason. It
  exits non-zero if a configured provider fails and exits zero — printing the skip list — if none
  are configured. That is what makes it honest to run in CI, and what makes G4 a matter of supplying
  credentials rather than of writing more code.
