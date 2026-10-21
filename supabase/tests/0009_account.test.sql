-- 0009_account: the export holds the account's own rows and nothing about anyone else; an
-- account delete cascades everywhere (clan leadership handed over) and the audit purge.
create extension if not exists pgtap with schema extensions;

begin;
select plan(18);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000001', 'a@example.com'),
  ('00000000-0000-0000-0000-000000000002', 'b@example.com');
update public.profiles set username = 'ava', onboarded_at = now(), league_eligible = true where id = '00000000-0000-0000-0000-000000000001';
update public.profiles set username = 'ben', onboarded_at = now(), league_eligible = true where id = '00000000-0000-0000-0000-000000000002';
insert into public.consents (user_id, kind, version) values ('00000000-0000-0000-0000-000000000001', 'terms_13_plus', '2026-10');
insert into public.devices (user_id, device_id, platform, push_token, live_activity_token) values ('00000000-0000-0000-0000-000000000001', 'device-aaaaaaaa', 'ios', 'ExponentPushToken[aaaaaaaaaaaa]', repeat('ab', 32));
insert into public.device_league_claims (device_id, user_id) values ('device-aaaaaaaa', '00000000-0000-0000-0000-000000000001');
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
insert into public.clans (id, name, banner, invite_code) values ('e0000000-0000-4000-8000-000000000001', 'Owls', 'navy', 'ABCDEFGH');
insert into public.clan_members (clan_id, user_id, role) values ('e0000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'leader'), ('e0000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000002', 'member');
insert into public.notification_prefs (user_id) values ('00000000-0000-0000-0000-000000000001');
insert into public.inbox (user_id, kind, payload, dedupe_key) values ('00000000-0000-0000-0000-000000000001', 'friend_request', '{"from_user_id":"00000000-0000-0000-0000-000000000002"}', 'friend_request:b'),
  -- the deleted user on the referenced side: B's inbox names A as the sender
  ('00000000-0000-0000-0000-000000000002', 'friend_request', '{"from_user_id":"00000000-0000-0000-0000-000000000001"}', 'friend_request:00000000-0000-0000-0000-000000000001');
insert into public.push_deliveries (inbox_id, user_id, token) values ((select id from public.inbox where user_id = '00000000-0000-0000-0000-000000000001'), '00000000-0000-0000-0000-000000000001', 'ExponentPushToken[aaaaaaaaaaaa]');
insert into public.rate_limits (user_id, key) values ('00000000-0000-0000-0000-000000000001', 'probe');
update public.progress set last_end_lat = 47.6, last_end_lng = -122.3, last_end_at = now() where user_id = '00000000-0000-0000-0000-000000000001';

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
  array['about', 'account', 'achievements', 'clan', 'consents', 'devices', 'event_disputes', 'exported_at', 'format', 'format_version', 'friends', 'inbox', 'notification_prefs', 'profile', 'progress', 'reports_made', 'trip_events', 'trips', 'weekly_challenges'],
  'with every section of the account''s own rows (no points ledger, no league results)');
select is((select e -> 'format_version' from ex), '4'::jsonb, 'format version 4');
select is((select position('00000000-0000-0000-0000-000000000002' in e::text) from ex), 0, 'nothing in it names the other user, not even the friend, the clanmate or the reported one');
select is((select position(repeat('ab', 32) in e::text) from ex), 0, 'nor the Live Activity push-to-start token');
select is((select e -> 'progress' ? 'last_end_lat' from ex), false, 'nor the merge-check end point');
select is((select position('ExponentPushToken' in e::text) from ex), 0, 'nor push tokens');
select is((select e -> 'friends' from ex), '{"count": 1, "blocked_count": 0, "incoming_requests": 0, "outgoing_requests": 0}'::jsonb, 'friends are counts');
select is((select (e -> 'clan') - 'joined_at' from ex), '{"name": "Owls", "role": "leader"}'::jsonb, 'the clan is this account''s membership and the name');
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
select is(pg_temp.tables_holding('00000000-0000-0000-0000-000000000001') @> array['trips', 'clan_members', 'devices', 'rate_limits', 'inbox'], true, 'before: the id is all over public, including another user''s inbox');
delete from auth.users where id = '00000000-0000-0000-0000-000000000001';
select is(pg_temp.tables_holding('00000000-0000-0000-0000-000000000001'), '{}'::text[], 'after: no table in public holds the id');
select is((select row(user_id, role)::text from public.clan_members), row('00000000-0000-0000-0000-000000000002'::uuid, 'leader')::text, 'the clanmate is the new leader');
select is((select count(*)::int from public.clans), 1, 'the clan survives');
select is((select count(*)::int from public.devices), 0, 'the device and its tokens are gone');
select is((select count(*)::int from public.trips), 0, 'the drives are gone');

select * from finish();
rollback;
