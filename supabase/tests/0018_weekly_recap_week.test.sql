-- 0018_weekly_recap_week: the recap names the week that ends on the driver's local Sunday, even
-- where 18:00 Sunday is already Monday in New York (Hawaii in summer).
create extension if not exists pgtap with schema extensions;

begin;
select plan(7);

insert into auth.users (id, email) values ('00000000-0000-0000-0000-000000000001', 'a@example.com');
-- a Honolulu driver: Friday 10 July 2026 and Sunday 12 July 2026, local
insert into public.trips (user_id, client_trip_id, started_at, ended_at, local_day, league_week, tz, miles, night_miles, duration_s, scored, clean,
    slowdowns, speedups, turns, limit_s, moving_s)
  select '00000000-0000-0000-0000-000000000001', gen_random_uuid(), s, s + interval '20 minutes', (s at time zone 'Pacific/Honolulu')::date,
    private.league_week(s), 'Pacific/Honolulu', 5, 0, 1200, true, true, 10, 10, 5, 600, 1000
  from (values (timestamptz '2026-07-10 09:00 Pacific/Honolulu'), (timestamptz '2026-07-12 14:00 Pacific/Honolulu')) v(s);
insert into public.weekly_challenges (user_id, league_week, slot, template_id, completed_at) values
  ('00000000-0000-0000-0000-000000000001', '2026-W28', 1, 'clean', timestamptz '2026-07-12 14:30 Pacific/Honolulu'),
  ('00000000-0000-0000-0000-000000000001', '2026-W28', 2, 'smooth', null),
  ('00000000-0000-0000-0000-000000000001', '2026-W28', 3, 'no_speeding', null);

select is(private.league_week(timestamptz '2026-07-12 18:30 Pacific/Honolulu'), '2026-W29', 'Sunday 18:30 in Honolulu is already next week in New York');
select is(private.produce_weekly_recaps(timestamptz '2026-07-12 18:30 Pacific/Honolulu'), 1, 'the recap goes out at 18:xx on the local Sunday');
select is((select array[payload ->> 'week', dedupe_key] from public.inbox where user_id = '00000000-0000-0000-0000-000000000001'), array['2026-W28', 'weekly_recap:2026-W28'],
  'it names the week ending that Sunday');
select is((select payload - 'week' from public.inbox where user_id = '00000000-0000-0000-0000-000000000001'),
  '{"drives": 2, "rating": null, "goals_done": 1, "rating_delta": null}'::jsonb, 'with that week''s drives and goals done, and no rating while unranked (nothing about points)');
select is((select array(select jsonb_object_keys(payload) order by 1) from public.inbox where user_id = '00000000-0000-0000-0000-000000000001'),
  array['drives', 'goals_done', 'rating', 'rating_delta', 'week'], 'the payload holds exactly those keys');
select is(private.produce_weekly_recaps(timestamptz '2026-07-12 17:30 Pacific/Honolulu'), 0, 'not before 18:00 local');
-- a week whose only drive was marked as not driving has nothing true to say
delete from public.inbox;
update public.trips set not_driving = true, not_driving_at = now() where user_id = '00000000-0000-0000-0000-000000000001';
select is(private.produce_weekly_recaps(timestamptz '2026-07-12 18:30 Pacific/Honolulu'), 0, 'a week with no kept scored drive gets no recap');

select * from finish();
rollback;
