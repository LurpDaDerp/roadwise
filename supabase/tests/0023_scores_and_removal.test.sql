-- 0023_scores_and_removal: points, levels, streaks, freezes, leagues and phone use are gone from the
-- schema; the CHECKs refuse what left; the per-opportunity rating agrees with packages/scoring to
-- the digit (rate_score, speeding_weight, recency_weight, estimate_exposure, event_weight_of, and
-- the stored scenarios A/B/C/E/F of scores.md §3.3 through apply_drive); a drive's counters are
-- estimated when absent and held to what the drive allows; a drive dated in the future is moved back
-- to end now; the merge is 300 s and 150 m to the second and the metre; "Wasn't driving" and a report
-- move the week's goals; the summary and the profile keep their LEGACY literals; the board ranks by
-- rating.
create extension if not exists pgtap with schema extensions;

begin;
select plan(72);
-- the scores travel in jsonb: read them back exactly (the test runner's session prints 15 digits)
set local extra_float_digits = 1;

-- ---------------------------------------------------------------------------
-- posture catch-alls
-- ---------------------------------------------------------------------------
select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'private') and c.relkind in ('r', 'p') and not c.relrowsecurity), 0, 'no table in public or private lacks RLS');
select is((select count(*)::int from pg_proc p join pg_roles r on r.oid = p.proowner
    where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace) and p.prosecdef
      and (r.rolname <> 'postgres' or p.proconfig is null or not ('search_path=public' = any(p.proconfig)))), 0,
  'every security definer function is owned by postgres and pins search_path=public');
select is((select count(*)::int from pg_proc p where p.pronamespace = 'private'::regnamespace
    and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))), 0,
  'no API role can execute anything in private (the new rating, goal, report and "Wasn''t driving" functions included)');
select is((select count(*)::int from pg_proc p where p.pronamespace = 'private'::regnamespace and p.prosecdef
    and p.proname in ('sync_challenges', 'mark_not_driving', 'dispute_event', 'dispute_answer', 'rating_at', 'estimate_exposure', 'recency_weight', 'rate_score', 'speeding_weight', 'event_weight_of', 'attention_penalty_of')), 0,
  'the new private functions run as their caller (no definer)');
select table_privs_are('public', 'trips', 'authenticated', '{}'::text[], 'trips: no table privilege for authenticated');
select table_privs_are('public', 'trip_events', 'authenticated', '{}'::text[], 'trip_events: none either');
select table_privs_are('public', 'progress', 'anon', '{}'::text[], 'progress: nothing for anon');
select is((select array_agg(c.column_name::text order by c.column_name::text) from information_schema.column_privileges c
    where c.grantee = 'authenticated' and c.table_schema = 'public' and c.table_name = 'progress' and c.privilege_type = 'SELECT'),
  array['created_at', 'ranked', 'rating_updated_at', 'safety_rating', 'updated_at', 'user_id'], 'the owner reads only the rating columns of progress (miles_90d and last_end_* through RPCs only)');
select is((select array[has_function_privilege('authenticated', 'public.get_friends_board()', 'execute'), has_function_privilege('anon', 'public.get_friends_board()', 'execute')]),
  array[true, false], 'get_friends_board() is a client RPC for authenticated only');
create function private.zz_probe_fn() returns int language sql as 'select 1';
select is(array[has_function_privilege('authenticated', 'private.zz_probe_fn()', 'execute'), has_function_privilege('service_role', 'private.zz_probe_fn()', 'execute')], array[false, true],
  'the default privileges still hold: a new private function is service_role''s only');
drop function private.zz_probe_fn();

-- ---------------------------------------------------------------------------
-- schema: what left, what came
-- ---------------------------------------------------------------------------
select hasnt_table('public', 'points_ledger', 'the points ledger is gone');
select hasnt_table('public', 'league_groups', 'league groups are gone');
select hasnt_table('public', 'league_members', 'league members are gone');
select is((select array_agg(column_name::text order by column_name::text) from information_schema.columns where table_schema = 'public' and table_name = 'progress'
    and column_name in ('points', 'lifetime', 'level', 'streak', 'at_risk', 'freezes', 'freezes_granted_at', 'clean_run', 'freeze_progress', 'phone_free_run', 'league_tier', 'miles_30d', 'clean_miles_30d', 'rating_penalty_30d')),
  null, 'progress keeps no points, level, streak, freeze, league or 30-day column');
