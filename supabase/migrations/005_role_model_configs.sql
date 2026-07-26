-- Plan 4 — per-role provider assignment (§2, D-H13).
--
-- Plan 2 could pin a provider per (workflow_type, step_key) — the Settings step→model
-- matrix. Plan 4 makes the agent ROLE a first-class resolution key, because that is the
-- axis orgs actually reason about: "run matching on Claude, run commentary on our own
-- Ollama box" is a statement about roles, not about the seven individual step keys that
-- happen to have role 'matcher' across three workflows.
--
-- Resolution order becomes (most specific first):
--   1. workflow_step_configs pin for the exact (workflow_type, step_key)
--   2. org_role_configs pin for the step's role          <-- this table
--   3. the org's active default config
--   4. the env-var implicit Anthropic config
--   5. throw NoProviderConfiguredError
--
-- Deliberately a separate table rather than a nullable `step_role` column on
-- workflow_step_configs: a role pin is org-wide and workflow-independent, so putting it in
-- the workflow-scoped table would need a sentinel workflow_type ('*'), and a sentinel in a
-- check-constrained column is how resolution bugs get written.

create table public.org_role_configs (
  org_id                     uuid not null references public.organizations(id) on delete cascade,
  -- Matches STEP_ROLES in lib/types.ts. `verifier` is absent by construction: it is
  -- deterministic code, never dispatched to a provider (D-H15).
  step_role                  text not null
                             check (step_role in ('parser','matcher','classifier','writer')),
  assigned_provider_config_id uuid not null
                             references public.org_model_configs(id) on delete cascade,
  updated_by                 uuid references public.profiles(id),
  updated_at                 timestamptz not null default now(),
  primary key (org_id, step_role)
);

/* -------------------------------------------------------------------------- */
/* RLS. Nothing here is secret (it stores a config id, never a key), so the    */
/* Settings page reads it under RLS like the other Plan 3 tables. Writes go    */
/* through the service role in an API route (D5).                              */
/* -------------------------------------------------------------------------- */

alter table public.org_role_configs enable row level security;

create policy "org role configs" on public.org_role_configs for select
  using (org_id = public.auth_org_id());

-- No insert/update/delete policies: service role bypasses RLS; anon/auth cannot write.
