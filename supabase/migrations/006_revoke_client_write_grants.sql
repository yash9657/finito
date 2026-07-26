-- Plan 4 — close the TRUNCATE hole on every table (§1, hardening D-H4).
--
-- FOUND WHILE APPLYING 004 TO THE LIVE PROJECT, and not catchable locally: Supabase grants ALL
-- on new tables in `public` to `anon` and `authenticated` by default, so every table in this
-- schema — including `audit_log` and the Plan 3 authorization tables — carried
-- INSERT/UPDATE/DELETE/TRUNCATE/TRIGGER/REFERENCES for both client roles. A vanilla-Postgres
-- check cannot reproduce that, because there those roles start with nothing.
--
-- Why it matters, stated precisely rather than alarmingly:
--
--   * INSERT / UPDATE / DELETE were already inert. RLS is enabled on every table and there is
--     not a single write policy anywhere in the schema (every policy is SELECT-only, by design
--     — all writes go through the service role, D5). RLS denies an unpoliced write regardless
--     of the grant.
--
--   * TRUNCATE is different, and this is the actual finding: **Postgres RLS does not apply to
--     TRUNCATE.** A role holding it can empty a table whatever the policies say. For
--     `audit_log` and `harness_events` that is the difference between an append-only trail and
--     one any client role is permitted to erase.
--
--   * It is latent, not live: PostgREST exposes no TRUNCATE verb, so there is no route to it
--     through the API today. But "append-only because the API happens not to offer that verb"
--     is a much weaker guarantee than "append-only because the grant does not exist", and it
--     stops being true the moment anyone adds a SECURITY DEFINER helper or a SQL-executing RPC.
--
-- So: revoke every write verb from both client roles on every table, keeping SELECT (the
-- policies above it are what scope reads to an org). Nothing in the app depends on a client-role
-- write grant, so this is a strict tightening with no behavioural change.

do $$
declare
  t record;
begin
  for t in
    select tablename from pg_tables where schemaname = 'public'
  loop
    execute format(
      'revoke insert, update, delete, truncate, trigger, references on public.%I from anon, authenticated',
      t.tablename
    );
  end loop;
end;
$$;

-- And for tables added later: deny by default rather than relying on each migration to remember.
-- A future table that genuinely needs a client-role write grant must ask for it explicitly, which
-- is the correct direction for a schema whose integrity story is "the database will not let you".
alter default privileges in schema public
  revoke insert, update, delete, truncate, trigger, references on tables from anon, authenticated;