select is((select array_agg(column_name::text order by column_name::text) from information_schema.columns where table_schema = 'public' and table_name = 'trips'
    and column_name in ('points_net', 'breakdown', 'n_pickup', 'handling_s', 'streak_before', 'progress_before', 'is_loop', 'loop_repeat', 'safe_miles_earlier_today', 'safe_miles', 'rev', 'rating_penalty')),
  null, 'trips keeps no points, phone, loop, snapshot or penalty column');
select is((select array_agg(column_name::text order by column_name::text) from information_schema.columns where table_schema = 'public' and table_name = 'trip_events'
    and column_name in ('penalty', 'units', 'stopped_in_traffic')), null, 'trip_events keeps no penalty, units or stopped-in-traffic');
select col_default_is('public', 'trips', 'origin', 'manual'::text, 'a drive started manually unless it says otherwise');
select col_default_is('public', 'trips', 'not_driving_expired', 'false', 'its "Not driving?" never ran out unless it says so');
select col_default_is('public', 'trips', 'scoring_version', '9', 'scoring version 9 (7 here, 8 since 0026, 9 since 0028)');
select is((select array_agg(column_name::text || '=' || is_nullable order by column_name::text) from information_schema.columns where table_schema = 'public' and table_name = 'trips'
    and column_name in ('slowdowns', 'speedups', 'turns', 'limit_s', 'moving_s')),
  array['limit_s=NO', 'moving_s=NO', 'slowdowns=NO', 'speedups=NO', 'turns=NO'], 'every drive holds its five counters (the backfill left none null)');
select col_default_is('public', 'progress', 'miles_90d', '0', 'progress holds the window''s miles');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where (n.nspname = 'private' and p.proname in ('week_points', 'complete_challenges', 'revert_challenges_of_trip', 'revert_trip', 'restore_progress', 'progress_snapshot',
           'progress_json', 'apply_freeze_grant', 'level_for', 'level_floor', 'revert_latest_not_driving', 'dispute_context', 'apply_dispute', 'dispute_outcome',
           'place_in_league', 'league_standings', 'close_leagues', 'rating_window', 'rating_penalty_of', 'safety_rating'))
       or (n.nspname = 'public' and p.proname in ('get_my_league', 'get_global_board'))
       or (n.nspname = 'public' and p.proname = 'get_friends_board' and p.pronargs = 1)), 0,
  'the 19 points, streak, level and league functions, the old ratings and the metric board are gone');
select is((select count(*)::int from pg_proc p where p.pronamespace = 'private'::regnamespace
    and p.proname in ('sync_challenges', 'mark_not_driving', 'dispute_event', 'dispute_answer', 'recency_weight', 'rate_score', 'speeding_weight', 'event_weight_of',
      'attention_penalty_of', 'estimate_exposure', 'rating_at')), 11, 'the eleven new private functions exist');
select is((select count(*)::int from cron.job where jobname = 'league-close'), 0, 'no league close is scheduled');

-- ---------------------------------------------------------------------------
-- the CHECKs refuse what left
-- ---------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000001', 'a@example.com'),
  ('00000000-0000-0000-0000-000000000002', 'b@example.com'),
  ('00000000-0000-0000-0000-000000000003', 'c@example.com'),
  ('00000000-0000-0000-0000-000000000004', 'd@example.com');
update public.profiles set username = 'ava', onboarded_at = now() where id = '00000000-0000-0000-0000-000000000001';
update public.profiles set username = 'ben', onboarded_at = now() where id = '00000000-0000-0000-0000-000000000002';
update public.profiles set username = 'cat', onboarded_at = now() where id = '00000000-0000-0000-0000-000000000003';
update public.profiles set username = 'dan', onboarded_at = now() where id = '00000000-0000-0000-0000-000000000004';

-- a drive through apply_drive: started p_start, p_dur seconds long, p_miles; events are
-- [{id, type, tier?, durationS?, measured?, at? (s in)}]; p_payload is merged into the payload, p_env into the envelope
create function pg_temp.drive(p_user uuid, p_client uuid, p_start timestamptz, p_dur int, p_miles numeric, p_events jsonb,
  p_payload jsonb default '{}'::jsonb, p_env jsonb default '{}'::jsonb) returns jsonb
