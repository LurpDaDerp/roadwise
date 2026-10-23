-- the rating's cost at scale: a driver with 3,000 back-dated drives (and about 9,000 events) in the
-- 90-day window. private.rating_at agrees to the digit with the per-drive loop it replaced (kept
-- here as the reference, with Phone use since 0026 and the 0028 weights), get_profile reads the rating once, and
-- get_my_summary reads the stored week-ago rating instead of computing one. The timings print as a
-- diag line.
create extension if not exists pgtap with schema extensions;

begin;
select plan(9);
-- the scores travel in jsonb: read them back exactly
set local extra_float_digits = 1;

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1', 'perf@example.com');
update public.profiles set username = 'perf', onboarded_at = now() where id = '00000000-0000-0000-0000-0000000000a1';

-- the reference: the rating as a per-drive loop with correlated sums (scoring ratingAt, drive by drive)
create function pg_temp.rating_at_ref(p_user uuid, p_at timestamptz) returns jsonb
language plpgsql stable as $$
declare
  r record;
  w float8;
  v_miles numeric := 0;
  bw float8 := 0; bo float8 := 0; aw float8 := 0; ao float8 := 0; tw float8 := 0; tow float8 := 0; sw float8 := 0; so float8 := 0;
  pw float8 := 0; po float8 := 0;
  ap float8 := 0; am float8 := 0;
  s_b float8; s_a float8; s_t float8; s_s float8; s_att float8; s_p float8;
  v_num float8; v_den float8;
