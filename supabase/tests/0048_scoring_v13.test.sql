-- 0048_scoring_v13: scoring version 13 agrees with packages/scoring to the digit (rating.test.ts
-- "speedingWeight", "weightedScore: the weighted harmonic mean" and "scoring v13: parity pins the
-- 0048 pgTAP stores too"): the weighted harmonic mean, speeding weighed against its limit (x
-- squared, capped at 5), Attention per watched second (drowsy 80, eyes off 40; the 3600 s prior at
-- 0.024 in the rating; the 3600 s floor in the drive score), Phone use on a drive over a fixed 240 s,
-- a full window through rating_at and each drive's score through wrapped_trips. category_score is gone; the new and replaced functions keep
-- their posture.
create extension if not exists pgtap with schema extensions;

begin;
select plan(29);
-- the scores travel in jsonb: read them back exactly (the test runner's session prints 15 digits)
set local extra_float_digits = 1;

-- ---------------------------------------------------------------------------
-- posture
-- ---------------------------------------------------------------------------
select hasnt_function('private', 'category_score', array['double precision', 'double precision', 'double precision'], 'private.category_score is gone');
select is((select count(*)::int from pg_proc p where p.proname = 'category_score'), 0, 'no category_score of any signature is left');
select is((select array[p.prosecdef::text, array_to_string(p.proconfig, ','), p.provolatile::text,
      (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))::text]
    from pg_proc p where p.oid = 'private.weighted_score(double precision, double precision, double precision, double precision, double precision, double precision)'::regprocedure),
  array['false', 'search_path=public', 'i', 'false'], 'weighted_score: invoker, immutable, search_path pinned, closed to the API roles');
select is((select array[p.prosecdef::text, array_to_string(p.proconfig, ','), p.provolatile::text,
      (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))::text]
    from pg_proc p where p.oid = 'private.rating_at(uuid, timestamptz)'::regprocedure),
  array['false', 'search_path=public', 's', 'false'], 'rating_at keeps its posture: invoker, stable, search_path pinned, closed to the API roles');
select ok((select p.prosrc ~ 'ev as materialized' from pg_proc p where p.oid = 'private.rating_at(uuid, timestamptz)'::regprocedure),
  'rating_at still sums each drive''s events in one materialized aggregate');
select is((select array_agg(p.proname::text || ':' || p.prosecdef::text || ':' || array_to_string(p.proconfig, ',') || ':' || p.provolatile::text
      || ':' || (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))::text order by p.proname)
    from pg_proc p where p.oid in ('private.speeding_weight(numeric, jsonb, text)'::regprocedure, 'private.attention_penalty_of(text)'::regprocedure,
      'private.attention_weight(text, numeric, jsonb)'::regprocedure, 'private.wrapped_trips(text, uuid)'::regprocedure)),
  array['attention_penalty_of:false:search_path=public:i:false', 'attention_weight:false:search_path=public:i:false',
    'speeding_weight:false:search_path=public:i:false', 'wrapped_trips:false:search_path=public:s:false'],
  'the replaced helpers keep their posture: invoker, search_path pinned, closed to the API roles');
select is((select count(*)::int from pg_proc p where p.pronamespace = 'private'::regnamespace
    and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))), 0,
  'no API role can execute anything in private');

-- ---------------------------------------------------------------------------
-- the weighted harmonic mean (scoring weightedScore)
-- ---------------------------------------------------------------------------
select is(private.weighted_score(95, 95, 95, null, 50, 95), 74.80314960629921::float8,
  'the handoff check: 95, 95, 95, Phone use 50, Speed 95, no Attention is 74.80314960629921 (the arithmetic mean would be 81.5)');
select is(array[private.weighted_score(90, 80, 70, 50, 40, 60), private.weighted_score(90, 80, 70, null, null, 60), private.weighted_score(100, 100, 100, 100, 100, 100)],
  array[55.22589345920432, 69.72332015810277, 100]::float8[], 'sum(w) / sum(w / s) in radar order, weights 1, 2, 1, 3, 3, 3');
select is(array[private.weighted_score(90, 0, 'NaN', -5, 'Infinity', 60), private.weighted_score(90, null, null, null, null, 60),
    private.weighted_score(null, null, null, null, null, null), private.weighted_score(null, 0, null, null, 'NaN', null)],
  array[65.45454545454545, 65.45454545454545, null, null]::float8[], 'a null, non-finite or non-positive score is left out of both sums; none scored is null');