language plpgsql as $$
declare
  v_ms bigint := floor(extract(epoch from p_start) * 1000)::bigint;
  v_ev jsonb;
  v_pl jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('id', e ->> 'id', 'type', e ->> 'type', 'tier', coalesce(e ->> 'tier', 'minor'),
      'startedAt', v_ms + coalesce((e ->> 'at')::bigint, 60) * 1000, 'durationS', coalesce((e ->> 'durationS')::numeric, 2),
      'lat', 47.6, 'lng', -122.3, 'measured', coalesce(e -> 'measured', '{}'::jsonb))), '[]'::jsonb)
    into v_ev from jsonb_array_elements(p_events) e;
  v_pl := jsonb_build_object('clientTripId', p_client, 'startedAt', v_ms, 'endedAt', v_ms + p_dur * 1000::bigint, 'tz', 'America/Los_Angeles',
      'localDay', to_char(p_start at time zone 'America/Los_Angeles', 'YYYY-MM-DD'), 'miles', p_miles, 'nightMiles', 0, 'durationS', p_dur,
      'end', jsonb_build_object('lat', 47.61, 'lng', -122.31), 'polyline', '', 'appVersion', '3.0.0', 'origin', 'auto', 'notDrivingExpired', false) || p_payload;
  -- a key given as null is left out (an older build's upload had no origin)
  v_pl := v_pl - array(select k from jsonb_each(p_payload) x(k, v) where jsonb_typeof(v) = 'null');
  return private.apply_drive(jsonb_build_object(
    'user', p_user, 'mergeInto', null, 'dashcam', null, 'payload', v_pl,
    'scored', true, 'reason', null, 'events', v_ev, 'scoringVersion', 7) || p_env);
end $$;
create function pg_temp.exp(a int, b int, c int, d int, e int) returns jsonb language sql immutable as $$
  select jsonb_build_object('exposure', jsonb_build_object('slowdowns', a, 'speedups', b, 'turns', c, 'limitS', d, 'movingS', e)) $$;
create function pg_temp.t(p_client uuid) returns public.trips language sql stable as $$ select * from public.trips where client_trip_id = p_client $$;

select pg_temp.drive('00000000-0000-0000-0000-000000000004', 'f0000000-0000-4000-8000-000000000001', now() - interval '3 hours', 600, 2, '[{"id":"f1000000-0000-4000-8000-000000000001","type":"hard_brake"}]');
select throws_ok($$ insert into public.trip_events (trip_id, client_event_id, user_id, type, tier, started_at, duration_s)
    values ((pg_temp.t('f0000000-0000-4000-8000-000000000001')).id, gen_random_uuid(), '00000000-0000-0000-0000-000000000004', 'phone_handling', 'severe', now(), 1) $$,
  '23514', null, 'phone handling cannot be stored (a phone pickup can again since 0026)');
select throws_ok($$ insert into public.event_disputes (trip_id, client_event_id, user_id, reason, status)
    values ((pg_temp.t('f0000000-0000-4000-8000-000000000001')).id, 'f1000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000004', 'not_driving', 'accepted') $$,
  '23514', null, 'a "not driving" report cannot be stored (it is the whole-drive action; "mounted" is a reason again since 0026)');
select throws_ok($$ insert into public.user_achievements (user_id, achievement_id) values ('00000000-0000-0000-0000-000000000004', 'phone_free_25') $$, '23514', null, 'phone_free_25 is no achievement');
select throws_ok($$ insert into public.inbox (user_id, kind, payload, dedupe_key) values ('00000000-0000-0000-0000-000000000004', 'league_result', '{}', 'x') $$, '23514', null, 'league_result is no inbox kind');

-- ---------------------------------------------------------------------------
-- parity pins (scores.md §3.3; packages/scoring rating.test.ts pins the same values)
-- ---------------------------------------------------------------------------
select is(array[private.rate_score(0.01, 0.01), private.rate_score(0.02, 0.01), private.rate_score(0.03, 0.01), private.rate_score(0, 0.01), private.rate_score(0.005, 0.01),
    private.rate_score(0.1, 0.01), private.rate_score(0.032432432432432434, 0.04)],
  array[85, 73.91304347826086, 65.38461538461539, 100, 91.8918918918919, 36.170212765957444, 87.48261474269819]::float8[], 'rate_score: typical reads 85, never 0');
select is(array[private.speeding_weight(30, '{"overMphS": 125}', 'minor'), private.speeding_weight(25, '{"overMphS": 160}', 'moderate'), private.speeding_weight(65, '{"overMphS": 720}', 'severe'),
    private.speeding_weight(3, '{"overMphS": 0}', 'minor'), private.speeding_weight(60, '{"overMphS": 0}', 'severe'), private.speeding_weight(10, '{"overMphS": 100000}', 'severe'),
    private.speeding_weight(30, '{}', 'minor'), private.speeding_weight(30, '{}', 'moderate'), private.speeding_weight(30, '{}', 'severe')],
  array[22.82177322938192, 36.20386719675123, 214.3320213701522, 0, 0, 226.27416997969522, 7.58946638440411, 44.466841578866386, 111.54192037077361]::float8[],
  'speeding_weight: every second over the line x (over / 5)^1.5, capped at 40 over; the tier mean without overMphS (0028)');
select is(array[private.recency_weight(0), private.recency_weight(1), private.recency_weight(7), private.recency_weight(21), private.recency_weight(42), private.recency_weight(63),
    private.recency_weight(89), private.recency_weight(90), private.recency_weight(-1)],
  array[1, 0.9675, 0.7937, 0.5, 0.25, 0.125, 0.053, 0, 0]::float8[], 'recency_weight: half every 21 days, 0 outside the 90-day window');
select is((select bool_and(private.recency_weight(d) = round(power(2::numeric, -d / 21.0), 4)::float8) from generate_series(0, 89) d), true,
  'the literal table is 2^(-d/21) to 4 decimals for every day');
select is((select array_agg(row(e.*)::text order by n) from (values (1, 8::numeric, 1600), (2, 2, 480), (3, 40, 2900), (4, 0.3, 240), (5, 15, 1500), (6, 0, 0), (7, 10, 36000)) v(n, m, s),
    private.estimate_exposure(v.m, v.s) e),
  array['(18,18,11,912,1136)', '(5,5,3,252,312)', '(13,13,6,2313,2808)', '(1,1,1,108,132)', '(13,13,7,1060,1357)', '(0,0,0,0,0)', '(30,30,20,16200,19800)'],
  'estimate_exposure: the seven pinned estimates');
select is(array[private.event_weight_of('hard_brake', 'minor', 2, '{}'), private.event_weight_of('hard_brake', 'severe', 2, '{}'), private.event_weight_of('hard_accel', 'moderate', 2, '{}'),
    private.event_weight_of('hard_corner', 'severe', 2, '{}'), private.event_weight_of('speeding', 'moderate', 25, '{"overMphS": 160}'), private.event_weight_of('eyes_off', 'severe', 2, '{}'),
    private.event_weight_of('phone_handling', 'severe', 2, '{}')],
  array[1, 2, 1, 2, 36.20386719675123, 0, 0]::float8[], 'event_weight_of: a hard event without a peak 1 / 2, speeding its weight, DashPal and anything else 0 (0026 pins a pickup, 0028 the peaks)');

-- A, B, C (one driver, ava): drives 0, 10 and 40 days old, each an hour long, with their counters
select pg_temp.drive('00000000-0000-0000-0000-000000000001', 'a0000000-0000-4000-8000-00000000000a', now() - interval '1 hour', 3600, 6,
  '[{"id":"a1000000-0000-4000-8000-000000000001","type":"hard_brake"},{"id":"a1000000-0000-4000-8000-000000000002","type":"speeding","tier":"moderate","durationS":25,"measured":{"overMphS":160},"at":120}]',
  pg_temp.exp(15, 15, 9, 840, 1136));
select is(private.rating_at('00000000-0000-0000-0000-000000000001', now()) - 'scores', '{"miles": 6.00, "rating": 83.3, "ranked": false}'::jsonb, 'pin A: 83.3, not ranked');
select is((select array[(s ->> 'acceleration')::float8, (s ->> 'braking')::float8, (s ->> 'turning')::float8, (s ->> 'speed')::float8] from (select private.rating_at('00000000-0000-0000-0000-000000000001', now()) -> 'scores' as s) x),
  array[87.62886597938144, 72.64957264957265, 86.69623059866963, 84.8134771697258]::float8[], 'pin A: the unrounded categories to the digit');
select pg_temp.drive('00000000-0000-0000-0000-000000000001', 'a0000000-0000-4000-8000-00000000000b', now() - interval '10 days', 3600, 20,
  '[{"id":"b1000000-0000-4000-8000-000000000001","type":"hard_brake","tier":"severe"},{"id":"b1000000-0000-4000-8000-000000000002","type":"hard_accel"}]',
  pg_temp.exp(40, 40, 25, 2400, 3200));
select is((select array[(r ->> 'rating')::float8, (s ->> 'acceleration')::float8, (s ->> 'braking')::float8, (s ->> 'turning')::float8, (s ->> 'speed')::float8]
    from (select r, r -> 'scores' as s from (select private.rating_at('00000000-0000-0000-0000-000000000001', now()) as r) y) x),
  array[82.4, 79.68828603627973, 65.93366008869643, 89.14703209011581, 88.57795986947009]::float8[], 'pin B: 82.4 with the categories to the digit');
select pg_temp.drive('00000000-0000-0000-0000-000000000001', 'a0000000-0000-4000-8000-00000000000c', now() - interval '40 days', 3600, 30,
  '[{"id":"c1000000-0000-4000-8000-000000000001","type":"eyes_off","tier":"severe","measured":{"source":"dashcam","speedMph":30}},{"id":"c1000000-0000-4000-8000-000000000002","type":"hard_corner","tier":"severe"},
    {"id":"c1000000-0000-4000-8000-000000000003","type":"speeding","tier":"severe","durationS":65,"measured":{"overMphS":720},"at":180}]',
  pg_temp.exp(10, 10, 5, 1800, 2000), '{"dashcam": {"deviceId": "a4c1380f2b7e", "movingS": 2000, "coveredS": 2000, "synced": true, "on": true}}'::jsonb);
