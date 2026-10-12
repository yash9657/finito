-- Each question remains an independently audited run; follow-ups retain its source scope.
alter table public.investigations
  add column conversation_id uuid,
  add column parent_workflow_id uuid,
  add column source_ids uuid[];
update public.investigations set conversation_id = workflow_id;
alter table public.investigations alter column conversation_id set not null;
alter table public.investigations add constraint investigations_org_workflow_unique unique (org_id, workflow_id);
alter table public.investigations add constraint investigations_parent_same_org
  foreign key (org_id, parent_workflow_id) references public.investigations(org_id, workflow_id);
alter table public.investigations add constraint investigations_no_self_parent check (parent_workflow_id is distinct from workflow_id);
alter table public.investigations add constraint investigations_source_limit check (source_ids is null or cardinality(source_ids) <= 10);
create index investigations_conversation_idx on public.investigations(org_id, conversation_id, created_at);
