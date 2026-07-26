# HANDOFF — the open-ended investigator agent

> Written at the end of the Plan 4 session so a **fresh session with zero prior context** can build
> this. Read §0 → §3 before writing any code; they contain the one architectural constraint that,
> if you get it wrong, makes everything else worthless.
>
> **What we are building:** an agent that can be pointed at whatever financial data an org has in
> FinFlow and asked an open-ended question — *"why doesn't this account tie out?"*, *"what changed in
> COGS this quarter?"*, *"find anything unusual in Q3 AP"* — and that investigates it: forming
> hypotheses, pulling the data it needs, following what it finds, and producing a cited answer.
>
> **What makes it hard:** every other FinFlow workflow is a fixed pipeline. This one isn't. It is
> the first place in the product where the model chooses what happens next, and the entire existing
> product promise is built on the model NOT doing that. §2 is how those are reconciled.

---

## 0. Where the codebase is (read this before anything)

Five build passes have shipped. `PLAN.md` (M0–M9 app), `PLAN-2.md` (multi-provider LLM layer + DAG
orchestrator), `PLAN-3.md` (per-action authorization + suspend/resume + authorization audit),
`PLAN-4.md` (the event-sourced harness). `HANDOFF.md` is the previous handoff — its §3 competitive
analysis is still worth reading; its §1.1 status block is now stale.

**What already exists that you will build on, not rebuild:**

| Thing | Where | Why it matters to you |
| --- | --- | --- |
| Event stream | `lib/harness/events.ts`, `harness_events` table | The agent's entire history goes here. Append-only, gapless, org-scoped. Do not invent a second history. |
| Action/observation loop | `lib/harness/loop.ts` | `executeStep()` — propose → verify → execute → observe. The agent's actions must flow through this, not around it. |
| Verifiers | `lib/harness/verifiers/` | Deterministic business rules per action type. Fail-closed on unregistered types. |
| Role registry | `lib/harness/roles/index.ts` | Each role has a **closed set** of action types it may propose. This is where the agent gets bounded. |
| Authorization | `lib/approvals/{risk,engine,service}.ts` | Ceilings → standing rules → human. Per-action, not per-workflow. |
| Provider layer | `lib/llm/provider.ts`, `lib/llm/providers/*`, `lib/llm/router.ts` | 5 providers, BYOK, AES-encrypted keys, per-(org, role, step) resolution. **Text/JSON only — no tool calling yet. This is your biggest build.** |
| Mastra substrate | `lib/harness/{mastra,workflows/}` | DAG execution + durable snapshots + crash resume. Workflows only — **no Mastra Agent is used, deliberately** (§2). |

**Live state:** Supabase project `lveaycbnqnphgbszrogn`, migrations 001–006 applied and recorded in
`supabase_migrations.schema_migrations`. `npm test` → 240 passing. `npm run harness-proof` → passes
against live Supabase with a real Claude call and a real SIGKILL/resume.

**Not yet built (Plan 4 remainder):** the Realtime live view + Harness Trace UI (H6), AP and FP&A
ported to the harness (H7), deletion of the old runner (H8). None of those block this work, but H6
overlaps heavily with the agent's UI needs — see §8.

---

## 1. The reference architectures, and what to actually take from each

The previous session researched these. Distilled, with the honest verdict on each — including the
parts to **reject**, which matter more than the parts to copy.

### OpenHands — the event-sourced action/observation loop

- **The pattern:** a central `EventStream` is the backbone. Everything is an `Action` (something the
  agent wants to do) or an `Observation` (what happened). The agent is a pure function
  `step(state) -> action`, where state wraps the event history plus execution metadata. Each
  observation carries a `cause` field pointing at the action id that produced it.
- **Take:** the `cause` linkage. Our `harness_events` has ordering but no explicit parent pointer.
  An investigation with 40 tool calls needs to know which observation answers which action. **Add a
  `caused_by` column (§4).**
- **Take:** agent-as-pure-function-of-history. It makes replay, debugging and resume trivial. Our
  loop already persists everything needed for it.
