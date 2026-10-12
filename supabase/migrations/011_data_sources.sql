begin;

create table public.data_sources (
  id uuid primary key,
  org_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references public.profiles(id) on delete set null,
  filename text not null check (length(filename) between 1 and 240),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  format text not null check (format in ('csv','tsv','xlsx','xls','json','jsonl','text','markdown','pdf')),
  byte_size bigint not null check (byte_size between 1 and 20971520),
  storage_path text not null unique,
  status text not null default 'active' check (status in ('active','deleting')),
  manifest jsonb not null check (jsonb_typeof(manifest) = 'object'),
  parse_options jsonb not null default '{}'::jsonb check (jsonb_typeof(parse_options) = 'object'),
  created_at timestamptz not null default now(),
  constraint data_source_storage_scope check (storage_path = org_id::text || '/' || id::text || '/source'),
  constraint data_sources_id_org_unique unique (id, org_id)
);

create index data_sources_org_created_idx on public.data_sources(org_id, created_at desc, id);
alter table public.data_sources enable row level security;
create policy data_sources_org_read on public.data_sources for select to authenticated
  using (org_id = public.auth_org_id() and status = 'active');
revoke all on public.data_sources from anon, authenticated;
grant select on public.data_sources to authenticated;
grant all on public.data_sources to service_role;

-- Stable citations depend on immutable bytes, source names, parse settings and manifests.
-- Deletion is a two-stage tombstone; clients cannot write either stage directly.
create function public.preserve_data_source_identity() returns trigger
language plpgsql set search_path = public as $$
begin
  if (new.id, new.org_id, new.filename, new.sha256, new.format, new.byte_size,
      new.storage_path, new.manifest, new.parse_options, new.created_at)
     is distinct from
     (old.id, old.org_id, old.filename, old.sha256, old.format, old.byte_size,
      old.storage_path, old.manifest, old.parse_options, old.created_at) then
    raise exception 'Data source content and parse identity are immutable; create a new source version';
  end if;
  if old.status = 'deleting' and new.status <> 'deleting' then
    raise exception 'A deleted source cannot be reactivated';
  end if;
  return new;
end;
$$;
create trigger preserve_data_source_identity before update on public.data_sources
  for each row execute function public.preserve_data_source_identity();
revoke all on function public.preserve_data_source_identity() from public, anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit)
  values ('analysis-sources', 'analysis-sources', false, 20971520);
create policy analysis_sources_org_read on storage.objects for select to authenticated
  using (bucket_id = 'analysis-sources' and exists (
    select 1 from public.data_sources source
    where source.storage_path = name
      and source.org_id = public.auth_org_id()
      and source.status = 'active'
  ));

commit;
