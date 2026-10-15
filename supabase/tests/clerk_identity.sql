-- Run against a disposable migrated database as a service/database owner.
-- Fixtures are rolled back; no application records survive.
begin;
do $$
declare
  legacy_org uuid;
  legacy uuid := gen_random_uuid();
  claimed public.profiles;
  again public.profiles;
  fresh public.profiles;
begin
  -- A pre-Clerk user: profile keyed by their old Supabase user id, no clerk_user_id yet.
  insert into public.organizations(name) values('Legacy') returning id into legacy_org;
  insert into public.profiles(id,email,org_id,role) values(legacy,'legacy@example.invalid',legacy_org,'reviewer');

  claimed := public.provision_clerk_profile('user_legacy','Legacy@Example.invalid');
  if claimed.id<>legacy or claimed.org_id<>legacy_org or claimed.role<>'reviewer' then
    raise exception 'A verified email must claim the pre-Clerk profile with its org and role';
  end if;
  again := public.provision_clerk_profile('user_legacy','legacy@example.invalid');
  if again.id<>legacy then raise exception 'Provisioning must be idempotent'; end if;

  fresh := public.provision_clerk_profile('user_fresh','fresh@example.invalid');
  if fresh.org_id=legacy_org or fresh.role<>'admin' then
    raise exception 'A new user must get a private workspace as its admin';
  end if;
  if (public.provision_clerk_profile('user_other','legacy@example.invalid')).id=legacy then
    raise exception 'A claimed profile must not be claimed again by another Clerk user';
  end if;

  if has_function_privilege('authenticated','public.provision_clerk_profile(text,text)','execute')
     or has_function_privilege('anon','public.provision_clerk_profile(text,text)','execute') then
    raise exception 'Client roles must not be able to provision or claim profiles';
  end if;

  -- RLS sees the caller through the Clerk token's sub.
  perform set_config('request.jwt.claims','{"sub":"user_legacy","role":"authenticated"}',true);
  if public.auth_profile_id()<>legacy or public.auth_org_id()<>legacy_org then
    raise exception 'Clerk sub must resolve to the claimed profile and its org';
  end if;
  execute 'set local role authenticated';
  if (select count(*) from public.organizations)<>1 or (select id from public.organizations)<>legacy_org then
    raise exception 'A Clerk session must see only its own organization';
  end if;
  execute 'reset role';

  perform set_config('request.jwt.claims','{"sub":"user_nobody","role":"authenticated"}',true);
  if public.auth_org_id() is not null then raise exception 'An unknown sub must resolve to no org'; end if;

  -- Pre-Clerk Supabase sessions keep working until the Clerk build is live.
  perform set_config('request.jwt.claims',json_build_object('sub',fresh.id::text)::text,true);
  if public.auth_org_id()<>fresh.org_id then raise exception 'A legacy uuid sub must still resolve'; end if;
end;
$$;
rollback;
