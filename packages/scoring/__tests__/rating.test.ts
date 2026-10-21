import * as barrel from '../src';
import { attentionPenalty, type DriveEvent } from '../src/drive';
import {
  AXES,
  AXIS_WEIGHT,
  CATEGORY_K,
  DASHPAL_AXIS,
  DRIVE_SCORE_MIN_MILES,
  RANKED_MIN_MILES,
  attentionDeficit,
  axisOf,
  axisPenalties,
  axisScores,
  categoryScore,
  driveScore,
  levelForPoints,
  safetyRating,
  safetyRatingOf,
  watchedMiles,
  weightedScore,
  zeroAxisPenalties,
  type AxisPenalties,
} from '../src/rating';

let seq = 0;
const ev = (p: Partial<DriveEvent> & Pick<DriveEvent, 'type' | 'tier'>): DriveEvent => {
  seq += 1;
  return { id: `e${seq}`, startedAt: 1_000_000 + seq * 1000, durationS: 0, ...p };
};
const pen = (p: Partial<AxisPenalties>): AxisPenalties => ({ ...zeroAxisPenalties(), ...p });

describe('categories', () => {
  test('the six axes in radar order, clockwise from the top; Attention is the DashPal one', () => {
    expect(AXES).toEqual(['acceleration', 'braking', 'turning', 'attention', 'phone', 'speed']);
    expect(DASHPAL_AXIS).toBe('attention');
  });

  test('axisOf: every event type lands on its category', () => {
    expect(axisOf('speeding')).toBe('speed');
    expect(axisOf('hard_brake')).toBe('braking');
    expect(axisOf('hard_accel')).toBe('acceleration');
    expect(axisOf('hard_corner')).toBe('turning');
    expect(axisOf('phone_pickup')).toBe('phone');
    expect(axisOf('phone_handling')).toBe('phone');
    expect(axisOf('eyes_off')).toBe('attention');
    expect(axisOf('drowsy')).toBe('attention');
  });

  test('weights: speed and phone use double, the rest single', () => {
    expect(AXIS_WEIGHT).toEqual({ speed: 2, phone: 2, braking: 1, acceleration: 1, turning: 1, attention: 1 });
  });

  test('axisPenalties: rating penalties per category over the active events, DashPal on Attention, never the points multipliers', () => {
    const events = [
      ev({ type: 'speeding', tier: 'severe', durationS: 90, zone: 'school', measured: { overMphS: 400 } }),
      ev({ type: 'speeding', tier: 'minor' }),
      ev({ type: 'hard_brake', tier: 'minor' }),
      ev({ type: 'hard_accel', tier: 'severe' }),
      ev({ type: 'hard_corner', tier: 'severe' }),
      ev({ type: 'phone_pickup', tier: 'severe', measured: { maxSpeedMph: 60 } }),
      ev({ type: 'phone_pickup', tier: 'severe', stoppedInTraffic: true }),
      ev({ type: 'phone_handling', tier: 'severe', units: 3 }),
      ev({ type: 'eyes_off', tier: 'severe' }),
      ev({ type: 'drowsy', tier: 'severe' }),
      ev({ type: 'phone_pickup', tier: 'severe', status: 'removed' }),
      ev({ type: 'drowsy', tier: 'severe', status: 'removed' }),
    ];
    expect(axisPenalties(events)).toEqual({ speed: 115, braking: 10, acceleration: 30, turning: 25, phone: 90, attention: 90 });
    expect(axisPenalties([])).toEqual(zeroAxisPenalties());
  });
});