select is((select array[(r ->> 'rating')::float8, (s ->> 'acceleration')::float8, (s ->> 'braking')::float8, (s ->> 'turning')::float8, (s ->> 'attention')::float8, (s ->> 'speed')::float8]
    from (select r, r -> 'scores' as s from (select private.rating_at('00000000-0000-0000-0000-000000000001', now()) as r) y) x),
  array[82.1, 80.09658912192572, 66.5022298398257, 79.78673027342722, 93.74047948255254, 86.38393595803475]::float8[], 'pin C: 82.1 with Attention, to the digit');
select is((select row(safety_rating, ranked, miles_90d)::text from public.progress where user_id = '00000000-0000-0000-0000-000000000001'), row(82.1, true, 56.00)::text,
  'refresh_rating stores the rating, ranked and the 90-day miles');
select is((select rating_week_ago from public.progress where user_id = '00000000-0000-0000-0000-000000000001'),
  private.rating_as_of('00000000-0000-0000-0000-000000000001', now() - interval '7 days'), 'and the rating as of 7 days before, for the trend');
select is((select rating_week_ago from public.progress where user_id = '00000000-0000-0000-0000-000000000004'), null, 'a driver whose drives are all this week has no rating a week before (so no trend)');
select is(private.rating_at('00000000-0000-0000-0000-000000000001', now() - interval '41 days') -> 'rating', 'null'::jsonb, 'a time before every drive has no rating');
-- a removed speeding event lowers the Speed weight
update public.trip_events set status = 'removed' where client_event_id = 'c1000000-0000-4000-8000-000000000003';
select cmp_ok((private.rating_at('00000000-0000-0000-0000-000000000001', now()) -> 'scores' ->> 'speed')::float8, '>', 86.38393595803475::float8, 'a removed speeding event no longer weighs on Speed');
update public.trip_events set status = 'active' where client_event_id = 'c1000000-0000-4000-8000-000000000003';

