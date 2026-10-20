-- 0018_weekly_recap_week: the recap names the week that ends on the driver's local Sunday, even
-- where 18:00 Sunday is already Monday in New York (Hawaii in summer).
create extension if not exists pgtap with schema extensions;

begin;
select plan(5);

insert into auth.users (id, email) values ('00000000-0000-0000-0000-000000000001', 'a@example.com');
-- a Honolulu driver: Friday 10 July 2026 and Sunday 12 July 2026, local
insert into public.trips (user_id, client_trip_id, started_at, ended_at, local_day, league_week, tz, miles, safe_miles, night_miles, duration_s, scored, points_net, clean)
  select '00000000-0000-0000-0000-000000000001', gen_random_uuid(), s, s + interval '20 minutes', (s at time zone 'Pacific/Honolulu')::date,
    private.league_week(s), 'Pacific/Honolulu', 5, 5, 0, 1200, true, n, true
  from (values (timestamptz '2026-07-10 09:00 Pacific/Honolulu', 60), (timestamptz '2026-07-12 14:00 Pacific/Honolulu', 40)) v(s, n);

select is(private.league_week(timestamptz '2026-07-12 18:30 Pacific/Honolulu'), '2026-W29', 'Sunday 18:30 in Honolulu is already next week in New York');
select is(private.produce_weekly_recaps(timestamptz '2026-07-12 18:30 Pacific/Honolulu'), 1, 'the recap goes out at 18:xx on the local Sunday');
select is((select array[payload ->> 'week', dedupe_key] from public.inbox where user_id = '00000000-0000-0000-0000-000000000001'), array['2026-W28', 'weekly_recap:2026-W28'],
  'it names the week ending that Sunday');
select is((select array[payload ->> 'drives', payload ->> 'week_points', payload ->> 'best_drive_net'] from public.inbox where user_id = '00000000-0000-0000-0000-000000000001'),
  array['2', '100', '60'], 'with that week''s drives, points and best drive');
select is(private.produce_weekly_recaps(timestamptz '2026-07-12 17:30 Pacific/Honolulu'), 0, 'not before 18:00 local');

select * from finish();
rollback;
