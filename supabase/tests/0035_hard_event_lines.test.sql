-- 0035_hard_event_lines: a hard event weighs (peak / its type's line)^2 between 1 and 4 at the
-- looser lines (0.36 g brake, 0.45 g start, 0.55 g turn), agreeing with packages/scoring
-- (rating.test.ts hardEventWeight) to the digit; without a peak, the tier's 1 or 2. The function
-- still runs as its caller, pins search_path and is closed to the API roles.
create extension if not exists pgtap with schema extensions;

begin;
select plan(5);
set local extra_float_digits = 1;

select is(array[private.hard_event_weight('hard_brake', 'minor', '{"peakG": 0.36}'), private.hard_event_weight('hard_accel', 'minor', '{"peakG": 0.45}'),
    private.hard_event_weight('hard_corner', 'minor', '{"peakG": 0.55}')],
  array[1, 1, 1]::float8[], 'an event at its line weighs 1');
select is(array[private.hard_event_weight('hard_brake', 'severe', '{"peakG": 0.55}'), private.hard_event_weight('hard_accel', 'minor', '{"peakG": 0.5}'),
    private.hard_event_weight('hard_corner', 'minor', '{"peakG": 0.6}'), private.hard_event_weight('hard_brake', 'minor', '{"peakG": 0.45}')],
  array[(0.55::float8 / 0.36::float8) * (0.55::float8 / 0.36::float8), 1.234567901234568, 1.190082644628099, 1.5625]::float8[],
  'over its line, (peak / line)^2');
select is(array[private.hard_event_weight('hard_brake', 'severe', '{"peakG": 0.72}'), private.hard_event_weight('hard_corner', 'severe', '{"peakG": 2}'),
    private.hard_event_weight('hard_brake', 'minor', '{"peakG": 0.3}'), private.hard_event_weight('hard_accel', 'minor', '{"peakG": 0.32}'),
    private.hard_event_weight('hard_brake', 'severe', '{}'), private.hard_event_weight('hard_brake', 'minor', '{"peakG": "x"}')],
  array[4, 4, 1, 1, 2, 1]::float8[], 'capped at 4 from twice the line, never under 1 (an older event under the new line); the tier without a peak');
select is((select p.prosecdef::text || ':' || array_to_string(p.proconfig, ',') from pg_proc p
    where p.pronamespace = 'private'::regnamespace and p.proname = 'hard_event_weight'),
  'false:search_path=public', 'it runs as its caller and pins search_path');
select is(array[has_function_privilege('anon', 'private.hard_event_weight(text, text, jsonb)', 'execute'),
    has_function_privilege('authenticated', 'private.hard_event_weight(text, text, jsonb)', 'execute')],
  array[false, false], 'closed to anon and authenticated');

select * from finish();
rollback;
