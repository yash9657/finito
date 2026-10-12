begin;

-- Contextual row matches must not let one large file occupy every discovery slot.
-- Keep its two strongest matches (metadata and rows share one quota) before
-- applying the global rank/limit. Original row citations and exact-match ranks remain.
create or replace function public.search_durable_memory(p_org uuid,p_user uuid,p_query text,p_kinds text[] default array['preference','question','source','interaction'],p_since timestamptz default null,p_until timestamptz default null,p_limit integer default 20)
returns jsonb language plpgsql security definer set search_path = public as $$
declare results jsonb; coverage jsonb; search_query tsquery;
begin
  perform public.assert_memory_identity(p_org,p_user);
  if length(trim(p_query)) not between 1 and 500 or p_limit not between 1 and 31 or not p_kinds <@ array['preference','question','source','interaction']::text[] then raise exception 'Invalid search options'; end if;
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
    union all
    select 'interaction:' || e.id::text,'interaction',e.summary,e.summary || E'\n' || e.metadata::text,e.occurred_at,e.occurred_at,
      ts_rank_cd(e.search_vector,search_query),e.workflow_id,e.source_id,null::text,null::integer
    from public.interaction_events e where 'interaction'=any(p_kinds) and e.org_id=p_org and e.user_id=p_user and not e.redacted and e.search_vector @@ search_query
  ), diversified as (
    select *,row_number() over (
      partition by case when kind='source' and source_id is not null then 'source:' || source_id::text else kind || ':' || id end
      order by rank desc,created_at desc,id
    ) as source_position
    from candidates where (p_since is null or created_at >= p_since) and (p_until is null or created_at <= p_until)
  ), ranked as (
    select * from diversified where source_position<=2
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