describe('categoryScore — 100 / (1 + (P / max(M, floor)) / 16), never 0', () => {
  test('the curve', () => expect(CATEGORY_K).toBe(16));

  test.each([
    [40, 10, 10, 80], // a pickup every 10 mi
    [0, 5, 10, 100],
    [40, 2, 10, 80], // under the floor the floor divides
    [40, 2, 3, 100 / (1 + 40 / 3 / 16)], // the drive floor
    [160, 10, 10, 50], // K per mile is 50
    [1e9, 10, 10, 100 / (1 + 1e8 / 16)], // tiny, never 0
  ])('P=%f over %f mi (floor %f) → %f', (p, m, floor, s) => expect(categoryScore(p, m, floor)).toBeCloseTo(s, 12));

  test('pinned values the SQL copy must reproduce', () => {
    expect(categoryScore(40, 10, 10)).toBe(80);
    expect(categoryScore(10, 20, 10)).toBeCloseTo(96.96969696969697, 12);
    expect(categoryScore(100, 10, 10)).toBeCloseTo(61.53846153846154, 12);
    expect(categoryScore(40, 20, 10)).toBeCloseTo(88.88888888888889, 12);
    expect(categoryScore(100, 20, 10)).toBeCloseTo(76.19047619047619, 12);
  });

  test('a negative or non-finite penalty reads as 0; non-finite miles as the floor', () => {
    expect(categoryScore(-5, 10, 10)).toBe(100);
    expect(categoryScore(Number.NaN, 10, 10)).toBe(100);
    expect(categoryScore(40, Number.NaN, 10)).toBe(80);
    expect(categoryScore(40, Number.POSITIVE_INFINITY, 10)).toBe(80);
  });
});

describe('axisScores and weightedScore', () => {
  test('each category over the miles, Attention over the watched miles, floored', () => {
    const s = axisScores({ penalties: pen({ speed: 100, phone: 40, braking: 10, attention: 40 }), miles: 20, watchedMiles: 20 }, RANKED_MIN_MILES);
    expect(s.speed).toBeCloseTo(76.19047619047619, 12);
    expect(s.phone).toBeCloseTo(88.88888888888889, 12);
    expect(s.braking).toBeCloseTo(96.96969696969697, 12);
    expect(s.acceleration).toBe(100);
    expect(s.turning).toBe(100);
    expect(s.attention).toBeCloseTo(88.88888888888889, 12);
  });

  test('no watched miles → Attention has no score; no miles → no scores at all', () => {
    const s = axisScores({ penalties: pen({ attention: 40 }), miles: 20, watchedMiles: 0 }, RANKED_MIN_MILES);
    expect(s.attention).toBeNull();
    expect(s.speed).toBe(100);
    expect(axisScores({ penalties: pen({}), miles: 0, watchedMiles: 5 }, RANKED_MIN_MILES)).toEqual({
      acceleration: null,
      braking: null,
      turning: null,
      attention: null,
      phone: null,
      speed: null,
    });
  });

  test('the weighted mean leaves a null category out of both sums; all null → null', () => {
    expect(weightedScore({ speed: 50, phone: 100, braking: 100, acceleration: 100, turning: 100, attention: null })).toBeCloseTo((100 + 200 + 300) / 7, 12);
    expect(weightedScore({ speed: 50, phone: 100, braking: 100, acceleration: 100, turning: 100, attention: 100 })).toBeCloseTo((100 + 200 + 400) / 8, 12);
    expect(weightedScore({ speed: 60 })).toBe(60);
    expect(weightedScore({})).toBeNull();
    expect(weightedScore({ speed: null, phone: Number.NaN })).toBeNull();
  });
});

