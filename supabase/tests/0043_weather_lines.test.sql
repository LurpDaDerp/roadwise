-- 0043_weather_lines: a hard event weighs (peak / the line it was judged at)^2 between 1 and 4, the
-- line being its measured lineG held between its type's snow line (0.29 g brake, 0.32 g start,
-- 0.38 g turn) and its dry line (0.36, 0.40, 0.48), agreeing with packages/scoring (rating.test.ts
-- hardEventWeight) to the digit. Without a numeric lineG it gives 0040's answers exactly; without a
-- peak, the tier's 1 or 2. The function still runs as its caller, pins search_path and is closed to
-- the API roles.
create extension if not exists pgtap with schema extensions;

begin;
select plan(7);
set local extra_float_digits = 1;

select is(array[private.hard_event_weight('hard_brake', 'minor', '{"peakG": 0.36, "lineG": 0.32}'),
    private.hard_event_weight('hard_brake', 'minor', '{"peakG": 0.36, "lineG": 0.29}'),
    private.hard_event_weight('hard_brake', 'minor', '{"peakG": 0.33, "lineG": 0.32}'),
    private.hard_event_weight('hard_brake', 'severe', '{"peakG": 0.45, "lineG": 0.32}'),
    private.hard_event_weight('hard_accel', 'minor', '{"peakG": 0.4, "lineG": 0.36}'),
    private.hard_event_weight('hard_accel', 'minor', '{"peakG": 0.4, "lineG": 0.32}'),
    private.hard_event_weight('hard_corner', 'minor', '{"peakG": 0.5, "lineG": 0.43}'),
    private.hard_event_weight('hard_corner', 'minor', '{"peakG": 0.48, "lineG": 0.38}')],
  array[1.265625, 1.5410225921521998, 1.0634765625, 1.9775390625, 1.234567901234568, 1.5625, 1.3520822065981613, 1.595567867036011]::float8[],
  'at a wet or snow line, (peak / line)^2: the digits packages/scoring gives');
select is(array[private.hard_event_weight('hard_brake', 'minor', '{"peakG": 0.36, "lineG": 0.1}'),
    private.hard_event_weight('hard_accel', 'minor', '{"peakG": 0.4, "lineG": 0.2}'),
    private.hard_event_weight('hard_corner', 'minor', '{"peakG": 0.48, "lineG": 0.2}')],
  array[1.5410225921521998, 1.5625, 1.595567867036011]::float8[], 'a line under the band reads the snow line');
select is(array[private.hard_event_weight('hard_brake', 'minor', '{"peakG": 0.36, "lineG": 0.5}'),
    private.hard_event_weight('hard_accel', 'minor', '{"peakG": 0.5, "lineG": 0.9}'),
    private.hard_event_weight('hard_corner', 'minor', '{"peakG": 0.6, "lineG": 1}')],
  array[1, (0.5::float8 / 0.4::float8) * (0.5::float8 / 0.4::float8), (0.6::float8 / 0.48::float8) * (0.6::float8 / 0.48::float8)]::float8[],
  'a line over the band reads the dry line (a line only ever raises a weight)');
select is(array[private.hard_event_weight('hard_corner', 'severe', '{"peakG": 0.9, "lineG": 0.38}'),
    private.hard_event_weight('hard_brake', 'minor', '{"peakG": 0.3, "lineG": 0.32}'),
    private.hard_event_weight('hard_brake', 'severe', '{"lineG": 0.32}'), private.hard_event_weight('hard_brake', 'minor', '{"peakG": "x", "lineG": 0.32}')],
  array[4, 1, 2, 1]::float8[], 'still between 1 and 4; the tier without a peak');
-- 0040's cases, with no lineG and with one that is not a number: the same answers
select is(array[private.hard_event_weight('hard_brake', 'minor', '{"peakG": 0.36}'), private.hard_event_weight('hard_accel', 'minor', '{"peakG": 0.4}'),
    private.hard_event_weight('hard_corner', 'minor', '{"peakG": 0.48}'), private.hard_event_weight('hard_brake', 'severe', '{"peakG": 0.55}'),
    private.hard_event_weight('hard_accel', 'minor', '{"peakG": 0.5}'), private.hard_event_weight('hard_corner', 'minor', '{"peakG": 0.6}'),
    private.hard_event_weight('hard_brake', 'minor', '{"peakG": 0.45}'), private.hard_event_weight('hard_accel', 'severe', '{"peakG": 0.8}'),
    private.hard_event_weight('hard_corner', 'severe', '{"peakG": 0.96}'), private.hard_event_weight('hard_corner', 'minor', '{"peakG": 0.4}'),
    private.hard_event_weight('hard_accel', 'minor', '{"peakG": 0.32}'), private.hard_event_weight('hard_brake', 'severe', '{}'),
    private.hard_event_weight('hard_brake', 'minor', '{"peakG": "x"}'), private.hard_event_weight('hard_brake', 'minor', '{"peakG": 0.45, "lineG": "0.32"}'),
    private.hard_event_weight('hard_corner', 'minor', '{"peakG": 0.6, "lineG": null}')],
  array[1, 1, 1, (0.55::float8 / 0.36::float8) * (0.55::float8 / 0.36::float8), (0.5::float8 / 0.4::float8) * (0.5::float8 / 0.4::float8),
    (0.6::float8 / 0.48::float8) * (0.6::float8 / 0.48::float8), 1.5625, 4, 4, 1, 1, 2, 1, 1.5625,
    (0.6::float8 / 0.48::float8) * (0.6::float8 / 0.48::float8)]::float8[],
  'no numeric lineG: the dry line, exactly as 0040');
select is((select p.prosecdef::text || ':' || array_to_string(p.proconfig, ',') from pg_proc p
    where p.pronamespace = 'private'::regnamespace and p.proname = 'hard_event_weight'),
  'false:search_path=public', 'it runs as its caller and pins search_path');
select is(array[has_function_privilege('anon', 'private.hard_event_weight(text, text, jsonb)', 'execute'),
    has_function_privilege('authenticated', 'private.hard_event_weight(text, text, jsonb)', 'execute')],
  array[false, false], 'closed to anon and authenticated');

select * from finish();
rollback;
