-- Plan 3 — per-action authorization (§2).
--
-- Adds the three tables the approval gate needs (org_approval_policies,
-- approval_rules, action_requests) and widens the workflow/step status vocabularies
-- with `awaiting_approval` (D-A10, extending D9).
--
-- Unlike the Plan 2 config tables (D-P3) nothing here is secret, so all three get
-- org-scoped SELECT policies — the report page and the settings page read them under
-- RLS. Every WRITE still goes through the service role in an API route or the
-- orchestrator (D5).

/* -------------------------------------------------------------------------- */
/* Status vocabularies (D-A10)                                                 */
/* -------------------------------------------------------------------------- */

alter table public.workflows drop constraint workflows_status_check;
alter table public.workflows add constraint workflows_status_check
  check (status in ('idle','running','awaiting_approval','awaiting_review',
                    'approved','rejected','error'));

alter table public.workflow_steps drop constraint workflow_steps_status_check;
alter table public.workflow_steps add constraint workflow_steps_status_check
  check (status in ('pending','running','awaiting_approval','complete','error'));

/* -------------------------------------------------------------------------- */
/* Structural ceilings + segregation of duties, one row per org (D-A4/D-A8).   */
/* No row = all-permissive ceilings AND no rules, so every consequential       */
/* action needs a human: fail-closed by construction.                          */
/* -------------------------------------------------------------------------- */

create table public.org_approval_policies (
  org_id                     uuid primary key
                             references public.organizations(id) on delete cascade,
  hard_deny_above_cents      bigint,                        -- null = no absolute ceiling
  auto_approve_max_cents     bigint,                        -- null = rule-based auto-approval uncapped
  require_known_counterparty boolean not null default false,
  approved_counterparties    text[]  not null default '{}',
  require_separate_approver  boolean not null default false,
  updated_by                 uuid references public.profiles(id),
  updated_at                 timestamptz not null default now()
);

/* -------------------------------------------------------------------------- */
/* Tiered, target-bound grants (D-A6/D-A7). A `standing` rule MUST carry at    */
/* least one binding constraint (counterparty and/or max_amount_cents) — the   */
/* API rejects unbounded grants; "approve the action type" is not expressible. */
/* -------------------------------------------------------------------------- */

create table public.approval_rules (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations(id) on delete cascade,
  scope            text not null check (scope in ('once','run','standing')),
  workflow_id      uuid references public.workflows(id) on delete cascade,
  action_type      text not null,
  target_kind      text not null,
  target_id        text,          -- required for scope 'once'
  counterparty     text,          -- exact-after-normalization; null = any counterparty
  max_amount_cents bigint,        -- inclusive cap in cents (D7/D-A16); null = uncapped
  note             text,
  created_by       uuid not null references public.profiles(id),
  created_at       timestamptz not null default now(),
  expires_at       timestamptz,
  consumed_at      timestamptz,   -- stamped when a 'once' rule fires
  revoked_at       timestamptz,   -- revocation is soft so past auto-approvals keep their rule
  revoked_by       uuid references public.profiles(id)
);
create index on public.approval_rules (org_id, action_type);
create index on public.approval_rules (workflow_id);

/* -------------------------------------------------------------------------- */
/* One row per consequential action — the durable pending item (D-A1/D-A9).    */
/* unique (workflow_id, action_key) is what makes the gate idempotent across   */
/* resumes: re-proposing an action finds its decision instead of duplicating.  */
/* -------------------------------------------------------------------------- */

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
  unique (workflow_id, action_key)
);
create index on public.action_requests (workflow_id, status);

/* -------------------------------------------------------------------------- */
/* RLS — org-scoped reads, service-role writes (D5).                           */
/* -------------------------------------------------------------------------- */

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
-- No insert/update/delete policies: service role bypasses RLS; anon/auth cannot write.