begin
  for r in
    select t.miles, t.started_at, t.slowdowns, t.speedups, t.turns, t.limit_s, t.phone_s,
      case when t.miles > 0 and t.dashcam_moving_s > 0 and t.dashcam_covered_s > 0
           then t.miles::float8 * least(t.dashcam_covered_s, t.dashcam_moving_s)::float8 / t.dashcam_moving_s::float8
           else 0::float8 end as watched,
      coalesce((select sum(private.event_weight_of(e.type, e.tier, e.duration_s, e.measured) order by e.started_at, e.client_event_id)
                from public.trip_events e where e.trip_id = t.id and e.status = 'active' and e.type = 'hard_brake'), 0::float8) as b_w,
      (select count(*) from public.trip_events e where e.trip_id = t.id and e.status = 'active' and e.type = 'hard_brake') as b_n,
      coalesce((select sum(private.event_weight_of(e.type, e.tier, e.duration_s, e.measured) order by e.started_at, e.client_event_id)
                from public.trip_events e where e.trip_id = t.id and e.status = 'active' and e.type = 'hard_accel'), 0::float8) as a_w,
      (select count(*) from public.trip_events e where e.trip_id = t.id and e.status = 'active' and e.type = 'hard_accel') as a_n,
      coalesce((select sum(private.event_weight_of(e.type, e.tier, e.duration_s, e.measured) order by e.started_at, e.client_event_id)
                from public.trip_events e where e.trip_id = t.id and e.status = 'active' and e.type = 'hard_corner'), 0::float8) as t_w,
      (select count(*) from public.trip_events e where e.trip_id = t.id and e.status = 'active' and e.type = 'hard_corner') as t_n,
      coalesce((select sum(private.event_weight_of(e.type, e.tier, e.duration_s, e.measured) order by e.started_at, e.client_event_id)
                from public.trip_events e where e.trip_id = t.id and e.status = 'active' and e.type = 'speeding'), 0::float8) as s_w,
      coalesce((select sum(greatest(1::float8, greatest(0::float8, e.duration_s::float8)) order by e.started_at, e.client_event_id)
                from public.trip_events e where e.trip_id = t.id and e.status = 'active' and e.type = 'speeding'), 0::float8) as s_n,
      coalesce((select sum(private.event_weight_of(e.type, e.tier, e.duration_s, e.measured) order by e.started_at, e.client_event_id)
                from public.trip_events e where e.trip_id = t.id and e.status = 'active' and e.type = 'phone_pickup'), 0::float8) as p_w,
      coalesce((select sum(least(43200::float8, greatest(0::float8, e.duration_s::float8)) order by e.started_at, e.client_event_id)
                from public.trip_events e where e.trip_id = t.id and e.status = 'active' and e.type = 'phone_pickup'), 0::float8) as p_n,
      coalesce((select sum(private.attention_weight(e.type, e.duration_s, e.measured) order by e.started_at, e.client_event_id)
                from public.trip_events e where e.trip_id = t.id and e.status = 'active' and e.type in ('eyes_off', 'drowsy')), 0::float8) as att
    from public.trips t
    where t.user_id = p_user and t.scored and not t.not_driving and t.merged_into is null
      and t.started_at > p_at - interval '2160 hours' and t.started_at <= p_at
    order by t.started_at, t.client_trip_id
  loop
    w := private.recency_weight(floor(extract(epoch from (p_at - r.started_at)) / 86400)::int);
    v_miles := v_miles + greatest(r.miles, 0);
    bw := bw + w * r.b_w;  bo := bo + w * greatest(coalesce(r.slowdowns, 0), r.b_n)::float8;
    aw := aw + w * r.a_w;  ao := ao + w * greatest(coalesce(r.speedups, 0), r.a_n)::float8;
    tw := tw + w * r.t_w;  tow := tow + w * greatest(coalesce(r.turns, 0), r.t_n)::float8;
    sw := sw + w * r.s_w;  so := so + w * greatest(coalesce(r.limit_s, 0)::float8, r.s_n);
    pw := pw + w * r.p_w;  po := po + w * greatest(coalesce(r.phone_s, 0)::float8, r.p_n);
    ap := ap + w * r.att;  am := am + w * r.watched;
  end loop;
  if v_miles <= 0 then
    return jsonb_build_object('rating', null, 'ranked', false, 'miles', 0, 'scores', jsonb_build_object(
      'acceleration', null, 'braking', null, 'turning', null, 'attention', null, 'phone', null, 'speed', null));
  end if;
  s_b := private.rate_score((bw + 60::float8 * 0.010::float8) / (bo + 60::float8), 0.010::float8);
  s_a := private.rate_score((aw + 60::float8 * 0.008::float8) / (ao + 60::float8), 0.008::float8);
  s_t := private.rate_score((tw + 60::float8 * 0.008::float8) / (tow + 60::float8), 0.008::float8);
  s_s := private.rate_score((sw + 3600::float8 * 0.040::float8) / (so + 3600::float8), 0.040::float8);
  s_p := case when po > 0 then private.rate_score((pw + 3600::float8 * 0.040::float8) / (po + 3600::float8), 0.040::float8) end;
  s_att := case when am > 0 then private.category_score(ap, am, 10) end;
  v_num := 1::float8 * s_a + 1::float8 * s_b + 1::float8 * s_t + coalesce(1::float8 * s_att, 0::float8) + coalesce(2::float8 * s_p, 0::float8) + 2::float8 * s_s;
  v_den := (1 + 1 + 1 + case when s_att is null then 0 else 1 end + case when s_p is null then 0 else 2 end + 2)::float8;
  return jsonb_build_object(
    'rating', round(private.round_half_up(least(100::float8, greatest(0::float8, v_num / v_den)), 1)::numeric, 1),
    'ranked', v_miles >= 10, 'miles', v_miles,
    'scores', jsonb_build_object('acceleration', s_a, 'braking', s_b, 'turning', s_t, 'attention', s_att, 'phone', s_p, 'speed', s_s));
end $$;