- **Reject:** OpenHands lets the LLM emit arbitrary shell/Python. Our sandbox equivalent is the
  verifier layer, and it only works if the tool surface is enumerable. No free-form execution.

### OpenCode — genuine provider-agnostic model routing

- **The pattern:** three parts — the AI SDK for provider integration, **models.dev** as the source
  of truth for model metadata and capabilities, and a **provider transform layer** that normalizes
  message shapes while *preserving* provider-specific features (reasoning effort, prompt caching).
  75+ providers, local models included.
- **Take:** the transform layer as a named architectural seam, not scattered `if (provider === …)`.
  Our providers are already one-file-each, but they only speak text. Tool calling is where provider
  divergence gets genuinely nasty (§5).
- **Take:** a capability model. We have none. "Does this model support tool calling / parallel tool
  calls / vision / a 200k context?" currently has no answer in our code, and an agent that plans
  around capabilities it doesn't have will fail confusingly. Consider consuming models.dev data
  rather than hand-maintaining a matrix — but pin/vendor it, don't fetch at runtime.
- **Reject:** adopting the Vercel AI SDK wholesale. We already have an encrypted-BYOK provider layer
  with per-role resolution that the AI SDK does not give us, and swapping it out would throw away
  Plan 2 and its tests for no product gain.

### SWE-agent — the Agent-Computer Interface, and minimalism

This is the most directly applicable one, and the least intuitive. The finding of the paper is that
**interface design mattered more than model choice**. Its four principles, and what each means here:

1. **Simplicity / minimal tools.** Bash commands with dozens of flags confuse agents; simple
   commands with few options and short docs work far better. → Ship **6–8 tools**, not 30. Resist
   one-tool-per-question.
2. **Compact, efficient actions.** Consolidate important operations so the agent makes real progress
   per step. → `query_ledger` that filters, groups and aggregates in one call beats `list_accounts`
   + `list_transactions` + client-side filtering across five turns.
3. **Informative feedback.** Structured, useful output after every action so the agent can correct
   itself. → A tool returning `{}` on no match is a dead end. Return
   `{rows: [], matched: 0, hint: "no transactions in that date range; the ledger covers 2026-01-01..2026-06-30"}`.
4. **Guardrails against cascading errors.** SWE-agent refuses edits that produce syntax errors,
   rather than letting the agent corrupt a file and then flail. → Reject a malformed tool call with a
   *correctable* message instead of running it. Our verifier layer is exactly this, one level up.

### OpenWorker (Andrew Ng) — studied in the previous session

Repo at `/Users/yashbhalgat/code/openworker` (Python, read-only, different product). `HANDOFF.md` §3
has file:line references. Relevant here:

- **Take:** `coworker/permissions.py` tiered grants (once / session / durable target-bound rule) —
  already implemented in `lib/approvals/`, and the agent must use it rather than a new mechanism.
- **Take:** the JSON/tool-call **salvage layer** in `openai_provider.py`. It recovers malformed tool
  calls by validating against the schema. This is what makes weak local models usable for tool
  calling, and it is the difference between "Ollama is supported" and "Ollama actually works" (§5).
- **Take:** error-message-driven param-fix retries — read the vendor's actual complaint and fix
  exactly that, rather than blind retry.
- **Reject:** its lack of context compaction. Fine for short desktop tasks; fatal for a 40-turn
  investigation (§7).
- **Reject:** free-form tool driving with no structured output. Our correctness story is the moat.

---

## 2. THE CONSTRAINT — read this twice

FinFlow's entire differentiation, stated in `PLAN.md` D3 and defended through three build passes:

> All arithmetic and matching runs in TypeScript. The LLM only adjudicates ambiguity and writes
> prose. Every ID the model returns is validated against source data. Every number is recomputed in
> code.

An open-ended agent appears to contradict this. It does not, if you hold one line:

> ### The agent may decide what to LOOK AT. It may never decide what to CHANGE.
>
> Reading is open-ended. Writing is not. Every consequential action the agent wants to take is a
> **proposal** that goes through the existing verify → authorize → execute path, exactly like a
> pipeline step's. The agent's autonomy ends at the boundary of the read-only tool surface.

