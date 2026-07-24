# FinFlow — Plan 2: Multi-Provider LLM Architecture + DAG Orchestrator (for Claude Opus 4.8)

> **How to use this document.** This is the execution plan for FinFlow's second major
> pass: (1) a model-agnostic provider abstraction so every org configures its own LLM
> provider(s), key(s), and per-step model choices, and (2) a real dependency-graph
> orchestrator replacing the linear runner. It follows the same contract as `PLAN.md`:
> every architectural ambiguity is resolved into a **Locked Decision** — do not
> re-litigate them. Work milestone by milestone (N0 → N6), in order. After each
> milestone: `npm run typecheck && npm run build && npm test`, verify acceptance
> criteria, one commit per milestone. If something is genuinely uncovered, pick the
> simplest option consistent with §1 and leave a `// DECISION:` comment.
>
> **Read `PLAN.md` first.** Its locked decisions D1–D10 remain in force except where
> explicitly superseded below (D4 is generalized by D-P1; the BYOK browser-key
> mechanism added after M9 is removed by D-P4). All §-references of the form "§7"
> refer to PLAN.md; "§N.x" refers to this file.
>
> **Codebase state you are starting from** (all committed, all green: typecheck,
> build, 39 vitest tests): the full M0–M9 app plus a BYOK pass. Key existing
> contracts you will modify — read these files before writing code:
> - `lib/agents/client.ts` — `callClaude<T>({system, user, schema, apiKey})` →
>   `{data: T, reasoning: string}`; Anthropic-only; structured outputs via
>   `zodOutputFormat`; validation-retry-once; 429/5xx transport retries.
> - `lib/types.ts` — `StepContext {workflowId, db, files, priorOutputs, apiKey}`,
>   `StepDefinition {stepNumber, track, name, kind, run(ctx)}`, `StepResult`.
> - `lib/agents/runner.ts` (467 lines) — `runWorkflow(workflowId, apiKey)`;
>   hardcoded groups (steps 1+2 parallel for recon/AP, else sequential);
>   per-step lifecycle (running → input_hash → run → retry-once → complete/error);
>   `stepRegistry: Record<WorkflowType, StepDefinition[]>`.
> - `lib/agents/{reconciliation,ap-matching,fpa-commentary}.ts` — three
>   `StepDefinition[]` arrays; LLM steps call `callClaude` with `ctx.apiKey`.
> - `app/api/workflows/[id]/run/route.ts` — reads `x-anthropic-api-key` header,
>   falls back to `process.env.ANTHROPIC_API_KEY`, calls `waitUntil(runWorkflow(id, apiKey))`.
> - `lib/anthropic-key.ts`, `components/settings/ApiKeyManager.tsx`,
>   `app/api/anthropic/test-key/route.ts` — the browser-BYOK layer (to be removed, D-P4).
> - `lib/excel/writer.ts` — audit certificate footer hardcodes
>   `claude-sonnet-4-6` (to be made dynamic, §N6).

---

## 0. What this pass delivers (one paragraph)