-- ---------------------------------------------------------------------------
-- speeding against its limit (scoring speedingWeight)
-- ---------------------------------------------------------------------------
select is(array[private.speeding_weight(30, '{"overMphS": 150, "limitMph": 25}', 'moderate'), private.speeding_weight(30, '{"overMphS": 150, "limitMph": 35}', 'moderate'),
    private.speeding_weight(30, '{"overMphS": 150, "limitMph": 65}', 'moderate')],
  array[58.8, 30, 8.698224852071005]::float8[], 'the same 5 mph over for 30 s weighs more at a lower limit: 25 mph, 35 mph, 65 mph');
select is(array[private.speeding_weight(30, '{"overMphS": 150}', 'moderate'), private.speeding_weight(30, '{"overMphS": 150, "limitMph": 0}', 'moderate'),
    private.speeding_weight(30, '{"overMphS": 150, "limitMph": -5}', 'moderate'), private.speeding_weight(30, '{"overMphS": 150, "limitMph": "25"}', 'moderate'),
    private.speeding_weight(30, '{"overMphS": 150, "limitMph": null}', 'moderate')],
  array[30, 30, 30, 30, 30]::float8[], 'no usable limit (none, 0, negative, not a number) reads the 5 mph reference');
select is(array[private.speeding_weight(30, '{"overMphS": 150, "limitMph": 0.5}', 'moderate'), private.speeding_weight(1, '{"overMphS": 1000000, "limitMph": 1e-303}', 'severe'),
    private.speeding_weight(30, '{"overMphS": 150, "limitMph": 1}', 'moderate')],
  array[30, 25, 750]::float8[],
  'a limit under 1 mph reads the 5 mph reference (a near-zero one never overflows); 1 mph is a limit');
select is(array[private.speeding_weight(30, '{"limitMph": 25}', 'minor'), private.speeding_weight(30, '{"limitMph": 25}', 'moderate'), private.speeding_weight(30, '{"limitMph": 25}', 'severe'),
    private.speeding_weight(30, '{"limitMph": 65}', 'minor'), private.speeding_weight(30, '{"limitMph": 65}', 'moderate'), private.speeding_weight(30, '{"limitMph": 65}', 'severe')],
  array[9.407999999999998, 99.37199999999999, 338.688, 1.3917159763313607, 14.7, 50.10177514792898]::float8[],
  'an older event without overMphS reads its tier''s mean over (2, 6.5, 12) through the same formula');
select is(array[private.speeding_weight(10, '{"overMphS": 100000, "limitMph": 65}', 'severe'), private.speeding_weight(10, '{"overMphS": 1000, "limitMph": 25}', 'severe'),
    private.speeding_weight(10, '{"overMphS": 250, "limitMph": 35}', 'severe'), private.speeding_weight(10, '{"overMphS": 249, "limitMph": 35}', 'severe')],
  array[250, 250, 250, 248.00399999999996]::float8[], 'x is capped at 5 (25 a second): 25 over at 35 mph is the cap, just under it is not');
select is(array[private.speeding_weight(20, '{"overMphS": 110, "limitMph": 25}', 'moderate'), private.speeding_weight(40, '{"overMphS": 520, "limitMph": 65}', 'severe'),
    private.speeding_weight(15, '{"limitMph": 35}', 'moderate'), private.speeding_weight(12, '{"overMphS": 30}', 'minor'),
    private.event_weight_of('speeding', 'moderate', 30, '{"overMphS": 150, "limitMph": 25}')],
  array[47.43199999999999, 78.39999999999999, 25.35, 3, 58.8]::float8[], 'pin W''s speeding weights; event_weight_of reads the limit too');

-- ---------------------------------------------------------------------------
-- Attention per watched second
-- ---------------------------------------------------------------------------
select is(array[private.attention_penalty_of('eyes_off'), private.attention_penalty_of('drowsy'), private.attention_penalty_of('hard_brake')], array[40, 80, 0],
  'attention_penalty_of: eyes off 40, drowsy 80');
select is(array[private.attention_weight('drowsy', 5, '{"speedMph": 30}'), private.attention_weight('eyes_off', 5, '{"speedMph": 30}'),
    private.attention_weight('eyes_off', 6, '{"source": "dashcam", "speedMph": 38}'), private.attention_weight('drowsy', 9, '{"source": "dashcam", "speedMph": 62}')],
  array[80, 40, 60.8, 297.6]::float8[], 'attention_weight: a 5 s drowsy at 30 mph weighs 80, an eyes-off 40; pin W''s episodes');

-- ---------------------------------------------------------------------------
-- the drives: ava (01) pin W, ben (02) / cat (03) / dan (04) pin R, eve (05) pin F, fay (06) pin P3
-- ---------------------------------------------------------------------------
insert into auth.users (id, email)
  select ('00000000-0000-0000-0000-00000000000' || g)::uuid, 'u' || g || '@example.com' from generate_series(1, 6) g;