Concretely:

- **Read tools** (query the ledger, fetch a statement, recompute a total): the agent calls these
  freely, as many times as it likes, in whatever order it decides. No approval. These are `read`
  risk class and they are the entire investigative surface.
- **Write actions** (book an entry, approve a payment, file something): the agent **cannot call
  these as tools at all**. It emits a *recommendation*, which becomes a `ProposedAction` that runs
  through `verifyAction()` and then `lib/approvals/engine.ts`. A human sees it in the existing
  approval panel. The agent never has an execute path.
- **Numbers in the answer** are recomputed in code and cited to source rows. The agent writes the
  prose around them; it does not supply the figures. Reuse the post-validation pattern from
  `lib/agents/reconciliation.ts:callWithPostValidation` — every ID validated against real data, one
  corrective retry, then fail.

This is also why **we did not use a Mastra Agent** and you should not add one now. Mastra's `Agent`
class runs its own tool loop with its own model layer — meaning our router, our BYOK keys, our
per-role resolution and our verifier gate would all be bypassed. Mastra stays what it is here: DAG
execution + durable snapshots. Build the agent loop yourself; it is ~200 lines and you need control
of every turn of it.

---

## 3. Shape of the thing

```
                 user question
                       │
              ┌────────▼─────────┐
              │  investigator    │  new role, lib/harness/roles/investigator.ts
              │  agent loop      │  bounded turns, bounded tokens, bounded wall-clock
              └────────┬─────────┘
                       │  every turn:
      ┌────────────────┼────────────────────────────┐
      │                │                            │
  read tools      recommendations              final answer
 (free, logged)   (ProposedAction)          (cited, numbers recomputed)
      │                │                            │
      │         verifyAction() ──► approvals engine ──► human panel
      │                                              (existing UI)
      ▼
 harness_events  ◄── every action, observation, tool call, token count
```

Everything lands in `harness_events`, so an investigation is replayable, auditable and resumable on
exactly the same machinery the pipelines use.

---

## 4. Part A — event stream extensions

Small, do it first, it unblocks everything else.

**Migration `007_agent_events.sql`:**

- Add `caused_by uuid references public.harness_events(id)` — the OpenHands `cause` linkage. An
  observation points at the action that produced it. Without this a 40-turn investigation is an
  undifferentiated wall of rows.
- Add `turn_number int` — which iteration of the agent loop this belongs to. Cheap, and the UI needs
  it to group.
- Extend the `event_type` check constraint with: `agent_turn_started`, `tool_called`,
  `tool_returned`, `agent_reasoning`, `agent_answered`, `agent_terminated`.
- **Remember the two live-environment traps from Plan 4** (both cost debugging time, both written up
  in `PLAN-4.md`): Supabase grants `ALL` on new tables to `anon`/`authenticated` by default, so any
  new table needs the explicit revoke — `006` now sets deny-by-default for the schema, but verify;
  and index `(workflow_id, turn_number)` because the trace view will query it constantly.

Keep using `append_harness_event`. Do not add a second write path; the gapless-sequence guarantee
(proven under 12-way concurrency, see `PLAN-4.md`) depends on that function being the only one.

---

## 5. Part B — tool calling in the provider layer ★ the hard part

**This is the bulk of the work.** Budget most of the session for it. Our `LLMProvider` interface is
text-in / JSON-out and has no concept of a tool. Every provider expresses tool calling differently,
and the differences are not cosmetic.

### What each provider actually needs

