import * as barrel from '../src';
import {
  ACHIEVEMENTS,
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
  expect(HARD_BRAKE_G).toEqual({ minor: 0.4, severe: 0.55 });
  expect(HARD_ACCEL_G).toEqual({ minor: 0.35, severe: 0.5 });
  expect(HARD_CORNER_G).toEqual({ minor: 0.4, severe: 0.55 });
  expect(SPEEDING_MIN_S).toEqual({ default: 5, severe: 3 });
  expect(MIN_SCORED_MILES).toBe(0.5);
  expect(MERGE_DIST_M).toBe(402);
});

test('the barrel re-exports the v3 constants', () => {
  expect(barrel.LEAGUE_TIERS).toBe(LEAGUE_TIERS);
  expect(barrel.ACHIEVEMENTS).toBe(ACHIEVEMENTS);
});
