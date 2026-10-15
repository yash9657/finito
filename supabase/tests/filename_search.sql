-- Run against a disposable migrated database as a service/database owner.
-- Fixtures are rolled back; no source content or application records survive.
begin;
do $$
declare
  actor uuid := gen_random_uuid();
  outsider uuid := gen_random_uuid();
  org uuid;
  other_org uuid;
  source uuid := gen_random_uuid();
  workflow uuid := gen_random_uuid();
  hits jsonb;
begin
  select id,org_id into actor,org from public.provision_clerk_profile('user_'||actor::text,actor::text||'@example.invalid');
  select id,org_id into outsider,other_org from public.provision_clerk_profile('user_'||outsider::text,outsider::text||'@example.invalid');
  insert into public.data_sources(id,org_id,filename,sha256,format,byte_size,storage_path,manifest)
    values(source,org,'helios-close_2026.05.csv',repeat('a',64),'csv',12,org::text||'/'||source::text||'/source','{"tables":[{"id":"t0","name":"Sheet 1","columns":["Owner"]}]}');
  perform public.replace_source_memory_chunks(org,source,'[{"chunk_no":0,"table_id":"t0","original_row":9,"row_kind":"data","content":"Maya"}]');
  hits := public.search_durable_memory(org,actor,'Helios Maya',array['source'],null,null,20);
  if not exists(select 1 from jsonb_array_elements(hits->'results') r where r->>'citation'='src:'||source::text||'/t0/r9') then
    raise exception 'Filename words and row text must match with the original citation';
  end if;
  hits := public.search_durable_memory(org,actor,'helios-close_2026.05.csv',array['source'],null,null,20);
  if jsonb_array_length(hits->'results')=0 then raise exception 'Exact filename must remain searchable'; end if;
  hits := public.search_durable_memory(other_org,outsider,'Helios',array['source'],null,null,20);
  if jsonb_array_length(hits->'results')<>0 then raise exception 'Filename lookup crossed organization boundary'; end if;
  if (select content from public.source_memory_chunks where source_id=source limit 1)<>'Maya' then
    raise exception 'Search normalization changed original row text';
  end if;
  insert into public.workflows(id,org_id,created_by,name,type) values(workflow,org,actor,'Archived close','reconciliation');
  insert into public.workflow_files(workflow_id,file_type,storage_path,filename,size_bytes,sha256)
    values(workflow,'erp_export','synthetic/ledger.csv','zephyr-ledger_2026.05.csv',12,repeat('b',64));
  hits := public.search_durable_memory(org,actor,'Zephyr export',array['source'],null,null,20);
  if not exists(select 1 from jsonb_array_elements(hits->'results') r where r->>'workflowId'=workflow::text) then
    raise exception 'Legacy filename words must combine with workflow context';
  end if;
  update public.data_sources set status='deleting' where id=source;
  hits := public.search_durable_memory(org,actor,'Helios',array['source'],null,null,20);
  if jsonb_array_length(hits->'results')<>0 then raise exception 'Deleted source stayed searchable'; end if;
end;
$$;
rollback;