| Provider | Tool declaration | Call in response | Result sent back | Gotcha |
| --- | --- | --- | --- | --- |
| Anthropic | `tools: [{name, description, input_schema}]` | content block `{type:"tool_use", id, name, input}` | user message with `{type:"tool_result", tool_use_id, content}` | **Thinking blocks carry signatures that must be echoed back verbatim** on later turns or the API rejects them |
| OpenAI | `tools:[{type:"function", function:{name, description, parameters}}]` | `message.tool_calls[]` with `function.arguments` as a **JSON string** | `role:"tool"` message with `tool_call_id` | arguments are a string, not an object — parse defensively |
| Google Gemini | `tools:[{functionDeclarations:[...]}]` | part with `functionCall {name, args}` | part with `functionResponse {name, response}` | **No call IDs.** Matching is by name, which is ambiguous when the model calls the same tool twice in parallel |
| DeepSeek | OpenAI-compatible — reuse the OpenAI path | same | same | Current models are `deepseek-v4-pro` / `deepseek-v4-flash`; `deepseek-chat` and `deepseek-reasoner` were **deprecated 2026-07-24**. Verify before hardcoding |
| Ollama / local | `/api/chat` `tools` field; support varies **by model**, not just by server | often malformed or emitted as prose | same shape as OpenAI | The salvage layer is mandatory here, not a nicety |
| Custom (vLLM, LM Studio) | OpenAI-compatible, quality varies | same | same | Same salvage path as Ollama |

### The design

1. **A canonical message format** (`lib/llm/messages.ts`). One internal representation —
   `{role, content, toolCalls?, toolResults?}` — that every provider converts to and from. The
   agent loop only ever sees canonical messages. This is OpenCode's transform layer.

2. **A provider sidecar for lossless same-provider continuation.** Anthropic thinking signatures and
   Gemini thought signatures are opaque and non-portable. Store them on the canonical message in a
   `sidecar: {providerId, data}` field. When the next turn goes to the *same* provider, replay them
   verbatim. When it goes to a *different* provider, **drop them and append an event saying so**.
   This is the honest version of "seamless model swapping": the conversation continues correctly,
   with a recorded, visible loss of provider-specific reasoning state. Silently dropping it is a
   debugging nightmare; erroring is a worse product. Say it out loud in the trace.

3. **A capability model** (`lib/llm/capabilities.ts`). Per (provider, model): supports tool calling,
   supports parallel tool calls, context window, supports vision. The agent loop must degrade — if a
   model can't do parallel calls, serialize; if it can't do tools at all, refuse to start an
   investigation on it with a clear message rather than looping uselessly. Consider vendoring
   models.dev data; do not fetch at runtime.

4. **A salvage layer** (`lib/llm/salvage.ts`). When a weak model emits a tool call as prose or
   malformed JSON, attempt recovery *validated against the tool's schema*, and record a
   `tool_call_salvaged` marker on the event. Never salvage silently — a salvage rate creeping up is
   the signal that a customer's local model is not fit for purpose, and the usage dashboard should
   be able to show it.

5. **Extend `dispatch()`**, don't fork it. Add optional `tools` and `toolChoice`; when absent the
   behaviour is byte-identical to today so all 240 existing tests keep passing. Everything still
   resolves per (org, role) — which is what gives you free, seamless model swapping for the agent:
   an org points the `investigator` role at DeepSeek or their own Ollama box in Settings and nothing
   else changes.

**Gate for Part A+B:** a `scripts/tool-calling-proof.ts` in the style of `scripts/harness-proof.ts`
that runs the *same* two-tool conversation against every configured provider and asserts each
produces a valid tool call, a valid result round-trip, and correct events. That script is what makes
"works with any model" a fact rather than a claim.

---

## 6. Part C — the tool surface (apply SWE-agent's ACI principles)

**Six to eight tools. Not thirty.** Suggested starting set — all read-only, all returning structured
data with helpful empty-states:

- `list_datasets` — what financial data exists for this org, with date ranges and row counts. The
  agent's orientation step; without it, it guesses at what it can see.
- `query_ledger` — filter / group / aggregate in ONE call (accounts, date range, counterparty,
  amount band). This is the compact-action principle: it should answer most questions alone.
- `get_transactions` — the rows behind an aggregate, paginated, so the agent can drill into a number
  it just computed.
