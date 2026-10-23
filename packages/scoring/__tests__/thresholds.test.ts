import * as barrel from '../src';
import {
  ACHIEVEMENTS,
  CAMERA_DISPUTE_AUTO_PER_WEEK,
  DASHCAM_MIN_COVERAGE,
  DASHCAM_MIN_MOVING_S,
  DASHCAM_MIN_MPH,
  DISPUTE_AUTO_PER_WEEK,
  END_CRAWL_MPH,
  END_NATIVE_SLACK_S,
  HARD_ACCEL_G,
  HARD_BRAKE_G,
  HARD_CORNER_G,
  IDLE_END_S,
  MERGE_GAP_S,
  MERGE_RADIUS_M,
  MIN_SCORED_MILES,
  MIN_SCORED_S,
  MOVING_MIN_MPH,
  NO_EVENTS_FIRST_S,
  NOT_DRIVING_PER_MONTH,
  NOT_DRIVING_WINDOW_S,
  PHONE_HANDLING_MIN_SCORE,
  PHONE_PICKUP_MIN_MPH,
  PHONE_PICKUP_MIN_ROWS,
  PHONE_PUTDOWN_QUIET_S,
  PHONE_SEVERE_S,
  TRIM_ENDS_M,
} from '../src/thresholds';

test('the three achievements, each with its title and description', () => {
  expect(ACHIEVEMENTS).toEqual([
    { id: 'first_drive', title: 'First Drive', description: 'Complete a scored drive.' },
    { id: 'clean_100', title: 'Clean 100', description: 'Drive 100 clean miles.' },
    { id: 'perfect_week', title: 'Perfect Week', description: 'Take 3 or more drives in a week, all with zero events.' },
  ]);
});

test('detection thresholds match the spec', () => {
  expect(HARD_BRAKE_G).toEqual({ minor: 0.3, severe: 0.45 });
  expect(HARD_ACCEL_G).toEqual({ minor: 0.32, severe: 0.45 });
  expect(HARD_CORNER_G).toEqual({ minor: 0.4, severe: 0.55 });
  expect(NO_EVENTS_FIRST_S).toBe(30);
  expect(MOVING_MIN_MPH).toBe(5);
  expect(MIN_SCORED_MILES).toBe(0.5);
  expect(MIN_SCORED_S).toBe(120);
});

test('phone use: a pickup at driving speed, put down after 10 quiet seconds, severe past 15 s in hand', () => {
  expect(PHONE_HANDLING_MIN_SCORE).toBe(0.6);
  expect(PHONE_PICKUP_MIN_MPH).toBe(10);
  expect(PHONE_PICKUP_MIN_ROWS).toBe(3);
  expect(PHONE_PUTDOWN_QUIET_S).toBe(10);
  expect(PHONE_SEVERE_S).toBe(15);
  expect(barrel.PHONE_PICKUP_MIN_MPH).toBe(PHONE_PICKUP_MIN_MPH);
});

test('the end, merge and privacy-trim rules', () => {
  expect(IDLE_END_S).toBe(300);
  expect(END_CRAWL_MPH).toBe(3);
  expect(END_NATIVE_SLACK_S).toBe(60);
  expect(MERGE_GAP_S).toBe(300);
  expect(MERGE_RADIUS_M).toBe(150);
  expect(TRIM_ENDS_M).toBe(402);
});

test('"Wasn\'t driving": 2 a month, until a day after the end', () => {
  expect(NOT_DRIVING_PER_MONTH).toBe(2);
  expect(NOT_DRIVING_WINDOW_S).toBe(86_400);
});

test('the DashPal rules match the plan', () => {
  expect([DASHCAM_MIN_MPH, DASHCAM_MIN_MOVING_S, DASHCAM_MIN_COVERAGE]).toEqual([10, 60, 0.8]);
  expect([CAMERA_DISPUTE_AUTO_PER_WEEK, DISPUTE_AUTO_PER_WEEK]).toEqual([3, 3]);
});

test('the barrel re-exports the constants, and none of the removed ones', () => {
  expect(barrel.ACHIEVEMENTS).toBe(ACHIEVEMENTS);
  expect(barrel.MERGE_RADIUS_M).toBe(MERGE_RADIUS_M);
  const names = Object.keys(barrel);
  for (const gone of [
    'PHONE_MIN_MPH',
    'MERGE_DIST_M',
    'CHALLENGE_REWARD_POINTS',
    'MAX_FREEZES',
    'DASHCAM_PHONE_OVERLAP_S',
    'SPEEDING_MIN_S',
    'SPEEDING_GRACE_S',
    'DASHCAM_DROWSY_GAP_S',
    'DASHCAM_EYES_OFF_GAP_S',
    'LEAGUE_TIERS',
  ]) {
    expect(names).not.toContain(gone);
  }
});