-- E and F: one clean 6-mi drive (ben), the same at 10 mi (cat)
select pg_temp.drive('00000000-0000-0000-0000-000000000002', 'e0000000-0000-4000-8000-00000000000e', now() - interval '1 hour', 3600, 6, '[]', pg_temp.exp(15, 15, 9, 840, 1136));
select is(private.rating_at('00000000-0000-0000-0000-000000000002', now()) - 'scores', '{"miles": 6.00, "rating": 87.4, "ranked": false}'::jsonb, 'pin E: one clean drive reads 87.4, not 100');
select pg_temp.drive('00000000-0000-0000-0000-000000000003', 'e0000000-0000-4000-8000-00000000000f', now() - interval '1 hour', 3600, 10, '[]', pg_temp.exp(15, 15, 9, 840, 1136));
select is(private.rating_at('00000000-0000-0000-0000-000000000003', now()) - 'scores', '{"miles": 10.00, "rating": 87.4, "ranked": true}'::jsonb, 'pin F: ranked from 10 mi');

-- ---------------------------------------------------------------------------
-- counters: estimated when absent, held to what the drive allows
-- ---------------------------------------------------------------------------
select pg_temp.drive('00000000-0000-0000-0000-000000000004', 'f0000000-0000-4000-8000-000000000002', now() - interval '5 hours', 1600, 8, '[]', '{"origin": "manual"}');
select is((select row(slowdowns, speedups, turns, limit_s, moving_s, origin)::text from pg_temp.t('f0000000-0000-4000-8000-000000000002')), row(18, 18, 11, 912, 1136, 'manual')::text,
  'an upload without counters stores the estimate from its own miles and length');
