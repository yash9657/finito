begin;

-- Serialize a file's parent-name snapshot with parent renames. Without the row
-- lock, a concurrent rename can miss an uncommitted file and leave its vector
-- permanently indexed under the old workflow name.
create or replace function public.set_workflow_file_memory_context() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  select w.name || ' ' || replace(w.type,'_',' ') into new.memory_workflow_context
    from public.workflows w where w.id=new.workflow_id for share;
  return new;
end;
$$;
revoke all on function public.set_workflow_file_memory_context() from public,anon,authenticated;

commit;
