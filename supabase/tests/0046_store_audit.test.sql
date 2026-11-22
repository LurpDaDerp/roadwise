-- 0046_store_audit: rating_at sums each drive's events once (one materialized aggregate) and gives
-- the same answer on every call of a session, past the 5 after which a session may use a generic
-- plan; the new budgets (accept_terms 10 new versions a day, a stored version free;
-- set_notification_prefs 30 zones an hour, the stored zone free, an unknown zone answered so its
-- take stands; get_heatmap 60 a minute); take_auth_mail drops stale rows only after locking its own,
-- with the same answers; the hourly auth-mail purge (47 hours); a push token on one row only (an
-- iPhone reinstall under the same account, then a sign-out); the weekly recap's change is the stored
-- pair Home shows; the month's "Wasn't driving" count has its index.
create extension if not exists pgtap with schema extensions;

begin;
select plan(37);

-- 01 drives a lot; 02..11 a little; 01..11 each give the budgets a fresh account
insert into auth.users (id, email)
  select ('00000000-0000-0000-0000-0000000000' || lpad(g::text, 2, '0'))::uuid, 'u' || g || '@example.com' from generate_series(1, 11) g;

create function pg_temp.uid(p int) returns uuid language sql immutable as $$
  select ('00000000-0000-0000-0000-0000000000' || lpad(p::text, 2, '0'))::uuid $$;
grant execute on function pg_temp.uid(int) to authenticated;
create function pg_temp.as_user(p int) returns void language sql as $$
  select set_config('request.jwt.claims', '{"sub":"' || pg_temp.uid(p) || '","role":"authenticated"}', true) $$;
grant execute on function pg_temp.as_user(int) to authenticated;
create function pg_temp.taken(p int, p_key text) returns int language sql stable as $$
  select coalesce((select r.count from public.rate_limits r where r.user_id = pg_temp.uid(p) and r.key = p_key), 0) $$;
-- p_n of a budget already spent in the current window
create function pg_temp.spend(p int, p_key text, p_n int) returns void language sql as $$
  insert into public.rate_limits (user_id, key, window_start, count) values (pg_temp.uid(p), p_key, now(), p_n)
  on conflict (user_id, key) do update set window_start = now(), count = excluded.count $$;
-- a scored 20-minute 6-mile drive from p_start (New York) with p_events events, the kinds in turn
create function pg_temp.trip(p_user int, p_start timestamptz, p_events int default 0, p_poly text default '') returns uuid
language plpgsql as $$
declare
  v_id uuid;
begin
  insert into public.trips (user_id, client_trip_id, started_at, ended_at, local_day, league_week, tz, miles, night_miles, duration_s, scored,
      clean, slowdowns, speedups, turns, limit_s, moving_s, phone_s, polyline, scoring_version)
    values (pg_temp.uid(p_user), gen_random_uuid(), p_start, p_start + interval '20 minutes', (p_start at time zone 'America/New_York')::date,
      private.league_week(p_start), 'America/New_York', 6, 0, 1200, true, p_events = 0, 20, 20, 12, 700, 1000, 900, p_poly, 12)
    returning id into v_id;
  insert into public.trip_events (trip_id, client_event_id, user_id, type, tier, started_at, duration_s, measured)
    select v_id, gen_random_uuid(), pg_temp.uid(p_user), (array['hard_brake', 'hard_accel', 'hard_corner', 'speeding', 'phone_pickup', 'eyes_off'])[1 + g % 6],
      'moderate', p_start + make_interval(secs => g * 60), 2 + g % 5,
      case g % 6 when 3 then '{"overMphS": 60, "limitMph": 35}' when 4 then '{"maxSpeedMph": 30}' when 5 then '{"speedMph": 30}' else '{"peakG": 0.45}' end::jsonb
    from generate_series(1, p_events) g;
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- rating_at: each drive's events summed once, the same answer on every call
-- ---------------------------------------------------------------------------
select pg_temp.trip(1, now() - make_interval(hours => 30 * g), 6) from generate_series(1, 60) g;
select pg_temp.trip(k, now() - make_interval(days => g * 5), 2) from generate_series(2, 11) k, generate_series(1, 3) g;
analyze public.trips;
analyze public.trip_events;

select is((select array[p.prosecdef::text, array_to_string(p.proconfig, ','), p.provolatile::text,
      (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))::text]
    from pg_proc p where p.oid = 'private.rating_at(uuid, timestamptz)'::regprocedure),
  array['false', 'search_path=public', 's', 'false'], 'rating_at keeps its posture: invoker, stable, search_path pinned, closed to the API roles');
select ok((select p.prosrc ~ 'ev as materialized' from pg_proc p where p.oid = 'private.rating_at(uuid, timestamptz)'::regprocedure),
  'each drive''s event sums are one materialized aggregate, whatever plan the session uses');
-- 25 calls in this session, the busy driver every other one: past the fifth the session may plan
-- rating_at's statement generically
create function pg_temp.rating_calls() returns int language plpgsql as $$
declare
  v_first jsonb := private.rating_at(pg_temp.uid(1), now());
  v_same int := 0;
