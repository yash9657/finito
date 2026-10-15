-- Clerk replaces Supabase Auth as the identity provider.
-- profiles.id stays the internal uuid every foreign key points at; clerk_user_id links a
-- profile to the `sub` of the Clerk session token Supabase now accepts (third-party auth).
begin;

alter table public.profiles drop constraint if exists profiles_id_fkey;
alter table public.profiles alter column id set default gen_random_uuid();
alter table public.profiles add column clerk_user_id text unique;

-- Profiles are provisioned by provision_clerk_profile below, not by Supabase sign-ups.
drop trigger if exists on_auth_user_created on auth.users;

-- The caller's profile. auth.uid() casts `sub` to uuid and so cannot read a Clerk id.
-- The id match keeps pre-Clerk Supabase sessions working until the Clerk build is live.
create function public.auth_profile_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from public.profiles
  where clerk_user_id = auth.jwt()->>'sub' or id::text = auth.jwt()->>'sub'
  limit 1
$$;

create or replace function public.auth_org_id() returns uuid
language sql stable security definer set search_path = public as
$$ select org_id from public.profiles where id = public.auth_profile_id() $$;

drop policy memory_settings_self_read on public.memory_settings;
create policy memory_settings_self_read on public.memory_settings for select to authenticated
  using (org_id = public.auth_org_id() and user_id = public.auth_profile_id());
drop policy memory_preferences_self_read on public.memory_preferences;
create policy memory_preferences_self_read on public.memory_preferences for select to authenticated
  using (org_id = public.auth_org_id() and user_id = public.auth_profile_id() and status = 'active');
drop policy interaction_events_self_read on public.interaction_events;
create policy interaction_events_self_read on public.interaction_events for select to authenticated
  using (org_id = public.auth_org_id() and user_id = public.auth_profile_id());

-- First request of a Clerk user. Returns their profile, in order:
--   1. already linked;
--   2. a pre-Clerk profile with the same email (the caller passes only a Clerk-verified email);
--   3. otherwise a new private workspace, as handle_new_user did. Never trust user input for org or role.
create function public.provision_clerk_profile(p_clerk_user_id text, p_email text)
returns public.profiles
language plpgsql security definer set search_path = public as $$
declare
  p public.profiles;
  new_org_id uuid;
begin
  select * into p from public.profiles where clerk_user_id = p_clerk_user_id;
  if found then return p; end if;

  update public.profiles set clerk_user_id = p_clerk_user_id
  where id = (select id from public.profiles
              where clerk_user_id is null and lower(email) = lower(p_email)
              order by created_at limit 1)
  returning * into p;
  if found then return p; end if;

  insert into public.organizations (name) values ('My workspace') returning id into new_org_id;
  insert into public.profiles (email, org_id, role, clerk_user_id)
    values (p_email, new_org_id, 'admin', p_clerk_user_id)
    on conflict (clerk_user_id) do nothing
    returning * into p;
  if not found then
    -- A concurrent first request provisioned this user; drop our unused workspace.
    delete from public.organizations where id = new_org_id;
    select * into p from public.profiles where clerk_user_id = p_clerk_user_id;
  end if;
  return p;
end $$;

-- Server-only: a client that could call this could claim any email's profile.
-- auth_profile_id stays callable by client roles like auth_org_id: RLS calls it, and it
-- returns only the caller's own id.
revoke all on function public.provision_clerk_profile(text, text) from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.provision_clerk_profile(text, text) to service_role;
  end if;
end;
$$;

commit;