select pg_temp.drive('00000000-0000-0000-0000-000000000004', 'f0000000-0000-4000-8000-000000000003', now() - interval '6 hours', 1200, 6, '[]',
  pg_temp.exp(20000, 20000, 20000, 43200, 43200) || '{"origin": null}'::jsonb);
select is((select row(slowdowns, speedups, turns, limit_s, moving_s, origin)::text from pg_temp.t('f0000000-0000-4000-8000-000000000003')), row(80, 80, 120, 1200, 1200, 'manual')::text,
  'inflated counters are clamped to the drive: moving time to its 1200 s, a swing per 15 s, a turn per 10 s; no origin reads manual');
select pg_temp.drive('00000000-0000-0000-0000-000000000004', 'f0000000-0000-4000-8000-000000000004', now() - interval '7 hours', 1800, 0.5, '[]', pg_temp.exp(1000, 1000, 1000, 1800, 1800));
select is((select row(slowdowns, speedups, turns, limit_s, moving_s)::text from pg_temp.t('f0000000-0000-4000-8000-000000000004')), row(20, 20, 20, 285, 510)::text,
  'and no count above 40 a mile (half a mile: 20), moving time at most ceil(mi x 900) + 60 s and limit time ceil(mi x 450) + 60 s (510 and 285)');
-- the time counters are held to the distance (moving time accrues at 5 mph or more, limit time at 10 mph or more)
select pg_temp.drive('00000000-0000-0000-0000-000000000004', 'f0000000-0000-4000-8000-000000000011', now() - interval '30 hours', 43200, 0.5, '[]', pg_temp.exp(5, 5, 5, 43200, 43200));
select is((select row(limit_s, moving_s)::text from pg_temp.t('f0000000-0000-4000-8000-000000000011')), row(285, 510)::text,
  'half a mile claimed as 12 h of moving under a limit (to dilute Speed) keeps 510 s moving and 285 s under a limit');
select pg_temp.drive('00000000-0000-0000-0000-000000000004', 'f0000000-0000-4000-8000-000000000012', now() - interval '10 hours', 5000, 1.1, '[]', pg_temp.exp(5, 5, 5, 5000, 5000));
select is((select row(limit_s, moving_s)::text from pg_temp.t('f0000000-0000-4000-8000-000000000012')), row(556, 1051)::text,
  'the caps are doubles in the phone''s order (boundExposure): 1.1 mi cuts to 1051 s and 556 s, not 1050 and 555');
select pg_temp.drive('00000000-0000-0000-0000-000000000004', 'f0000000-0000-4000-8000-000000000013', now() - interval '9 hours', 720, 1, '[]', pg_temp.exp(1, 1, 1, 0, 720));
select pg_temp.drive('00000000-0000-0000-0000-000000000004', 'f0000000-0000-4000-8000-000000000014', now() - interval '9 hours 30 minutes', 360, 1, '[]', pg_temp.exp(1, 1, 1, 360, 360));
select is(array[(select row(limit_s, moving_s)::text from pg_temp.t('f0000000-0000-4000-8000-000000000013')), (select row(limit_s, moving_s)::text from pg_temp.t('f0000000-0000-4000-8000-000000000014'))],
  array[row(0, 720)::text, row(360, 360)::text], 'a real drive always fits: a mile at 5 mph keeps its 720 s moving, a mile at 10 mph its 360 s under a limit');