-- the best of p_n runs of p_sql, in milliseconds, as EXPLAIN ANALYZE times it (a monotonic clock,
-- so a step in the container's wall clock cannot skew it)
create function pg_temp.best_ms(p_sql text, p_n int default 3) returns float8 language plpgsql as $$
declare
  v_plan json;
  v_ms float8;
  v_best float8;
begin
  for i in 1..p_n loop
    execute 'explain (analyze, timing off, format json) ' || p_sql into v_plan;
    v_ms := (v_plan -> 0 ->> 'Execution Time')::float8;
    v_best := least(coalesce(v_best, v_ms), v_ms);
  end loop;
  return v_best;
end $$;

-- 3,000 drives over the window (pairs share a start, so the drive order falls to client_trip_id), a
-- few unscored, "not driving" or merged away, every fifth one watched by DashPal
create temporary table g as
  select i, md5('trip-' || i)::uuid as cid, now() - make_interval(secs => (i / 2) * 5180 + 30) as st,
    round((0.4 + (i % 37) * 0.73)::numeric, 2) as mi, 300 + (i % 50) * 60 as dur
  from generate_series(1, 3000) i;
insert into public.trips (user_id, client_trip_id, started_at, ended_at, local_day, league_week, tz, miles, night_miles, duration_s,
    scored, not_driving, slowdowns, speedups, turns, limit_s, moving_s, phone_s, dashcam_moving_s, dashcam_covered_s)
  select '00000000-0000-0000-0000-0000000000a1', g.cid, g.st, g.st + make_interval(secs => g.dur), g.st::date, private.league_week(g.st), 'America/New_York',
    g.mi, 0, g.dur, g.i % 41 <> 0, g.i % 53 = 0, g.i % 20, (g.i * 7) % 17, (g.i * 3) % 13,
    floor(g.dur * 0.8 * (g.i % 5) * 0.2)::int, floor(g.dur * 0.8)::int,
    case when g.i % 3 = 0 then floor(g.dur * 0.6 * (g.i % 4) * 0.25)::int else 0 end,
    case when g.i % 5 = 0 then floor(g.dur * 0.8)::int else 0 end, case when g.i % 5 = 0 then floor(g.dur * 0.56)::int else 0 end
  from g;
update public.trips t set merged_into = (select x.id from public.trips x where x.client_trip_id = md5('trip-1')::uuid)
  where t.client_trip_id in (select cid from g where i % 59 = 0);
-- and some the window leaves out: older than 90 days, the edge itself, and ahead of now
insert into public.trips (user_id, client_trip_id, started_at, ended_at, local_day, league_week, tz, miles, night_miles, duration_s,
    scored, slowdowns, speedups, turns, limit_s, moving_s)
  select '00000000-0000-0000-0000-0000000000a1', md5('out-' || k)::uuid, s, s + interval '20 minutes', s::date, private.league_week(s), 'America/New_York',
    5, 0, 1200, true, 9, 9, 6, 600, 900
  from generate_series(1, 22) k
  cross join lateral (select case when k <= 20 then now() - interval '2160 hours' - make_interval(hours => k - 1)
                                  else now() + make_interval(hours => k - 20) end as s) x;
-- 0 to 6 events a drive, every type and tier, some removed, some starting together (event order
-- falls to client_event_id), speeding with and without a measured overMphS, hard events with and
-- without a peak, DashPal events at a speed and a length
insert into public.trip_events (trip_id, client_event_id, user_id, type, tier, started_at, duration_s, measured, status)
  select t.id, md5('ev-' || g.i || '-' || k)::uuid, t.user_id,
    (array['hard_brake', 'hard_accel', 'hard_corner', 'speeding', 'phone_pickup', 'eyes_off', 'drowsy'])[1 + (g.i + k) % 7],
    case when (g.i + k) % 7 >= 5 then 'severe'
         when (g.i + k) % 7 = 4 then case when 1 + (g.i * k) % 40 > 15 then 'severe' else 'moderate' end
         else (array['minor', 'moderate', 'severe'])[1 + (g.i * k) % 3] end,
    t.started_at + make_interval(secs => case when g.i % 4 = 0 and k = 3 then 60 else k * 30 end),
    case when (g.i + k) % 7 = 3 then 3.5 + (g.i * k) % 90 when (g.i + k) % 7 = 4 then 1 + (g.i * k) % 40
         when (g.i + k) % 7 >= 5 then 0.5 + (g.i * k) % 23 else 1.5 end,
    case when (g.i + k) % 7 = 3 and (g.i + k) % 4 <> 0 then jsonb_build_object('overMphS', (g.i * k) % 400 + 0.25)
         when (g.i + k) % 7 = 4 then jsonb_build_object('speedMph', 20 + (g.i * k) % 30, 'maxSpeedMph', 25 + (g.i * k) % 30)
         when (g.i + k) % 7 < 3 and (g.i + k) % 3 <> 0 then jsonb_build_object('peakG', 0.3 + ((g.i * k) % 37) * 0.01)
         when (g.i + k) % 7 >= 5 then jsonb_build_object('source', 'dashcam', 'speedMph', 10 + (g.i * k) % 70)
         else '{}'::jsonb end,
    case when (g.i * 3 + k) % 11 = 0 then 'removed' else 'active' end
  from g join public.trips t on t.client_trip_id = g.cid and t.user_id = '00000000-0000-0000-0000-0000000000a1'
  cross join lateral generate_series(1, g.i % 7) k;
analyze public.trips;
analyze public.trip_events;
select private.refresh_rating('00000000-0000-0000-0000-0000000000a1');

-- ---------------------------------------------------------------------------
-- the set-based rating is the per-drive loop, to the digit
-- ---------------------------------------------------------------------------
select is((select array[s ->> 'attention' is not null, s ->> 'phone' is not null] from (select private.rating_at('00000000-0000-0000-0000-0000000000a1', now()) -> 'scores' as s) x),
  array[true, true], 'the data scores every category, Attention and Phone use included');
select is(private.rating_at('00000000-0000-0000-0000-0000000000a1', now()), pg_temp.rating_at_ref('00000000-0000-0000-0000-0000000000a1', now()),
  '3,000 drives: the rating and every category equal the per-drive loop, to the digit');
select is(private.rating_at('00000000-0000-0000-0000-0000000000a1', now() - interval '7 days'), pg_temp.rating_at_ref('00000000-0000-0000-0000-0000000000a1', now() - interval '7 days'),
  'and a week ago');
select is(private.rating_at('00000000-0000-0000-0000-0000000000a1', now() - interval '45 days 3 hours'), pg_temp.rating_at_ref('00000000-0000-0000-0000-0000000000a1', now() - interval '45 days 3 hours'),
  'and 45 days ago');
select is(private.rating_at('00000000-0000-0000-0000-0000000000a1', now() + interval '3 hours'), pg_temp.rating_at_ref('00000000-0000-0000-0000-0000000000a1', now() + interval '3 hours'),
  'and three hours ahead (the drives dated ahead of now count)');

-- ---------------------------------------------------------------------------
-- the cost
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
create temporary table ms as select
  pg_temp.best_ms($q$ select private.rating_at('00000000-0000-0000-0000-0000000000a1', now()) $q$) as rating_at,
  pg_temp.best_ms($q$ select public.get_profile('perf') $q$) as get_profile,
  pg_temp.best_ms($q$ select public.get_my_summary() $q$) as get_my_summary;
select diag(format('3,000 drives, %s events: rating_at %s ms, get_profile %s ms, get_my_summary %s ms',
    (select count(*) from public.trip_events where user_id = '00000000-0000-0000-0000-0000000000a1'),
    round(rating_at::numeric, 1), round(get_profile::numeric, 1), round(get_my_summary::numeric, 1)))
  from ms;
select cmp_ok(get_profile, '<', 500::float8, 'get_profile on 3,000 drives answers well under half a second') from ms;
select cmp_ok(get_profile, '<', 2 * rating_at + 50, 'get_profile computes the rating once, not once per score it reads') from ms;
select cmp_ok(get_my_summary, '<', 500::float8, 'get_my_summary on 3,000 drives answers well under half a second') from ms;
select cmp_ok(get_my_summary, '<', rating_at / 4, 'get_my_summary computes no rating (the week-ago rating is stored when ratings refresh)') from ms;

select * from finish();
rollback;
