-- Plan 5 — the open-ended investigator agent (§3, D-G2 … D-G12).
--
-- Five things, all small, all unblocking:
--   1. `caused_by` on harness_events — the OpenHands `cause` linkage (D-G9). An observation points
--      at the action that produced it. Without it a 40-turn investigation is an undifferentiated
--      wall of rows and the UI cannot pair a tool call with its result.
--   2. `turn_number` — which iteration of the agent loop an event belongs to (D-G10).
--   3. Eight new event types for the agent lifecycle (D-G11).
--   4. `investigator` as a fifth step role (D-G2) and `investigation` as a workflow row type
--      (D-G3), so per-role model assignment and the whole harness_events/RLS/Realtime stack apply
--      to the agent for free.
--   5. `investigations` — a projection row per investigation (D-G4), the same relationship
--      workflow_steps has to the stream: cheap current state for the UI, subordinate to the trail.

/* -------------------------------------------------------------------------- */
/* 1. The cause linkage and turn grouping (D-G9 / D-G10).                      */
/* -------------------------------------------------------------------------- */

alter table public.harness_events
  -- Self-referential, and deliberately WITHOUT `on delete cascade`: a cascade path from the audit
  -- stream into itself is how one delete could unravel a trail. The parent workflow's cascade is
  -- the only deletion route, and it takes the whole run at once.
  add column caused_by  uuid references public.harness_events(id),
  add column turn_number int;

-- The trace view groups by turn and queries this on every render.
create index on public.harness_events (workflow_id, turn_number);
-- Pairing a tool_returned back to its tool_called.
create index on public.harness_events (caused_by);

/* -------------------------------------------------------------------------- */
/* 2. The agent event vocabulary (D-G11).                                      */
/*                                                                             */
/* Six come from the Plan 5 brief. Two more are here on the same grounds D-H7  */
/* used for `action_failed_verification` — a trail that can only record the     */
/* happy path proves nothing:                                                   */
/*                                                                             */
/*   context_compacted       — compaction silently discarding a finding is      */
/*                             exactly the failure the trail exists to expose.  */
/*   provider_state_dropped  — when an investigation moves between providers,   */
/*                             the previous one's opaque reasoning state cannot */
/*                             travel with it. We drop it and say so (D-G13).   */
/* -------------------------------------------------------------------------- */

alter table public.harness_events drop constraint harness_events_event_type_check;

alter table public.harness_events add constraint harness_events_event_type_check
  check (event_type in (
    -- Plan 4 — the step lifecycle (D-H7).
    'step_started',
    'action_proposed',
    'action_verified',
    'action_failed_verification',
    'action_executed',
    'observation_received',
    'step_completed',
    'step_failed',
    'human_review_requested',
    'human_decision',
    'workflow_paused',
    'workflow_resumed',
    -- Plan 5 — the agent loop (D-G11).
    'agent_turn_started',
    'agent_reasoning',
    'tool_called',
    'tool_returned',
    'agent_answered',
    'agent_terminated',
    'context_compacted',
    'provider_state_dropped'
  ));

/* -------------------------------------------------------------------------- */
/* 3. The append path (D-G12).                                                 */
/*                                                                             */
/* Two new parameters mean a new signature, and `create or replace` with a     */
/* different argument list creates an OVERLOAD rather than replacing anything. */
/* Two overloads reachable by PostgREST named-argument RPC is an ambiguity      */
/* waiting to surface at runtime, so the old one is dropped outright.          */
/*                                                                             */
/* A dropped function takes its grants with it — hence the revoke below is      */
/* re-applied, not assumed. Re-granting by accident is how "service role only"  */
/* quietly stops being true.                                                    */
/* -------------------------------------------------------------------------- */

drop function public.append_harness_event(
  uuid, text, text, uuid, text, jsonb, text, text, text
);

create function public.append_harness_event(
  p_workflow_id   uuid,
  p_event_type    text,
  p_actor         text,
  p_step_id       uuid    default null,
  p_step_key      text    default null,
  p_payload       jsonb   default null,
  p_provider_used text    default null,
  p_model_used    text    default null,
  p_input_hash    text    default null,
  p_caused_by     uuid    default null,
  p_turn_number   int     default null
) returns public.harness_events
language plpgsql volatile security definer set search_path = public as $$
declare
  v_seq bigint;
  v_row public.harness_events;