begin
  for i in 1..12 loop
    perform private.rating_at(pg_temp.uid(2 + i % 10), now());
    if private.rating_at(pg_temp.uid(1), now()) = v_first then
      v_same := v_same + 1;
    end if;
  end loop;
  return v_same;
end $$;
select is(pg_temp.rating_calls(), 12, 'the busy driver''s rating is the same on every later call as on the first');
select is((select (r ->> 'ranked')::boolean and (r ->> 'rating') is not null from (select private.rating_at(pg_temp.uid(1), now()) as r) x), true,
  'and it is a rating (360 mi, ranked)');

-- ---------------------------------------------------------------------------
-- accept_terms: 10 new versions a day, a stored version free
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.as_user(2);
select is((select count(*)::int from generate_series(1, 10) g, lateral (select public.accept_terms('v' || g) as r) x), 10, '10 new terms versions in a day');
select throws_ok($$ select public.accept_terms('v11') $$, '42501', 'too many requests', 'the 11th new version in a day is refused');
select lives_ok($$ select public.accept_terms('v3') $$, 'a version already stored is still accepted');
select throws_ok($$ select public.accept_terms('v 1') $$, '22023', 'version must be 1 to 32 characters', 'a bad version is refused as before');
reset role;
select is(array[pg_temp.taken(2, 'accept_terms'), (select count(*)::int from public.consents where user_id = pg_temp.uid(2))], array[10, 10],
  'the stored version took nothing, and the refused one stored nothing');

-- ---------------------------------------------------------------------------
-- set_notification_prefs: 30 zones an hour; the stored zone free; an unknown zone's take stands
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.as_user(3);
select is(public.set_notification_prefs(p_tz := 'America/Chicago') ->> 'tz', 'America/Chicago', 'a first zone is stored');
select is(public.set_notification_prefs(p_weekly_recap := false, p_tz := 'America/Chicago') ->> 'weekly_recap', 'false',
  'a save in the stored zone goes through');
reset role;
select is(pg_temp.taken(3, 'set_notification_tz'), 1, 'only the new zone took from the budget');
set local role authenticated;
select is(public.set_notification_prefs(p_social := false, p_tz := 'Mars/Olympus'),
  '{"code": "22023", "details": null, "hint": null, "message": "unknown time zone"}'::jsonb, 'an unknown zone is answered with PostgREST''s error body');
select is(current_setting('response.status', true), '400', 'and the 400 the raise gave');
reset role;
select is((select array[pg_temp.taken(3, 'set_notification_tz')::text, p.tz, p.social::text] from public.notification_prefs p where p.user_id = pg_temp.uid(3)),
  array['2', 'America/Chicago', 'true'], 'its take stands, and nothing is written');
select pg_temp.spend(3, 'set_notification_tz', 29);
set local role authenticated;
select is(public.set_notification_prefs(p_tz := 'Europe/Paris') ->> 'tz', 'Europe/Paris', 'the 30th zone in an hour');
select throws_ok($$ select public.set_notification_prefs(p_tz := 'Asia/Tokyo') $$, '42501', 'too many requests', 'the 31st is refused');
select is(public.set_notification_prefs(p_social := false, p_tz := 'Europe/Paris') ->> 'social', 'false', 'while saves in the stored zone still go through');
select throws_ok($$ select public.set_notification_prefs(p_quiet_start := '25:00', p_tz := 'Asia/Tokyo') $$, '22023', 'quiet hours must be HH:MM',
  'a bad time is still refused first');
reset role;

-- ---------------------------------------------------------------------------
-- get_heatmap: 60 a minute
-- ---------------------------------------------------------------------------
select pg_temp.trip(4, now() - interval '2 days', 0, 'poly-4');
set local role authenticated;
select pg_temp.as_user(4);
select is(public.get_heatmap(pg_temp.uid(4)), '[{"polyline": "poly-4"}]'::jsonb, 'the driver''s own heat map, as before');
reset role;
select is(pg_temp.taken(4, 'get_heatmap'), 1, 'takes one of the 60 a minute');
select pg_temp.spend(4, 'get_heatmap', 59);
set local role authenticated;
select lives_ok($$ select public.get_heatmap(pg_temp.uid(4)) $$, 'the 60th in a minute');
select throws_ok($$ select public.get_heatmap(pg_temp.uid(4)) $$, '42501', 'too many requests', 'the 61st is refused');
reset role;

-- ---------------------------------------------------------------------------
-- take_auth_mail: stale rows go after the call's own rows are locked; the hourly purge
-- ---------------------------------------------------------------------------
create function pg_temp.h(p text) returns bytea language sql immutable as $$ select extensions.digest(p, 'sha256') $$;
select ok((select position('auth_mail_window(p_ip_hash)' in p.prosrc) > 0
      and position('auth_mail_window(p_ip_hash)' in p.prosrc) < position('delete from private.auth_mail_sends' in p.prosrc)
    from pg_proc p where p.oid = 'private.take_auth_mail(bytea, bytea, bytea)'::regprocedure),
  'take_auth_mail drops stale rows only after it has locked its own');