select pg_temp.drive('00000000-0000-0000-0000-000000000004', 'f0000000-0000-4000-8000-000000000005', now() - interval '8 hours', 1800, 12, '[]', pg_temp.exp(18, 17, 11, 1700, 1650));
select is((select row(slowdowns, speedups, turns, limit_s, moving_s)::text from pg_temp.t('f0000000-0000-4000-8000-000000000005')), row(18, 17, 11, 1650, 1650)::text,
  'an honest drive keeps its counters; limit time never exceeds moving time');

-- ---------------------------------------------------------------------------
-- the clock: a drive dated in the future is moved back to end now
-- ---------------------------------------------------------------------------
select pg_temp.drive('00000000-0000-0000-0000-000000000004', 'f0000000-0000-4000-8000-000000000006', now() + interval '3 days', 1800, 6,
  '[{"id":"f6000000-0000-4000-8000-000000000001","type":"hard_brake","at":600}]');
select is((select row(ended_at = now(), ended_at - started_at, duration_s, league_week = private.league_week(started_at),
    local_day = (started_at at time zone 'America/Los_Angeles')::date)::text from pg_temp.t('f0000000-0000-4000-8000-000000000006')),
  row(true, interval '30 minutes', 1800, true, true)::text, 'it ends now, keeps its length, and its day and week are read again');
select is((select e.started_at - t.started_at from public.trip_events e join public.trips t on t.id = e.trip_id where e.client_event_id = 'f6000000-0000-4000-8000-000000000001'),
  interval '10 minutes', 'its events move with it');
select is((select last_end_at = now() from public.progress where user_id = '00000000-0000-0000-0000-000000000004'), true, 'and the last end it leaves is now');
-- ---------------------------------------------------------------------------
-- the merge: 300 s and 150 m, to the second and the metre
-- ---------------------------------------------------------------------------
-- dan's latest end is now (the moved drive); a start 1 m north is about 0.000009 degrees
create function pg_temp.merge_at(p_secs int, p_metres double precision) returns jsonb language sql as $$
  select private.drive_context('00000000-0000-0000-0000-000000000004', gen_random_uuid(), now() + make_interval(secs => p_secs), current_date,
    47.61 + p_metres / 111195.0, -122.31, now() + make_interval(secs => p_secs + 60)) -> 'merge'
$$;
select is(array[pg_temp.merge_at(300, 149) ->> 'clientTripId', pg_temp.merge_at(301, 149) ->> 'clientTripId'],
  array['f0000000-0000-4000-8000-000000000006', null], '300 s after the end merges, 301 s does not');
select is(array[pg_temp.merge_at(60, 149) ->> 'clientTripId', pg_temp.merge_at(60, 151) ->> 'clientTripId'],
  array['f0000000-0000-4000-8000-000000000006', null], '149 m from the end merges, 151 m does not');

select pg_temp.drive('00000000-0000-0000-0000-000000000004', 'f0000000-0000-4000-8000-000000000007', now() - interval '20 minutes', 1500, 4, '[]');
select is((select abs(extract(epoch from ended_at - (now() + interval '5 minutes'))) < 0.01 from pg_temp.t('f0000000-0000-4000-8000-000000000007')), true, 'a clock up to 10 minutes ahead is taken as dated');
select is(private.drive_context('00000000-0000-0000-0000-000000000004', 'f0000000-0000-4000-8000-000000000008', now() + interval '2 days', (now() + interval '2 days')::date, 47.6, -122.3,
    now() + interval '2 days 30 minutes') -> 'version', '23'::jsonb, 'drive_context reads a future upload on the same clock (no error)');

