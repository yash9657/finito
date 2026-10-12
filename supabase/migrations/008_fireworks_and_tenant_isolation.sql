-- Additive rollout: existing users and provider selections are preserved.
begin;
alter table public.org_model_configs drop constraint org_model_configs_provider_check;
alter table public.org_model_configs add constraint org_model_configs_provider_check
  check (provider in ('fireworks','anthropic','openai','google','ollama','custom'));

-- New signups get a private workspace. Never trust user metadata for org or role.
-- Existing Demo Org memberships require explicit operator review; do not move them silently.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare new_org_id uuid;
begin
  insert into public.organizations (name) values ('My workspace') returning id into new_org_id;
  insert into public.profiles (id, email, org_id, role)
    values (new.id, new.email, new_org_id, 'admin');
  return new;
end $$;

-- Defense in depth: a pin cannot resolve to another tenant's encrypted credential.
alter table public.org_model_configs add constraint org_model_configs_id_org_unique unique (id, org_id);
alter table public.workflow_step_configs add constraint workflow_step_config_same_org
  foreign key (assigned_provider_config_id, org_id) references public.org_model_configs (id, org_id);
alter table public.org_role_configs add constraint role_config_same_org
  foreign key (assigned_provider_config_id, org_id) references public.org_model_configs (id, org_id);
commit;