Any organization can register one or more LLM providers (Anthropic, OpenAI, Google
Gemini, Ollama, or any OpenAI-compatible endpoint), each with an encrypted-at-rest API
key and optional base URL, test the connection, pick an org-wide default, and pin
specific workflow steps to specific provider+model combos ("matching uses GPT-4.1,
commentary uses Claude"). Agent steps never touch a provider SDK — they call a role- and
org-aware router. The runner becomes a true DAG executor: steps declare dependencies,
independent steps run concurrently, failures retry with backoff then pause the workflow
for human intervention. Every step row records provider, exact model, token counts, and
latency — surfaced in the UI, the audit certificate, and a per-org usage view. This is
the compliance story ("prove only the approved model touched our data") and the
open-source story (bring any key, including fully local models) in one layer.

---

## 1. Locked decisions (do not revisit)

**D-P1 — Two-layer LLM interface: raw `LLMProvider.complete` + typed `invoke`.**
The required `LLMProvider` interface (§2.1) is transport-only: strings in, string +
metadata out. All schema validation, corrective retries, and reasoning extraction live
ONE level up in `router.invoke<T>()` (§2.3), which is what step code calls. Rationale:
JSON-schema enforcement differs wildly per provider (Anthropic `output_config`, OpenAI
`response_format`, Gemini `responseSchema`, Ollama `format`), but zod validation +
retry-with-error is provider-independent and must not be duplicated five times.
`lib/agents/client.ts` is deleted; its semantics move into `providers/anthropic.ts`
(transport) and `router.ts` (validation loop).

**D-P2 — Key encryption in Node, not in SQL.** API keys are encrypted with
**AES-256-GCM in the API route process** using a 32-byte key derived (SHA-256) from a
new server-only env var `LLM_KEY_ENCRYPTION_SECRET`. Stored as
`v1:<iv_b64>:<tag_b64>:<ciphertext_b64>` in `org_model_configs.api_key_ciphertext`.
We do NOT use `pgp_sym_encrypt`: it would put the plaintext key inside SQL statement
text, where Supabase statement logging could capture it. Decryption happens only in
the router and the test route, server-side. If `LLM_KEY_ENCRYPTION_SECRET` is unset,
config-save routes return 500 with a clear message (fail closed). Document in README:
rotating this secret invalidates stored keys (users re-enter them) — acceptable for MVP.

**D-P3 — Keys are write-only; reads expose only `key_last4`.** Following D5, there is
**no RLS SELECT policy** on `org_model_configs` at all — the browser can never read the
table. All reads go through `GET /api/llm/configs`, which returns rows WITHOUT the
ciphertext, exposing the stored `key_last4` (e.g. `sk-…a8f2`) for display. There is no
"reveal key" path anywhere. Rotation = submit a new key for the same config (overwrite
ciphertext + last4). Admin-only writes are enforced in the API route via
`profile.role === 'admin'` (not RLS, since writes already go through the service role
per D5).

**D-P4 — Browser BYOK is removed, superseded by org configs.** Delete
`lib/anthropic-key.ts`, `components/settings/ApiKeyManager.tsx`,
`app/api/anthropic/test-key/route.ts`, and every `x-anthropic-api-key` header read
(run route, wizard, ReviewBanner re-run). The launch-time guard becomes: the run route
verifies the org can resolve a provider for every LLM role in the workflow (D-P7) and
returns `400 { error: 'No LLM provider configured — add one in Settings → Models' }`
if not. `process.env.ANTHROPIC_API_KEY` remains ONLY as a self-host fallback: when an
org has zero active configs, the router treats the env var (if set) as an implicit
Anthropic config with `default_model = 'claude-sonnet-4-6'`. This keeps `next dev`
demos working with nothing but an env var.

**D-P5 — DAG steps are identified by `step_key` (string), `step_number` retained.**
Workflow definitions become graphs keyed by snake_case string ids (`parse_erp`,
`match`, …). The DB keeps `step_number` (stable UI ordering, existing unique
constraint) and gains `step_key text not null` populated from the definition. The
`priorOutputs` map in `StepContext` is re-keyed by `step_key`
(`Record<string, unknown>`), and steps gain typed access via
`ctx.priorOutputs['parse_erp']`. Existing step code referencing numeric priors
(`priorParsedFile(ctx, 1)`) is updated to keys. Track values stay `'A'|'B'|'C'|'main'`
purely as UI layout hints; the executor derives real concurrency from `dependsOn`, not
tracks.

**D-P6 — Executor semantics (ready-set scheduling, resumable, pause-on-error).**
The orchestrator loop: (1) load step rows; (2) ready = steps whose `dependsOn` are all
`complete` and own status is `pending`; (3) run ALL ready steps concurrently via
`Promise.all`; (4) per step: up to **3 attempts total** (initial + 2 retries) with
exponential backoff **1s then 4s** (replacing the old single retry); on final failure
mark step `error`, workflow `error` (+ `error_message` naming the step), audit
`step_failed`, and **stop scheduling** — but let already-running sibling steps finish
and persist (their work is not wasted; resume skips them); (5) after each wave,
recompute ready set; (6) when all steps `complete` → `awaiting_review`. Resume (re-POST
`/run` on status `error`) resets `error` steps to `pending` and re-enters the loop —
`complete` steps are never re-run (idempotent, per D2). The >3-minute stale-`running`
check in the status route stays unchanged. Deterministic steps and LLM steps go through
the identical lifecycle.

**D-P7 — Provider resolution order (the router's core rule).** Given
`(org_id, workflow_type, step_key)`:
1. `workflow_step_configs` row for (org_id, workflow_type, step_key) → its
   `assigned_provider_config_id` (must be active, else treated as absent + warning in
   the step's reasoning footer).
2. Else the org's `org_model_configs` row with `is_default = true` (and `is_active`).
3. Else the env-var implicit Anthropic config (D-P4), if `ANTHROPIC_API_KEY` is set.
4. Else throw `NoProviderConfiguredError` — surfaced as the step error message.
The model used is the config's `default_model` (per-step model override IS the
per-step config row — pin a step by creating a config with the desired model and
assigning it; no separate model-override column, keeps the matrix simple).

**D-P8 — Role vocabulary.** Each step declares a `role`:
`'parser' | 'matcher' | 'classifier' | 'writer'`. Deterministic steps carry
`role: 'parser'` (or the closest fit) for display/config symmetry but NEVER consult the
router. Only `kind: 'llm'` steps resolve providers. The Settings UI only offers
step-assignment for LLM steps. Roles are informational grouping; resolution is by
`step_key` (D-P7), not role — role exists so the UI can say "matcher" and future
policy ("all matchers use X") has a hook without new schema.

**D-P9 — JSON strategy per provider.** `responseFormat: 'json'` maps to each
provider's strongest native mechanism, and router-level zod validation backstops all:
- **anthropic**: `output_config: { format: zodOutputFormat(schema) }` exactly as
  today (the schema is threaded to the provider via `params.jsonSchema`, see §2.1),
  `thinking: { type: 'adaptive' }` preserved, thinking blocks → `reasoningNative`.
- **openai**: Chat Completions `response_format: { type: 'json_schema', json_schema:
  { name: 'output', schema, strict: true } }`.
- **google**: `generationConfig: { responseMimeType: 'application/json',
  responseSchema: <schema translated to Gemini's OpenAPI-subset> }` — write a small
  JSON-Schema→Gemini-schema converter (objects/arrays/strings/numbers/enums only; our
  schemas are already constrained to that subset per §5.3).
- **ollama** and **custom-endpoint**: `format: 'json'` (Ollama) / best-effort
  `response_format: { type: 'json_object' }` (custom), PLUS the schema appended to the
  system prompt as "Respond with JSON matching this schema: …" — weakest natively, so
  the router's validate-retry loop does the real enforcement.
The router's corrective retry (one extra attempt appending the zod error) is uniform
across all providers and replaces the retry currently inside `callClaude`.

**D-P10 — HTTP-first providers; only Anthropic keeps an SDK.** `@anthropic-ai/sdk`
stays (already installed, powers structured outputs + typed errors). OpenAI, Gemini,
Ollama, and custom endpoints are implemented with **plain `fetch`** against their REST
APIs — no `openai` or `@google/generative-ai` packages. Rationale: four SDKs is
dependency surface with zero benefit for a single non-streaming completion call, and
`custom-endpoint.ts` must be raw-fetch anyway; openai.ts and custom-endpoint.ts share
one Chat-Completions implementation (custom = same body, custom `base_url`, optional
key). Timeout: 120s per call via `AbortSignal.timeout`.

**D-P11 — Raw response storage, capped.** Each LLM step stores the provider's full
JSON response in a new `workflow_steps.llm_raw jsonb` column for the audit trail,
**after** passing it through a redact+cap helper: any key case-insensitively matching
`/api[-_]?key|authorization|token/` is replaced with `"[redacted]"`, and if the
serialized JSON exceeds **64 KB** it is replaced by
`{ truncated: true, bytes: <n>, head: <first 8KB of the serialization> }`. Usage
metadata (`tokens_in/out`, `latency_ms`, `provider_used`, `model_used`) is stored in
dedicated columns (§3), NOT inside `llm_raw`, so aggregation is a plain SQL query.

**D-P12 — Usage view is derived, not double-booked.** No separate usage-events table.
`GET /api/llm/usage` aggregates `workflow_steps` (joined to workflows for org scoping):
tokens in/out and call counts grouped by `provider_used, model_used, month`. Test-
connection calls are not persisted and don't count (negligible, ~10 tokens). If billing-
grade accounting is ever needed, add an events table then — not now.

**D-P13 — Ollama/custom reachability is deployment-scoped (MVP).** `base_url` must be
reachable **from the FinFlow server process**. That means: local dev and self-hosted
FinFlow can point at `http://localhost:11434` or a VPC vLLM; the hosted product cannot
reach a customer's laptop, and the UI copy + README say so explicitly. The on-prem
connector/webhook pattern is OUT of scope; README gets a "Local models & the connector
pattern" section describing how `custom-endpoint.ts` + a reverse proxy inside the
customer network would extend this later. SSRF guard: base_url must parse as http/https
URL; when `NODE_ENV === 'production'` AND the deployment sets `LLM_BLOCK_PRIVATE_URLS=1`,
reject RFC-1918/localhost hosts at config-save time (default off so self-hosters work).

**D-P14 — `model` column semantics change.** `workflow_steps.model` (existing) now
stores the **exact model string returned by the provider** (`modelUsed`, e.g.
`claude-sonnet-4-6`, `gpt-4.1-2025-04-14`, `llama3.2:3b`) and `provider_used` stores
the provider id. Deterministic steps keep `model = null, provider_used = null`. The
audit certificate line format becomes `provider:model` (e.g. `anthropic:claude-sonnet-4-6`)
or `deterministic`. The Excel footer (§N6) becomes dynamic: it lists the distinct
provider:model pairs actually used in the run.

**D-P15 — Config deletion is soft.** `DELETE /api/llm/configs/[id]` sets
`is_active = false` (keeps FK integrity for `workflow_step_configs` history and past-run
provenance). Assigning steps to an inactive config is blocked; resolution skips
inactive configs (D-P7). A config row's ciphertext is overwritten with `''` on
deactivation so the key material is actually gone.

---

## 2. The provider layer — `lib/llm/`

```
lib/llm/
  provider.ts            # LLMProvider interface + shared param/result types
  crypto.ts              # encryptApiKey / decryptApiKey (AES-256-GCM, D-P2)
  json-schema.ts         # zod → plain JSON Schema + Gemini-schema converter (D-P9)
  redact.ts              # redactAndCap(raw) for llm_raw (D-P11)
  router.ts              # resolveProvider + invoke<T>() — the ONLY import for steps
  providers/
    anthropic.ts
    openai.ts
    google.ts
    ollama.ts
    custom-endpoint.ts
```

### 2.1 `provider.ts` (verbatim contract)

```ts
export type ProviderId = 'anthropic' | 'openai' | 'google' | 'ollama' | 'custom';

export interface LLMCompleteParams {
  systemPrompt: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  model: string;
  maxTokens: number;
  responseFormat?: 'json' | 'text';
  /** Plain JSON Schema for the expected output when responseFormat === 'json'.
   *  Providers with native schema enforcement use it (D-P9); others embed it in
   *  the prompt. Produced by lib/llm/json-schema.ts from the step's zod schema. */
  jsonSchema?: Record<string, unknown>;
  /** Transport config resolved by the router — never read from env inside providers. */
  apiKey?: string;      // absent for keyless endpoints (ollama, some custom)
  baseUrl?: string;     // required for ollama/custom; optional override elsewhere
}

export interface LLMCompleteResult {
  content: string;          // the text the model returned (JSON string when 'json')
  modelUsed: string;        // exact model id echoed by the provider (or params.model)
  tokensIn: number;         // 0 if the provider reports none (some Ollama builds)
  tokensOut: number;
  latencyMs: number;
  raw: unknown;             // full provider response body (router redacts+caps, D-P11)
  reasoningNative?: string; // provider-native reasoning (Anthropic thinking blocks)
}

export interface LLMProvider {
  id: ProviderId;
  complete(params: LLMCompleteParams): Promise<LLMCompleteResult>;
}
```

Transport-retry policy lives in a shared helper in `provider.ts`
(`withTransportRetry(fn)`): on HTTP 429 honor `retry-after` (cap 60s) and retry once;
on 5xx retry once after 2s; everything else rethrows — identical to today's
`createWithRetry`, applied uniformly in every provider file. Providers throw
`LLMProviderError { providerId, status, message }` (message must never contain the key).

### 2.2 Provider implementations (per-file notes)

- **anthropic.ts** — port the transport half of the current `client.ts`:
  `new Anthropic({ apiKey, baseURL: baseUrl ?? undefined })`, non-streaming
  `messages.create` with `max_tokens`, `thinking: { type: 'adaptive' }` and, when
  `responseFormat === 'json'`, `output_config: { format: { type: 'json_schema',
  schema: jsonSchema } }` (build the format object directly from the plain JSON schema —
  `zodOutputFormat` moves to `json-schema.ts` where zod→JSON-schema conversion
  happens once, router-side). Extract `content` from the first text block,
  `reasoningNative` from thinking blocks, tokens from `usage.input_tokens/output_tokens`.
- **openai.ts** — `POST {baseUrl ?? 'https://api.openai.com'}/v1/chat/completions`,
  `Authorization: Bearer <key>`; system prompt as the first `system`-role message;
  `max_completion_tokens`; `response_format` json_schema per D-P9; tokens from
  `usage.prompt_tokens/completion_tokens`; content from `choices[0].message.content`.
- **google.ts** — `POST https://generativelanguage.googleapis.com/v1beta/models/
  {model}:generateContent` with `x-goog-api-key` header (never the key in the URL
  query string — it would land in any URL logging); `systemInstruction`, `contents`
  from messages, `generationConfig` per D-P9; tokens from `usageMetadata.
  promptTokenCount/candidatesTokenCount`; content from
  `candidates[0].content.parts[*].text` joined.
- **ollama.ts** — `POST {baseUrl}/api/chat` with `stream: false`,
  `options: { num_predict: maxTokens }`, `format: 'json'` when json; messages include
  the system prompt as a `system` message; tokens from `prompt_eval_count/eval_count`
  (default 0 when absent); no auth header (if `apiKey` present, send
  `Authorization: Bearer` anyway — some proxies want it).
- **custom-endpoint.ts** — identical body shape to openai.ts with `baseUrl` required
  and `response_format: { type: 'json_object' }` (schema-in-prompt per D-P9); export
  the shared Chat-Completions helper from openai.ts to avoid duplication.

### 2.3 `router.ts` — what agent steps actually call

```ts
export interface ResolvedProvider {
  provider: LLMProvider;
  configId: string | null;       // null for env-fallback
  providerId: ProviderId;
  model: string;
  apiKey?: string;               // decrypted, in memory only
  baseUrl?: string;
}

export async function resolveProvider(db: SupabaseAdmin, args: {
  orgId: string; workflowType: WorkflowType; stepKey: string;
}): Promise<ResolvedProvider>;   // resolution order per D-P7

export interface InvokeResult<T> {
  data: T;
  reasoning: string;             // reasoningNative || data.reasoning fallback (as today)
  meta: { providerId: ProviderId; modelUsed: string; tokensIn: number;
          tokensOut: number; latencyMs: number; raw: unknown };  // raw already redacted+capped
}

export async function invoke<T>(resolved: ResolvedProvider, opts: {
  system: string; user: string; schema: z.ZodType<T>;
}): Promise<InvokeResult<T>>;
```

`invoke` behavior (ports `callClaude`'s validation loop verbatim, provider-agnostic):
build `jsonSchema` from the zod schema once (`json-schema.ts`; use
`zodOutputFormat(schema).schema` if the SDK helper exposes it, else `z.toJSONSchema` /
a minimal manual converter — our schemas are flat); call
`provider.complete({... responseFormat:'json', maxTokens: 16000})`; `JSON.parse` +
`schema.safeParse`; on failure retry ONCE appending the assistant turn + corrective
user message ("Your previous response failed validation: <error>. Return corrected
JSON."); then throw. Accumulate `tokensIn/Out` across both attempts; `latencyMs` is the
sum. `meta.raw` = redacted+capped LAST response.

`resolveProvider` decrypts the key via `crypto.ts` at resolution time; the key lives
on the returned object in memory for the duration of the step and is never logged,
serialized, or stored (same discipline as the removed BYOK path).

---

## 3. Database — `supabase/migrations/002_llm_providers.sql` (complete)

```sql
create table public.org_model_configs (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.organizations(id) on delete cascade,
  provider            text not null
                      check (provider in ('anthropic','openai','google','ollama','custom')),
  display_name        text not null,            -- "Anthropic (prod key)"
  api_key_ciphertext  text not null default '', -- 'v1:<iv>:<tag>:<ct>' or '' (keyless/ollama)
  key_last4           text not null default '', -- display only, e.g. 'a8f2'
  base_url            text,                     -- required for ollama/custom
  default_model       text not null,            -- 'claude-sonnet-4-6' | 'gpt-4.1' | ...
  is_default          boolean not null default false,
  is_active           boolean not null default true,
  created_at          timestamptz not null default now()
);
-- at most one default per org (partial unique index)
create unique index org_model_configs_one_default
  on public.org_model_configs (org_id) where is_default;
create index on public.org_model_configs (org_id);

create table public.workflow_step_configs (
  id                          uuid primary key default gen_random_uuid(),
  org_id                      uuid not null references public.organizations(id) on delete cascade,
  workflow_type               text not null
                              check (workflow_type in ('reconciliation','ap_matching','fpa_commentary')),
  step_key                    text not null,
  assigned_provider_config_id uuid not null references public.org_model_configs(id),
  created_at                  timestamptz not null default now(),
  unique (org_id, workflow_type, step_key)
);
create index on public.workflow_step_configs (org_id);

-- provenance + usage columns on steps (D-P11, D-P14)
alter table public.workflow_steps
  add column step_key      text,
  add column provider_used text,
  add column tokens_in     int,
  add column tokens_out    int,
  add column latency_ms    int,
  add column llm_raw       jsonb;

-- RLS: enabled with NO select policies — browser can never read configs (D-P3).
alter table public.org_model_configs   enable row level security;
alter table public.workflow_step_configs enable row level security;
-- (intentionally no policies; service role bypasses RLS, all access via API routes)
```

Backfill note: existing step rows get `step_key = null`; the orchestrator populates
`step_key` on the rows it inserts, and `ensureStepRows` UPDATEs null `step_key` on
legacy rows by matching `step_number` against the definition (workflows in flight
across the deploy are demo-scale; this keeps resume working).

New env vars (add to `.env.example` + README): `LLM_KEY_ENCRYPTION_SECRET`
(required for saving keys), `LLM_BLOCK_PRIVATE_URLS` (optional, D-P13).
`ANTHROPIC_API_KEY` stays documented as the self-host fallback (D-P4).

---

## 4. DAG orchestrator — `lib/agents/dag.ts` + `lib/agents/orchestrator.ts`

### 4.1 Definition types (in `lib/types.ts`, replacing StepDefinition's shape)

```ts
export type StepRole = 'parser' | 'matcher' | 'classifier' | 'writer';

export interface DagStepDefinition {
  key: string;                    // 'parse_erp' — unique within the workflow
  stepNumber: number;             // stable UI order + DB unique constraint (D-P5)
  dependsOn: string[];            // keys; [] = source node
  role: StepRole;                 // D-P8
  track: Track;                   // UI layout hint only
  name: string;                   // display name, unchanged strings from PLAN.md
  kind: 'deterministic' | 'llm';
  run(ctx: StepContext): Promise<StepResult>;
}

export interface WorkflowDefinition {
  type: WorkflowType;
  steps: DagStepDefinition[];     // validated at module load: no unknown/cyclic deps
}
```

`StepContext` changes: `priorOutputs: Record<string, unknown>` (keyed by step key,
D-P5); `apiKey: string` is REMOVED and replaced by
`llm(opts: {system: string; user: string; schema: z.ZodType<T>}) => Promise<InvokeResult<T>>`
— a closure the orchestrator builds per step (it has already resolved the provider for
this step's key, D-P7), so step code never sees keys or the router. Steps that call
the LLM must ALSO return the invoke `meta` so the orchestrator can persist it: extend
`StepResult` with optional `llmMeta?: InvokeResult<unknown>['meta']` — the step passes
through `meta` from its (final) `ctx.llm()` call; steps making zero LLM calls (or the
skip-adjudication path in `match`) leave it undefined.

### 4.2 The three graphs (`dag.ts`)

```ts
// reconciliation
[ { key:'parse_erp',  n:1, deps:[],                        role:'parser',     track:'A' },
  { key:'parse_bank', n:2, deps:[],                        role:'parser',     track:'B' },
  { key:'match',      n:3, deps:['parse_erp','parse_bank'],role:'matcher',    track:'main' },
  { key:'flag',       n:4, deps:['match'],                 role:'classifier', track:'main' },
  { key:'report',     n:5, deps:['flag'],                  role:'writer',     track:'main' } ]
// ap_matching: parse_pos(A) + parse_invoices(B) → match_invoices → flag_invoices → approval_queue
//   roles: parser, parser, matcher, classifier, writer
// fpa_commentary: parse_join → compute_variances → rank_variances → commentary → board_deck
//   deps chain linearly EXCEPT board_deck depends on ['rank_variances','commentary']
//   roles: parser, parser, parser, writer, writer   (compute/rank are deterministic)
```

`dag.ts` exports `workflowDefinitions: Record<WorkflowType, WorkflowDefinition>` and a
`validateDag(def)` (unknown dep / cycle / duplicate key ⇒ throw at import time; add a
vitest for it). The step `run` bodies move over from the three existing agent files
with only mechanical changes: numeric prior lookups → key lookups; `callClaude({...,
apiKey: ctx.apiKey})` → `const r = await ctx.llm({system, user, schema})`, use
`r.data`/`r.reasoning`, and pass `llmMeta: r.meta` through the StepResult. The three
files keep their names and their prompt text EXACTLY as-is (prompts are tested
product surface — do not rewrite them).

### 4.3 Executor (`orchestrator.ts`, replaces `runner.ts`)

`runWorkflow(workflowId: string): Promise<void>` (no key parameter — the router owns
resolution now). Algorithm, preserving all of runner.ts's per-step lifecycle:

1. Load workflow + org_id; load & parse files (unchanged helpers — port them over).
2. `ensureStepRows`: insert `pending` rows (now with `step_key`) if none; backfill
   null `step_key` on legacy rows by `step_number`.
3. Reset any `error` steps to `pending` (resume semantics, D-P6).
4. Build `done: Map<stepKey, output>` from `complete` rows (validated outputs).
5. Loop: `ready = defs.filter(d => rowStatus(d.key)==='pending' && d.dependsOn.every(k => done.has(k)))`.
   If ready is empty and not all complete → the workflow is stuck on an errored/running
   step → exit loop (workflow status already set by the failure path).
6. `await Promise.all(ready.map(executeStep))`. `executeStep` per step:
   - status `running` + `started_at`; audit `step_started`.
   - `input_hash` = sha256 of canonical full input (unchanged); truncated snapshot
     (unchanged).
   - For `kind:'llm'`: `resolveProvider(db, {orgId, workflowType, stepKey})` — a
     `NoProviderConfiguredError` here counts as a step failure (no retries; the
     message tells the user to configure Settings → Models). Build the `ctx.llm`
     closure around `invoke(resolved, …)`.
   - Attempt loop: up to 3 attempts, backoff 1s/4s (D-P6). Each attempt calls
     `def.run(ctx)`.
   - Success: persist `output, agent_reasoning, sources`, and from `llmMeta`:
     `model = meta.modelUsed`, `provider_used = meta.providerId`,
     `tokens_in/out, latency_ms`, `llm_raw = meta.raw` (already redacted+capped).
     Deterministic: those columns null. Audit `step_completed`
     `{input_hash, duration_ms, model, provider: provider_used, tokens_in, tokens_out}`.
   - Final failure: step `error` + `error_message`; workflow `error` +
     `error_message: 'Step "<name>" failed: …'`; audit `step_failed`. Set a shared
     `aborted` flag so the loop stops scheduling new waves (in-flight siblings finish).
7. All complete → `awaiting_review` + `completed_at` + audit (unchanged).
8. Top-level try/catch → workflow `error` (never throw to platform). Never log keys.

The run route changes: drop the header read; keep file/status validation; ADD the
fail-fast provider check (D-P4): for each LLM step in the definition, `resolveProvider`
must succeed (catch → 400 with the settings message) — do this BEFORE flipping status
to `running`. Then `waitUntil(runWorkflow(id))`.

Concurrency note: `waitUntil` + `Promise.all` inside one serverless invocation is the
same execution budget as today (`maxDuration = 300` unchanged); the DAG makes recon/AP
parse steps genuinely parallel and leaves room for future wider graphs — the UI's
track columns are now literally true.

---

## 5. API routes — `app/api/llm/*`

All follow the existing pattern: session via server client → profile → org scoping →
service-role writes → `{ error }` JSON on failure. **Admin-only** (profile.role
=== 'admin') for every mutating route; GETs allowed for any org member.

- **`GET /api/llm/configs`** → `{ configs: [{ id, provider, display_name, key_last4,
  base_url, default_model, is_default, is_active, created_at }], stepAssignments:
  [{ workflow_type, step_key, assigned_provider_config_id }] }`. NEVER the ciphertext.
- **`POST /api/llm/configs`** — body `{ provider, display_name, api_key?, base_url?,
  default_model, is_default? }`. Validate: provider enum; `base_url` required for
  ollama/custom (URL-parse + D-P13 private-range check when enabled); `api_key`
  required for anthropic/openai/google. Encrypt (D-P2), store ciphertext +
  `key_last4 = api_key.slice(-4)`. If `is_default`, clear the org's previous default
  first (partial unique index enforces). Audit `llm_config_created`
  `{ provider, display_name, default_model }` — never the key. → `201 { id }`.
- **`PATCH /api/llm/configs/[id]`** — rotate key (`api_key`), rename, change
  `default_model`/`base_url`/`is_default`. Same validation; overwrite ciphertext+last4
  on rotation; audit `llm_config_updated` (field names only).
- **`DELETE /api/llm/configs/[id]`** — soft-deactivate per D-P15 (`is_active=false`,
  ciphertext=''); also delete `workflow_step_configs` rows pointing at it; audit.
- **`POST /api/llm/configs/[id]/test`** — decrypt, `provider.complete({systemPrompt:
  'You are a connection test.', messages:[{role:'user',content:'Reply with exactly:
  OK'}], model: default_model, maxTokens: 8, responseFormat:'text'})` with a 15s
  abort; → `{ ok: true, modelUsed, latencyMs }` or `{ ok: false, error }` with the
  provider error mapped to human text ('Invalid API key', 'Endpoint unreachable',
  'Model not found'). `maxDuration = 30`. (Also accept a transient body
  `{ provider, api_key, base_url, default_model }` for **pre-save** testing — same
  logic, nothing stored.)
- **`PUT /api/llm/step-configs`** — body `{ workflow_type, step_key,
  provider_config_id | null }`; null deletes the assignment (falls back to default).
  Upsert on the unique triple. Validate the config is active + same org. Audit.
- **`GET /api/llm/usage`** → per D-P12:
  `{ months: [{ month: '2026-07', rows: [{ provider, model, calls, tokensIn,
  tokensOut }] }] }` from a service-role aggregate over workflow_steps ⋈ workflows
  where org matches and `provider_used is not null`.

---

## 6. Settings UI — `/settings/models`

New page `app/(app)/settings/models/page.tsx` (server component shell + client
manager). Link it from the settings page and the sidebar ("Models"). Components under
`components/settings/`:

- **`ProviderConfigList.tsx`** — table of configs: provider icon/name, display name,
  default model, `key: sk-…a8f2`, base_url (when set), status chip, Default badge,
  actions (Test, Edit/Rotate, Deactivate). Status chip = result of the last Test click
  this session (`connected ✓ / invalid key ✗ / unreachable ✗`, gray `untested`
  initially — no background polling).
- **`AddProviderDialog.tsx`** — provider type select (5 options); masked key input
  (`type="password"`, autocomplete off) with copy explaining it's shown never again,
  only last-4 kept for display; base URL field appearing for ollama/custom (with the
  D-P13 reachability note: "must be reachable from the FinFlow server"); default-model
  text input pre-filled per provider (`claude-sonnet-4-6`, `gpt-4.1`,
  `gemini-2.5-pro`, `llama3.2:3b`, empty for custom); "Test connection" button (uses
  the pre-save test mode) that must pass before Save enables (allow "Save anyway" as a
  secondary action for offline setups); Set-as-default checkbox.
- **`StepModelMatrix.tsx`** — per workflow type, list its LLM steps (from a small
  static export of `{workflow_type, step_key, name, role}` — generate it from
  `dag.ts` via a server import, don't hand-copy) with a select: `Org default (…)` |
  each active config. Writes via `PUT /api/llm/step-configs`.
- **`UsagePanel.tsx`** — current + previous month from `/api/llm/usage`: rows of
  provider/model/calls/tokens-in/tokens-out. Plain table, monospace numbers. No cost
  math (prices vary by account — show tokens, let users multiply).
- Non-admin members see the page read-only (hide mutating buttons; the API enforces
  regardless).

UX guards elsewhere: the wizard's launch stage and the ReviewBanner "Re-run" button
lose the localStorage key check (deleted with D-P4) and instead surface the run
route's 400 message inline, linking to `/settings/models`.

---

## 7. UI/audit surfacing of provenance

- **StepCard footer** (LLM steps): `anthropic:claude-sonnet-4-6 · 1,204→312 tok ·
  8.4s · hash 3fa9c2…` (provider:model, tokens_in→out, latency, input-hash short).
  Data already flows through `/status` (it selects full step rows — add the new
  columns to its select list and to `StepRow` in types).
- **AuditTrail component + Excel "Audit Certificate" sheet**: the per-step Model
  column becomes `provider:model` or `deterministic` (D-P14); add Tokens In/Out and
  Latency columns; the footer line becomes: `Generated by FinFlow · models used:
  <distinct provider:model list> · all step inputs hashed with SHA-256 at execution
  time`.
- **`llm_raw` is NOT sent to the client** — exclude it from the status route's select
  (it exists for DB-level audit/export only; keeps payloads small and avoids leaking
  provider account metadata into the browser).

---

## 8. Milestones & acceptance criteria

**N0 — Schema + crypto + env.** Migration 002; `lib/llm/crypto.ts` with vitest
round-trip tests (encrypt→decrypt; tampered tag throws; missing secret throws);
`.env.example` + README env section updated.
✓ `npm test` green incl. crypto tests; migration SQL applies cleanly on a fresh DB
after 001.

**N1 — Provider layer.** `provider.ts`, `json-schema.ts`, `redact.ts`, all five
providers, transport-retry helper. Vitest for: zod→JSON-schema conversion of the
existing agent schemas; Gemini schema conversion; redactAndCap (key-shaped fields
redacted, >64KB capped); provider request-body builders (pure builder functions
exported for testability — assert exact JSON bodies per D-P9 without network).
✓ typecheck + tests green. No step code touched yet.

**N2 — Router + config service.** `router.ts` (`resolveProvider` w/ D-P7 order +
env fallback, `invoke` w/ validation loop), all `/api/llm/*` routes.
✓ Unit tests for resolution order (step-config beats default beats env; inactive
skipped) using a mocked db. Routes compile; admin-only enforced.

**N3 — DAG + orchestrator.** `dag.ts` (three definitions + validateDag + tests:
cycle/unknown-dep detection; recon ready-set sequence is [parse_erp,parse_bank] →
[match] → [flag] → [report]); `orchestrator.ts`; port the three agent files to
`ctx.llm` + key-based priors; delete `runner.ts`, `client.ts`; update run/status
routes; remove browser-BYOK files (D-P4).
✓ typecheck + build + ALL tests green. An orchestrator unit test with stubbed step
runs (no network): happy path completes all rows; a failing middle step pauses the
workflow with siblings persisted; resume after failure re-runs only non-complete
steps; retry/backoff attempted 3× (fake timers).

**N4 — Settings UI.** `/settings/models` + four components + sidebar link + wizard/
ReviewBanner guard changes.
✓ Build green; page renders configs/assignments/usage from the routes; add-provider
flow enforces per-provider required fields; non-admin sees read-only.

**N5 — Provenance surfacing.** StepCard footer, status-route columns (+`StepRow`),
AuditTrail + Excel changes (D-P14), llm_raw excluded from /status.
✓ Build green; Excel workbook shows provider:model + token columns; footer dynamic.

**N6 — Docs + polish.** README: multi-provider architecture section (resolution
order D-P7, encryption model D-P2/D-P3, env vars, Ollama/local-models section with the
connector-pattern note D-P13); PLAN-2 locked-decision references in code comments where
non-obvious. Final full-suite run.
✓ `npm run typecheck && npm run build && npm test` all green; README accurate.

**⛔ Human checkpoint after N6:** live end-to-end with ≥2 real providers (e.g.
Anthropic org-default + one step pinned to OpenAI or a local Ollama), verifying: the
step rows record different provider/model per step, usage panel shows both, audit
certificate lists both, and demo-data expected results (§13 of PLAN.md) still hold
with the default Anthropic config.

---

## 9. Known risks & handling

- **Anthropic SDK structured-output format drift.** anthropic.ts builds
  `output_config.format` from a plain JSON schema. If the installed SDK insists on the
  `zodOutputFormat` helper object shape, use the helper in `json-schema.ts` to produce
  it and pass through — keep the provider file free of zod. Check
  `node_modules/@anthropic-ai/sdk` before guessing.
- **Weak-JSON providers (ollama/custom).** Small local models will fail schema
  validation more often; the invoke retry gives one correction shot, then the step
  errors cleanly and pauses (D-P6) — honest failure, resumable, and the error message
  names the provider/model so the user can reassign the step to a stronger model.
- **Gemini schema subset.** Our schemas are flat (PLAN.md §5.3 constraints), so the
  converter stays small; if a schema feature can't convert, fall back to
  schema-in-prompt for that call (log a `// DECISION:` comment site).
- **Secret rotation.** `LLM_KEY_ENCRYPTION_SECRET` rotation invalidates ciphertexts
  (D-P2). Decrypt failures must surface as 'Stored key cannot be decrypted — re-enter
  it in Settings → Models', not a crash.
- **Concurrent waves vs Vercel duration.** The DAG never widens beyond 2 concurrent
  steps in current definitions; total run time is unchanged. Do not add streaming.
- **Legacy in-flight workflows across deploy.** `step_key` backfill (§3) + resume
  semantics cover it; worst case a demo workflow is re-created.
- **Never log keys.** The discipline from the BYOK pass carries over: decrypted keys
  exist only inside `resolveProvider`→`invoke`→provider call frames; `LLMProviderError`
  messages are constructed from status codes, not request bodies; `llm_raw` passes
  through `redact.ts` before persistence. N3's leak-audit grep from the BYOK commit
  should be re-run and reported in the commit message.

---

*End of Plan 2. Build N0 first. Do not begin N3 until N1+N2 tests are green — the
orchestrator swap touches every workflow and must land on a proven provider layer.*
