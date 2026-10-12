begin;

-- Durable observations are separate from model context. Free-form questions,
-- answers, file bodies, preference values and credentials are never copied here.
create table public.interaction_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete cascade,
  occurred_at timestamptz not null default now(),
  recorded_at timestamptz not null default now(),
  action text not null,
  entity_type text not null check (entity_type in ('page','workflow','question','source','workflow_file','review','approval','approval_rule','approval_policy','preference','memory_setting','setting')),
  entity_id uuid,
  workflow_id uuid,
  source_id uuid,
  actor_kind text not null check (actor_kind in ('user','system')),
  summary text not null check (length(summary) between 1 and 240),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata)='object' and octet_length(metadata::text)<=2048),
  event_key text check (length(event_key)<=160),
  redacted boolean not null default false,
  search_vector tsvector generated always as (setweight(to_tsvector('english'::regconfig,summary),'A') || to_tsvector('english'::regconfig,metadata::text)) stored
);
create unique index interaction_events_idempotency on public.interaction_events(org_id,event_key) where event_key is not null;
create index interaction_events_owner_time on public.interaction_events(org_id,user_id,occurred_at desc,id desc);
create index interaction_events_entity on public.interaction_events(org_id,entity_type,entity_id);
create index interaction_events_workflow on public.interaction_events(org_id,workflow_id) where workflow_id is not null;
create index interaction_events_source on public.interaction_events(org_id,source_id) where source_id is not null;
create index interaction_events_search on public.interaction_events using gin(search_vector) where not redacted;
alter table public.interaction_events enable row level security;
create policy interaction_events_self_read on public.interaction_events for select to authenticated
  using (org_id=public.auth_org_id() and user_id=auth.uid());
revoke all on public.interaction_events from anon,authenticated;
grant select on public.interaction_events to authenticated;
grant all on public.interaction_events to service_role;

