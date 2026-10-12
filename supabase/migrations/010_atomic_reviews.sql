begin;
create or replace function public.submit_workflow_review(
  p_workflow_id uuid, p_org_id uuid, p_reviewer_id uuid, p_decision text, p_comment text default null
) returns text language plpgsql security definer set search_path = public as $$
declare wf public.workflows; reviewer_role text; next_status text; separate_approver boolean;
begin
  if p_decision not in ('approved','rejected','revision_requested') then
    raise exception 'Invalid decision' using errcode = '22023';
  end if;
  select role into reviewer_role from public.profiles where id = p_reviewer_id and org_id = p_org_id;
  if reviewer_role is null or reviewer_role not in ('admin','reviewer') then
    raise exception 'Reviewer role required' using errcode = '42501';
  end if;
  select * into wf from public.workflows where id = p_workflow_id and org_id = p_org_id for update;
  if not found then raise exception 'Workflow not found' using errcode = 'P0002'; end if;
  if wf.status <> 'awaiting_review' then raise exception 'Workflow is no longer awaiting review' using errcode = '55000'; end if;
  select require_separate_approver into separate_approver from public.org_approval_policies where org_id = p_org_id;
  if coalesce(separate_approver,false) and wf.created_by = p_reviewer_id then
    raise exception 'A separate reviewer is required' using errcode = '42501';
  end if;
  if exists(select 1 from public.action_requests where workflow_id = p_workflow_id and status = 'pending') then
    raise exception 'Resolve pending authorizations first' using errcode = '55000';
  end if;
  next_status := case when p_decision = 'revision_requested' then 'awaiting_review' else p_decision end;
  insert into public.review_decisions(workflow_id,reviewer_id,decision,comment)
    values(p_workflow_id,p_reviewer_id,p_decision,p_comment);
  update public.workflows set status = next_status where id = p_workflow_id;
  insert into public.audit_log(workflow_id,actor_type,actor_id,action,detail)
    values(p_workflow_id,'human',p_reviewer_id::text,'review_submitted',jsonb_build_object('decision',p_decision,'reviewer',p_reviewer_id));
  return next_status;
end $$;
revoke all on function public.submit_workflow_review(uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.submit_workflow_review(uuid,uuid,uuid,text,text) to service_role;
commit;
