-- 0009_account: the export holds the account's own rows and nothing about anyone else; an
-- account delete cascades everywhere and the audit purge.
create extension if not exists pgtap with schema extensions;

begin;
select plan(16);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000001', 'a@example.com'),
  ('00000000-0000-0000-0000-000000000002', 'b@example.com');
update public.profiles set username = 'ava', onboarded_at = now(), league_eligible = true where id = '00000000-0000-0000-0000-000000000001';
update public.profiles set username = 'ben', onboarded_at = now(), league_eligible = true where id = '00000000-0000-0000-0000-000000000002';
insert into public.consents (user_id, kind, version) values ('00000000-0000-0000-0000-000000000001', 'terms_13_plus', '2026-10');
insert into public.devices (user_id, device_id, platform, push_token, live_activity_token) values ('00000000-0000-0000-0000-000000000001', 'device-aaaaaaaa', 'ios', 'ExponentPushToken[aaaaaaaaaaaa]', repeat('ab', 32));
insert into public.trips (id, user_id, client_trip_id, started_at, ended_at, local_day, league_week, tz, miles, night_miles, duration_s, scored, origin,
    slowdowns, speedups, turns, limit_s, moving_s)
  values ('d0000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', '11111111-1111-4111-8111-111111111111', now() - interval '1 hour', now() - interval '30 minutes', current_date,
    private.league_week(now()), 'America/New_York', 5, 0, 1800, true, 'auto', 10, 10, 5, 900, 1500);
insert into public.trip_events (trip_id, client_event_id, user_id, type, tier, started_at, duration_s)
  values ('d0000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', '00000000-0000-0000-0000-000000000001', 'hard_brake', 'minor', now() - interval '50 minutes', 2);
insert into public.event_disputes (trip_id, client_event_id, user_id, reason, status) values ('d0000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', '00000000-0000-0000-0000-000000000001', 'hazard', 'accepted');
insert into public.user_achievements (user_id, achievement_id) values ('00000000-0000-0000-0000-000000000001', 'first_drive');
insert into public.weekly_challenges (user_id, league_week, slot, template_id) values ('00000000-0000-0000-0000-000000000001', private.league_week(now()), 1, 'clean');
insert into public.friendships (user_a, user_b) values ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002');
insert into public.blocks (blocker_id, blocked_id) values ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001');
insert into public.reports (reporter_id, target_kind, target_id, reason) values ('00000000-0000-0000-0000-000000000001', 'user', '00000000-0000-0000-0000-000000000002', 'other');
insert into public.notification_prefs (user_id) values ('00000000-0000-0000-0000-000000000001');
insert into public.inbox (user_id, kind, payload, dedupe_key) values ('00000000-0000-0000-0000-000000000001', 'friend_request', '{"from_user_id":"00000000-0000-0000-0000-000000000002"}', 'friend_request:b'),
  -- the deleted user on the referenced side: B's inbox names A as the sender
  ('00000000-0000-0000-0000-000000000002', 'friend_request', '{"from_user_id":"00000000-0000-0000-0000-000000000001"}', 'friend_request:00000000-0000-0000-0000-000000000001');
insert into public.push_deliveries (inbox_id, user_id, token) values ((select id from public.inbox where user_id = '00000000-0000-0000-0000-000000000001'), '00000000-0000-0000-0000-000000000001', 'ExponentPushToken[aaaaaaaaaaaa]');
insert into public.rate_limits (user_id, key) values ('00000000-0000-0000-0000-000000000001', 'probe');

-- every table in public that holds the id (used after the delete)
create function pg_temp.tables_holding(p_needle text) returns text[] language plpgsql as $$
declare
  r record;
  v_found text[] := '{}';
  v_n int;
begin
  for r in select c.oid::regclass as rel from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' loop
    execute format('select count(*) from %s t where t::text like %L', r.rel, '%' || p_needle || '%') into v_n;
    if v_n > 0 then
      v_found := array_append(v_found, r.rel::text);
    end if;
  end loop;
  return v_found;
end $$;

-- ---------------------------------------------------------------------------
-- export
-- ---------------------------------------------------------------------------
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
create temporary table ex as select public.export_account('00000000-0000-0000-0000-000000000001') as e;
select is((select e ->> 'format' from ex), 'roadwise-export', 'the export document');
select is((select array_agg(k order by k) from ex, jsonb_object_keys(e) k),
  array['about', 'account', 'achievements', 'consents', 'devices', 'event_disputes', 'exported_at', 'format', 'format_version', 'friends', 'inbox', 'notification_prefs', 'profile', 'progress', 'reports_made', 'route_pool', 'trip_events', 'trips', 'weekly_challenges'],
  'with every section of the account''s own rows (no points ledger, no league results, no clan)');
select is((select e -> 'format_version' from ex), '6'::jsonb, 'format version 6 (0032: no clan key, no merged_into on a drive)');
select is((select position('00000000-0000-0000-0000-000000000002' in e::text) from ex), 0, 'nothing in it names the other user, not even the friend or the reported one');
select is((select position(repeat('ab', 32) in e::text) from ex), 0, 'nor the Live Activity push-to-start token');
select is((select e -> 'progress' ? 'last_end_lat' from ex), false, 'progress holds no end point (0032)');
select is((select position('ExponentPushToken' in e::text) from ex), 0, 'nor push tokens');
select is((select e -> 'friends' from ex), '{"count": 1, "blocked_count": 0, "incoming_requests": 0, "outgoing_requests": 0}'::jsonb, 'friends are counts');
select is((select array[(e -> 'trips' -> 0) ? 'merged_into', (e -> 'trips' -> 0) ? 'origin'] from ex), array[false, true], 'a drive is its own row: no merged_into (0032)');
select throws_ok($$ select public.export_account('00000000-0000-0000-0000-000000000009') $$, 'P0002', 'no such account', 'an unknown account');
select throws_ok($$ select public.purge_auth_audit('00000000-0000-0000-0000-000000000001', 'a@example.com') $$, '42501', 'account still exists', 'the audit purge refuses a live account');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select throws_ok($$ select public.export_account('00000000-0000-0000-0000-000000000001') $$, '42501', null, 'a client cannot export, not even itself (no execute grant)');
reset role;

-- ---------------------------------------------------------------------------
-- delete
-- ---------------------------------------------------------------------------
select is(pg_temp.tables_holding('00000000-0000-0000-0000-000000000001') @> array['trips', 'devices', 'rate_limits', 'inbox'], true, 'before: the id is all over public, including another user''s inbox');
delete from auth.users where id = '00000000-0000-0000-0000-000000000001';
select is(pg_temp.tables_holding('00000000-0000-0000-0000-000000000001'), '{}'::text[], 'after: no table in public holds the id');
select is((select count(*)::int from public.devices), 0, 'the device and its tokens are gone');
select is((select count(*)::int from public.trips), 0, 'the drives are gone');

select * from finish();
rollback;