- `compare_periods` — this period vs prior, with variances computed **in code**.
- `find_anomalies` — run the existing deterministic detectors (`lib/agents/matching.ts` and friends)
  and return findings. Reuses tested logic instead of asking the model to eyeball outliers.
- `get_workflow_history` — prior runs, their exceptions and their resolutions. Where the agent
  learns this org's normal.
- `recommend_action` — the ONLY tool with consequences, and it does not execute. It creates a
  `ProposedAction` for the approval queue and returns the queued state.

Rules, from the ACI findings:

- Every tool returns `{ok, data, summary, hint?}` — `summary` is one line the agent can reason over
  without re-parsing, `hint` is what to try next when a result is empty or suspicious.
- Every returned row carries a **stable source id**, so the final answer can cite it and
  post-validation can check the citation is real.
- Cap result sizes and say so explicitly (`{truncated: true, total: 4820, showing: 50}`). Silent
  truncation makes the agent confidently wrong.
- Argument validation failures come back as correctable messages, never as thrown errors.

Register the tools per role so `investigator` cannot reach a tool it shouldn't — the mechanism in
`roles/index.ts` already exists for action types; mirror it for tools.

---

## 7. Part D — context management

`HANDOFF.md` flagged this as a gap in OpenWorker. For a 40-turn investigation over financial data it
is not optional: you will blow a 200k window on tool results alone.

- **Compaction:** when the conversation approaches the model's context limit (from the capability
  model), summarize the oldest turns into a structured digest — findings so far, ruled-out
  hypotheses, key figures with their source ids — and keep the digest plus the last N turns. Write a
  `context_compacted` event with what was dropped. **Never compact away a source citation**; the
  final answer must still be able to prove its numbers.
- **Tool-result trimming:** store the full result in `harness_events` (the audit trail keeps
  everything) but feed the model a bounded excerpt. The trail and the context window have different
  jobs and should not share a size limit.

---

## 8. Part E — safety, budget and termination

An open-ended loop on a metered API is a cost incident waiting to happen.

- **Hard bounds, all configurable per org but with non-negotiable ceilings:** max turns, max total
  tokens, max wall-clock, max tool calls per turn. Hitting one writes `agent_terminated` with the
  reason and returns whatever was found so far — a partial answer that says it is partial, never a
  silent stop.
- **Loop detection:** the same tool with the same arguments three times is a stuck agent. Break, and
  tell it why in the next turn so it can correct.
- **Cost visibility:** tokens are already on every event via `provider_used`/`model_used` — the
  usage dashboard aggregation should treat investigations as first-class alongside pipeline runs.
- **The high-risk floor still applies.** Any recommendation the verifier rates `high` forces human
  review regardless of org config (`D-H10`). The agent cannot argue its way past it, because it is
  not consulted.

---

## 9. Part F — UI

Overlaps Plan 4's H6, so consider doing them together:

- Realtime subscription to `harness_events` (the migration already publishes the table).
- An investigation transcript view: turns, the agent's reasoning, each tool call and its result
  collapsed by default, and the final cited answer. This is the coding-agent terminal-trace analogue
  and it is what makes the feature feel real rather than magic.
- Recommendations render in the **existing** approval panel. Do not build a parallel approval UI.

---

## 10. Milestones and gates

Follow the established discipline: locked decisions in a `PLAN-5.md` before coding, one focused
commit per milestone, every milestone green on `npm run typecheck && npm run build && npm test`.

| # | Milestone | Gate |
| --- | --- | --- |
| **G0** | `PLAN-5.md` with locked decisions (`D-G1…`) | reviewed before code |
| **G1** | `007_agent_events.sql` + canonical message format | migration applies to a throwaway Postgres container first (see `PLAN-4.md` — a live-only failure cost a debugging round) |
| **G2** | Tool calling across all providers + capabilities + salvage | `scripts/tool-calling-proof.ts` green on **every** configured provider |
| **G3** | The agent loop with 2 tools, bounded | a real investigation end-to-end, full event trail, on Claude |
| **G4** | **PROVIDER SWAP PROOF** — the same investigation on Claude, GPT, Gemini, DeepSeek and a local Ollama model | all five produce a valid cited answer; the trail shows which model did what. **This is the milestone that proves the headline claim.** |
| **G5** | Full tool surface + context compaction | a 30+ turn investigation that does not exceed context |
| **G6** | `recommend_action` → approval queue | a recommendation appears in the existing panel, unverified ones are rejected pre-queue |
| **G7** | Transcript UI + Realtime | parallel tool calls visibly concurrent |

