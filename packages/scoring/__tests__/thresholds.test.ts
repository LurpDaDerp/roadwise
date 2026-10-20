import * as barrel from '../src';
import {
  ACHIEVEMENTS,
  CAMERA_DISPUTE_AUTO_PER_WEEK,
  DASHCAM_DROWSY_GAP_S,
  DASHCAM_EYES_OFF_GAP_S,
  DASHCAM_MIN_COVERAGE,
  DASHCAM_MIN_MOVING_S,
  DASHCAM_MIN_MPH,
  DASHCAM_PHONE_OVERLAP_S,
  DISPUTE_AUTO_PER_WEEK,
  HARD_ACCEL_G,
  HARD_BRAKE_G,
  HARD_CORNER_G,
  LEAGUE_TIERS,
  MERGE_DIST_M,
  MIN_SCORED_MILES,
  SPEEDING_MIN_S,
} from '../src/thresholds';

test('league tiers in promotion order', () =>
  expect(LEAGUE_TIERS).toEqual(['bronze', 'silver', 'gold', 'platinum', 'diamond']));

test('the 5 launch achievements, each with a title and description', () => {
  expect(ACHIEVEMENTS.map((a) => a.id)).toEqual(['first_drive', 'clean_100', 'perfect_week', 'phone_free_25', 'streak_10']);
  for (const a of ACHIEVEMENTS) {
    expect(a.title.length).toBeGreaterThan(0);
    expect(a.description.length).toBeGreaterThan(0);
  }
});

test('detection thresholds match the spec', () => {
  expect(HARD_BRAKE_G).toEqual({ minor: 0.3, severe: 0.45 });
  expect(HARD_ACCEL_G).toEqual({ minor: 0.28, severe: 0.4 });
  expect(HARD_CORNER_G).toEqual({ minor: 0.4, severe: 0.55 });
  expect(SPEEDING_MIN_S).toEqual({ default: 5, severe: 3 });
  expect(MIN_SCORED_MILES).toBe(0.5);
  expect(MERGE_DIST_M).toBe(402);
});

test('the DashPal rules match the plan', () => {
  expect([DASHCAM_MIN_MPH, DASHCAM_DROWSY_GAP_S, DASHCAM_EYES_OFF_GAP_S, DASHCAM_MIN_MOVING_S, DASHCAM_MIN_COVERAGE]).toEqual([10, 600, 300, 60, 0.8]);
  expect(DASHCAM_PHONE_OVERLAP_S).toBe(5);
  expect([CAMERA_DISPUTE_AUTO_PER_WEEK, DISPUTE_AUTO_PER_WEEK]).toEqual([3, 3]);
});

test('the barrel re-exports the v3 constants', () => {
  expect(barrel.LEAGUE_TIERS).toBe(LEAGUE_TIERS);
  expect(barrel.ACHIEVEMENTS).toBe(ACHIEVEMENTS);
});
