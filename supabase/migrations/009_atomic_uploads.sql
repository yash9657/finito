-- Lock the workflow while replacing its input. A concurrent launch either sees the
-- complete new input or wins the lock and makes this upload fail. No half replacement.
begin;
create unique index workflow_files_one_per_type on public.workflow_files (workflow_id, file_type);
create or replace function public.replace_workflow_file(
  p_workflow_id uuid, p_org_id uuid, p_actor_id uuid,
  p_file_type text, p_storage_path text, p_filename text, p_size_bytes bigint, p_sha256 text
) returns public.workflow_files
language plpgsql security definer set search_path = public as $$
declare wf public.workflows; result public.workflow_files;
begin
  select * into wf from public.workflows where id = p_workflow_id and org_id = p_org_id for update;
  if not found then raise exception 'Workflow not found' using errcode = 'P0002'; end if;
  if wf.status <> 'idle' then raise exception 'Workflow is not accepting uploads' using errcode = '55000'; end if;
  if not exists (select 1 from public.profiles where id = p_actor_id and org_id = p_org_id) then
    raise exception 'Actor organization mismatch' using errcode = '42501';
  end if;
  if not ((wf.type = 'reconciliation' and p_file_type in ('erp_export','bank_statement'))
    or (wf.type = 'ap_matching' and p_file_type in ('po','invoice'))
    or (wf.type = 'fpa_commentary' and p_file_type in ('budget','actuals'))) then
    raise exception 'Invalid file type' using errcode = '22023';
  end if;
  delete from public.workflow_files where workflow_id = p_workflow_id and file_type = p_file_type;
  insert into public.workflow_files (workflow_id,file_type,storage_path,filename,size_bytes,sha256)
  values (p_workflow_id,p_file_type,p_storage_path,p_filename,p_size_bytes,p_sha256) returning * into result;
  insert into public.audit_log (workflow_id,actor_type,actor_id,action,detail)
  values (p_workflow_id,'human',p_actor_id::text,'file_uploaded',jsonb_build_object('filename',p_filename,'size',p_size_bytes,'sha256',p_sha256));
  return result;
end $$;
revoke all on function public.replace_workflow_file(uuid,uuid,uuid,text,text,text,bigint,text) from public, anon, authenticated;
grant execute on function public.replace_workflow_file(uuid,uuid,uuid,text,text,text,bigint,text) to service_role;
commit;