describe('safetyRatingOf — the weighted mean of the category scores over 30 days', () => {
  test('one severe speeding, a pickup and a hard brake over 20 mi, no DashPal → 89.6 (pinned for SQL)', () => {
    const r = safetyRatingOf({ penalties: pen({ speed: 100, phone: 40, braking: 10 }), miles: 20, watchedMiles: 0 });
    expect(r).toEqual({ rating: 89.6, ranked: true });
  });

  test('the same with DashPal watching all 20 mi and one eyes-off → 89.5 (pinned for SQL)', () => {
    const r = safetyRatingOf({ penalties: pen({ speed: 100, phone: 40, braking: 10, attention: 40 }), miles: 20, watchedMiles: 20 });
    expect(r).toEqual({ rating: 89.5, ranked: true });
  });

  test('one phone pickup every 10 mi → phone 80, the rest 100 → 94.3', () => {
    expect(safetyRatingOf({ penalties: pen({ phone: 40 }), miles: 10, watchedMiles: 0 }).rating).toBe(94.3); // (160 + 500) / 7
  });

  test('one severe speeding in a 9-mile month no longer sinks the rating to 0', () => {
    // speed over max(9, 10) = 10 mi: 61.54; (123.08 + 500) / 7 = 89.0
    expect(safetyRatingOf({ penalties: pen({ speed: 100 }), miles: 9, watchedMiles: 0 })).toEqual({ rating: 89, ranked: false });
  });

  test('the same rate over 100 mi rates the same', () => {
    expect(safetyRatingOf({ penalties: pen({ phone: 400 }), miles: 100, watchedMiles: 0 }).rating).toBe(94.3);
  });

  test('a terrible month still reads above 0: 1000 penalty per category over 10 mi → every category 13.8', () => {
    const r = safetyRatingOf({ penalties: pen({ speed: 1000, phone: 1000, braking: 1000, acceleration: 1000, turning: 1000 }), miles: 10, watchedMiles: 0 });
    expect(r.rating).toBe(13.8); // 100 / (1 + 100 / 16)
  });

  test('no miles → no rating; ranked from 10 mi', () => {
    expect(safetyRatingOf({ penalties: pen({}), miles: 0, watchedMiles: 0 })).toEqual({ rating: null, ranked: false });
    expect(safetyRatingOf({ penalties: pen({ phone: 40 }), miles: 0, watchedMiles: 0 })).toEqual({ rating: null, ranked: false });
    expect(safetyRatingOf({ penalties: pen({}), miles: 9.9, watchedMiles: 0 })).toEqual({ rating: 100, ranked: false });
    expect(safetyRatingOf({ penalties: pen({}), miles: 10, watchedMiles: 0 })).toEqual({ rating: 100, ranked: true });
  });

  test('Attention counts only for a driver DashPal watched, over the watched miles (floored at 10)', () => {
    const base = pen({ attention: 40 });
    expect(safetyRatingOf({ penalties: base, miles: 20, watchedMiles: 0 }).rating).toBe(100);
    // attention over max(2, 10) = 10 mi → 80: (80 + 700) / 8 = 97.5
    expect(safetyRatingOf({ penalties: base, miles: 20, watchedMiles: 2 }).rating).toBe(97.5);
    // over 40 mi → 100 / (1 + 1 / 16) = 94.1176: (94.1176 + 700) / 8 = 99.26
    expect(safetyRatingOf({ penalties: base, miles: 40, watchedMiles: 40 }).rating).toBe(99.3);
  });

  test('rounded to 1 decimal', () => {
    // speed 100/(1 + 1/16) = 94.117647, (188.235 + 500) / 7 = 98.319
    expect(safetyRatingOf({ penalties: pen({ speed: 15 }), miles: 15, watchedMiles: 0 }).rating).toBe(98.3);
  });
});