-- a scored drive an hour long, stored as it stands: p_start, its miles, counters, phone seconds and
-- DashPal seconds (moving, covered); its local day in September 2026 for wrapped_trips
create function pg_temp.trip(p_user int, p_client int, p_start timestamptz, p_miles numeric, p_slow int, p_up int, p_turns int, p_limit int, p_moving int,
  p_phone int, p_dc_moving int default 0, p_dc_covered int default 0) returns uuid
language plpgsql as $$
declare
  v_id uuid;
begin
  insert into public.trips (user_id, client_trip_id, started_at, ended_at, local_day, league_week, tz, miles, night_miles, duration_s, scored,
      n_events, clean, slowdowns, speedups, turns, limit_s, moving_s, phone_s, dashcam_moving_s, dashcam_covered_s, dashcam_synced, scoring_version)
    values (('00000000-0000-0000-0000-00000000000' || p_user)::uuid, ('c0000000-0000-4000-8000-0000000000' || lpad(p_client::text, 2, '0'))::uuid,
      p_start, p_start + interval '1 hour', date '2026-09-01' + p_client, private.league_week(p_start), 'America/Los_Angeles',
      p_miles, 0, 3600, true, 0, true, p_slow, p_up, p_turns, p_limit, p_moving, p_phone, p_dc_moving, p_dc_covered, p_dc_moving > 0, 13)
    returning id into v_id;
  return v_id;
end $$;
-- an event p_at seconds into drive p_client, with its id d0000000-...-0000000000NN
create function pg_temp.ev(p_client int, p_n int, p_type text, p_tier text, p_at int, p_dur numeric, p_measured jsonb, p_status text default 'active') returns void
language sql as $$
  insert into public.trip_events (trip_id, client_event_id, user_id, type, tier, started_at, duration_s, measured, status)
  select t.id, ('d0000000-0000-4000-8000-0000000000' || lpad(p_n::text, 2, '0'))::uuid, t.user_id, p_type, p_tier,
    t.started_at + make_interval(secs => p_at), p_dur, p_measured, p_status
  from public.trips t where t.client_trip_id = ('c0000000-0000-4000-8000-0000000000' || lpad(p_client::text, 2, '0'))::uuid
$$;
create function pg_temp.scores(p_user int) returns float8[] language sql stable as $$
  select array[(r ->> 'rating')::float8, (s ->> 'acceleration')::float8, (s ->> 'braking')::float8, (s ->> 'turning')::float8,
      (s ->> 'attention')::float8, (s ->> 'phone')::float8, (s ->> 'speed')::float8]
  from (select r, r -> 'scores' as s from (select private.rating_at(('00000000-0000-0000-0000-00000000000' || p_user)::uuid, now()) as r) y) x $$;
create function pg_temp.wrapped(p_user int) returns float8[] language sql stable as $$
  select array_agg(score order by started_at) from private.wrapped_trips('2026-09', ('00000000-0000-0000-0000-00000000000' || p_user)::uuid) $$;

-- pin W (ava). W1 an hour ago: 20 s at 25 mph a mean 5.5 over, a hard brake, a pickup, an eyes-off; DashPal watched 1500 of 1700 s
select pg_temp.trip(1, 1, now() - interval '1 hour', 12, 24, 22, 14, 1300, 1700, 1500, 1700, 1500);
select pg_temp.ev(1, 11, 'speeding', 'moderate', 300, 20, '{"overMphS": 110, "limitMph": 25}');
select pg_temp.ev(1, 12, 'hard_brake', 'minor', 400, 2, '{"peakG": 0.42}');
select pg_temp.ev(1, 13, 'phone_pickup', 'moderate', 500, 7, '{"speedMph": 28, "maxSpeedMph": 36.5}');
select pg_temp.ev(1, 14, 'eyes_off', 'severe', 600, 6, '{"source": "dashcam", "speedMph": 38}');
-- W2 3 days ago: 40 s at 65 mph, an older speeding with no overMphS at 35 mph, a drowsy, a hard start; watched 2000 of 2900 s
select pg_temp.trip(1, 2, now() - interval '3 days 2 hours', 30, 30, 30, 12, 2500, 2900, 2700, 2900, 2000);
select pg_temp.ev(2, 21, 'speeding', 'severe', 200, 40, '{"overMphS": 520, "limitMph": 65}');
select pg_temp.ev(2, 22, 'speeding', 'moderate', 900, 15, '{"limitMph": 35}');
select pg_temp.ev(2, 23, 'drowsy', 'severe', 1200, 9, '{"source": "dashcam", "speedMph": 62}');
select pg_temp.ev(2, 24, 'hard_accel', 'severe', 1300, 2, '{"peakG": 0.61}');
-- W3 20 days ago: two pickups, a sharp turn and a removed hard brake; no DashPal
select pg_temp.trip(1, 3, now() - interval '20 days', 9, 20, 20, 15, 900, 1100, 1000);
select pg_temp.ev(3, 31, 'phone_pickup', 'severe', 100, 25, '{"speedMph": 33, "maxSpeedMph": 41}');
select pg_temp.ev(3, 32, 'phone_pickup', 'moderate', 300, 4, '{"speedMph": 15}');
select pg_temp.ev(3, 33, 'hard_corner', 'minor', 500, 2, '{"peakG": 0.53}');
select pg_temp.ev(3, 34, 'hard_brake', 'severe', 600, 2, '{"peakG": 0.7}', 'removed');
-- W4 55 days ago, before phone tracking: a speeding with no limit and a hard brake without a peak
select pg_temp.trip(1, 4, now() - interval '55 days', 20, 35, 35, 20, 2000, 2400, 0);
select pg_temp.ev(4, 41, 'speeding', 'minor', 400, 12, '{"overMphS": 30}');
select pg_temp.ev(4, 42, 'hard_brake', 'severe', 800, 2, '{}');

