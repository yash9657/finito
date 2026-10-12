begin;

-- Existing reconciliation/AP/variance uploads predate the general source library.
-- Index their metadata without pretending their file contents were indexed.
alter table public.workflows add column memory_search tsvector generated always as (
  setweight(to_tsvector('english'::regconfig,name),'A') ||
  setweight(to_tsvector('english'::regconfig,replace(type,'_',' ')),'B')
) stored;
create index workflows_memory_search on public.workflows using gin(memory_search);

-- Keep parent metadata in the file vector so a query can combine a workflow name
-- with a file type and still use one indexed vector (e.g. 'Helios export').
alter table public.workflow_files add column memory_workflow_context text not null default '';
update public.workflow_files f set memory_workflow_context = w.name || ' ' || replace(w.type,'_',' ')
  from public.workflows w where w.id = f.workflow_id;
alter table public.workflow_files add column memory_search tsvector generated always as (
  setweight(to_tsvector('english'::regconfig,filename),'A') ||
  setweight(to_tsvector('english'::regconfig,replace(file_type,'_',' ')),'B') ||
  setweight(to_tsvector('english'::regconfig,memory_workflow_context),'B')
) stored;
create index workflow_files_memory_search on public.workflow_files using gin(memory_search);

create function public.set_workflow_file_memory_context() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  select w.name || ' ' || replace(w.type,'_',' ') into new.memory_workflow_context
    from public.workflows w where w.id=new.workflow_id;
  return new;
end;
$$;
create trigger set_workflow_file_memory_context before insert or update of workflow_id on public.workflow_files
  for each row execute function public.set_workflow_file_memory_context();
create function public.refresh_workflow_file_memory_context() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  if (new.name,new.type) is distinct from (old.name,old.type) then
    update public.workflow_files set memory_workflow_context=new.name || ' ' || replace(new.type,'_',' ') where workflow_id=new.id;
  end if;
  return new;
end;
$$;
create trigger refresh_workflow_file_memory_context after update of name,type on public.workflows
  for each row execute function public.refresh_workflow_file_memory_context();
revoke all on function public.set_workflow_file_memory_context(),public.refresh_workflow_file_memory_context() from public,anon,authenticated;

create or replace function public.search_durable_memory(p_org uuid,p_user uuid,p_query text,p_kinds text[] default array['preference','question','source'],p_since timestamptz default null,p_until timestamptz default null,p_limit integer default 20)
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
    union all
    select 'workflow-file:' || f.id::text,'source',f.filename,
      'File: ' || f.filename || E'\nFile type: ' || replace(f.file_type,'_',' ') || E'\nWorkflow: ' || w.name || E'\nWorkflow type: ' || replace(w.type,'_',' ') || E'\nUploaded: ' || f.uploaded_at::text,
      f.uploaded_at,f.uploaded_at,ts_rank_cd(f.memory_search,search_query),w.id,null::uuid,null::text,null::integer
    from public.workflow_files f join public.workflows w on w.id=f.workflow_id
    where 'source'=any(p_kinds) and w.org_id=p_org and w.type <> 'investigation' and f.memory_search @@ search_query
    union all
    select 'workflow:' || w.id::text,'source',left(w.name,240),
      'Workflow: ' || w.name || E'\nWorkflow type: ' || replace(w.type,'_',' ') || E'\nStatus: ' || w.status,
      w.created_at,coalesce(w.completed_at,w.created_at),ts_rank_cd(w.memory_search,search_query),w.id,null::uuid,null::text,null::integer
    from public.workflows w where 'source'=any(p_kinds) and w.org_id=p_org and w.type <> 'investigation' and w.memory_search @@ search_query
      and not exists (select 1 from public.workflow_files f where f.workflow_id=w.id)
  ), ranked as (
    select * from candidates where (p_since is null or created_at >= p_since) and (p_until is null or created_at <= p_until)
    order by rank desc,created_at desc,id limit p_limit
  ) select coalesce(jsonb_agg(jsonb_build_object(
    'id',id,'kind',kind,'title',title,'excerpt',left((case when id like 'workflow:%' or id like 'workflow-file:%' then 'Legacy workflow metadata only; file contents were not searched. ' else '' end) || ts_headline('english'::regconfig,body,search_query,'StartSel=⟦, StopSel=⟧, MaxFragments=2, MinWords=8, MaxWords=50'),1600),
    'createdAt',created_at,'updatedAt',updated_at,'rank',rank,'workflowId',workflow_id,'sourceId',source_id,'tableId',table_id,'originalRow',original_row,
    'citation',case when source_id is not null and table_id is not null and original_row is not null then 'src:' || source_id::text || '/' || table_id || '/r' || original_row::text else null end
  ) order by rank desc,created_at desc,id),'[]'::jsonb) into results from ranked;
  select jsonb_build_object('totalSources',count(*),'indexedSources',count(*) filter(where search_index_status='indexed'),'pendingSources',count(*) filter(where search_index_status='pending'),'failedSources',count(*) filter(where search_index_status='failed'))
    into coverage from public.data_sources where org_id=p_org and status='active';
  coverage := coverage || jsonb_build_object('legacyWorkflowFiles',(
    select count(*) from public.workflow_files f join public.workflows w on w.id=f.workflow_id where w.org_id=p_org and w.type <> 'investigation'
  ),'legacyWorkflowMetadataOnly',true);
  return jsonb_build_object('results',results,'coverage',coverage);
end;
$$;

revoke all on function public.search_durable_memory(uuid,uuid,text,text[],timestamptz,timestamptz,integer) from public,anon,authenticated;
grant execute on function public.search_durable_memory(uuid,uuid,text,text[],timestamptz,timestamptz,integer) to service_role;

commit;
