-- Plan 2 — multi-provider LLM configuration (§3).
--
-- Two new tables (org_model_configs, workflow_step_configs) plus provenance +
-- usage columns on workflow_steps. RLS is enabled with NO select policies on the
-- config tables (D-P3): the browser can never read them; all access is via the
-- service role in /api/llm/* routes. API keys are AES-256-GCM ciphertext (D-P2),
-- encrypted in the Node API process, never with pgp_sym_encrypt.

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
-- at most one default per org (partial unique index, D-P7 resolution step 2)
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
alter table public.org_model_configs     enable row level security;
alter table public.workflow_step_configs enable row level security;
-- (intentionally no policies; service role bypasses RLS, all access via API routes)