select is(pg_temp.scores(1),
  array[78.9, 68.69727227258444, 75.91666720301164, 79.65581995980288, 69.28278917626614, 90.44662769010905, 86.31474611197726]::float8[],
  'pin W: 78.9 and every category to the digit, with speeding against its limit, DashPal events over watched seconds and pickups (scoring ratingAt)');
select is(private.rating_at('00000000-0000-0000-0000-000000000001', now()) - 'scores', '{"miles": 71.00, "rating": 78.9, "ranked": true}'::jsonb, 'pin W: ranked over 71 mi');
select is(pg_temp.wrapped(1), array[85, 74, 81, 84]::float8[], 'pin W: each drive''s Wrapped score is scoring driveScore''s (W4, W3, W2, W1)');
select private.refresh_rating('00000000-0000-0000-0000-000000000001');
select is((select row(safety_rating, ranked, miles_90d)::text from public.progress where user_id = '00000000-0000-0000-0000-000000000001'), row(78.9, true, 71.00)::text,
  'refresh_rating stores the v13 rating');

-- pin R: one 8-mi drive an hour ago with a 5 s episode at 30 mph half an hour in. ben: eyes off,
-- 1200 watched seconds; cat: drowsy, 1200 watched seconds; dan: drowsy, no DashPal seconds
select pg_temp.trip(2, 11, now() - interval '1 hour', 8, 15, 15, 9, 840, 1136, 0, 1200, 1200);
select pg_temp.ev(11, 51, 'eyes_off', 'severe', 1800, 5, '{"source": "dashcam", "speedMph": 30}');
select pg_temp.trip(3, 12, now() - interval '1 hour', 8, 15, 15, 9, 840, 1136, 0, 1200, 1200);
select pg_temp.ev(12, 52, 'drowsy', 'severe', 1800, 5, '{"source": "dashcam", "speedMph": 30}');
select pg_temp.trip(4, 13, now() - interval '1 hour', 8, 15, 15, 9, 840, 1136, 0);
select pg_temp.ev(13, 53, 'drowsy', 'severe', 1800, 5, '{"source": "dashcam", "speedMph": 30}');
select is(pg_temp.scores(2),
  array[86.3, 87.62886597938144, 87.62886597938144, 86.69623059866963, 83.7782340862423, null, 87.48261474269819]::float8[],
  'pin R: an eyes-off over 1200 watched seconds, Attention 83.7782340862423 with the prior');
select is((pg_temp.scores(2))[5], private.rate_score((40::float8 + 3600::float8 * 0.024::float8) / (1200::float8 + 3600::float8), 0.024::float8),
  'the prior: 3600 watched seconds at 0.024 per second');
select is(pg_temp.scores(3),
  array[85, 87.62886597938144, 87.62886597938144, 86.69623059866963, 79.6875, null, 87.48261474269819]::float8[],
  'pin R: a drowsy weighs 80, twice an eyes-off: Attention 79.6875');
select is(pg_temp.scores(4),
  array[87.4, 87.62886597938144, 87.62886597938144, 86.69623059866963, null, null, 87.48261474269819]::float8[],
  'pin R: no watched seconds, no Attention score, even with a DashPal event; the rating leaves it out');