create function public.valid_interaction_metadata(value jsonb) returns boolean
language plpgsql immutable set search_path=public as $$
declare item record;
begin
  if jsonb_typeof(value) is distinct from 'object' or octet_length(value::text)>2048 then return false; end if;
  for item in select key,val from jsonb_each(value) as e(key,val) loop
    if item.key in ('enabled','automatic') then
      if jsonb_typeof(item.val)<>'boolean' then return false; end if;
    elsif item.key='route' then
      if jsonb_typeof(item.val)<>'string' or length(item.val#>>'{}')>160 or (item.val#>>'{}') !~ '^/[a-zA-Z0-9/-]*$' then return false; end if;
    elsif item.key in ('status','previousStatus') then
      if (item.val#>>'{}') not in ('idle','running','awaiting_approval','awaiting_review','approved','rejected','error','answered','terminated','failed','active','deleted','pending','auto_approved','denied','complete') then return false; end if;
    elsif item.key='type' then
      if (item.val#>>'{}') not in ('reconciliation','ap_matching','fpa_commentary','investigation') then return false; end if;
    elsif item.key='fileType' then
      if (item.val#>>'{}') not in ('bank_statement','erp_export','invoice','po','budget','actuals') then return false; end if;
    elsif item.key='format' then
      if (item.val#>>'{}') not in ('csv','tsv','xlsx','xls','json','jsonl','text','markdown','pdf') then return false; end if;
    elsif item.key='decision' then
      if (item.val#>>'{}') not in ('approved','rejected','revision_requested','pending','auto_approved','denied') then return false; end if;
    elsif item.key='scope' then
      if (item.val#>>'{}') not in ('once','run','standing') then return false; end if;
    elsif item.key='riskClass' then
      if (item.val#>>'{}') not in ('read','writes_ledger','moves_money','external_filing') then return false; end if;
    elsif item.key='role' then
      if (item.val#>>'{}') not in ('parser','matcher','classifier','writer','investigator') then return false; end if;
    else return false;
    end if;
    if item.key not in ('enabled','automatic') and jsonb_typeof(item.val)<>'string' then return false; end if;
  end loop;
  return true;
end;
$$;
alter table public.interaction_events add constraint interaction_metadata_allowlist check (public.valid_interaction_metadata(metadata));

create function public.interaction_summary(p_action text) returns text
language plpgsql immutable set search_path=public as $$
declare result text;
begin
  result := case p_action
    when 'page_view' then 'Visited an application page'
    when 'workflow.created' then 'Created a workflow'
    when 'workflow.renamed' then 'Renamed a workflow'
    when 'workflow.status_changed' then 'Workflow status changed'
    when 'workflow.deleted' then 'Deleted a workflow'
    when 'question.asked' then 'Asked an investigation question'
    when 'question.status_changed' then 'Investigation status changed'
    when 'question.answered' then 'Investigation produced an answer'
    when 'source.uploaded' then 'Uploaded a data source'
    when 'source.deleted' then 'Removed a data source from active analysis'
    when 'workflow_file.uploaded' then 'Uploaded a workflow file'
    when 'workflow_file.deleted' then 'Removed a workflow file'
    when 'review.submitted' then 'Submitted a workflow review'
    when 'approval.requested' then 'Requested approval for an action'
    when 'approval.decided' then 'Recorded an action approval decision'
    when 'approval_rule.created' then 'Created an approval rule'
    when 'approval_rule.revoked' then 'Revoked an approval rule'
    when 'approval_policy.changed' then 'Changed an approval policy'
    when 'preference.created' then 'Saved a personal preference'
    when 'preference.updated' then 'Corrected a personal preference'
    when 'preference.deleted' then 'Deleted a personal preference'
    when 'memory.toggled' then 'Changed automatic memory recall'
    when 'setting.changed' then 'Changed application settings'
    when 'setting.deleted' then 'Removed application settings'
    else null end;
  if result is null then raise exception 'Unknown interaction action' using errcode='22023'; end if;
  return result;
end;
$$;

-- Internal trigger helper. Null-user system observations are archived for operators,
-- but never returned as another user's private interaction history.
create function public.append_interaction_event(p_org uuid,p_user uuid,p_action text,p_entity_type text,p_entity uuid,p_workflow uuid default null,p_source uuid default null,p_metadata jsonb default '{}'::jsonb,p_time timestamptz default now(),p_key text default null,p_actor text default 'system') returns uuid
language plpgsql security definer set search_path=public as $$
declare result uuid;
begin
  if not public.valid_interaction_metadata(p_metadata) then raise exception 'Invalid interaction metadata' using errcode='22023'; end if;
  if p_user is not null and not exists(select 1 from public.profiles where id=p_user and org_id=p_org) then p_user := null; end if;
  insert into public.interaction_events(org_id,user_id,action,entity_type,entity_id,workflow_id,source_id,metadata,occurred_at,event_key,actor_kind,summary)
  values(p_org,p_user,p_action,p_entity_type,p_entity,p_workflow,p_source,p_metadata,p_time,p_key,case when p_user is null then 'system' else p_actor end,public.interaction_summary(p_action))
  on conflict(org_id,event_key) where event_key is not null do nothing returning id into result;
  if result is null and p_key is not null then select id into result from public.interaction_events where org_id=p_org and event_key=p_key; end if;
  return result;
end;
$$;

create function public.redact_entity_interactions(p_org uuid,p_type text,p_id uuid) returns void
language plpgsql security definer set search_path=public as $$
begin
  update public.interaction_events set redacted=true,summary='Deleted entity history',metadata='{}',workflow_id=null,source_id=null
  where org_id=p_org and action not like '%.deleted' and (
    (entity_type=p_type and entity_id=p_id) or (p_type='workflow' and workflow_id=p_id) or (p_type='source' and source_id=p_id)
  );
end;
$$;

create function public.record_page_interaction(p_org uuid,p_user uuid,p_id uuid,p_route text) returns jsonb
language plpgsql security definer set search_path=public as $$
declare existing public.interaction_events; target uuid; route_workflow uuid; route_entity text := 'page';
begin
  perform public.assert_memory_identity(p_org,p_user);
  if p_id is null or p_route is null or length(p_route)>160 then raise exception 'Invalid event' using errcode='22023'; end if;
  if p_route not in ('/','/dashboard','/data','/investigations','/workflows/new','/settings','/settings/models','/settings/approvals','/settings/memory') then
    if p_route !~ '^/(workflows/[0-9a-fA-F-]{36}(/report)?|investigations/[0-9a-fA-F-]{36})$' then raise exception 'Invalid route' using errcode='22023'; end if;
    begin target := split_part(p_route,'/',3)::uuid; exception when invalid_text_representation then raise exception 'Invalid route target' using errcode='22023'; end;
    select id into route_workflow from public.workflows where id=target and org_id=p_org;
    if not found then raise exception 'Route target unavailable' using errcode='P0002'; end if;
    route_entity := case when p_route like '/investigations/%' then 'question' else 'workflow' end;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('interaction-rate:' || p_org::text || ':' || p_user::text,0));
  select * into existing from public.interaction_events where id=p_id;
  if found then
    if existing.org_id<>p_org or existing.user_id is distinct from p_user then raise exception 'Event unavailable' using errcode='42501'; end if;
    if existing.action<>'page_view' or existing.metadata->>'route' is distinct from p_route then raise exception 'Event identifier reused' using errcode='22023'; end if;
    return jsonb_build_object('id',p_id,'duplicate',true);
  end if;
  if (select count(*) from public.interaction_events where org_id=p_org and user_id=p_user and action='page_view' and occurred_at>now()-interval '1 minute')>=60 then raise exception 'interaction_rate_limited'; end if;
  insert into public.interaction_events(id,org_id,user_id,action,entity_type,entity_id,workflow_id,actor_kind,summary,metadata)
  values(p_id,p_org,p_user,'page_view',route_entity,target,route_workflow,'user',public.interaction_summary('page_view'),jsonb_build_object('route',p_route));
  return jsonb_build_object('id',p_id,'duplicate',false);
end;
$$;

create function public.list_interaction_events(p_org uuid,p_user uuid,p_limit integer default 51,p_before timestamptz default null,p_before_id uuid default null) returns jsonb
language plpgsql security definer set search_path=public as $$
declare result jsonb;
begin
  perform public.assert_memory_identity(p_org,p_user);
  if p_limit not between 1 and 101 or (p_before is null) is distinct from (p_before_id is null) then raise exception 'Invalid history page' using errcode='22023'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'occurredAt',occurred_at,'action',action,'entityType',entity_type,'entityId',entity_id,'workflowId',workflow_id,'sourceId',source_id,'summary',summary,'actorKind',actor_kind,'metadata',metadata,'redacted',redacted) order by occurred_at desc,id desc),'[]'::jsonb)
  into result from (select * from public.interaction_events where org_id=p_org and user_id=p_user and (p_before is null or (occurred_at,id)<(p_before,p_before_id)) order by occurred_at desc,id desc limit p_limit) e;
  return result;
end;
$$;

create function public.capture_application_interaction() returns trigger
language plpgsql security definer set search_path=public as $$
declare r jsonb; previous jsonb; organization uuid; owner_id uuid; wf uuid; entity uuid; metadata jsonb := '{}'; actor text := 'system';
begin
  r := case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end;
  previous := case when tg_op='UPDATE' then to_jsonb(old) else null end;
  organization := (r->>'org_id')::uuid;
  entity := (r->>'id')::uuid;
  owner_id := coalesce((r->>'user_id')::uuid,(r->>'created_by')::uuid,(r->>'updated_by')::uuid);
  wf := (r->>'workflow_id')::uuid;
  if organization is null and wf is not null then
    select org_id,created_by into organization,owner_id from public.workflows where id=wf;
    if not found then return null; end if;
  end if;

  if tg_table_name='workflows' then
    wf:=entity; metadata:=jsonb_build_object('type',r->>'type');
    if tg_op='INSERT' then
      perform public.append_interaction_event(organization,owner_id,'workflow.created','workflow',entity,wf,null,metadata,(r->>'created_at')::timestamptz,'workflow:'||entity::text||':created','user');
    elsif tg_op='DELETE' then
      perform public.redact_entity_interactions(organization,'workflow',entity);
      perform public.append_interaction_event(organization,owner_id,'workflow.deleted','workflow',entity,null,null,'{}',now(),'workflow:'||entity::text||':deleted');
    else
      if previous->>'name' is distinct from r->>'name' then perform public.append_interaction_event(organization,owner_id,'workflow.renamed','workflow',entity,wf,null,metadata); end if;
      if previous->>'status' is distinct from r->>'status' then perform public.append_interaction_event(organization,owner_id,'workflow.status_changed','workflow',entity,wf,null,metadata||jsonb_build_object('status',r->>'status','previousStatus',previous->>'status')); end if;
    end if;
  elsif tg_table_name='investigations' then
    entity:=wf;
    if tg_op='INSERT' then
      perform public.append_interaction_event(organization,owner_id,'question.asked','question',entity,wf,null,'{}',(r->>'created_at')::timestamptz,'question:'||wf::text||':asked','user');
    else
      if previous->>'status' is distinct from r->>'status' then perform public.append_interaction_event(organization,owner_id,'question.status_changed','question',entity,wf,null,jsonb_build_object('status',r->>'status','previousStatus',previous->>'status')); end if;
      if new.answer is not null and old.answer is distinct from new.answer then perform public.append_interaction_event(organization,owner_id,'question.answered','question',entity,wf,null,jsonb_build_object('status',r->>'status')); end if;
    end if;
  elsif tg_table_name='data_sources' then
    if tg_op='INSERT' then
      perform public.append_interaction_event(organization,owner_id,'source.uploaded','source',entity,null,entity,jsonb_build_object('format',r->>'format'),(r->>'created_at')::timestamptz,'source:'||entity::text||':uploaded','user');
    elsif tg_op='DELETE' or (previous->>'status'='active' and r->>'status'='deleting') then
      perform public.redact_entity_interactions(organization,'source',entity);
      perform public.append_interaction_event(organization,owner_id,'source.deleted','source',entity,null,null,'{}',now(),'source:'||entity::text||':deleted');
    end if;
  elsif tg_table_name='workflow_files' then
    if tg_op='INSERT' then
      perform public.append_interaction_event(organization,owner_id,'workflow_file.uploaded','workflow_file',entity,wf,null,jsonb_build_object('fileType',r->>'file_type'),(r->>'uploaded_at')::timestamptz,'workflow-file:'||entity::text||':uploaded');
    elsif tg_op='DELETE' then
      perform public.redact_entity_interactions(organization,'workflow_file',entity);
      perform public.append_interaction_event(organization,owner_id,'workflow_file.deleted','workflow_file',entity,wf,null,'{}',now(),'workflow-file:'||entity::text||':deleted');
    end if;
  elsif tg_table_name='review_decisions' then
    perform public.append_interaction_event(organization,(r->>'reviewer_id')::uuid,'review.submitted','review',entity,wf,null,jsonb_build_object('decision',r->>'decision'),(r->>'decided_at')::timestamptz,'review:'||entity::text,'user');
  elsif tg_table_name='action_requests' then
    if tg_op='INSERT' then perform public.append_interaction_event(organization,owner_id,'approval.requested','approval',entity,wf,null,jsonb_build_object('riskClass',r->>'risk_class'),(r->>'proposed_at')::timestamptz,'approval:'||entity::text||':requested'); end if;
    if (tg_op='INSERT' and r->>'status'<>'pending') or (tg_op='UPDATE' and previous->>'status' is distinct from r->>'status') then
      actor:=case when r->>'decided_by' is not null then 'user' else 'system' end;
      perform public.append_interaction_event(organization,coalesce((r->>'decided_by')::uuid,owner_id),'approval.decided','approval',entity,wf,null,jsonb_build_object('decision',r->>'status'),coalesce((r->>'decided_at')::timestamptz,now()),null,actor);
    end if;
  elsif tg_table_name='approval_rules' then
    if tg_op='INSERT' then perform public.append_interaction_event(organization,owner_id,'approval_rule.created','approval_rule',entity,wf,null,jsonb_build_object('scope',r->>'scope'),(r->>'created_at')::timestamptz,'approval-rule:'||entity::text||':created','user');
    elsif previous->>'revoked_at' is null and r->>'revoked_at' is not null then perform public.append_interaction_event(organization,coalesce((r->>'revoked_by')::uuid,owner_id),'approval_rule.revoked','approval_rule',entity,wf,null,'{}',(r->>'revoked_at')::timestamptz,'approval-rule:'||entity::text||':revoked',case when r->>'revoked_by' is not null then 'user' else 'system' end); end if;
  elsif tg_table_name='org_approval_policies' then
    if tg_op='INSERT' or previous is distinct from r then perform public.append_interaction_event(organization,owner_id,'approval_policy.changed','approval_policy',organization,null,null,'{}',(r->>'updated_at')::timestamptz,null,'user'); end if;
  elsif tg_table_name='memory_preferences' then
    if tg_op='DELETE' or (tg_op='UPDATE' and r->>'status'='deleted' and previous->>'status'<>'deleted') then
      perform public.redact_entity_interactions(organization,'preference',entity);
      perform public.append_interaction_event(organization,owner_id,'preference.deleted','preference',entity,null,null,'{}',now(),'preference:'||entity::text||':deleted','user');
    elsif tg_op='INSERT' and r->>'status'='active' then
      perform public.append_interaction_event(organization,owner_id,'preference.created','preference',entity,null,null,'{}',(r->>'created_at')::timestamptz,'preference:'||entity::text||':created','user');
    elsif tg_op='UPDATE' and r->>'status'='active' and (previous->>'updated_at' is distinct from r->>'updated_at' or previous->>'content' is distinct from r->>'content') then
      perform public.append_interaction_event(organization,owner_id,'preference.updated','preference',entity,null,null,'{}',now(),null,'user');
    end if;
  elsif tg_table_name='memory_settings' then
    if tg_op='INSERT' or previous->>'enabled' is distinct from r->>'enabled' then perform public.append_interaction_event(organization,owner_id,'memory.toggled','memory_setting',owner_id,null,null,jsonb_build_object('enabled',(r->>'enabled')::boolean),(r->>'updated_at')::timestamptz,null,'user'); end if;
  elsif tg_table_name in ('org_model_configs','workflow_step_configs','org_role_configs') then
    entity:=coalesce(entity,organization);
    if tg_op='DELETE' then
      perform public.redact_entity_interactions(organization,'setting',entity);
      perform public.append_interaction_event(organization,owner_id,'setting.deleted','setting',entity);
    elsif tg_op='INSERT' or previous is distinct from r then
      perform public.append_interaction_event(organization,owner_id,'setting.changed','setting',entity,null,null,'{}',now(),null,case when owner_id is null then 'system' else 'user' end);
    end if;
  end if;
  return null;
end;
$$;

create trigger interaction_workflows after insert or update of name,status or delete on public.workflows for each row execute function public.capture_application_interaction();
create trigger interaction_questions after insert or update of status,answer on public.investigations for each row execute function public.capture_application_interaction();
create trigger interaction_sources after insert or update of status or delete on public.data_sources for each row execute function public.capture_application_interaction();
create trigger interaction_workflow_files after insert or delete on public.workflow_files for each row execute function public.capture_application_interaction();
create trigger interaction_reviews after insert on public.review_decisions for each row execute function public.capture_application_interaction();
create trigger interaction_approvals after insert or update of status on public.action_requests for each row execute function public.capture_application_interaction();
create trigger interaction_approval_rules after insert or update of revoked_at on public.approval_rules for each row execute function public.capture_application_interaction();
create trigger interaction_approval_policy after insert or update on public.org_approval_policies for each row execute function public.capture_application_interaction();
create trigger interaction_preferences after insert or update or delete on public.memory_preferences for each row execute function public.capture_application_interaction();
create trigger interaction_memory_setting after insert or update on public.memory_settings for each row execute function public.capture_application_interaction();
create trigger interaction_model_setting after insert or update or delete on public.org_model_configs for each row execute function public.capture_application_interaction();
create trigger interaction_step_setting after insert or update or delete on public.workflow_step_configs for each row execute function public.capture_application_interaction();
create trigger interaction_role_setting after insert or update or delete on public.org_role_configs for each row execute function public.capture_application_interaction();

-- Historical records supply their real stored dates. This cannot reconstruct
-- prior unrecorded clicks, overwritten preference versions or deleted bodies.
select public.append_interaction_event(w.org_id,w.created_by,'workflow.created','workflow',w.id,w.id,null,jsonb_build_object('type',w.type),w.created_at,'workflow:'||w.id::text||':created','user') from public.workflows w;
select public.append_interaction_event(w.org_id,w.created_by,'workflow.status_changed','workflow',w.id,w.id,null,jsonb_build_object('type',w.type,'status',w.status),w.completed_at,'workflow:'||w.id::text||':status-backfill') from public.workflows w where w.completed_at is not null;
select public.append_interaction_event(i.org_id,i.created_by,'question.asked','question',i.workflow_id,i.workflow_id,null,'{}',i.created_at,'question:'||i.workflow_id::text||':asked','user') from public.investigations i;
select public.append_interaction_event(i.org_id,i.created_by,'question.status_changed','question',i.workflow_id,i.workflow_id,null,jsonb_build_object('status',i.status),i.completed_at,'question:'||i.workflow_id::text||':status-backfill') from public.investigations i where i.completed_at is not null;
select public.append_interaction_event(i.org_id,i.created_by,'question.answered','question',i.workflow_id,i.workflow_id,null,jsonb_build_object('status',i.status),i.completed_at,'question:'||i.workflow_id::text||':answered') from public.investigations i where i.answer is not null and i.completed_at is not null;
select public.append_interaction_event(s.org_id,s.created_by,'source.uploaded','source',s.id,null,s.id,jsonb_build_object('format',s.format),s.created_at,'source:'||s.id::text||':uploaded','user') from public.data_sources s where s.status='active';
select public.append_interaction_event(w.org_id,w.created_by,'workflow_file.uploaded','workflow_file',f.id,w.id,null,jsonb_build_object('fileType',f.file_type),f.uploaded_at,'workflow-file:'||f.id::text||':uploaded') from public.workflow_files f join public.workflows w on w.id=f.workflow_id;
select public.append_interaction_event(w.org_id,r.reviewer_id,'review.submitted','review',r.id,w.id,null,jsonb_build_object('decision',r.decision),r.decided_at,'review:'||r.id::text,'user') from public.review_decisions r join public.workflows w on w.id=r.workflow_id;
select public.append_interaction_event(w.org_id,w.created_by,'approval.requested','approval',a.id,w.id,null,jsonb_build_object('riskClass',a.risk_class),a.proposed_at,'approval:'||a.id::text||':requested') from public.action_requests a join public.workflows w on w.id=a.workflow_id;
select public.append_interaction_event(w.org_id,coalesce(a.decided_by,w.created_by),'approval.decided','approval',a.id,w.id,null,jsonb_build_object('decision',a.status),a.decided_at,'approval:'||a.id::text||':decided',case when a.decided_by is null then 'system' else 'user' end) from public.action_requests a join public.workflows w on w.id=a.workflow_id where a.decided_at is not null and a.status<>'pending';
select public.append_interaction_event(r.org_id,r.created_by,'approval_rule.created','approval_rule',r.id,r.workflow_id,null,jsonb_build_object('scope',r.scope),r.created_at,'approval-rule:'||r.id::text||':created','user') from public.approval_rules r;
select public.append_interaction_event(r.org_id,coalesce(r.revoked_by,r.created_by),'approval_rule.revoked','approval_rule',r.id,r.workflow_id,null,'{}',r.revoked_at,'approval-rule:'||r.id::text||':revoked',case when r.revoked_by is null then 'system' else 'user' end) from public.approval_rules r where r.revoked_at is not null;
select public.append_interaction_event(p.org_id,p.updated_by,'approval_policy.changed','approval_policy',p.org_id,null,null,'{}',p.updated_at,'approval-policy:'||p.org_id::text||':backfill','user') from public.org_approval_policies p;
select public.append_interaction_event(p.org_id,p.user_id,'preference.created','preference',p.id,null,null,'{}',p.created_at,'preference:'||p.id::text||':created','user') from public.memory_preferences p where p.status='active';
select public.append_interaction_event(p.org_id,p.user_id,'preference.updated','preference',p.id,null,null,'{}',p.updated_at,'preference:'||p.id::text||':updated-backfill','user') from public.memory_preferences p where p.status='active' and p.updated_at>p.created_at;
select public.append_interaction_event(p.org_id,p.user_id,'preference.deleted','preference',p.id,null,null,'{}',p.updated_at,'preference:'||p.id::text||':deleted','user') from public.memory_preferences p where p.status='deleted';
select public.append_interaction_event(s.org_id,s.user_id,'memory.toggled','memory_setting',s.user_id,null,null,jsonb_build_object('enabled',s.enabled),s.updated_at,'memory:'||s.user_id::text||':backfill','user') from public.memory_settings s;
select public.append_interaction_event(s.org_id,null,'setting.changed','setting',s.id,null,null,'{}',s.created_at,'model-setting:'||s.id::text||':backfill') from public.org_model_configs s;
select public.append_interaction_event(s.org_id,null,'setting.changed','setting',s.id,null,null,'{}',s.created_at,'step-setting:'||s.id::text||':backfill') from public.workflow_step_configs s;
select public.append_interaction_event(s.org_id,s.updated_by,'setting.changed','setting',s.org_id,null,null,'{}',s.updated_at,'role-setting:'||s.org_id::text||':'||s.step_role||':backfill','user') from public.org_role_configs s;

-- Deterministic contextual retrieval: filename, table name and column labels
-- accompany each row's vector. Raw row text and immutable citations stay intact.
create function public.source_chunk_search_context(p_org uuid,p_source uuid,p_table text) returns text
language sql stable security definer set search_path=public as $$
  select left(s.filename || E'\n' || coalesce((
    select coalesce(t->>'name','') || E'\n' || coalesce((t->'columns')::text,'')
    from jsonb_array_elements(coalesce(s.manifest->'tables','[]'::jsonb)) t where t->>'id'=p_table limit 1
  ),''),8192) from public.data_sources s where s.org_id=p_org and s.id=p_source;
$$;
alter table public.source_memory_chunks add column search_context text not null default '' check(length(search_context)<=8192);
update public.source_memory_chunks c set search_context=coalesce(public.source_chunk_search_context(c.org_id,c.source_id,c.table_id),'');
drop index public.source_memory_chunks_search;
alter table public.source_memory_chunks drop column search_vector;
alter table public.source_memory_chunks add column search_vector tsvector generated always as (
  setweight(to_tsvector('english'::regconfig,content),'A') || setweight(to_tsvector('english'::regconfig,search_context),'B')
) stored;
create index source_memory_chunks_search on public.source_memory_chunks using gin(search_vector);
create function public.set_source_chunk_search_context() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  new.search_context := public.source_chunk_search_context(new.org_id,new.source_id,new.table_id);
  if new.search_context is null then raise exception 'Source context is unavailable in this organization' using errcode='42501'; end if;
  return new;
end;
$$;
create trigger source_chunk_search_context before insert or update of source_id,org_id,table_id on public.source_memory_chunks for each row execute function public.set_source_chunk_search_context();

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

revoke all on function public.valid_interaction_metadata(jsonb),public.interaction_summary(text),public.append_interaction_event(uuid,uuid,text,text,uuid,uuid,uuid,jsonb,timestamptz,text,text),public.redact_entity_interactions(uuid,text,uuid),public.capture_application_interaction(),public.source_chunk_search_context(uuid,uuid,text),public.set_source_chunk_search_context(),public.record_page_interaction(uuid,uuid,uuid,text),public.list_interaction_events(uuid,uuid,integer,timestamptz,uuid),public.search_durable_memory(uuid,uuid,text,text[],timestamptz,timestamptz,integer) from public,anon,authenticated;
grant execute on function public.record_page_interaction(uuid,uuid,uuid,text),public.list_interaction_events(uuid,uuid,integer,timestamptz,uuid),public.search_durable_memory(uuid,uuid,text,text[],timestamptz,timestamptz,integer) to service_role;

commit;
