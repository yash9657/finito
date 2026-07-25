# FinFlow — Plan 3: Per-Action Authorization (risk taxonomy · approval gate · durable suspend/resume · authorization audit)

> **How to use this document.** Execution plan for FinFlow's third pass, covering
> HANDOFF.md **Edge #1** (per-action approval gating + finance risk taxonomy),
> **Edge #3** (durable suspend-and-resume as the HITL primitive) and **Edge #4**
> (stage-by-stage immutable audit of the *decision*) — the handoff's build-order items
> 1 and 2. Same contract as `PLAN.md` / `PLAN-2.md`: every ambiguity is resolved into a
> **Locked Decision** (D-A1…D-A16) — do not re-litigate. Work milestone by milestone
> (A0 → A6), in order. After each: `npm run typecheck && npm run build && npm test`,
> verify acceptance criteria, one commit per milestone. If something is genuinely
> uncovered, pick the simplest option consistent with §1 and leave a `// DECISION:`
> comment at the site.
>
> `PLAN.md` D1–D10 and `PLAN-2.md` D-P1–D-P15 remain in force. This plan **extends**
> D9 (status vocabulary) and the `DagStepDefinition` / `StepContext` contracts; it
> changes no workflow graph, no prompt text, and no provider-layer behavior.
>
> **Edge #2** (typed org-scoped learned rules) is deliberately NOT in this pass — it is
> the larger moat build and gets its own plan. Where this pass touches its territory
> (vendor-name normalization, promoting a one-off decision into a standing rule) the
> seam is called out so Edge #2 can land on top without rework.

---

## 0. What this pass delivers (one paragraph)