insert into private.auth_mail_sends (key_hash, hour_start, hour_count, day_start, day_count) values
  (pg_temp.h('own@example.com'), now() - interval '3 days', 5, now() - interval '3 days', 10),
  (pg_temp.h('stale@example.com'), now() - interval '3 days', 1, now() - interval '3 days', 1),
  (pg_temp.h('old@example.com'), now() - interval '47 hours 30 minutes', 1, now() - interval '47 hours 30 minutes', 1),
  (pg_temp.h('recent@example.com'), now() - interval '46 hours', 1, now() - interval '46 hours', 1);
select is(private.take_auth_mail(pg_temp.h('own@example.com'), null, null), 'ok', 'a full inbox whose day ended long ago is mailed');
select is((select array[(hour_count, day_count)::text, (day_start = now())::text] from private.auth_mail_sends where key_hash = pg_temp.h('own@example.com')),
  array['(1,1)', 'true'], 'its windows start again from that mail, as when its row was dropped first');
select is((select count(*)::int from private.auth_mail_sends where key_hash = pg_temp.h('stale@example.com')), 0, 'and another stale row still goes with it');
select is((select array[schedule, command] from cron.job where jobname = 'auth-mail-purge'),
  array['25 * * * *', 'delete from private.auth_mail_sends where key_hash in (select key_hash from private.auth_mail_sends where day_start < now() - interval ''47 hours'' for update skip locked)'],
  'the purge runs hourly at :25');
select lives_ok((select command from cron.job where jobname = 'auth-mail-purge'), 'the purge runs');
select is((select array_agg(k order by k) from (values ('old'), ('recent')) v(k)
    where exists (select 1 from private.auth_mail_sends s where s.key_hash = pg_temp.h(v.k || '@example.com'))),
  array['recent'], 'a row whose day started over 47 hours ago is gone; one from 46 hours ago stays');

-- ---------------------------------------------------------------------------
-- register_device: a push token on one row only
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.as_user(5);
select public.register_device('install-one-0001', 'ios', 'ExponentPushToken[reinstall00001]');
-- the app deleted and installed again: a new install id, the same Expo token
select public.register_device('install-two-0002', 'ios', 'ExponentPushToken[reinstall00001]');
reset role;
select is((select array_agg(device_id || '=' || coalesce(push_token, '-') order by device_id) from public.devices where user_id = pg_temp.uid(5)),
  array['install-one-0001=-', 'install-two-0002=ExponentPushToken[reinstall00001]'], 'after a reinstall the token stays only on the new install');
set local role authenticated;
select public.register_device('install-two-0002', 'ios', 'ExponentPushToken[reinstall00001]');
reset role;
select is((select push_token from public.devices where user_id = pg_temp.uid(5) and device_id = 'install-two-0002'), 'ExponentPushToken[reinstall00001]',
  'registering the same install again keeps its token');
set local role authenticated;
select public.release_device('install-two-0002');
reset role;
select is((select count(*)::int from public.devices where push_token = 'ExponentPushToken[reinstall00001]'), 0,
  'so a sign-out there leaves no row that still pushes to the phone');

-- ---------------------------------------------------------------------------
-- the weekly recap: the stored rating less the stored rating a week before it
-- ---------------------------------------------------------------------------
-- 06 and 07 drove on Friday 10 July 2026 (New York); 06 had no rating a week before the recap's time,
-- but the last refresh stored one a week before it
select pg_temp.trip(6, timestamptz '2026-07-10 12:00 America/New_York');
select pg_temp.trip(7, timestamptz '2026-07-10 12:00 America/New_York');
update public.progress set safety_rating = 89.4, rating_week_ago = 87.1, ranked = true where user_id = pg_temp.uid(6);
update public.progress set safety_rating = 80, rating_week_ago = null, ranked = true where user_id = pg_temp.uid(7);
select is(private.produce_weekly_recaps(timestamptz '2026-07-12 18:30 America/New_York'), 2, 'both recaps go out at 18:30 on Sunday');
select is((select array[payload ->> 'rating', payload ->> 'rating_delta'] from public.inbox where user_id = pg_temp.uid(6) and kind = 'weekly_recap'),
  array['89.4', '2.3'], 'the change is the one Home shows: the stored rating less the stored rating a week before it');
select is((select array[payload ->> 'rating', payload ->> 'rating_delta'] from public.inbox where user_id = pg_temp.uid(7) and kind = 'weekly_recap'),
  array['80.0', null], 'with no stored rating a week before, no change (Home shows none)');

-- ---------------------------------------------------------------------------
-- the month's "Wasn't driving" count
-- ---------------------------------------------------------------------------
select has_index('public', 'trips', 'trips_user_not_driving_idx', array['user_id', 'not_driving_at'],
  'the month''s not-driving count reads the driver''s marked drives through their index');

select * from finish();
rollback;
