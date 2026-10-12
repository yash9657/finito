begin;

create table public.memory_settings (
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create table public.memory_preferences (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  content text not null,
  status text not null default 'active' check (status in ('active','deleted')),
  source_question_id uuid,
  source_question text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  search_vector tsvector generated always as (to_tsvector('english'::regconfig, content)) stored,
  check ((status = 'active' and length(content) between 1 and 2000) or (status = 'deleted' and content = '')),
  foreign key (org_id, source_question_id) references public.investigations(org_id, workflow_id) on delete set null (source_question_id)
);
create index memory_preferences_owner on public.memory_preferences(org_id, user_id, updated_at desc) where status = 'active';
create index memory_preferences_search on public.memory_preferences using gin(search_vector) where status = 'active';
alter table public.memory_settings enable row level security;
alter table public.memory_preferences enable row level security;
create policy memory_settings_self_read on public.memory_settings for select to authenticated
  using (org_id = public.auth_org_id() and user_id = auth.uid());
create policy memory_preferences_self_read on public.memory_preferences for select to authenticated
  using (org_id = public.auth_org_id() and user_id = auth.uid() and status = 'active');
revoke all on public.memory_settings, public.memory_preferences from anon, authenticated;
grant select on public.memory_settings, public.memory_preferences to authenticated;
grant all on public.memory_settings, public.memory_preferences to service_role;

-- Generated vectors index existing questions immediately, including historical answers.
alter table public.investigations add column memory_search tsvector generated always as (
  setweight(to_tsvector('english'::regconfig, question), 'A') ||
  setweight(to_tsvector('english'::regconfig, coalesce(answer ->> 'prose', '')), 'B')
) stored;
create index investigations_memory_search on public.investigations using gin(memory_search);
alter table public.data_sources
  add column search_index_status text not null default 'pending' check (search_index_status in ('pending','indexed','failed')),
  add column search_index_error text,
  add column search_indexed_at timestamptz,
  add column search_index_chunks integer not null default 0,
  add column memory_search tsvector generated always as (
    setweight(to_tsvector('english'::regconfig, filename), 'A') ||
    setweight(to_tsvector('english'::regconfig, left(manifest::text, 65536)), 'B')
  ) stored;
create index data_sources_memory_search on public.data_sources using gin(memory_search) where status = 'active';

create table public.source_memory_chunks (
  source_id uuid not null,
  org_id uuid not null,
  chunk_no integer not null check (chunk_no between 0 and 59999),
  table_id text not null check (table_id ~ '^t[0-9]+$'),
  original_row integer check (original_row > 0),
  row_kind text not null check (row_kind in ('metadata','header','preamble','data')),
  content text not null check (length(content) between 1 and 8000),
  search_vector tsvector generated always as (to_tsvector('english'::regconfig, content)) stored,
  primary key (source_id, chunk_no),
  foreign key (source_id, org_id) references public.data_sources(id, org_id) on delete cascade
);
create index source_memory_chunks_org on public.source_memory_chunks(org_id, source_id);
create index source_memory_chunks_search on public.source_memory_chunks using gin(search_vector);
alter table public.source_memory_chunks enable row level security;
create policy source_memory_chunks_org_read on public.source_memory_chunks for select to authenticated
  using (org_id = public.auth_org_id() and exists (
    select 1 from public.data_sources s where s.id = source_id and s.org_id = public.auth_org_id() and s.status = 'active' and s.search_index_status = 'indexed'
  ));
revoke all on public.source_memory_chunks from anon, authenticated;
grant select on public.source_memory_chunks to authenticated;
grant all on public.source_memory_chunks to service_role;

create function public.assert_memory_identity(p_org uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_user is null or not exists (select 1 from public.profiles where id = p_user and org_id = p_org) then
    raise exception using errcode = '42501', message = 'Memory identity does not belong to this organization';
  end if;
end;
$$;

create function public.set_memory_enabled(p_org uuid, p_user uuid, p_enabled boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.assert_memory_identity(p_org, p_user);
  if p_enabled is null then raise exception 'enabled must be boolean'; end if;
  insert into public.memory_settings(org_id,user_id,enabled) values(p_org,p_user,p_enabled)
  on conflict(org_id,user_id) do update set enabled = excluded.enabled, updated_at = now();
end;
$$;

create function public.save_memory_preference(p_org uuid, p_user uuid, p_content text, p_id uuid default null, p_question uuid default null, p_automatic boolean default false)
returns public.memory_preferences language plpgsql security definer set search_path = public as $$
declare result public.memory_preferences; question_text text;
begin
  perform public.assert_memory_identity(p_org, p_user);
  if p_automatic and not coalesce((select enabled from public.memory_settings where org_id=p_org and user_id=p_user),true) then
    raise exception using errcode='P0001',message='memory_disabled';
  end if;
  if p_content is null or length(trim(p_content)) not between 1 and 2000 then raise exception 'Preference must contain 1 to 2000 characters'; end if;
  if p_question is not null then
    select question into question_text from public.investigations where workflow_id=p_question and org_id=p_org and created_by=p_user;
    if not found then raise exception using errcode='42501',message='Preference provenance is unavailable for this user'; end if;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_org::text || ':' || p_user::text, 0));
  if p_id is null then
    if (select count(*) from public.memory_preferences where org_id=p_org and user_id=p_user and status='active') >= 100 then raise exception 'A user can store at most 100 active preferences'; end if;
    insert into public.memory_preferences(org_id,user_id,content,source_question_id,source_question)
      values(p_org,p_user,trim(p_content),p_question,question_text) returning * into result;
  else
    update public.memory_preferences set content=trim(p_content), source_question_id=p_question, source_question=question_text, updated_at=now()
      where id=p_id and org_id=p_org and user_id=p_user and status='active' returning * into result;
    if not found then raise exception using errcode='P0002',message='Preference not found'; end if;
  end if;
  return result;
end;
$$;

create function public.delete_memory_preference(p_org uuid, p_user uuid, p_id uuid) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  perform public.assert_memory_identity(p_org,p_user);
  update public.memory_preferences set status='deleted',content='',source_question_id=null,source_question=null,updated_at=now()
    where id=p_id and org_id=p_org and user_id=p_user and status='active';
  return found;
end;
$$;

create function public.replace_source_memory_chunks(p_org uuid,p_source uuid,p_chunks jsonb) returns integer
language plpgsql security definer set search_path = public as $$
declare chunk_count integer; char_count bigint;
begin
  if not exists (select 1 from public.data_sources where id=p_source and org_id=p_org and status='active' for update) then raise exception 'Source not found'; end if;
  if jsonb_typeof(p_chunks) is distinct from 'array' then raise exception 'Chunks must be an array'; end if;
  select count(*), coalesce(sum(length(c->>'content')),0) into chunk_count,char_count from jsonb_array_elements(p_chunks) c;
  if chunk_count > 60000 or char_count > 33554432 then raise exception 'Source exceeds the full-content search index limit'; end if;
  delete from public.source_memory_chunks where org_id=p_org and source_id=p_source;
  insert into public.source_memory_chunks(source_id,org_id,chunk_no,table_id,original_row,row_kind,content)
    select p_source,p_org,c.chunk_no,c.table_id,c.original_row,c.row_kind,c.content
    from jsonb_to_recordset(p_chunks) as c(chunk_no integer,table_id text,original_row integer,row_kind text,content text);
  update public.data_sources set search_index_status='indexed', search_index_error=null, search_indexed_at=now(), search_index_chunks=chunk_count where id=p_source and org_id=p_org;
  return chunk_count;
end;
$$;

create function public.search_durable_memory(p_org uuid,p_user uuid,p_query text,p_kinds text[] default array['preference','question','source'],p_since timestamptz default null,p_until timestamptz default null,p_limit integer default 20)
returns jsonb language plpgsql security definer set search_path = public as $$
declare results jsonb; coverage jsonb; search_query tsquery;
begin
  perform public.assert_memory_identity(p_org,p_user);
  if length(trim(p_query)) not between 1 and 500 or p_limit not between 1 and 31 or not p_kinds <@ array['preference','question','source']::text[] then raise exception 'Invalid search options'; end if;
  if p_since is not null and p_until is not null and p_since > p_until then raise exception 'Invalid date range'; end if;
  search_query := websearch_to_tsquery('english'::regconfig,p_query);
  with candidates as (
    select p.id::text as id,'preference'::text as kind,left(p.content,100) as title,p.content as body,p.created_at,p.updated_at,
      ts_rank_cd(p.search_vector,search_query)::real as rank,null::uuid as workflow_id,null::uuid as source_id,null::text as table_id,null::integer as original_row
    from public.memory_preferences p where 'preference'=any(p_kinds) and p.org_id=p_org and p.user_id=p_user and p.status='active' and p.search_vector @@ search_query
    union all
    select i.workflow_id::text,'question',left(i.question,180),i.question || E'\n' || coalesce(i.answer->>'prose','[No completed answer]'),i.created_at,coalesce(i.completed_at,i.created_at),
      ts_rank_cd(i.memory_search,search_query),i.workflow_id,null::uuid,null::text,null::integer
    from public.investigations i join public.workflows w on w.id=i.workflow_id and w.org_id=p_org
    where 'question'=any(p_kinds) and i.org_id=p_org and i.memory_search @@ search_query
    union all
    select s.id::text,'source',s.filename,left(s.manifest::text,65536),s.created_at,s.created_at,
      ts_rank_cd(s.memory_search,search_query),null::uuid,s.id,null::text,null::integer
    from public.data_sources s where 'source'=any(p_kinds) and s.org_id=p_org and s.status='active' and s.memory_search @@ search_query
    union all
    select c.source_id::text || ':' || c.chunk_no::text,'source',s.filename,c.content,s.created_at,coalesce(s.search_indexed_at,s.created_at),
      ts_rank_cd(c.search_vector,search_query),null::uuid,c.source_id,c.table_id,c.original_row
    from public.source_memory_chunks c join public.data_sources s on s.id=c.source_id and s.org_id=c.org_id
    where 'source'=any(p_kinds) and c.org_id=p_org and s.status='active' and s.search_index_status='indexed' and c.search_vector @@ search_query
  ), ranked as (
    select * from candidates where (p_since is null or created_at >= p_since) and (p_until is null or created_at <= p_until)
    order by rank desc,created_at desc,id limit p_limit
  ) select coalesce(jsonb_agg(jsonb_build_object(
    'id',id,'kind',kind,'title',title,'excerpt',left(ts_headline('english'::regconfig,body,search_query,'StartSel=⟦, StopSel=⟧, MaxFragments=2, MinWords=8, MaxWords=50'),1600),
    'createdAt',created_at,'updatedAt',updated_at,'rank',rank,'workflowId',workflow_id,'sourceId',source_id,'tableId',table_id,'originalRow',original_row,
    'citation',case when source_id is not null and table_id is not null and original_row is not null then 'src:' || source_id::text || '/' || table_id || '/r' || original_row::text else null end
  ) order by rank desc,created_at desc,id),'[]'::jsonb) into results from ranked;
  select jsonb_build_object('totalSources',count(*),'indexedSources',count(*) filter(where search_index_status='indexed'),'pendingSources',count(*) filter(where search_index_status='pending'),'failedSources',count(*) filter(where search_index_status='failed'))
    into coverage from public.data_sources where org_id=p_org and status='active';
  return jsonb_build_object('results',results,'coverage',coverage);
end;
$$;

revoke all on function public.assert_memory_identity(uuid,uuid), public.set_memory_enabled(uuid,uuid,boolean), public.save_memory_preference(uuid,uuid,text,uuid,uuid,boolean), public.delete_memory_preference(uuid,uuid,uuid), public.replace_source_memory_chunks(uuid,uuid,jsonb), public.search_durable_memory(uuid,uuid,text,text[],timestamptz,timestamptz,integer) from public, anon, authenticated;
grant execute on function public.set_memory_enabled(uuid,uuid,boolean), public.save_memory_preference(uuid,uuid,text,uuid,uuid,boolean), public.delete_memory_preference(uuid,uuid,uuid), public.replace_source_memory_chunks(uuid,uuid,jsonb), public.search_durable_memory(uuid,uuid,text,text[],timestamptz,timestamptz,integer) to service_role;

commit;
