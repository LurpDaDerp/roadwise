-- 0010_badges_challenges: badge and challenge definitions, earned badges and enrolments, the two RPCs, and
-- the counting of challenges and badges over settled driving days. The builders are 0009's (copied).
--
-- pgTAP is installed by 0001's test file outside its transaction; repeating it keeps this file
-- runnable alone. now() is the transaction's start throughout; settlement is driven by p_now, so the
-- fixture days are fixed dates in June 2026 (in the past). Section 0 opens real sessions over dblink
-- (test-only, local-only guard, dropped at the end): client writes as the first statement of a fresh
-- session, two sweeps racing on one user, apply_trip while a settlement is open, and the lease race.
-- Its fixture users are committed and deleted again; a run that dies midway leaves them, and the next
-- run deletes them first.
create extension if not exists pgtap with schema extensions;
do $$
begin
  if coalesce(current_setting('app.settings.jwt_secret', true), '') <> 'super-secret-jwt-token-with-at-least-32-characters-long' then
    raise exception '0010_badges_challenges.test.sql runs only against the local Supabase stack';
  end if;
  create extension if not exists dblink with schema extensions;
end $$;

begin;
select plan(81);

-- ---------------------------------------------------------------------------
-- builders
-- ---------------------------------------------------------------------------
create function pg_temp.u(n int) returns uuid language sql immutable as $$
  select ('c9000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
$$;
create function pg_temp.mkuser(n int, p_birth date default date '1990-01-01') returns uuid language plpgsql as $$
begin
  insert into auth.users (id, email) values (pg_temp.u(n), 'r9-' || n || '@example.com');
  update public.private_profiles set birth_date = p_birth where user_id = pg_temp.u(n);
  return pg_temp.u(n);
end $$;
-- a trip on local day p_day (10:00 there), written straight into the table like 0002's tests do
create function pg_temp.trip(p_user uuid, p_day date, p_score int, p_minutes int default 20, p_tz text default 'America/Los_Angeles',
  p_role text default 'driver', p_severe boolean default false, p_events text[] default '{}', p_deleted boolean default false) returns uuid
language plpgsql as $$
declare
  v_id uuid;
  v_start timestamptz := (p_day::timestamp + interval '10 hours') at time zone p_tz;
  v_cat text;
  v_i int := 0;
  v_status text := case when p_role = 'driver' then 'final' else 'unscored' end;
begin
  insert into public.trips (user_id, client_trip_id, started_at, ended_at, tz, distance_m, duration_s, role, mode, exposure,
    data_quality, status, score, unscored_reason, had_severe_event, deleted_at, category_deductions)
  values (p_user, 'r9-' || replace(gen_random_uuid()::text, '-', ''), v_start, v_start + make_interval(mins => p_minutes), p_tz,
    10000, p_minutes * 60, p_role, 'mounted', 1, 'A', v_status, case when v_status = 'final' then p_score end,
    case when v_status = 'unscored' then 'passenger' end, p_severe, case when p_deleted then now() end,
    coalesce((select jsonb_object_agg(c, 5) from unnest(p_events) c), '{}'::jsonb))
  returning id into v_id;
  foreach v_cat in array p_events loop
    v_i := v_i + 1;
    insert into public.trip_events (trip_id, user_id, client_event_id, category, started_at, duration_ms, severity, confidence,
      context_multiplier, source, status)
    values (v_id, p_user, 'ev-' || v_i, v_cat, v_start + interval '1 minute', 5000, 1, 0.9, 1, 'gnss', 'scored');
  end loop;
  return v_id;
end $$;
-- a score_daily row as the TypeScript day evaluation would store it; updated_at is set back 30 days so a
-- later rewrite (the touch trigger's now()) is seen as a change
create function pg_temp.day(p_user uuid, p_day date, p_safe boolean, p_good boolean default false, p_minutes int default 20,
  p_pf boolean default false, p_cam boolean default false, p_prov boolean default false) returns void
language sql as $$
  insert into public.score_daily (user_id, day, provisional, safe_day, good_day, phone_free_day, camera_day, exposure, driving_s,
    trips_scored, severe_events, updated_at)
  values (p_user, p_day, p_prov, p_safe, p_good, p_pf, p_cam, 1, p_minutes * 60, 1, 0, now() - interval '30 days')
$$;
-- a safe or unsafe driven day in one call
create function pg_temp.drove(p_user uuid, p_day date, p_safe boolean, p_tz text default 'America/Los_Angeles') returns void
language plpgsql as $$
begin
  perform pg_temp.trip(p_user, p_day, case when p_safe then 95 else 60 end, 20, p_tz);
  perform pg_temp.day(p_user, p_day, p_safe, false, 20, p_safe);
end $$;
-- the wall close of a Los Angeles day (02:00 PDT the next morning in June = 09:00 UTC)
create function pg_temp.la_close(p_day date) returns timestamptz language sql immutable as $$
  select ((p_day + 1)::timestamp + interval '2 hours') at time zone 'America/Los_Angeles'
$$;
create function pg_temp.settle(p_user uuid, p_now timestamptz) returns jsonb language sql as $$
  select public.settle_rewards(p_user, p_now)
$$;
create function pg_temp.dayrow(p_day date, p_safe boolean, p_pf boolean default false, p_minutes int default 20) returns jsonb
language sql immutable as $$
  select jsonb_build_object('day', p_day, 'longTermScore', 80, 'band', 'good', 'provisional', false, 'safeDay', p_safe,
    'goodDay', false, 'phoneFreeDay', p_pf, 'cameraDay', false, 'exposure', 1.25, 'drivingS', p_minutes * 60,
    'tripsScored', 1, 'severeEvents', 0)
$$;
-- apply_trip envelopes (FinalizeTripPayload at HEAD, as 0006's fixtures), Los Angeles
create function pg_temp.env(p_user uuid, p_client text, p_day date, p_score int, p_minutes int default 20,
  p_safe boolean default null, p_pf boolean default false, p_events int default 0) returns jsonb
language sql as $$
  select jsonb_build_object(
    'userId', p_user,
    'payload', jsonb_build_object(
      'clientTripId', p_client,
      'startedAt', floor(extract(epoch from (p_day::timestamp + interval '10 hours') at time zone 'America/Los_Angeles') * 1000)::bigint,
      'endedAt', floor(extract(epoch from (p_day::timestamp + interval '10 hours' + make_interval(mins => p_minutes)) at time zone 'America/Los_Angeles') * 1000)::bigint,
      'tz', 'America/Los_Angeles', 'distanceM', 12500, 'durationS', p_minutes * 60,
      'role', 'driver', 'roleConfidence', null, 'roleSource', 'manual', 'mode', 'mounted', 'cameraSession', false,
      'events', (select coalesce(jsonb_agg(jsonb_build_object(
          'id', 'ev-' || i, 'category', 'speeding',
          'startedAt', floor(extract(epoch from (p_day::timestamp + interval '10 hours') at time zone 'America/Los_Angeles') * 1000)::bigint + i * 10000,
          'durationS', 8.5, 'durationMs', 8500, 'q', 0.9, 'corrected', false, 'status', 'scored',
          'measured', '{}'::jsonb, 'context', '{}'::jsonb, 'contextMultiplier', 1, 'severity', 1, 'deduction', 2,
          'lat', 47.606, 'lng', -122.332, 'alertShown', true, 'source', 'gnss') order by i), '[]'::jsonb)
        from generate_series(1, p_events) i),
      'rowsDigest', jsonb_build_object('count', 900, 'validGnssPct', 98.5, 'imuPresent', true, 'maxSustainedSpeedMps', 31.2, 'sha256', repeat('a', 64)),
      'startGeohash5', 'c23nb', 'endGeohash5', 'c23nb', 'polyline', '_p~iF~ps|U', 'tracePath', null,
      'hadSevereEvent', false, 'incomplete', false),
    'scored', jsonb_build_object('score', p_score, 'status', 'final', 'exposure', 1.25, 'dataQuality', 'A',
      'categoryDeductions', '{"phone":0,"speeding":0,"braking":0,"accel":0,"cornering":0,"focus":0}'::jsonb,
      'eventDeductions', (select coalesce(jsonb_object_agg('ev-' || i, 2), '{}'::jsonb) from generate_series(1, p_events) i), 'scoringVersion', 1),
    'day', pg_temp.dayrow(p_day, coalesce(p_safe, p_score >= 85 and p_minutes >= 10), p_pf, p_minutes))
$$;
create function pg_temp.as_service(p_sql text) returns void language plpgsql as $$
begin
  execute 'set local role service_role';
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  execute p_sql;
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end $$;
-- settled state that must never change: reward rows (not their bookkeeping), the ledger, the counters, the goals
create function pg_temp.snap(p_user uuid) returns jsonb language sql as $$
  select jsonb_build_object(
    'days', (select jsonb_agg(to_jsonb(r) - 'checked_through' - 'updated_at' order by r.day) from public.reward_days r where r.user_id = p_user),
    'ledger', (select jsonb_agg(to_jsonb(l) - 'id' - 'created_at' order by l.idempotency_key) from public.points_ledger l where l.user_id = p_user),
    'progress', (select to_jsonb(p) - 'updated_at' from public.progress p where p.user_id = p_user),
    'goals', (select jsonb_agg(to_jsonb(g) - 'updated_at' order by g.week_start) from public.weekly_goals g where g.user_id = p_user))
$$;
create function pg_temp.contra(p_user uuid, p_kind text default 'changed_after_settlement') returns int language sql as $$
  select count(*)::int from public.reward_contradictions where user_id = p_user and kind = p_kind
$$;
-- re-stamp a user's just-changed score_daily rows to a distinct later time (now() is constant in a test)
create function pg_temp.bump(p_user uuid, p_i int) returns int language plpgsql as $$
declare
  v_n int;
begin
  execute 'alter table public.score_daily disable trigger score_daily_touch';
  update public.score_daily set updated_at = now() + make_interval(mins => p_i) where user_id = p_user and updated_at = now();
  get diagnostics v_n = row_count;
  execute 'alter table public.score_daily enable trigger score_daily_touch';
  return v_n;
end $$;

-- the late settlement instant: every June and early July close, plus its 72 h cap, has passed
create function pg_temp.late() returns timestamptz language sql immutable as $$ select timestamptz '2026-08-01 00:00+00' $$;
create function pg_temp.conn() returns text language sql as $$
  select 'host=' || host(inet_server_addr()) || ' port=' || current_setting('port')
    || ' dbname=' || current_database() || ' user=postgres password=postgres'
$$;
create function pg_temp.remote(p_conn text, p_sql text) returns text language plpgsql as $$
begin
  return extensions.dblink_exec(p_conn, p_sql);
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;
-- one fresh connection signed in as F: p_sql's first row, or the error; rolled back, disconnected
create function pg_temp.fresh_client(p_sql text, p_exec boolean default false) returns text language plpgsql as $$
declare
  v text;
begin
  perform extensions.dblink_connect('rw9_client', pg_temp.conn());
  perform extensions.dblink_exec('rw9_client', $q$begin; set local role authenticated;
    set local request.jwt.claims = '{"role":"authenticated","sub":"c9000000-0000-4000-8000-000000000901"}'$q$);
  begin
    if p_exec then
      v := extensions.dblink_exec('rw9_client', p_sql);
    else
      select r into v from extensions.dblink('rw9_client', p_sql) as t(r text);
    end if;
  exception when others then
    v := sqlstate || ' ' || sqlerrm;
  end;
  perform extensions.dblink_exec('rw9_client', 'rollback');
  perform extensions.dblink_disconnect('rw9_client');
  return v;
end $$;
-- a service-role apply_trip in its own committed transaction, refusing to wait more than 200 ms
create function pg_temp.remote_apply(p_conn text, p_env jsonb) returns text language sql as $$
  select pg_temp.remote(p_conn, format($q$begin; set local role service_role;
    set local request.jwt.claims = '{"role":"service_role"}'; set local lock_timeout = '200ms';
    do $d$ begin perform public.apply_trip(%L::jsonb); end $d$; commit$q$, p_env::text))
$$;


-- ---------------------------------------------------------------------------
-- 0. fresh sessions (dblink): join_challenge and leave_challenge as the first statement
-- ---------------------------------------------------------------------------
select extensions.dblink_connect('rw9_pg', pg_temp.conn());
select extensions.dblink_exec('rw9_pg', $q$delete from auth.users where id = 'c9000000-0000-4000-8000-000000000901'$q$);
select extensions.dblink_exec('rw9_pg', $q$insert into auth.users (id, email) values ('c9000000-0000-4000-8000-000000000901', 'r10-f@example.com')$q$);
select extensions.dblink_exec('rw9_pg', $q$update public.private_profiles set birth_date = date '1990-01-01' where user_id = 'c9000000-0000-4000-8000-000000000901'$q$);
select extensions.dblink_exec('rw9_pg', $q$insert into public.user_challenges (id, user_id, def_id, start_day)
  values ('c1000000-0000-4000-8000-000000000001', 'c9000000-0000-4000-8000-000000000901', 'safe_run', current_date)$q$);
select is((pg_temp.fresh_client($q$select public.join_challenge('phone_down')::text$q$))::jsonb ->> 'state', 'active',
  'join_challenge succeeds as the first statement of a fresh session as authenticated');
select is(pg_temp.fresh_client($q$select public.leave_challenge('c1000000-0000-4000-8000-000000000001')::text$q$), '',
  'leave_challenge succeeds as the first statement of a fresh session');
select extensions.dblink_exec('rw9_pg', $q$delete from auth.users where id = 'c9000000-0000-4000-8000-000000000901'$q$);
select is((select n from extensions.dblink('rw9_pg', $q$select count(*)::int from auth.users where id = 'c9000000-0000-4000-8000-000000000901'$q$) as t(n int)), 0,
  'the committed fixture is gone again');
select extensions.dblink_disconnect('rw9_pg');

select pg_temp.mkuser(1);
select pg_temp.mkuser(2);
select pg_temp.mkuser(4);

-- ---------------------------------------------------------------------------
-- 1. structure and conventions
-- ---------------------------------------------------------------------------
select columns_are('public', 'badge_defs', array['id', 'family', 'tier', 'metric', 'threshold', 'sort', 'created_at', 'updated_at']::name[], 'badge_defs has exactly its columns');
select columns_are('public', 'challenge_defs', array['id', 'predicate', 'target_days', 'window_days', 'points', 'sort', 'active', 'created_at', 'updated_at']::name[],
  'challenge_defs has exactly its columns');
select columns_are('public', 'user_badges', array['user_id', 'badge_id', 'earned_at', 'created_at']::name[], 'user_badges has exactly its columns (append-only)');
select columns_are('public', 'user_challenges', array['id', 'user_id', 'def_id', 'start_day', 'state', 'pass_days', 'fail_days', 'completed_at', 'ended_at',
  'created_at', 'updated_at']::name[], 'user_challenges has exactly its columns');
select policies_are('public', 'badge_defs', array['badge_defs_select']::name[], 'badge_defs: select for authenticated');
select policies_are('public', 'challenge_defs', array['challenge_defs_select']::name[], 'challenge_defs: select for authenticated');
select policies_are('public', 'user_badges', array['user_badges_select_own']::name[], 'user_badges: select own');
select policies_are('public', 'user_challenges', array['user_challenges_select_own']::name[], 'user_challenges: select own');
select is((select count(*)::int from pg_policy where polrelid in ('public.badge_defs'::regclass, 'public.challenge_defs'::regclass, 'public.user_badges'::regclass,
    'public.user_challenges'::regclass) and polroles = array['authenticated'::regrole::oid] and polcmd = 'r'), 4, 'the four policies are select-only, to authenticated');
select is(array(select row(t, r, (select coalesce(array_agg(p order by p), '{}') from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
      where has_table_privilege(r, ('public.' || t)::regclass, p)))::text
    from unnest(array['badge_defs','challenge_defs','user_badges','user_challenges']) t, unnest(array['anon','authenticated','service_role']) r order by t, r),
  array[row('badge_defs','anon','{}'::text[])::text, row('badge_defs','authenticated','{SELECT}'::text[])::text, row('badge_defs','service_role','{}'::text[])::text,
        row('challenge_defs','anon','{}'::text[])::text, row('challenge_defs','authenticated','{SELECT}'::text[])::text, row('challenge_defs','service_role','{}'::text[])::text,
        row('user_badges','anon','{}'::text[])::text, row('user_badges','authenticated','{SELECT}'::text[])::text, row('user_badges','service_role','{}'::text[])::text,
        row('user_challenges','anon','{}'::text[])::text, row('user_challenges','authenticated','{SELECT}'::text[])::text, row('user_challenges','service_role','{}'::text[])::text],
  'exact privileges: authenticated reads, anon nothing, and no DML for any API role, the service role included');
select has_index('public', 'user_badges', 'user_badges_badge_idx', 'user_badges (badge_id)');
select has_index('public', 'user_challenges', 'user_challenges_user_state_idx', 'user_challenges (user_id, state)');
select has_index('public', 'user_challenges', 'user_challenges_def_idx', 'user_challenges (def_id)');
select is((select pg_get_indexdef('public.user_challenges_one_active_idx'::regclass)),
  'CREATE UNIQUE INDEX user_challenges_one_active_idx ON public.user_challenges USING btree (user_id, def_id) WHERE (state = ''active''::text)',
  'one active enrolment per definition');
select is(array[(select count(*)::int from public.badge_defs), (select count(*)::int from public.challenge_defs)], array[15, 4],
  'seeds: 15 badges (referrals_1 comes with 0011) and 4 challenges');
select is((select count(*)::int from pg_trigger where not tgisinternal and tgfoid = 'public.refuse_underage_writes()'::regprocedure
    and tgrelid in ('public.user_badges'::regclass, 'public.user_challenges'::regclass)), 2, 'both user tables refuse an under-13 account''s inserts');
select is((select count(*)::int from pg_trigger where not tgisinternal and tgfoid = 'public.touch_updated_at()'::regprocedure
    and tgrelid in ('public.badge_defs'::regclass, 'public.challenge_defs'::regclass, 'public.user_challenges'::regclass)), 3, 'the mutable tables keep updated_at');
select is((select count(*)::int from pg_proc p where p.oid in ('public.join_challenge(text)'::regprocedure, 'public.leave_challenge(uuid)'::regprocedure)
    and p.prosecdef and p.proowner = 'postgres'::regrole and p.proconfig = array['search_path=public', 'lock_timeout=2s']), 2,
  'the two RPCs are definer, owned by postgres, proconfig exactly search_path=public, lock_timeout=2s');
select is((select count(*)::int from pg_proc p where p.oid in ('public.settle_challenges(uuid, timestamptz)'::regprocedure, 'public.settle_badges(uuid)'::regprocedure,
    'public.refresh_progress(uuid)'::regprocedure, 'public.settle_rewards(uuid, timestamptz, timestamptz)'::regprocedure)
    and not p.prosecdef and p.proconfig = array['search_path=public']), 4, 'the settle steps are invoker, pinning search_path (the replaced ones keep theirs)');
select is((select row(p.prosecdef, p.proconfig)::text from pg_proc p where p.oid = 'public.minimise_underage_rewards()'::regprocedure),
  row(true, array['search_path=public'])::text, 'the replaced minimisation keeps its definer flag and pinned path');
select is(array[has_function_privilege('authenticated', 'public.join_challenge(text)', 'execute'), has_function_privilege('authenticated', 'public.leave_challenge(uuid)', 'execute')],
  array[true, true], 'authenticated executes the two RPCs');
select is((select bool_or(has_function_privilege(r, f, 'execute')) from unnest(array['anon', 'service_role']) r,
    unnest(array['public.join_challenge(text)', 'public.leave_challenge(uuid)']::regprocedure[]) f), false, 'anon and the service role execute neither');
select is((select bool_or(has_function_privilege(r, f, 'execute')) from unnest(array['anon', 'authenticated', 'service_role']) r,
    unnest(array['public.settle_challenges(uuid, timestamptz)', 'public.settle_badges(uuid)', 'public.refresh_progress(uuid)',
      'public.settle_rewards(uuid, timestamptz, timestamptz)']::regprocedure[]) f), false, 'no API role executes a settle step (the replaced settle_rewards keeps no grant)');
select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity), 0, 'no table in public is missing RLS');
select is((select count(*)::int from pg_proc p join pg_roles r on r.oid = p.proowner
    where p.pronamespace = 'public'::regnamespace and p.prosecdef
      and (r.rolname <> 'postgres' or p.proconfig is null or not ('search_path=public' = any(p.proconfig)))),
  0, 'every security definer function in public is owned by postgres and pins search_path=public');
create table public.zz_probe10 (id int);
create function public.zz_probe10_fn() returns int language sql as 'select 1';
select is((select bool_or(has_table_privilege(r, 'public.zz_probe10', p)) from unnest(array['anon', 'authenticated']) r, unnest(array['select', 'insert', 'update', 'delete']) p)
    or has_function_privilege('anon', 'public.zz_probe10_fn()', 'execute') or has_function_privilege('authenticated', 'public.zz_probe10_fn()', 'execute'),
  false, 'default privileges still grant anon and authenticated nothing on new objects');
drop function public.zz_probe10_fn();
drop table public.zz_probe10;
select is((select coalesce(array_agg(t.relname::text order by t.relname), '{}') from pg_class t
    where t.relnamespace = 'public'::regnamespace and t.relkind = 'r' and t.relname not in ('profiles', 'private_profiles')
      and (exists (select 1 from pg_constraint c where c.conrelid = t.oid and c.contype = 'f' and c.confrelid = 'auth.users'::regclass)
           or exists (select 1 from pg_attribute a where a.attrelid = t.oid and a.attname = 'user_id' and not a.attisdropped))
      and not exists (select 1 from pg_proc p where p.oid in ('public.minimise_underage_account()'::regprocedure,
                        'public.minimise_underage_notifications()'::regprocedure, 'public.minimise_underage_rewards()'::regprocedure)
                      and p.prosrc ~ ('delete from public\.' || t.relname || ' where'))), '{}'::text[],
  'every user-referencing public table (user_badges and user_challenges included) is deleted by the under-13 minimisation');
create function pg_temp.client_reach(r text) returns table (via text, fn regprocedure, can_execute boolean)
language plpgsql as $$
begin
  return query
  with recursive writable as (
    select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p') and n.nspname in ('public', 'storage')
      and (has_any_column_privilege(r, c.oid, 'INSERT') or has_any_column_privilege(r, c.oid, 'UPDATE')
           or has_table_privilege(r, c.oid, 'DELETE'))
  ),
  -- trigger functions that run as the writer (invoker), on client-writable tables
  inv_trig as (
    select t.tgrelid::regclass::text || '.' || t.tgname as via, t.tgfoid as fid
    from pg_trigger t join writable w on w.oid = t.tgrelid join pg_proc p on p.oid = t.tgfoid
    where not t.tgisinternal and not p.prosecdef
  ),
  -- direct expression dependencies: trigger WHEN, policies, CHECKs, defaults (pg_depend)
  expr as (
    select 'trigger WHEN ' || t.tgrelid::regclass::text || '.' || t.tgname as via, d.refobjid as fid
    from pg_trigger t join writable w on w.oid = t.tgrelid
    join pg_depend d on d.classid = 'pg_trigger'::regclass and d.objid = t.oid and d.refclassid = 'pg_proc'::regclass
    where not t.tgisinternal and d.refobjid <> t.tgfoid
    union all
    select 'policy ' || pol.polrelid::regclass::text || '.' || pol.polname, d.refobjid
    from pg_policy pol join writable w on w.oid = pol.polrelid
      and (pol.polroles @> array[r::regrole::oid] or pol.polroles = array[0::oid])
    join pg_depend d on d.classid = 'pg_policy'::regclass and d.objid = pol.oid and d.refclassid = 'pg_proc'::regclass
    union all
    select 'check ' || con.conrelid::regclass::text || '.' || con.conname, d.refobjid
    from pg_constraint con join writable w on w.oid = con.conrelid
    join pg_depend d on d.classid = 'pg_constraint'::regclass and d.objid = con.oid and d.refclassid = 'pg_proc'::regclass
    union all
    select 'default ' || ad.adrelid::regclass::text, d.refobjid
    from pg_attrdef ad join writable w on w.oid = ad.adrelid
    join pg_depend d on d.classid = 'pg_attrdef'::regclass and d.objid = ad.oid and d.refclassid = 'pg_proc'::regclass
  ),
  -- calls from invoker function bodies: ANY schema-qualified `<schema>.<name>(` (fix round 5, n1),
  -- resolved through pg_namespace + pg_proc to EVERY overload of that name, followed through invoker
  -- callees (a definer callee is still checked for EXECUTE, but runs as its owner beyond that).
  -- Unqualified calls are not seen: the conventions require every name to be schema-qualified.
  body_calls(via, caller, callee) as (
    select it.via, it.fid, p2.oid
    from inv_trig it join pg_proc p on p.oid = it.fid
    cross join lateral regexp_matches(p.prosrc, '\m([a-z_][a-z_0-9]*)\.([a-z_][a-z_0-9]*)\s*\(', 'g') m
    join pg_namespace n2 on n2.nspname = m[1]
    join pg_proc p2 on p2.pronamespace = n2.oid and p2.proname = m[2]
    union
    select bc.via, bc.callee, p2.oid
    from body_calls bc join pg_proc p on p.oid = bc.callee and not p.prosecdef
    cross join lateral regexp_matches(p.prosrc, '\m([a-z_][a-z_0-9]*)\.([a-z_][a-z_0-9]*)\s*\(', 'g') m
    join pg_namespace n2 on n2.nspname = m[1]
    join pg_proc p2 on p2.pronamespace = n2.oid and p2.proname = m[2]
  ),
  expr_calls(via, callee) as (
    select e.via, e.fid from expr e
    union
    select ec.via, p2.oid
    from expr_calls ec join pg_proc p on p.oid = ec.callee and not p.prosecdef
    cross join lateral regexp_matches(p.prosrc, '\m([a-z_][a-z_0-9]*)\.([a-z_][a-z_0-9]*)\s*\(', 'g') m
    join pg_namespace n2 on n2.nspname = m[1]
    join pg_proc p2 on p2.pronamespace = n2.oid and p2.proname = m[2]
  )
  select distinct x.via, x.callee::regprocedure, has_function_privilege(r, x.callee, 'execute')
  from (select b.via, b.callee from body_calls b union select e.via, e.callee from expr_calls e) x
  order by 1, 2;
end $$;
select is((select coalesce(array_agg(via || ' -> ' || fn::text order by via, fn::text), '{}') from pg_temp.client_reach(r) where not can_execute),
  '{}'::text[], 'client-reach audit: ' || r) from unnest(array['anon', 'authenticated', 'service_role']) r;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok($$ select id from public.badge_defs $$, '42501', null, 'anon cannot read the badge definitions');
select throws_ok($$ select id from public.challenge_defs $$, '42501', null, 'nor the challenge definitions');
select throws_ok($$ select public.join_challenge('phone_down') $$, '42501', null, 'nor join a challenge');
reset role;
select set_config('request.jwt.claims', '', true);

-- ---------------------------------------------------------------------------
-- 2. join_challenge and leave_challenge
-- ---------------------------------------------------------------------------
select throws_ok($$ select public.join_challenge('phone_down') $$, '42501', 'join_challenge requires an authenticated user', 'no JWT, no join');
update public.challenge_defs set active = false where id = 'within_limit';
create temp table res10 (k text primary key, v jsonb);
grant select, insert on res10 to authenticated;
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"c9000000-0000-4000-8000-000000000001"}', true);
insert into res10 values ('join', public.join_challenge('phone_down'));
reset role;
select set_config('request.jwt.claims', '', true);
select is((select v from res10 where k = 'join') - 'id', jsonb_build_object('def_id', 'phone_down', 'start_day', public.user_local_date(pg_temp.u(1)) + 1,
    'state', 'active', 'pass_days', 0, 'fail_days', 0), 'a join starts counting the day after (the join day is already partly known)');
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"c9000000-0000-4000-8000-000000000001"}', true);
select throws_ok($$ select public.join_challenge('bogus') $$, '22023', 'unknown challenge', 'an unknown challenge is refused');
select throws_ok($$ select public.join_challenge('within_limit') $$, '22023', 'unknown challenge', 'an inactive one too');
select throws_ok($$ select public.join_challenge('phone_down') $$, '22023', 'challenge already active', 'the same challenge twice is refused');
select lives_ok($$ select public.join_challenge('smooth_ride') $$, 'a second challenge is allowed');
select throws_ok($$ select public.join_challenge('safe_run') $$, '42501', 'two challenges at a time', 'a third is refused');
select lives_ok($$ select public.leave_challenge((select id from public.user_challenges where def_id = 'smooth_ride')) $$, 'A leaves one');
select is((select row(state, ended_at = now())::text from public.user_challenges where def_id = 'smooth_ride'), row('left', true)::text, 'it is left, final, with no points');
select lives_ok($$ select public.join_challenge('smooth_ride') $$, 'rejoining after it ends is allowed');
reset role;
select set_config('request.jwt.claims', '', true);
update public.challenge_defs set active = true where id = 'within_limit';
insert into public.user_challenges (user_id, def_id, start_day) values (pg_temp.u(2), 'safe_run', date '2026-06-01');
insert into res10 select 'b', to_jsonb(id) from public.user_challenges where user_id = pg_temp.u(2);
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"c9000000-0000-4000-8000-000000000001"}', true);
select throws_ok(format($$ select public.leave_challenge(%L) $$, (select v #>> '{}' from res10 where k = 'b')), '42501', 'challenge not found',
  'A cannot leave B''s enrolment');
select is((select count(*)::int from public.user_challenges where def_id = 'safe_run'), 0, 'nor see it');
select throws_ok($$ update public.user_challenges set state = 'left' $$, '42501', null, 'there is no direct client write of enrolments');
select throws_ok($$ insert into public.user_badges (user_id, badge_id, earned_at) values ('c9000000-0000-4000-8000-000000000001', 'safe_days_7', now()) $$, '42501', null,
  'nor of badges');
reset role;
select set_config('request.jwt.claims', '', true);
select is((select state from public.user_challenges where user_id = pg_temp.u(2)), 'active', 'B''s enrolment is unchanged');
update public.rate_limits set count = 20 where user_id = pg_temp.u(1) and key = 'challenge_day';
update public.user_challenges set state = 'left' where user_id = pg_temp.u(1) and state = 'active' and def_id = 'smooth_ride';
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"c9000000-0000-4000-8000-000000000001"}', true);
select throws_ok($$ select public.join_challenge('smooth_ride') $$, '42501', 'challenge limit reached', 'the 21st join in 24 h is refused');
reset role;
select set_config('request.jwt.claims', '', true);

-- ---------------------------------------------------------------------------
-- 3. counting in settled driving days (§R6)
-- ---------------------------------------------------------------------------
-- P passes phone (a safe drive), F fails it (a phone event), N a day with no drive, U unsafe, C a cornering event
create function pg_temp.days(p_user uuid, p_from date, p_pattern text) returns void language plpgsql as $$
declare
  v_day date;
begin
  for i in 1 .. char_length(p_pattern) loop
    v_day := p_from + (i - 1);
    case substr(p_pattern, i, 1)
      when 'P' then perform pg_temp.drove(p_user, v_day, true);
      when 'U' then perform pg_temp.drove(p_user, v_day, false);
      when 'F' then perform pg_temp.trip(p_user, v_day, 90, 20, 'America/Los_Angeles', 'driver', false, array['phone']); perform pg_temp.day(p_user, v_day, false);
      when 'C' then perform pg_temp.trip(p_user, v_day, 90, 20, 'America/Los_Angeles', 'driver', false, array['cornering']); perform pg_temp.day(p_user, v_day, false);
      else perform pg_temp.day(p_user, v_day, false, false, 0);
    end case;
  end loop;
end $$;
create function pg_temp.enrol(p_user uuid, p_def text, p_start date) returns uuid language sql as $$
  insert into public.user_challenges (user_id, def_id, start_day) values (p_user, p_def, p_start) returning id
$$;
-- the join day is not counted
select pg_temp.mkuser(10);
select pg_temp.days(pg_temp.u(10), date '2026-06-01', 'P');
select pg_temp.enrol(pg_temp.u(10), 'phone_down', date '2026-06-02');
select pg_temp.settle(pg_temp.u(10), pg_temp.late());
select is((select pass_days from public.user_challenges where user_id = pg_temp.u(10)), 0, 'a day before start_day (the join day) is not counted');
-- 10 passing driving days out of 12, with 4 days of no driving between
select pg_temp.mkuser(11);
select pg_temp.days(pg_temp.u(11), date '2026-06-01', 'PPFNPPNPFPNPPNPP');
create temp table uc11 as select pg_temp.enrol(pg_temp.u(11), 'phone_down', date '2026-06-01') as id;
select pg_temp.settle(pg_temp.u(11), pg_temp.late());
select is((select row(state, pass_days, fail_days, completed_at is not null)::text from public.user_challenges where user_id = pg_temp.u(11)),
  row('completed', 10, 2, true)::text, '10 passing driving days out of 12, days of no driving between: completed');
select is((select row(type, amount, idempotency_key)::text from public.points_ledger where user_id = pg_temp.u(11) and type = 'challenge'),
  row('challenge', 200, 'challenge:' || (select id from uc11))::text, '+200 once, keyed to the enrolment');
select is((select payload from public.inbox where user_id = pg_temp.u(11) and dedupe_key like 'goal_completed:challenge:%'),
  '{"kind": "challenge", "challengeId": "phone_down", "points": 200}'::jsonb, 'a goal_completed challenge event with exactly the catalog''s keys');
select is((pg_temp.settle(pg_temp.u(11), pg_temp.late()) ->> 'ledgerRows')::int, 0, 'a replayed settlement adds nothing');
select is((select points from public.progress where user_id = pg_temp.u(11)), (select sum(amount)::int from public.points_ledger where user_id = pg_temp.u(11)),
  'progress points include the challenge points');
-- 5 passes and 9 fails end the window
select pg_temp.mkuser(12);
select pg_temp.days(pg_temp.u(12), date '2026-06-01', 'PFFPFFPFFPFFPF');
select pg_temp.enrol(pg_temp.u(12), 'phone_down', date '2026-06-01');
select pg_temp.settle(pg_temp.u(12), pg_temp.late());
select is((select row(state, pass_days, fail_days)::text from public.user_challenges where user_id = pg_temp.u(12)), row('ended', 5, 9)::text,
  '5 passes and 9 fails: ended at 14 driving days');
select is((select count(*)::int from public.points_ledger where user_id = pg_temp.u(12) and type = 'challenge'), 0, 'no points');
-- (R-A) a later change of a counted day changes nothing
update public.score_daily set safe_day = true where user_id = pg_temp.u(12) and day = '2026-06-02';
update public.trips set status = 'unscored', role = 'passenger', score = null, unscored_reason = 'passenger' where user_id = pg_temp.u(12) and local_day = '2026-06-02';
select pg_temp.bump(pg_temp.u(12), 1);
select pg_temp.settle(pg_temp.u(12), pg_temp.late());
select is((select row(state, pass_days, fail_days)::text from public.user_challenges where user_id = pg_temp.u(12)), row('ended', 5, 9)::text,
  'a post-settlement change turning a counted fail into a pass leaves the enrolment ended with its counts');
-- a watermark-held day is not counted until it settles
select pg_temp.mkuser(13);
select pg_temp.days(pg_temp.u(13), date '2026-06-01', 'PP');
select pg_temp.enrol(pg_temp.u(13), 'phone_down', date '2026-06-01');
insert into public.devices (id, user_id, platform, synced_through, last_seen_at) values
  ('w13', pg_temp.u(13), 'ios', pg_temp.la_close(date '2026-06-01') + interval '1 minute', pg_temp.la_close(date '2026-06-01') + interval '1 minute');
select pg_temp.settle(pg_temp.u(13), pg_temp.la_close(date '2026-06-02') + interval '1 hour');
select is((select pass_days from public.user_challenges where user_id = pg_temp.u(13)), 1, 'a day held by the watermark is not counted');
update public.devices set synced_through = pg_temp.la_close(date '2026-06-02') + interval '1 minute' where id = 'w13';
select pg_temp.settle(pg_temp.u(13), pg_temp.la_close(date '2026-06-02') + interval '2 hours');
select is((select pass_days from public.user_challenges where user_id = pg_temp.u(13)), 2, 'and is counted once it settles');
-- safe_run counts outcomes; smooth_ride fails on a cornering event
select pg_temp.mkuser(14);
select pg_temp.days(pg_temp.u(14), date '2026-06-01', 'PUNP');
select pg_temp.enrol(pg_temp.u(14), 'safe_run', date '2026-06-01');
select pg_temp.enrol(pg_temp.u(14), 'smooth_ride', date '2026-06-01');
select pg_temp.settle(pg_temp.u(14), pg_temp.late());
select is((select row(pass_days, fail_days)::text from public.user_challenges where user_id = pg_temp.u(14) and def_id = 'safe_run'), row(2, 1)::text,
  'safe_run counts outcomes: two safe days pass, the unsafe day fails, the empty day is not a driving day');
select pg_temp.mkuser(15);
select pg_temp.days(pg_temp.u(15), date '2026-06-01', 'PC');
select pg_temp.enrol(pg_temp.u(15), 'smooth_ride', date '2026-06-01');
select pg_temp.settle(pg_temp.u(15), pg_temp.late());
select is((select row(pass_days, fail_days)::text from public.user_challenges where user_id = pg_temp.u(15)), row(1, 1)::text, 'smooth_ride fails on a cornering event');
-- nothing before rewards_start counts
select pg_temp.mkuser(16);
insert into public.progress (user_id, rewards_start) values (pg_temp.u(16), date '2026-06-03');
select pg_temp.days(pg_temp.u(16), date '2026-06-01', 'PPPP');
select pg_temp.enrol(pg_temp.u(16), 'phone_down', date '2026-06-01');
select pg_temp.settle(pg_temp.u(16), pg_temp.late());
select is((select pass_days from public.user_challenges where user_id = pg_temp.u(16)), 2, 'only days on or after rewards_start count');

-- ---------------------------------------------------------------------------
-- 4. badges (§R7)
-- ---------------------------------------------------------------------------
select pg_temp.mkuser(20);
select pg_temp.days(pg_temp.u(20), date '2026-06-01', 'PPPPPPP');
select pg_temp.settle(pg_temp.u(20), pg_temp.late());
select is((select array_agg(badge_id order by badge_id) from public.user_badges where user_id = pg_temp.u(20)), array['safe_days_7', 'smooth_days_7', 'weekly_goals_1'],
  '7 settled safe days: safe_days_7 (and smooth_days_7, and the goal they achieved)');
select is((select payload from public.inbox where user_id = pg_temp.u(20) and dedupe_key = 'level_up:badge:safe_days_7'),
  '{"kind": "badge", "badgeId": "safe_days_7", "tier": "bronze"}'::jsonb, 'a level_up badge event with exactly the catalog''s keys');
select pg_temp.settle(pg_temp.u(20), pg_temp.late());
select is((select count(*)::int from public.user_badges where user_id = pg_temp.u(20) and badge_id = 'safe_days_7'), 1, 'earned once');
select pg_temp.mkuser(21);
select pg_temp.days(pg_temp.u(21), date '2026-03-01', repeat('P', 100));
select pg_temp.settle(pg_temp.u(21), pg_temp.late());
select is((select array_agg(badge_id order by badge_id) from public.user_badges where user_id = pg_temp.u(21) and badge_id like 'safe_days_%'),
  array['safe_days_100', 'safe_days_30', 'safe_days_7'], 'reaching 7, 30 and 100 in one settlement inserts every tier');
select is((select array_agg(payload ->> 'badgeId' order by payload ->> 'badgeId') from public.inbox where user_id = pg_temp.u(21) and payload ->> 'kind' = 'badge'
    and payload ->> 'badgeId' like 'safe_days_%'), array['safe_days_100'], 'but announces only the highest tier of the family');
-- badges and enrolments never change under later inputs (the Task 2 property loop, extended)
select pg_temp.mkuser(22);
select pg_temp.as_service(format('select public.apply_trip(%L::jsonb)', pg_temp.env(pg_temp.u(22), 'q' || i, date '2026-05-31' + i, 95, 20, true, true)::text))
  from generate_series(1, 14) i;
create temp table uc22 as select pg_temp.enrol(pg_temp.u(22), 'safe_run', date '2026-06-01') as id;
select pg_temp.settle(pg_temp.u(22), pg_temp.late());
alter table public.score_daily disable trigger score_daily_touch;
update public.score_daily set updated_at = now() - interval '30 days' where user_id = pg_temp.u(22);
alter table public.score_daily enable trigger score_daily_touch;
create temp table snap22 as select
  (select jsonb_agg(to_jsonb(b) order by b.badge_id) from public.user_badges b where b.user_id = pg_temp.u(22)) as badges,
  (select jsonb_agg(to_jsonb(c) - 'updated_at' order by c.id) from public.user_challenges c where c.user_id = pg_temp.u(22)) as challenges,
  pg_temp.snap(pg_temp.u(22)) as s;
do $$
declare
  v_user uuid := pg_temp.u(22);
  v_day date;
  v_trip uuid;
begin
  perform setseed(0.25);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  for i in 1 .. 30 loop
    v_day := date '2026-06-01' + floor(random() * 14)::int;
    select t.id into v_trip from public.trips t where t.user_id = v_user and t.local_day = v_day and t.deleted_at is null and t.role = 'driver' limit 1;
    case floor(random() * 3)::int
      when 0 then perform public.apply_trip(pg_temp.env(v_user, 'late' || i, v_day, 30, 20, false));
      when 1 then update public.score_daily set safe_day = not safe_day where user_id = v_user and day = v_day;
      else
        if v_trip is not null then
          perform public.soft_delete_trip(v_user, v_trip);
          perform public.apply_recompute(v_user, v_trip, null, null, pg_temp.dayrow(v_day, false), null);
        end if;
    end case;
    perform pg_temp.bump(v_user, i);
    perform public.settle_rewards(v_user, pg_temp.late());
  end loop;
  perform set_config('request.jwt.claims', '', true);
end $$;
select is((select jsonb_build_object('b', (select jsonb_agg(to_jsonb(b) order by b.badge_id) from public.user_badges b where b.user_id = pg_temp.u(22)),
    'c', (select jsonb_agg(to_jsonb(c) - 'updated_at' order by c.id) from public.user_challenges c where c.user_id = pg_temp.u(22)), 's', pg_temp.snap(pg_temp.u(22)))),
  (select jsonb_build_object('b', badges, 'c', challenges, 's', s) from snap22),
  'after 30 random late inputs, badges, enrolments and all settled value are unchanged');
select is((select state from public.user_challenges where id = (select id from uc22)), 'completed', '(the enrolment it holds completed before the inputs)');

-- ---------------------------------------------------------------------------
-- 5. class and under 13
-- ---------------------------------------------------------------------------
select pg_temp.mkuser(23);
insert into public.points_ledger (user_id, type, amount, ref_key, balance_after, idempotency_key) values (pg_temp.u(23), 'challenge', 1400, 'seed', 1400, 'seed');
select pg_temp.days(pg_temp.u(23), date '2026-06-01', 'P');
select pg_temp.enrol(pg_temp.u(23), 'phone_down', date '2026-06-01');
update public.challenge_defs set target_days = 1 where id = 'phone_down';
select pg_temp.settle(pg_temp.u(23), pg_temp.la_close(date '2026-06-01') + interval '1 minute');
update public.challenge_defs set target_days = 10 where id = 'phone_down';
select is((select row(points, level, challenges_completed)::text from public.progress where user_id = pg_temp.u(23)), row(1675, 2, 1)::text,
  'the class counts challenge points: 1,400 + 75 for the day + 200 for the challenge = class 2, one challenge completed');
select is((select count(*)::int from public.user_badges where user_id = pg_temp.u(23) and badge_id = 'challenges_1'), 1, 'and the challenges_1 badge');
select pg_temp.days(pg_temp.u(4), date '2026-06-01', 'PPPPPPP');
select pg_temp.enrol(pg_temp.u(4), 'phone_down', date '2026-06-01');
select pg_temp.settle(pg_temp.u(4), pg_temp.late());
select is(array[(select count(*) from public.user_badges where user_id = pg_temp.u(4)), (select count(*) from public.user_challenges where user_id = pg_temp.u(4))]::int[],
  array[3, 1], 'U holds badges and an enrolment');
update public.private_profiles set birth_date = null where user_id = pg_temp.u(4);
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"c9000000-0000-4000-8000-000000000004"}', true);
select lives_ok($$ select public.set_birth_date((current_date - interval '10 years')::date) $$, 'U gives a child''s birth date');
select throws_ok($$ select public.join_challenge('phone_down') $$, '42501', 'account not eligible', 'U cannot join a challenge');
reset role;
select set_config('request.jwt.claims', '', true);
select is(array[(select count(*) from public.user_badges where user_id = pg_temp.u(4)), (select count(*) from public.user_challenges where user_id = pg_temp.u(4)),
    (select count(*) from public.progress where user_id = pg_temp.u(4))]::int[], array[0, 0, 0], 'the u13 transition deletes both tables'' rows (and progress)');
select is((select level from public.profiles where id = pg_temp.u(4)), 1, 'and the class reset is kept (R-H)');
select throws_ok($$ insert into public.user_challenges (user_id, def_id, start_day) values (pg_temp.u(4), 'phone_down', current_date) $$, '42501', 'account not eligible',
  'no enrolment can be written for U');

select * from finish();
rollback;
drop extension if exists dblink;