Today FinFlow approves **the whole workflow, once, at the end** — after every
consequential act has already happened. After this pass, a consequential act is a
first-class **action** with a **risk class**, proposed deterministically in TypeScript
from source data, evaluated against an org **permission policy** *before* the step that
commits it runs. Actions above a structural ceiling are **denied outright** — no
in-band click can override them. Actions covered by a **target-bound standing rule**
("this vendor, up to this amount") are auto-approved with the rule recorded. Everything
else **durably suspends the workflow**: the pending item lives in Postgres, survives
restarts, is answerable from any surface, resolves exactly once, and auto-resumes the
DAG when the last one is decided. Every stage of that chain — proposed → approval
requested → auto-approved-under-rule / resolved-by-human / denied-by-ceiling →
committed — is written to the immutable audit log and surfaced in the on-page audit
certificate and the Excel workbook. The artifact an auditor wants ("payment P was
auto-approved under standing rule R, minted by U on D, and the $50k+ one was denied by
the org ceiling regardless of who clicked") is now producible.

---

## 1. Locked decisions (do not revisit)

**D-A1 — An "action" is a first-class, deterministically-proposed object.**
A consequential act is neither a step nor a tool call: it is a `ProposedAction` returned
by a step's `proposeActions(ctx)`, computed in **pure TypeScript** from parsed files and
prior step outputs (D3 — the model never invents an action, an amount, or a
counterparty). `actionKey` is deterministic (`<action_type>:<target.id>`) and unique per
workflow, which is what makes the whole gate idempotent across resumes: re-proposing an
action finds its existing decision instead of creating a second one.

**D-A2 — The risk taxonomy is a data table, not name checks.**
`RISK_CLASSES = ['read','writes_ledger','moves_money','external_filing']`, each with a
row in `lib/approvals/risk.ts` carrying `severity`, `label`, `requiresAuthorization`,
`ceilingApplies`. `DagStepDefinition` gains `risk: RiskClass` (default `'read'`).
Nothing anywhere branches on a step name or an action-type string literal to decide
consequence. **Today's only non-`read` step is AP `approval_queue` → `moves_money`**
(approving a supplier invoice for payment): it is the one place FinFlow currently
decides that money should move. Reconciliation and FP&A steps stay `read` — we do not
invent a ledger-posting or filing integration we do not have. The machinery is generic,
so adding `writes_ledger` / `external_filing` actions later is a data change plus a
`proposeActions` body, not a redesign.

**D-A3 — Gate before commit; evaluate per action; bind approval to arguments.**
For a step with `risk !== 'read'` (or any step declaring `proposeActions`), the
orchestrator: marks the step `running`, writes the input snapshot + hash, calls
`proposeActions(ctx)`, persists/reconciles one `action_requests` row per action,
evaluates each, and then **either** suspends (any row still `pending`) **or** runs
`def.run(ctx)` with `ctx.approvals` populated. The step commits **only** authorized
actions and records why the rest were not. An approval is always bound to the action's
**target** (`kind`, `id`, `counterparty`, `amountCents`) — never to "the step" or "the
action type" in the abstract.

**D-A4 — Structural ceilings are absolute; no in-band click can override them.**
`org_approval_policies` (one row per org, all-permissive defaults when absent):
- `hard_deny_above_cents` — an action whose amount exceeds this is `denied` at proposal
  time, terminal, audited `action_denied_by_ceiling`. The decide route refuses to
  resolve a `denied` row; no UI path exists. (Analog of OpenWorker's "writes outside a
  sanctioned root are denied regardless of approval".)
- `require_known_counterparty` + `approved_counterparties text[]` — when on, an action
  whose counterparty is not in the allowlist is `denied` the same way.
- `auto_approve_max_cents` — a **rule ceiling**: a standing rule can never auto-approve
  above this; such actions fall through to a human even with a matching rule.
Evaluation order is fixed: **ceilings → rules → human**.

**D-A5 — Denial resolves an action; it does not fail the run.**
`denied` and `rejected` are *resolutions*. The workflow proceeds and the committing step
excludes those actions, recording the reason on the output (AP: the invoice moves to
hold-for-review with its authorization note). Only `pending` suspends. Rationale: an
org ceiling doing its job is not a system error, and failing the run would destroy the
rest of the deliverable.

**D-A6 — Tiered grants: `once` / `run` / `standing`, always target-bound.**
`approval_rules.scope`:
- `once` — this exact target, single use (`target_id` + `workflow_id` required,
  `consumed_at` stamped when it fires).
- `run` — this workflow run (`workflow_id` required + ≥1 binding constraint).
- `standing` — durable, org-wide, **must** carry ≥1 binding constraint
  (`counterparty` and/or `max_amount_cents`); `workflow_id` must be null. An unbounded
  standing rule is rejected `400` server-side — "approve the action type" is not
  expressible in this schema by construction.
Matching is exact-after-normalization on `action_type` + `target_kind` + constraints,
with `revoked_at` / `expires_at` / `consumed_at` respected. Counterparty comparison
normalizes case + surrounding/collapsed whitespace only — **fuzzy vendor aliasing is
Edge #2's typed `vendor_alias` layer and is deliberately absent here** (a fuzzy match
that silently widens an authorization is exactly the bug this pass exists to prevent).

**D-A7 — Learn-path and apply-path are separate (Edge #2 seam).**
Resolving a pending action never creates a rule as a side effect. Minting a standing
rule is an explicit, separately-audited act (`grant` on the decide call or the Settings
page), stamped with `created_by` + `created_at`, revocable, and re-evaluated against the
workflow's remaining pending actions when it lands. Deliberate accretion, not implicit
drift.

**D-A8 — Who may approve (segregation of duties).**
Approving/rejecting requires `profile.role ∈ {admin, reviewer}` (an `analyst` may launch
runs but not authorize money movement). Minting/revoking rules and editing the policy
are `admin` only. Policy flag `require_separate_approver` (default `false`): when on,
the workflow's `created_by` may not resolve its own run's actions (`403`) — real
four-eyes, off by default because the demo org has one member.

**D-A9 — Durable pending items; resolve-exactly-once; first-responder-wins.**
No in-memory waiters, no queue: a pending item **is** an `action_requests` row. A
decision is a conditional `UPDATE … WHERE id = $1 AND status = 'pending'` returning the
row; zero rows returned ⇒ `409` naming the existing resolution. The same POST route is
what a future Slack/email action would call — the surface is a detail, the row is the
truth. This is why the gate survives a process restart, a redeploy, or a week of
waiting at ~zero idle cost.

**D-A10 — Suspension is a status, and resume is the existing idempotent path.**
Workflow statuses gain `awaiting_approval`; step statuses gain `awaiting_approval`
(migration widens both check constraints; D9 extended). The orchestrator, on entry,
resets `error` **and** `awaiting_approval` steps to `pending` and re-enters the ready-set
loop (D-P6 semantics unchanged; `complete` steps are never re-run, D2). Resolving the
last pending action of a suspended workflow flips it to `running` and fires
`waitUntil(runWorkflow(id))` — **auto-resume**. `POST /run` also accepts
`awaiting_approval` (manual resume) but `409`s while pending actions remain.

**D-A11 — Suspension is not failure, in code as well as in status.**
`executeStep` returns a three-way outcome (`ok` / `suspended` / `failed`). Suspension
sets a `suspended` flag that stops scheduling new waves (in-flight siblings still finish
and persist, as with failure — their work is not wasted) but leaves `workflows.status =
'awaiting_approval'` and `error_message = null`. The `awaiting_review` flip requires
`allComplete && !aborted && !suspended`.

**D-A12 — Polling is unchanged (D1).** The status route now also returns
`actions: ActionRequestRow[]`, so the live view needs no new endpoint. Polling still
runs only while `running`: `awaiting_approval` is a human-wait state, and the approval
panel refetches on every decision, so a 2s poll against a waiting workflow would be pure
noise.

**D-A13 — Proposal and commit share one deterministic function.**
For each gated step, the candidate set is computed by a single exported helper used by
**both** `proposeActions` and `run` (AP: `payableCandidates(invoices, match, flags)`).
They can therefore never disagree about which actions exist — the class of bug where a
gate authorizes one thing and the commit does another is structurally excluded.

**D-A14 — Prompts are not rewritten (PLAN-2 §4.2 discipline).**
`AP_QUEUE_SYSTEM` and every other prompt string is byte-identical after this pass. The
AP narrative's user payload gains one additive key (`authorizationHolds`) so the model
can mention withheld payments; adding a key is compatible with the existing instruction
text and does not touch it.

**D-A15 — The authorization chain lives in `audit_log`, workflow-scoped.**
New actions: `action_proposed`, `approval_requested`, `action_auto_approved`,
`action_denied_by_ceiling`, `approval_resolved`, `action_committed`, `action_withheld`,
`standing_rule_minted`, `workflow_suspended`, `workflow_resumed`. Details carry
`action_key`, `action_type`, `risk_class`, target (`id`, `counterparty`,
`amount_cents`), the rule id and the approver id — never free text from a secret-bearing
surface. `audit_log.workflow_id` stays `NOT NULL` (no schema loosening): **org-level**
authorization events (policy edits, rules minted or revoked from Settings) are recorded
on the rows themselves via `created_by` / `created_at` / `revoked_by` / `revoked_at` /
`updated_by` / `updated_at`, which is what the Settings UI renders. A rule minted *in
the context of a workflow decision* also writes `standing_rule_minted` to that
workflow's audit log.

**D-A16 — Money is integer cents (D7) everywhere in this layer** — ceilings, rule caps,
action amounts, all `bigint` in SQL and `number` cents in TS. Formatting happens only in
the UI/report layer via `lib/format.ts`.

---

## 2. Database — `supabase/migrations/003_approvals.sql` (complete)

```sql
-- Widen the status vocabularies (D-A10, extends D9).
alter table public.workflows      drop constraint workflows_status_check;
alter table public.workflows      add  constraint workflows_status_check
  check (status in ('idle','running','awaiting_approval','awaiting_review',
                    'approved','rejected','error'));
alter table public.workflow_steps drop constraint workflow_steps_status_check;
alter table public.workflow_steps add  constraint workflow_steps_status_check
  check (status in ('pending','running','awaiting_approval','complete','error'));

-- Structural ceilings + SoD policy, one row per org (D-A4/D-A8).
create table public.org_approval_policies (
  org_id                     uuid primary key
                             references public.organizations(id) on delete cascade,
  hard_deny_above_cents      bigint,                        -- null = no absolute ceiling
  auto_approve_max_cents     bigint,                        -- null = rules uncapped
  require_known_counterparty boolean not null default false,
  approved_counterparties    text[]  not null default '{}',
  require_separate_approver  boolean not null default false,
  updated_by                 uuid references public.profiles(id),
  updated_at                 timestamptz not null default now()
);

-- Tiered, target-bound grants (D-A6/D-A7).
create table public.approval_rules (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations(id) on delete cascade,
  scope            text not null check (scope in ('once','run','standing')),
  workflow_id      uuid references public.workflows(id) on delete cascade,
  action_type      text not null,
  target_kind      text not null,
  target_id        text,          -- required for scope 'once'
  counterparty     text,          -- exact-after-normalization; null = any
  max_amount_cents bigint,        -- inclusive cap; null = uncapped
  note             text,
  created_by       uuid not null references public.profiles(id),
  created_at       timestamptz not null default now(),
  expires_at       timestamptz,
  consumed_at      timestamptz,
  revoked_at       timestamptz,
  revoked_by       uuid references public.profiles(id)
);
create index on public.approval_rules (org_id, action_type);
create index on public.approval_rules (workflow_id);

-- One row per consequential action; the durable pending item (D-A1/D-A9).
create table public.action_requests (
  id               uuid primary key default gen_random_uuid(),
  workflow_id      uuid not null references public.workflows(id) on delete cascade,
  step_id          uuid references public.workflow_steps(id) on delete set null,
  step_key         text not null,
  action_key       text not null,
  action_type      text not null,
  risk_class       text not null
                   check (risk_class in ('read','writes_ledger','moves_money','external_filing')),
  target           jsonb not null,
  target_kind      text not null,
  target_id        text not null,
  counterparty     text,
  amount_cents     bigint,
  summary          text not null,
  payload          jsonb,
  status           text not null default 'pending'
                   check (status in ('pending','auto_approved','approved','rejected','denied')),
  decision_source  text check (decision_source in ('standing_rule','human','ceiling','policy')),
  decision_reason  text,
  standing_rule_id uuid references public.approval_rules(id) on delete set null,
  decided_by       uuid references public.profiles(id),
  comment          text,
  proposed_at      timestamptz not null default now(),
  decided_at       timestamptz,
  committed_at     timestamptz,
  unique (workflow_id, action_key)            -- idempotency of the gate (D-A1)
);
create index on public.action_requests (workflow_id, status);

-- RLS: org-scoped SELECT (no secrets here, unlike D-P3's key table); all writes via
-- the service role in API routes / the orchestrator (D5).
alter table public.action_requests       enable row level security;
alter table public.approval_rules        enable row level security;
alter table public.org_approval_policies enable row level security;

create policy "org actions" on public.action_requests for select
  using (exists (select 1 from public.workflows w
                 where w.id = workflow_id and w.org_id = public.auth_org_id()));
create policy "org rules"   on public.approval_rules for select
  using (org_id = public.auth_org_id());
create policy "org policy"  on public.org_approval_policies for select
  using (org_id = public.auth_org_id());
```

**Default policy semantics:** no row ⇒ every field null/false ⇒ nothing is denied,
nothing is auto-approved (there are no rules yet), so **every** consequential action
requires a human. Fail-closed by construction.

---

## 3. `lib/approvals/` — the authorization layer

```
lib/approvals/
  risk.ts       # RISK_CLASSES data table + specs (D-A2)
  engine.ts     # pure evaluateAction() + validateRuleInput() + rule matching (D-A4/D-A6)
  service.ts    # DB-facing: load policy/rules, sync proposals, resolve-exactly-once
```

### 3.1 `engine.ts` (verbatim contract — pure, no DB, no I/O)

```ts
export type ActionOutcome = 'auto_approved' | 'pending' | 'denied';

export interface ActionEvaluation {
  outcome: ActionOutcome;
  /** Human-readable, stored in action_requests.decision_reason and shown in the UI. */
  reason: string;
  ruleId: string | null;
  source: 'standing_rule' | 'ceiling' | 'policy' | null;
}

export function evaluateAction(input: {
  action: ProposedAction;
  workflowId: string;
  policy: ApprovalPolicy;      // defaults already applied
  rules: ApprovalRule[];       // org rules; engine filters scope/expiry/revocation
  nowIso: string;
}): ActionEvaluation;

/** Server-side grant validation (D-A6). Returns an error message or null. */
export function validateRuleInput(input: ApprovalRuleInput): string | null;
```

Order inside `evaluateAction` (each step returns immediately):
1. `!spec.requiresAuthorization` → `auto_approved` / `policy` ("read-only action").
2. `spec.ceilingApplies && amountCents == null` → `pending` (fail closed: an amountless
   money action can never be ceiling-checked, so it always sees a human).
3. `hard_deny_above_cents != null && amount > it` → `denied` / `ceiling`.
4. `require_known_counterparty` and counterparty ∉ `approved_counterparties` (normalized)
   → `denied` / `policy`.
5. First matching rule (precedence `once` → `run` → `standing`, newest first):
   - `auto_approve_max_cents != null && amount > it` → `pending` / `ceiling`
     ("rule R covers this but the org auto-approve ceiling is $X").
   - else → `auto_approved` / `standing_rule` with `ruleId`.
6. else → `pending`, `source: null`, reason naming action type, counterparty, amount.

`ruleMatches` requires **all** of: not revoked; not expired; `scope === 'standing' ||
workflow_id === workflowId`; `scope !== 'once' || (consumed_at == null && target_id ===
action.target.id)`; `action_type` and `target_kind` equal; `counterparty == null ||
normalizedEqual(...)`; `max_amount_cents == null || (amountCents != null && amount <=
cap)`. A rule that constrains a dimension the action lacks does **not** match.

### 3.2 `service.ts` (DB-facing, service-role client)

```ts
loadPolicy(db, orgId): Promise<ApprovalPolicy>              // defaults when no row
loadRules(db, orgId, workflowId): Promise<ApprovalRule[]>   // org + this run's scoped rules
gateStepActions(db, {workflow, stepKey, stepId, actions}): Promise<ActionRequestRow[]>
reevaluatePending(db, {workflowId, orgId}): Promise<ActionRequestRow[]>
resolveAction(db, {actionId, decision, approverId, comment}): Promise<ResolveResult>
pendingActions(db, workflowId): Promise<ActionRequestRow[]>
decisionMap(rows): ActionDecisionMap
markCommitted(db, rows): Promise<void>
```

`gateStepActions` is idempotent (D-A1): for each proposed action it upserts by
`(workflow_id, action_key)` — an existing row keeps its decision, a new row is evaluated,
inserted, and audited (`action_proposed` plus one of `approval_requested` /
`action_auto_approved` / `action_denied_by_ceiling`). It then calls `reevaluatePending`
so a rule minted since the last attempt flips matching pending rows without a human.
`resolveAction` performs the conditional single-row update of D-A9 and returns
`{ ok: true, row } | { ok: false, reason: 'already_resolved' | 'not_overridable', row }`
— `denied` rows are never resolvable.

---

## 4. Step-engine contract changes (`lib/types.ts`)

```ts
export interface DagStepDefinition {
  …                                      // unchanged fields
  /** D-A2 — defaults to 'read'; only non-read steps are gated. */
  risk?: RiskClass;
  /** D-A1/D-A13 — deterministic; must not call ctx.llm. */
  proposeActions?(ctx: StepContext): Promise<ProposedAction[]>;
}

export interface StepContext {
  …
  /** D-A3 — actionKey → decision for THIS step's actions; empty for read steps. */
  approvals: ActionDecisionMap;
}
```

`validateDag` additionally throws when a step declares `proposeActions` with
`risk: 'read'` (or omits `risk`) and when a non-`read` step has no `proposeActions` — a
mislabelled gate is a build-time error, not a silent bypass.

---

## 5. API routes

- **`POST /api/workflows/[id]/approvals`** — body
  `{ actionIds: string[], decision: 'approve'|'reject', comment?, grant? }`.
  Role + SoD checks (D-A8) → resolve each id exactly once (D-A9) → if `grant` is present
  with an `approve`, validate + insert the rule (audited `standing_rule_minted`) and
  re-evaluate the run's remaining pending actions → if none remain and the workflow is
  `awaiting_approval`, flip to `running`, audit `workflow_resumed`, and
  `waitUntil(runWorkflow(id))`. → `{ resolved, alreadyResolved, notOverridable,
  pendingRemaining, resumed }`. `maxDuration = 300`.
- **`GET|PUT /api/approvals/policy`** — org policy; `PUT` admin-only, validates
  `hard_deny_above_cents ≥ auto_approve_max_cents` when both set, upserts, audits via
  `updated_by/updated_at`.
- **`GET|POST /api/approvals/rules`** — list active/standing rules; `POST` mints one
  (admin-only, `validateRuleInput`).
- **`DELETE /api/approvals/rules/[id]`** — revoke (`revoked_at`, `revoked_by`); never a
  hard delete, so past auto-approvals keep pointing at the rule that authorized them.
- **`GET /api/workflows/[id]/status`** — gains `actions: ActionRequestRow[]` (D-A12).
- **`POST /api/workflows/[id]/run`** — accepts `awaiting_approval` as resumable;
  `409` while pending actions remain.

---

## 6. UI

- **`components/workflow/ApprovalPanel.tsx`** — renders when the run has actions: a
  pending group (risk chip, counterparty, amount, summary, the `decision_reason`
  explaining *why* a human is needed, per-row and bulk Approve/Reject, and an explicit
  "also create a standing rule…" affordance with the scope/constraint selector) and a
  resolved group (status, source, rule, approver, timestamp). Denied rows render with no
  approve control and the ceiling reason.
- **Workflow page** — panel above `ReviewBanner`; `ReviewBanner` gains an
  `awaiting_approval` state pointing at the panel; `StepCard` renders an
  `awaiting_approval` glyph/badge; status header label + variant added.
- **`app/(app)/settings/approvals/page.tsx`** — server component reading policy + rules
  under RLS, with client editors: ceilings, counterparty allowlist, SoD toggle, and the
  standing-rules table with mint/revoke. Non-admins see it read-only (the API enforces
  regardless). Linked from the sidebar and the Settings page.

---

## 7. Audit + report surfacing (Edge #4)

- **`AuditTrail.tsx`** — new "Authorization chain" section: one row per action with
  action type, target (`id` · counterparty · amount), risk class, status, decision
  source, standing rule id, approver email, proposed/decided timestamps. Certificate
  footer gains `· N of M consequential actions authorized (K by standing rule, J denied
  by ceiling)`.
- **Excel** — new **Authorization** sheet with the same columns; the "Hold for Review"
  sheet gains an Authorization column; the footer line matches the on-page one.
- **Report page** — loads `action_requests` (RLS-scoped) and the approver profiles.

---

## 8. Milestones & acceptance criteria

**A0 — Schema + types + risk taxonomy.** Migration 003; `lib/approvals/risk.ts`;
`lib/types.ts` additions (risk/action/rule/policy types, widened status unions,
`StepContext.approvals`, `DagStepDefinition.risk/proposeActions`); `validateDag` gate
consistency check + test.
✓ typecheck + build + tests green; migration applies cleanly after 002.

**A1 — Permission engine.** `engine.ts` + `engine.test.ts`: ceiling denial beats a
matching rule and cannot be resolved; unknown counterparty denied only when the policy
requires it; rules match only their bound target (vendor, amount band, exact id);
expired/revoked/consumed rules ignored; `run` rules do not leak across workflows;
`auto_approve_max_cents` demotes a rule hit to `pending`; amountless money action →
`pending`; unbounded standing rule rejected by `validateRuleInput`.
✓ tests green; the engine imports nothing from `@supabase/*`.

**A2 — Orchestrator gate + durable suspend/resume.** `service.ts`; orchestrator
three-way outcome + gate + suspension; entry-time reset of `awaiting_approval` steps;
run-route resume; `/status` actions.
✓ orchestrator tests: a gated step suspends the workflow (`awaiting_approval`, rows
persisted, `run` NOT called, sibling in the same wave still persists); after approval a
resume runs it with `ctx.approvals` and reaches `awaiting_review`; a rule-covered action
never suspends; a ceiling-denied action does not block the run; re-entry does not
duplicate action rows.

**A3 — AP wired to the gate.** `payableCandidates` shared helper; `approval_queue`
declares `risk: 'moves_money'` + `proposeActions`; commit path honors
`ctx.approvals` and records `authorization` on both auto-approved and withheld items;
`authorizationHolds` added to the narrative payload; prompts byte-identical.
✓ tests: helper split matches the pre-existing behavior when everything is authorized;
withheld invoices land in `holdForReview` with a reason; `git diff` shows no change to
any prompt constant.

**A4 — API routes.** All of §5, each audited.
✓ build green; decide route is exactly-once under a double POST (unit-tested through the
service); role/SoD enforced; auto-resume fires only when the last pending action clears.

**A5 — UI.** All of §6.
✓ build green; a suspended run renders the pending actions with reasons; approving all
resumes the run; the settings page mints and revokes a standing rule.

**A6 — Audit chain + docs.** §7 plus a README section (risk taxonomy, evaluation order,
ceilings, grant tiers, SoD, resume semantics) and PLAN-3 references at non-obvious sites.
✓ `npm run typecheck && npm run build && npm test` green; Excel workbook contains the
Authorization sheet; certificate footer counts correct.

**⛔ Human checkpoint after A6:** run the AP demo end-to-end against the live Supabase
project: confirm the run suspends, one payment is approved by hand, a standing rule
("vendor X ≤ $Y") auto-approves the rest on resume, a policy ceiling denies an oversized
payment un-overridably, and the downloaded workbook's Authorization sheet tells that
whole story.

---

## 9. Known risks & handling

- **Every AP run now stops for approval on a fresh org.** Intended (D-A4 default is
  fail-closed) and it is the demo's punchline, but it changes PLAN.md §13's AP
  expectations: the run reaches `awaiting_review` only after authorization. The sanctioned
  way to make it flow is minting a bounded standing rule — deliberately *not* a
  "skip approvals" flag, which would undermine the whole edge.
- **A step's proposal must be deterministic.** A `proposeActions` that depended on the
  clock or the model would produce a different action set on resume and orphan decisions.
  The AP proposal derives only from parsed rows + prior outputs; `payableCandidates` is
  pure and unit-tested for stability.
- **Long suspensions vs. `waitUntil`.** Suspension deliberately *ends* the serverless
  invocation — nothing is held open, so a week-long wait costs nothing. Resume is a fresh
  invocation of the same idempotent `runWorkflow` (D2).
- **Double-decide races** (two reviewers, or a retried POST) are settled by the
  conditional update of D-A9; the loser gets `409` naming the winner, never a silent
  overwrite.
- **Ceiling changes mid-flight.** Pending actions are re-evaluated at gate time, so
  tightening a ceiling can flip a pending action to `denied` before it is committed.
  Already-`approved` actions are never retro-denied — the audit chain records the policy
  as of the decision.
- **Vendor-name drift** ("Acme Inc" vs "ACME, Inc.") will fail exact-after-normalization
  matching and correctly fall through to a human. Fixing that is Edge #2's typed
  `vendor_alias` layer, not a fuzzy matcher bolted on here (D-A6).

---

*End of Plan 3. Build A0 first. Do not begin A2 until A1's engine tests are green — the
orchestrator gate must land on a proven evaluator.*