select is(array[pg_temp.wrapped(2), pg_temp.wrapped(3), pg_temp.wrapped(4)], array[array[98], array[95], array[100]]::float8[],
  'pin R: the drive scores 98, 95, 100 (scoring driveScore)');

-- pin F (eve): one 3-mi drive with a 5 s eyes-off at 30 mph, watched 1800, 3600, 7200 and 0 seconds
select pg_temp.trip(5, 21, now() - interval '4 hours', 3, 6, 6, 4, 400, 500, 450, 1800, 1800);
select pg_temp.ev(21, 61, 'eyes_off', 'severe', 60, 5, '{"source": "dashcam", "speedMph": 30}');
select pg_temp.trip(5, 22, now() - interval '3 hours', 3, 6, 6, 4, 400, 500, 450, 3600, 3600);
select pg_temp.ev(22, 62, 'eyes_off', 'severe', 60, 5, '{"source": "dashcam", "speedMph": 30}');
select pg_temp.trip(5, 23, now() - interval '2 hours', 3, 6, 6, 4, 400, 500, 450, 7200, 7200);
select pg_temp.ev(23, 63, 'eyes_off', 'severe', 60, 5, '{"source": "dashcam", "speedMph": 30}');
select pg_temp.trip(5, 24, now() - interval '1 hour', 3, 6, 6, 4, 400, 500, 450);
select pg_temp.ev(24, 64, 'eyes_off', 'severe', 60, 5, '{"source": "dashcam", "speedMph": 30}');
select is(pg_temp.wrapped(5), array[98, 98, 99, 100]::float8[],
  'pin F: a drive''s Attention reads at least 3600 watched seconds (1800 and 3600 both 98, 7200 is 99); none watched leaves it out (scoring driveScore)');

-- pin P3 (fay): Phone use on a drive reads a fixed 240 s (scoring PHONE_DRIVE_REF_S), whatever the
-- drive's phone seconds or seconds in hand. 20-minute drives (1200 s at driving speed) unless noted:
-- one 20 s pickup at 30 mph; three; 300 s in hand; one 20 s pickup on an hour (3600 s); a 5 s pickup
-- with no speed on a drive with no phone seconds; 240 s at 30 mph plus 600 s at 10 mph (no count term,
-- so the slow extra pickup lowers the score)
select pg_temp.trip(6, 5, now() - interval '6 hours', 10, 25, 25, 15, 1100, 1200, 1200);
select pg_temp.ev(5, 70, 'phone_pickup', 'severe', 60, 20, '{"speedMph": 30, "maxSpeedMph": 30}');
select pg_temp.trip(6, 6, now() - interval '5 hours', 10, 25, 25, 15, 1100, 1200, 1200);
select pg_temp.ev(6, 71, 'phone_pickup', 'severe', 60, 20, '{"speedMph": 30, "maxSpeedMph": 30}');
select pg_temp.ev(6, 72, 'phone_pickup', 'severe', 300, 20, '{"speedMph": 30, "maxSpeedMph": 30}');
select pg_temp.ev(6, 73, 'phone_pickup', 'severe', 600, 20, '{"speedMph": 30, "maxSpeedMph": 30}');
select pg_temp.trip(6, 7, now() - interval '4 hours', 10, 25, 25, 15, 1100, 1200, 1200);
select pg_temp.ev(7, 74, 'phone_pickup', 'severe', 60, 300, '{"speedMph": 30, "maxSpeedMph": 30}');
select pg_temp.trip(6, 8, now() - interval '3 hours', 30, 75, 75, 45, 3300, 3600, 3600);
select pg_temp.ev(8, 75, 'phone_pickup', 'severe', 60, 20, '{"speedMph": 30, "maxSpeedMph": 30}');
select pg_temp.trip(6, 9, now() - interval '2 hours', 10, 25, 25, 15, 1100, 1200, 0);
select pg_temp.ev(9, 76, 'phone_pickup', 'moderate', 60, 5, '{}');
select pg_temp.trip(6, 10, now() - interval '1 hour', 10, 25, 25, 15, 1100, 1200, 1200);
select pg_temp.ev(10, 77, 'phone_pickup', 'severe', 60, 240, '{"speedMph": 30, "maxSpeedMph": 30}');
select pg_temp.ev(10, 78, 'phone_pickup', 'severe', 600, 600, '{"speedMph": 10, "maxSpeedMph": 10}');
select is(pg_temp.wrapped(6), array[86, 67, 37, 86, 92, 29]::float8[],
  'pin P3: Phone use on a drive is the pickups'' weight over a fixed 240 s, no floor and no count term (scoring driveScore)');

select * from finish();
rollback;
