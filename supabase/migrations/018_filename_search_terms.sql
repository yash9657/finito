begin;

-- PostgreSQL recognizes export filenames as a single file/host token. Preserve
-- that exact token AND index its component words so "Helios" finds
-- "helios-close_2026.05.csv" even when the name never appears inside a cell.
drop index public.data_sources_memory_search;
alter table public.data_sources drop column memory_search;
alter table public.data_sources add column memory_search tsvector generated always as (
  setweight(to_tsvector('english'::regconfig, filename || ' ' || regexp_replace(filename,'[^[:alnum:]]+',' ','g')), 'A') ||
  setweight(to_tsvector('english'::regconfig, left(manifest::text,65536)), 'B')
) stored;
create index data_sources_memory_search on public.data_sources using gin(memory_search) where status='active';

drop index public.workflow_files_memory_search;
alter table public.workflow_files drop column memory_search;
alter table public.workflow_files add column memory_search tsvector generated always as (
  setweight(to_tsvector('english'::regconfig, filename || ' ' || regexp_replace(filename,'[^[:alnum:]]+',' ','g')), 'A') ||
  setweight(to_tsvector('english'::regconfig,replace(file_type,'_',' ')),'B') ||
  setweight(to_tsvector('english'::regconfig,memory_workflow_context),'B')
) stored;
create index workflow_files_memory_search on public.workflow_files using gin(memory_search);

create or replace function public.source_chunk_search_context(p_org uuid,p_source uuid,p_table text) returns text
language sql stable security definer set search_path=public as $$
  select left(s.filename || E'\n' || regexp_replace(s.filename,'[^[:alnum:]]+',' ','g') || E'\n' || coalesce((
    select coalesce(t->>'name','') || E'\n' || coalesce((t->'columns')::text,'')
    from jsonb_array_elements(coalesce(s.manifest->'tables','[]'::jsonb)) t where t->>'id'=p_table limit 1
  ),''),8192) from public.data_sources s where s.org_id=p_org and s.id=p_source;
$$;
-- Regenerate only search context/vectors. Original content, hashes, dates and
-- row citations are unchanged. This transaction also covers existing uploads.
update public.source_memory_chunks c set search_context=coalesce(public.source_chunk_search_context(c.org_id,c.source_id,c.table_id),'');

commit;
