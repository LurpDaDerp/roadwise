-- 0022_round7_scoring, as 0023 left it: the helpers the per-opportunity rating still uses
-- (category_score for Attention, round_half_up for the 1-decimal rating) agree with the scoring
-- package to the digit; axis_of names the category of every event type (none for anything else);
-- the linear and the penalty-per-mile ratings are gone (0023's own test pins the new rating).
create extension if not exists pgtap with schema extensions;

begin;
select plan(14);

-- ---------------------------------------------------------------------------
-- parity with packages/scoring (the TypeScript pins the same values)
-- ---------------------------------------------------------------------------
select is(private.category_score(40, 10, 10), 80::float8, 'an eyes-off (40) every 10 watched mi scores 80');
select is(private.category_score(10, 20, 10), 96.96969696969697::float8, '10 over 20 mi scores 96.97');
select is(private.category_score(100, 10, 10), 61.53846153846154::float8, '100 over 10 mi scores 61.54');
select is(array[private.category_score(40, 20, 10), private.category_score(100, 20, 10)], array[88.88888888888889::float8, 76.19047619047619::float8], '40 and 100 over 20 mi');
select is(array[private.category_score(40, 3, 10), private.category_score(null, 10, 10), private.category_score(-5, 10, 10), private.category_score(40, null, 10)],
  array[80::float8, 100, 100, 80], 'the miles are floored; a null or negative penalty reads as 0, null miles as the floor');
select is(private.category_score(100000, 10, 10) > 0, true, 'a category is never 0');

select is(array[private.round_half_up(89.549999999999997, 1), private.round_half_up(12.499999999999998, 0), private.round_half_up(59.400000000000006, 1), private.round_half_up(2.5, 0)],
  array[89.6::float8, 13, 59.4, 3], 'round_half_up: half up (2.5 is 3, never half to even), immune to binary drift (12.499999999999998 is 12.5, so 13)');

select is(array[private.axis_of('speeding'), private.axis_of('hard_brake'), private.axis_of('hard_accel'), private.axis_of('hard_corner'), private.axis_of('eyes_off'), private.axis_of('drowsy'),
    private.axis_of('phone_pickup'), private.axis_of('phone_handling'), private.axis_of('nope')],
  array['speed', 'braking', 'acceleration', 'turning', 'attention', 'attention', null, null, null], 'axis_of: the radar category of every event type; phone use counts nowhere');

-- ---------------------------------------------------------------------------
-- the older ratings are gone
-- ---------------------------------------------------------------------------
select hasnt_function('private', 'safety_rating', array['numeric', 'numeric'], 'the 2-argument linear rating is gone');
select hasnt_function('private', 'safety_rating', array['numeric', 'numeric', 'numeric', 'numeric'], 'the 4-argument linear rating is gone');
select hasnt_function('private', 'safety_rating', array['numeric', 'numeric', 'numeric', 'numeric', 'numeric', 'numeric', 'numeric', 'numeric'], 'the penalty-per-mile rating is gone');
select hasnt_function('private', 'rating_penalty_of', array['text', 'text', 'integer', 'boolean'], 'the per-event penalty table is gone');
select hasnt_function('private', 'rating_window', array['uuid', 'timestamp with time zone', 'timestamp with time zone'], 'the 30-day window is gone');
select hasnt_function('private', 'complete_challenges', array['uuid', 'text', 'uuid'], 'a goal pays nothing: the paying completion is gone');

select * from finish();
rollback;