---

## 11. Decisions to lock in `PLAN-5.md`

1. **Is `investigator` a fifth `StepRole`, or a separate concept?** `STEP_ROLES` is a four-value
   vocabulary shared with the settings matrix and a DB check constraint (`005`), so adding one is a
   migration plus UI. Recommendation: **yes, add it** — it makes per-role model assignment work for
   the agent for free, which is exactly the seamless-swap requirement.
2. **Does an investigation live in `workflows`?** It needs a `workflow_id` for `harness_events`.
   Either add a `type: 'investigation'` (widening the check constraint) or a separate table with its
   own event scope. Recommendation: reuse `workflows` — the audit certificate, RLS and Realtime all
   come free.
3. **Which model is the default?** The agent is materially more sensitive to model quality than the
   pipelines. Consider a higher default for `investigator` than for `parser`.
4. **How much does an investigation cost, and who sees that before it runs?** A UI decision with
   real product weight.
5. **Does the agent get memory across investigations?** This is Edge #2 from `HANDOFF.md` (the typed
   learned-rules layer, still unbuilt and still described there as the durable moat). The agent is a
   strong reason to finally build it — but do not conflate the two; ship the agent stateless first.

---

## 12. Traps already discovered — do not rediscover these

All written up in `PLAN-4.md`; listed here so you see them before they cost you an hour.

- **`libpq` and `node-postgres` parse connection URLs differently.** libpq splits userinfo on the
  *first* `@`, node-postgres on the *last*. A password containing `@` must stay percent-encoded as
  `%40` or `psql` and `supabase db push` break while the app works fine.
- **`DATABASE_URL` currently points at the IPv6-only direct host.** Fine locally, will likely fail on
  Vercel. Switch to the pooler before deploying.
- **Postgres RLS does not cover `TRUNCATE`,** and Supabase grants `ALL` on new public tables to
  client roles by default. `006` set deny-by-default for the schema — verify it held for any new
  table you add.
- **Mastra: a cancel is not a crash.** `run.cancel()` writes status `canceled`, which `restart()`
  rejects; a `SIGKILL` leaves `running`, which it accepts.
- **Mastra: `start()` has no `abortSignal`** — passing one type-errors and would be ignored.
- **Mastra: `getStepResult` returns `null`, not `undefined`,** for a step that hasn't run.
- **Killing a child process:** `spawn("npx", …)` does the work in a grandchild. Signal the process
  **group** (`detached: true` + `process.kill(-pid)`), and assert the event stream goes quiet
  afterwards — without that check, a surviving orphan makes a contaminated run look like a clean one.
- **Prior outputs come from every completed step, not just declared dependencies.** The old runner
  does this and the real graph depends on it.
- **Test against a real Postgres container before trusting a migration.** Two of the above were
  invisible in unit tests with a fake client.

---

## 13. First moves

1. `cd /Users/yashbhalgat/code/finito`; read `PLAN-4.md` §0–§4 (the harness you are extending) and
   this file's §2 (the constraint).
2. Skim `lib/harness/loop.ts` end to end. It is ~590 lines and it is the thing the agent plugs into.
3. Run `npm test` and `npm run harness-proof` to confirm you have a green starting point.
4. Read `lib/llm/provider.ts` and one provider (`anthropic.ts` is the most featureful) to see the
   shape you are extending with tools.
5. Write `PLAN-5.md`: locked decisions for §11, then G1 onward.

**Do not start by writing the agent loop.** It is the fun part and the smallest part. Without tool
calling across providers (§5) it has nothing to stand on, and without the constraint in §2 it is a
liability rather than a feature.
