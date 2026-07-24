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