-- ---------------------------------------------------------------------------
-- "Wasn't driving" and a report move the week's goals
-- ---------------------------------------------------------------------------
-- dan: three clean short drives this week (after the week's start, before now)
create temporary table w as select greatest(private.week_start(now()) + interval '1 minute', now() - interval '3 hours') as w0;
delete from public.trips where user_id = '00000000-0000-0000-0000-000000000004';
delete from public.weekly_challenges where user_id = '00000000-0000-0000-0000-000000000004';
select pg_temp.drive('00000000-0000-0000-0000-000000000004', 'd0000000-0000-4000-8000-000000000001', (select w0 from w), 120, 0.6, '[]');
select pg_temp.drive('00000000-0000-0000-0000-000000000004', 'd0000000-0000-4000-8000-000000000002', (select w0 from w) + interval '3 minutes', 120, 0.6, '[]');
select pg_temp.drive('00000000-0000-0000-0000-000000000004', 'd0000000-0000-4000-8000-000000000003', (select w0 from w) + interval '6 minutes', 120, 0.6,
  '[{"id":"d3000000-0000-4000-8000-000000000001","type":"hard_brake","at":30}]');
select is((select completed_at is null from public.weekly_challenges where user_id = '00000000-0000-0000-0000-000000000004' and template_id = 'clean'), true,
  'two clean drives and one with a hard brake: the clean goal is open');
select is((private.dispute_event('00000000-0000-0000-0000-000000000004', 'd0000000-0000-4000-8000-000000000003', 'd3000000-0000-4000-8000-000000000001', 'hazard')) ->> 'clean', 'true',
  'an accepted report makes the one-event drive clean');
select is((select completed_at is not null from public.weekly_challenges where user_id = '00000000-0000-0000-0000-000000000004' and template_id = 'clean'), true,
  'and checks the week''s clean goal');
select is((private.mark_not_driving('00000000-0000-0000-0000-000000000004', 'd0000000-0000-4000-8000-000000000002')) ->> 'notDrivingLeft', '1', '"Wasn''t driving" on one of the three');
select is((select completed_at is null from public.weekly_challenges where user_id = '00000000-0000-0000-0000-000000000004' and template_id = 'clean'), true,
  'unchecks the goal the drive had helped reach');

-- ---------------------------------------------------------------------------
-- reads: the summary, the profile, the export, the board
-- ---------------------------------------------------------------------------
create temporary table trend as select 82.1 - private.rating_as_of('00000000-0000-0000-0000-000000000001', now() - interval '7 days') as d;
grant select on trend to authenticated;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
create temporary table s as select public.get_my_summary() as s;
select is((select array(select jsonb_object_keys(s) order by 1) from s), array['achievements', 'challenges', 'not_driving_left', 'profile', 'progress'], 'the summary has no league');
select is((select (s -> 'progress') - 'rating_trend' from s),
  '{"safety_rating": 82.1, "ranked": true, "miles_90d": 56.00, "points": 0, "lifetime": 0, "level": 1, "level_floor": 0, "level_next": 250, "streak": 0, "at_risk": false, "next_mult": 1, "freezes": 0, "clean_run": 0, "freeze_progress": 0, "phone_free_run": 0, "clean_miles_30d": 0, "league_tier": "bronze", "miles_30d": 56.00}'::jsonb,
  'progress: the rating, ranked and the 90-day miles, plus the LEGACY literals an older build reads');
select is((select s -> 'progress' -> 'rating_trend' from s), (select to_jsonb(d) from trend),
  'the trend is the rating less the rating a week ago');
select is((select array_agg(c ->> 'id' order by c ->> 'id') from s, jsonb_array_elements(s -> 'challenges') c), array['clean', 'no_speeding', 'smooth'], 'this week''s three goals');
select is(public.get_profile('ava') - 'user_id' - 'scores' - 'achievements',
  '{"clan": null, "level": 1, "ranked": true, "streak": 0, "username": "ava", "league_tier": "bronze", "relationship": "self", "safety_rating": 82.1, "can_view_stats": true, "can_view_heatmap": true}'::jsonb,
  'the profile card keeps its LEGACY level, streak and tier literals');
select is((select array_agg(x ->> 'username' || '=' || coalesce(x ->> 'value', '-') || '/' || (x ->> 'rank') order by (x ->> 'rank')::int) from jsonb_array_elements(public.get_friends_board()) x),
  array['ava=82.1/1'], 'with no friends the board is the driver alone, by rating');
reset role;
insert into public.friendships (user_a, user_b) values ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002'), ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000003');
set local role authenticated;
select is((select array_agg(x ->> 'username' || '=' || coalesce(x ->> 'value', '-') order by (x ->> 'rank')::int) from jsonb_array_elements(public.get_friends_board()) x),
  array['cat=87.4', 'ava=82.1', 'ben=-'], 'the board ranks by Safety Rating; an unranked friend comes last with no value');
reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is((select array[e ->> 'format_version', ((e -> 'trips' -> 0) ? 'points_net')::text, ((e -> 'trips' -> 0) ? 'origin')::text] from (select public.export_account('00000000-0000-0000-0000-000000000001') as e) x),
  array['4', 'false', 'true'], 'the export is format 4: drives with how they started, without points');
reset role;

select * from finish();
rollback;
