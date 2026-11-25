-- 0022_round7_scoring, as 0023 and 0048 left it: the helper the per-opportunity rating still uses
-- (round_half_up for the 1-decimal rating) agrees with the scoring package to the digit; axis_of
-- names the category of every event type (none for anything else); Attention's per-mile curve
-- (category_score) and the linear and penalty-per-mile ratings are gone (0023's own test pins the
-- new rating).
create extension if not exists pgtap with schema extensions;

begin;
select plan(9);

-- ---------------------------------------------------------------------------
-- parity with packages/scoring (the TypeScript pins the same values)
-- ---------------------------------------------------------------------------
select is(array[private.round_half_up(89.549999999999997, 1), private.round_half_up(12.499999999999998, 0), private.round_half_up(59.400000000000006, 1), private.round_half_up(2.5, 0)],
  array[89.6::float8, 13, 59.4, 3], 'round_half_up: half up (2.5 is 3, never half to even), immune to binary drift (12.499999999999998 is 12.5, so 13)');

select is(array[private.axis_of('speeding'), private.axis_of('hard_brake'), private.axis_of('hard_accel'), private.axis_of('hard_corner'), private.axis_of('eyes_off'), private.axis_of('drowsy'),
    private.axis_of('phone_pickup'), private.axis_of('phone_handling'), private.axis_of('nope')],
  array['speed', 'braking', 'acceleration', 'turning', 'attention', 'attention', 'phone', null, null], 'axis_of: the radar category of every event type; a phone pickup counts toward Phone use (0026), phone handling nowhere');

-- ---------------------------------------------------------------------------
-- the older ratings are gone
-- ---------------------------------------------------------------------------
select hasnt_function('private', 'category_score', array['double precision', 'double precision', 'double precision'],
  'Attention''s per-mile curve is gone: Attention is judged per watched second on the common curve (0048)');
select hasnt_function('private', 'safety_rating', array['numeric', 'numeric'], 'the 2-argument linear rating is gone');
select hasnt_function('private', 'safety_rating', array['numeric', 'numeric', 'numeric', 'numeric'], 'the 4-argument linear rating is gone');
select hasnt_function('private', 'safety_rating', array['numeric', 'numeric', 'numeric', 'numeric', 'numeric', 'numeric', 'numeric', 'numeric'], 'the penalty-per-mile rating is gone');
select hasnt_function('private', 'rating_penalty_of', array['text', 'text', 'integer', 'boolean'], 'the per-event penalty table is gone');
select hasnt_function('private', 'rating_window', array['uuid', 'timestamp with time zone', 'timestamp with time zone'], 'the 30-day window is gone');
select hasnt_function('private', 'complete_challenges', array['uuid', 'text', 'uuid'], 'a goal pays nothing: the paying completion is gone');

select * from finish();
rollback;