describe('driveScore — one drive, floored at 3 mi, a whole number', () => {
  test('the floor', () => expect(DRIVE_SCORE_MIN_MILES).toBe(3));

  test('a clean drive scores 100; one pickup on 5 mi scores 90; on 1 mi (floored at 3) 87', () => {
    expect(driveScore([], 5, 0)).toBe(100);
    expect(driveScore([ev({ type: 'phone_pickup', tier: 'severe' })], 5, 0)).toBe(90); // phone 66.67: (133.33 + 500) / 7 = 90.48
    expect(driveScore([ev({ type: 'phone_pickup', tier: 'severe' })], 1, 0)).toBe(87); // phone 54.55: (109.09 + 500) / 7 = 87.01
  });

  test('removed events do not count; DashPal events count only with watched miles', () => {
    expect(driveScore([ev({ type: 'phone_pickup', tier: 'severe', status: 'removed' })], 5, 0)).toBe(100);
    expect(driveScore([ev({ type: 'drowsy', tier: 'severe' })], 5, 0)).toBe(100);
    // attention 50 over max(5, 3) = 5 mi: 100 / (1 + 10 / 16) = 61.54; (61.54 + 700) / 8 = 95.19
    expect(driveScore([ev({ type: 'drowsy', tier: 'severe' })], 5, 5)).toBe(95);
  });

  test('a severe speeding on a 3 mi drive: 100 / (1 + (100 / 3) / 16) = 32.43 → (64.86 + 500) / 7 = 81', () => {
    expect(driveScore([ev({ type: 'speeding', tier: 'severe', durationS: 40, measured: { overMphS: 500 } })], 3, 0)).toBe(81);
  });

  test('null with no miles; a too-short drive still scores over the floor', () => {
    expect(driveScore([], 0, 0)).toBeNull();
    expect(driveScore([ev({ type: 'hard_brake', tier: 'minor' })], 0.3, 0)).toBe(98); // braking 100 / (1 + (10 / 3) / 16) = 82.76; (82.76 + 600) / 7 = 97.54
  });

  test('the barrel exports the category API', () => {
    expect(barrel.driveScore).toBe(driveScore);
    expect(barrel.safetyRatingOf).toBe(safetyRatingOf);
    expect(barrel.categoryScore).toBe(categoryScore);
    expect(barrel.axisOf).toBe(axisOf);
    expect(barrel.AXES).toBe(AXES);
  });
});

describe('legacy safetyRating (kept for callers not yet switched)', () => {
  test('one phone pickup every 10 mi → 60; clamped to 0; Attention takes its share', () => {
    expect(safetyRating(40, 10)).toEqual({ rating: 60, ranked: true });
    expect(safetyRating(1000, 10).rating).toBe(0);
    expect(safetyRating(0, 0)).toEqual({ rating: null, ranked: false });
    expect(safetyRating(40, 20, { penalty: 40, watchedMiles: 20 }).rating).toBe(60);
    expect(attentionDeficit(40, 2)).toBe(40);
  });
});

describe('Attention (DashPal)', () => {
  test('watched miles: the drive’s miles × the covered share of its moving seconds', () => {
    expect(watchedMiles(20, 1000, 500)).toBe(10);
    expect(watchedMiles(20, 1000, 1500)).toBe(20);
    expect(watchedMiles(20, 0, 0)).toBe(0);
    expect(watchedMiles(0, 1000, 1000)).toBe(0);
  });

  test('its penalty: DashPal events only', () => {
    const base = { id: 'e', startedAt: 0, durationS: 3 };
    expect(attentionPenalty({ ...base, type: 'eyes_off', tier: 'severe' })).toBe(40);
    expect(attentionPenalty({ ...base, type: 'drowsy', tier: 'severe' })).toBe(50);
    expect(attentionPenalty({ ...base, type: 'hard_brake', tier: 'severe' })).toBe(0);
  });
});

describe('levelForPoints — level n at 250 × n(n−1)/2', () => {
  test.each([
    [0, 1, 0, 250],
    [249, 1, 0, 250],
    [250, 2, 250, 750],
    [749, 2, 250, 750],
    [750, 3, 750, 1500],
    [1499, 3, 750, 1500],
    [1500, 4, 1500, 2500],
    [306_249, 49, 294_000, 306_250],
  ])('%i points → level %i [%i, %i)', (points, level, floor, next) =>
    expect(levelForPoints(points)).toEqual({ level, floor, next }));

  test('caps at level 50 with no next threshold', () => {
    expect(levelForPoints(306_250)).toEqual({ level: 50, floor: 306_250, next: null });
    expect(levelForPoints(1e9)).toEqual({ level: 50, floor: 306_250, next: null });
  });

  test('negative or non-finite points read as level 1', () => {
    expect(levelForPoints(-5)).toEqual({ level: 1, floor: 0, next: 250 });
    expect(levelForPoints(Number.NaN)).toEqual({ level: 1, floor: 0, next: 250 });
  });
});