begin
  -- Serialize appends for THIS workflow only (D-H3). The lock is released at statement end;
  -- concurrent appends queue behind it rather than colliding on the unique index.
  perform 1 from public.workflows where id = p_workflow_id for update;
  if not found then
    raise exception 'append_harness_event: unknown workflow %', p_workflow_id;
  end if;

  -- A cause must belong to the same workflow. Cross-workflow causation is always a bug, and
  -- catching it here keeps the trail's own referential story true rather than merely plausible.
  if p_caused_by is not null then
    perform 1 from public.harness_events
      where id = p_caused_by and workflow_id = p_workflow_id;
    if not found then
      raise exception 'append_harness_event: caused_by % is not an event of workflow %',
        p_caused_by, p_workflow_id;
    end if;
  end if;

  select coalesce(max(sequence_number), 0) + 1
    into v_seq
    from public.harness_events
   where workflow_id = p_workflow_id;

  insert into public.harness_events (
    workflow_id, step_id, step_key, sequence_number, event_type, actor,
    payload, provider_used, model_used, input_hash, caused_by, turn_number
  ) values (
    p_workflow_id, p_step_id, p_step_key, v_seq, p_event_type, p_actor,
    p_payload, p_provider_used, p_model_used, p_input_hash, p_caused_by, p_turn_number
  )
  returning * into v_row;

  return v_row;
end;
$$;

/* -------------------------------------------------------------------------- */
/* SECURITY FINDING (found while testing this migration; see §7 of the header   */
/* comment in 006 for the precedent).                                           */
/*                                                                              */
/* `revoke ... from anon, authenticated` — which is what 004 did — does NOT      */
/* make this function service-role-only. Postgres grants EXECUTE on every new    */
/* function to PUBLIC, and revoking from two role names leaves the PUBLIC grant  */
/* untouched. On the live project `proacl` read `=X/postgres,...`, that leading  */
/* `=X` being PUBLIC, and                                                        */
/*                                                                              */
/*   POST /rest/v1/rpc/append_harness_event   with the public anon key           */
/*                                                                               */
/* reached the function and returned its own `unknown workflow <uuid>` error —   */
/* i.e. it executed. This is SECURITY DEFINER, so RLS does not apply to its       */
/* insert.                                                                       */
/*                                                                               */
/* Severity, stated precisely: it is append-forgery, not erasure. There is no    */
/* UPDATE or DELETE path, and an attacker needs a real workflow UUID — which     */
/* rules out `anon` in practice but not an authenticated org member, who reads   */
/* their workflow ids straight out of the URL bar. Such a user could inject a    */
/* fabricated `human_decision` or `action_verified` into a genuine run. "The     */
/* trail is append-only and every event was written by the harness" is precisely */
/* the claim Plan 4 D-H4 makes, and this made the second half of it false.        */
/*                                                                               */
/* The fix is to revoke from PUBLIC and then grant back only to service_role.    */
/* The old signature is dropped above, which takes its (broken) ACL with it, so  */
/* this is the whole remedy — there is no lingering grant on the 9-arg form.     */
/*                                                                               */
/* The schema's other SECURITY DEFINER functions were audited at the same time:  */
/* `handle_new_user` and `rls_auto_enable` are (event) trigger functions, which   */
/* Postgres refuses to invoke directly, and `auth_org_id` is deliberately        */
/* callable by client roles — the RLS policies call it, and it returns only the   */
/* caller's own org. Neither needs a change.                                      */
/* -------------------------------------------------------------------------- */

revoke all on function public.append_harness_event(
  uuid, text, text, uuid, text, jsonb, text, text, text, uuid, int
) from public, anon, authenticated;

-- Guarded because `service_role` is a Supabase role: on the throwaway Postgres container the
-- migrations are rehearsed against, it does not exist, and an unguarded grant would make this
-- migration untestable in exactly the place PLAN-4 says to test it.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.append_harness_event(
      uuid, text, text, uuid, text, jsonb, text, text, text, uuid, int
    ) to service_role;
  end if;
end;
$$;

/* -------------------------------------------------------------------------- */
/* 4. The investigator role (D-G2) and the investigation workflow type (D-G3). */
/*                                                                             */
/* Widening `org_role_configs.step_role` is what makes per-role model           */
/* assignment work for the agent for free: an org points `investigator` at      */
/* DeepSeek or its own Ollama box in Settings and resolution tier 2 does the    */
/* rest. Building a parallel mechanism for one role would be the wrong kind of  */
/* special case.                                                                */
/*                                                                             */
/* `workflow_step_configs.workflow_type` is deliberately NOT widened: an        */
/* investigation has no step keys to pin, so a row there could never match      */
/* anything. The router's tier-1 SELECT with 'investigation' simply returns no  */
/* rows, which is the correct outcome and needs no constraint change.          */
/* -------------------------------------------------------------------------- */

alter table public.org_role_configs drop constraint org_role_configs_step_role_check;
alter table public.org_role_configs add constraint org_role_configs_step_role_check
  check (step_role in ('parser','matcher','classifier','writer','investigator'));

alter table public.workflows drop constraint workflows_type_check;
alter table public.workflows add constraint workflows_type_check
  check (type in ('reconciliation','ap_matching','fpa_commentary','investigation'));

/* -------------------------------------------------------------------------- */
/* 5. `investigations` — a projection, not a second history (D-G4).            */
/*                                                                             */
/* Same relationship workflow_steps has to harness_events: a cheap current-     */
/* state read for the UI, derived from and subordinate to the stream. The rule  */
/* that keeps it safe is that nothing reads this table to decide what happens   */
/* next — the loop's state is its conversation and, on resume, the events. If   */
/* the two ever disagree, the stream is right.                                  */
/* -------------------------------------------------------------------------- */

create table public.investigations (
  workflow_id        uuid primary key references public.workflows(id) on delete cascade,
  org_id             uuid not null references public.organizations(id) on delete cascade,
  question           text not null,
  status             text not null default 'running'
                     check (status in ('running','answered','terminated','failed')),
  -- The bounds this run was launched under, resolved from org config and clamped to the
  -- non-negotiable ceilings (D-G22). Stored so a completed run can be read back exactly as it ran.
  budget             jsonb not null,
  -- The cited answer: prose with figures already substituted, plus the citation set. Null until
  -- the run answers; a terminated run may still carry a partial answer, labelled as one.
  answer             jsonb,
  -- Why the loop stopped: 'answered' | 'max_turns' | 'max_tokens' | 'max_wall_clock' |
  -- 'loop_detected' | 'no_tool_support' | 'provider_error' | 'error'.
  termination_reason text,
  turns_used         int  not null default 0,
  tokens_in          int  not null default 0,
  tokens_out         int  not null default 0,
  created_by         uuid references public.profiles(id),
  created_at         timestamptz not null default now(),
  completed_at       timestamptz
);

create index on public.investigations (org_id, created_at desc);

alter table public.investigations enable row level security;

create policy "org investigations" on public.investigations for select
  using (org_id = public.auth_org_id());

-- 006 set deny-by-default for new tables in this schema, but that default is per-owner-role and
-- Supabase grants ALL on new public tables to the client roles. Belt and braces (PLAN-4's live-only
-- finding): an append-only-ish record that a client role could TRUNCATE is not one.
revoke insert, update, delete, truncate, trigger, references
  on public.investigations from anon, authenticated;

-- And granted explicitly rather than inherited from the platform's default privileges, so the
-- policy above is load-bearing on any Postgres this schema is applied to — not only on one where
-- Supabase happened to grant SELECT on our behalf.
grant select on public.investigations to anon, authenticated;

/* -------------------------------------------------------------------------- */
/* 6. Realtime. The transcript streams harness_events; the header reads the     */
/* investigation row's status flip when the run finishes.                       */
/* -------------------------------------------------------------------------- */

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.investigations;
  end if;
end;
$$;
