import * as barrel from '../src';
import type { DriveEvent } from '../src/drive';
import {
  ATTENTION_MIN_MILES,
  ATTENTION_PENALTY,
  AXES,
  AXIS_WEIGHT,
  BASELINE,
  CATEGORY_K,
  DASHPAL_AXIS,
  DRIVE_ATTENTION_MIN_MILES,
  ESTIMATE_KNOTS,
  EXPOSURE_MAX,
  HARD_EVENT_WEIGHT,
  LEGACY_MEAN_OVER_MPH,
  OVER_CAP_MPH,
  OVER_REF_MPH,
  RANKED_MIN_MILES,
  RATE_AXES,
  RATING_HALF_LIFE_DAYS,
  RATING_WINDOW_DAYS,
  RECENCY_WEIGHT,
  TYPICAL_SCORE,
  axisOf,
  categoryScore,
  clampExposure,
  driveLoads,
  driveScore,
  estimateExposure,
  eventWeight,
  ratingAt,
  rateScore,
  recencyWeight,
  speedingWeight,
  watchedMiles,
  weightedScore,
  type Exposure,
  type RatingDrive,
} from '../src/rating';

const DAY = 86_400_000;
const AT = Date.UTC(2026, 9, 21, 12);
let seq = 0;
const ev = (p: Partial<DriveEvent> & Pick<DriveEvent, 'type' | 'tier'>): DriveEvent => {
  seq += 1;
  return { id: `e${String(seq).padStart(4, '0')}`, startedAt: 1_000_000 + seq * 1000, durationS: 0, ...p };
};
const exp = (slowdowns: number, speedups: number, turns: number, limitS: number, movingS: number): Exposure => ({
  slowdowns,
  speedups,
  turns,
  limitS,
  movingS,
});
const EXP6 = exp(15, 15, 9, 840, 1136);
const roundTo4 = (v: number): number => Math.round(Math.round(v * 1e4 * 1e9) / 1e9) / 1e4;

describe('categories', () => {
  test('the five axes in radar order, clockwise from the top; Attention is the DashPal one', () => {
    expect(AXES).toEqual(['acceleration', 'braking', 'turning', 'attention', 'speed']);
    expect(RATE_AXES).toEqual(['acceleration', 'braking', 'turning', 'speed']);
    expect(DASHPAL_AXIS).toBe('attention');
  });

  test('Speed counts double, the rest single', () =>
    expect(AXIS_WEIGHT).toEqual({ speed: 2, braking: 1, acceleration: 1, turning: 1, attention: 1 }));

  test('axisOf: each type to its category; anything else (a stored phone type) to none', () => {
    expect(axisOf('speeding')).toBe('speed');
    expect(axisOf('hard_brake')).toBe('braking');
    expect(axisOf('hard_accel')).toBe('acceleration');
    expect(axisOf('hard_corner')).toBe('turning');
    expect(axisOf('eyes_off')).toBe('attention');
    expect(axisOf('drowsy')).toBe('attention');
    expect(axisOf('phone_pickup')).toBeNull();
    expect(axisOf('phone_handling')).toBeNull();
  });

  test('the constants', () => {
    expect([RATING_WINDOW_DAYS, RATING_HALF_LIFE_DAYS, RANKED_MIN_MILES, TYPICAL_SCORE]).toEqual([90, 21, 10, 85]);
    expect(BASELINE).toEqual({
      braking: { rate: 0.01, prior: 60, floor: 10 },
      acceleration: { rate: 0.008, prior: 60, floor: 10 },
      turning: { rate: 0.008, prior: 60, floor: 10 },
      speed: { rate: 0.04, prior: 3600, floor: 600 },
    });
    expect(HARD_EVENT_WEIGHT).toEqual({ minor: 1, severe: 2 });
    expect([OVER_REF_MPH, OVER_CAP_MPH]).toEqual([5, 40]);
    expect(LEGACY_MEAN_OVER_MPH).toEqual({ minor: 2, moderate: 6.5, severe: 12 });
    expect(ATTENTION_PENALTY).toEqual({ eyes_off: 40, drowsy: 50 });
    expect([ATTENTION_MIN_MILES, DRIVE_ATTENTION_MIN_MILES, CATEGORY_K]).toEqual([10, 3, 16]);
    expect(EXPOSURE_MAX).toEqual({ count: 20_000, seconds: 43_200 });
  });
});

describe('recency', () => {
  test('the table is 2^(−d/21) to 4 dp for every day of the window', () => {
    expect(RECENCY_WEIGHT).toHaveLength(90);
    RECENCY_WEIGHT.forEach((w, d) => expect(w).toBe(roundTo4(2 ** (-d / 21))));
  });

  test.each([
    [0, 1],
    [1, 0.9675],
    [7, 0.7937],
    [21, 0.5],
    [42, 0.25],
    [63, 0.125],
    [89, 0.053],
    [90, 0],
    [-1, 0],
    [7.9, 0.7937],
    [Number.NaN, 0],
  ])('recencyWeight(%f) = %f', (d, w) => expect(recencyWeight(d)).toBe(w));
});

describe('rateScore: 100 / (1 + (r / r0) × 15/85)', () => {
  test.each([
    [0.01, 0.01, 85],
    [0.02, 0.01, 73.91304347826086],
    [0.03, 0.01, 65.38461538461539],
    [0, 0.01, 100],
    [0.005, 0.01, 91.8918918918919],
    [0.1, 0.01, 36.170212765957444],
    [0.032432432432432434, 0.04, 87.48261474269819],
  ])('rateScore(%f, %f) = %f', (r, b, s) => expect(rateScore(r, b)).toBe(s));

  test('a negative or non-finite rate reads 100; never 0', () => {
    expect(rateScore(-1, 0.01)).toBe(100);
    expect(rateScore(Number.NaN, 0.01)).toBe(100);
    expect(rateScore(1e6, 0.01)).toBeGreaterThan(0);
  });
});

describe('speedingWeight: charged seconds × (over / 5)^1.5', () => {
  test.each([
    [30, 125, 'minor', 25],
    [25, 160, 'moderate', 40.47715405015526],
    [65, 720, 'severe', 223.08384074154722],
    [3, 0, 'minor', 0],
    [60, 0, 'severe', 0],
    [10, 100000, 'severe', 113.13708498984761], // the mean over capped at 40
    [30, null, 'minor', 6.324555320336759],
    [30, null, 'moderate', 37.05570131572199],
    [30, null, 'severe', 92.95160030897802],
  ] as const)('(%f s, %s mph·s, %s) = %f', (d, over, tier, w) => expect(speedingWeight(d, over, tier)).toBe(w));

  test('a non-finite overMphS reads as the tier mean; a negative one as nothing over', () => {
    expect(speedingWeight(30, Number.NaN, 'minor')).toBe(speedingWeight(30, null, 'minor'));
    expect(speedingWeight(30, -10, 'severe')).toBe(0);
  });
});

describe('eventWeight', () => {
  test('hard events minor 1 / severe 2; a two-level type reads moderate as minor', () => {
    expect(eventWeight(ev({ type: 'hard_brake', tier: 'minor' }))).toBe(1);
    expect(eventWeight(ev({ type: 'hard_accel', tier: 'severe' }))).toBe(2);
    expect(eventWeight(ev({ type: 'hard_corner', tier: 'moderate' }))).toBe(1);
  });

  test('speeding by its measured overMphS, else its tier mean', () => {
    expect(eventWeight(ev({ type: 'speeding', tier: 'minor', durationS: 30, measured: { overMphS: 125 } }))).toBe(25);
    expect(eventWeight(ev({ type: 'speeding', tier: 'severe', durationS: 30 }))).toBe(92.95160030897802);
    expect(eventWeight(ev({ type: 'speeding', tier: 'severe', durationS: 30, measured: { overMphS: 'x' as unknown as number } }))).toBe(
      92.95160030897802
    );
  });

  test('DashPal, removed and stored phone events weigh 0', () => {
    expect(eventWeight(ev({ type: 'drowsy', tier: 'severe' }))).toBe(0);
    expect(eventWeight(ev({ type: 'hard_brake', tier: 'severe', status: 'removed' }))).toBe(0);
    expect(eventWeight(ev({ type: 'phone_pickup' as DriveEvent['type'], tier: 'severe' }))).toBe(0);
  });
});

describe('exposure', () => {
  test('clampExposure: finite whole numbers, capped, limitS ≤ movingS', () => {
    expect(clampExposure({ slowdowns: 3.9, speedups: -2, turns: Number.NaN, limitS: 500, movingS: 400 })).toEqual(exp(3, 0, 0, 400, 400));
    expect(clampExposure({ slowdowns: 1e9, speedups: 20_001, turns: Infinity, limitS: 1e9, movingS: 1e9 })).toEqual(
      exp(20_000, 20_000, 0, 43_200, 43_200)
    );
    expect(clampExposure(null)).toEqual(exp(0, 0, 0, 0, 0));
    expect(clampExposure(undefined)).toEqual(exp(0, 0, 0, 0, 0));
    expect(clampExposure({ slowdowns: '4' as unknown as number })).toEqual(exp(0, 0, 0, 0, 0));
    expect(clampExposure(EXP6)).toEqual(EXP6);
  });

  test.each([
    [8, 1600, exp(18, 18, 11, 912, 1136)],
    [2, 480, exp(5, 5, 3, 252, 312)],
    [40, 2900, exp(13, 13, 6, 2313, 2808)],
    [0.3, 240, exp(1, 1, 1, 108, 132)],
    [15, 1500, exp(13, 13, 7, 1060, 1357)],
    [0, 0, exp(0, 0, 0, 0, 0)],
    [10, 36000, exp(30, 30, 20, 16200, 19800)],
  ])('estimateExposure(%f mi, %f s)', (mi, s, e) => expect(estimateExposure(mi, s)).toEqual(e));

  test('the estimate always satisfies the clamp, whatever the input', () => {
    expect(ESTIMATE_KNOTS).toHaveLength(4);
    for (const [mi, s] of [
      [500, 200_000],
      [Number.NaN, 600],
      [-3, 600],
      [5, -1],
      [1000, 10],
    ] as const) {
      const e = estimateExposure(mi, s);
      expect(clampExposure(e)).toEqual(e);
    }
  });
});

describe('driveLoads', () => {
  test('weights, counts and opportunities per category; Attention from the DashPal events', () => {
    const loads = driveLoads(
      [
        ev({ type: 'hard_brake', tier: 'minor' }),
        ev({ type: 'hard_brake', tier: 'severe' }),
        ev({ type: 'speeding', tier: 'moderate', durationS: 25, measured: { overMphS: 160 } }),
        ev({ type: 'eyes_off', tier: 'severe' }),
        ev({ type: 'drowsy', tier: 'severe' }),
        ev({ type: 'hard_corner', tier: 'severe', status: 'removed' }),
      ],
      EXP6
    );
    expect(loads.rates.braking).toEqual({ weight: 3, count: 2, opportunities: 15 });
    expect(loads.rates.acceleration).toEqual({ weight: 0, count: 0, opportunities: 15 });
    expect(loads.rates.turning).toEqual({ weight: 0, count: 0, opportunities: 9 });
    expect(loads.rates.speed).toEqual({ weight: 40.47715405015526, count: 20, opportunities: 840 });
    expect(loads.attentionPenalty).toBe(90);
  });

  test('a legacy speeding event (no overMphS) uses its tier mean', () => {
    const loads = driveLoads([ev({ type: 'speeding', tier: 'minor', durationS: 30 })], EXP6);
    expect(loads.rates.speed).toEqual({ weight: 6.324555320336759, count: 25, opportunities: 840 });
  });
});

const drive = (p: Partial<RatingDrive> & { ageDays: number }): RatingDrive => {
  const { ageDays, ...rest } = p;
  return { startedAt: AT - ageDays * DAY, miles: 6, watchedMiles: 0, exposure: EXP6, events: [], ...rest };
};
const pinA = drive({
  ageDays: 0,
  id: 'a',
  events: [
    ev({ type: 'hard_brake', tier: 'minor', startedAt: AT + 60_000 }),
    ev({ type: 'speeding', tier: 'moderate', durationS: 25, startedAt: AT + 120_000, measured: { overMphS: 160 } }),
  ],
});
const pinB = drive({
  ageDays: 10,
  id: 'b',
  miles: 20,
  exposure: exp(40, 40, 25, 2400, 3200),
  events: [ev({ type: 'hard_brake', tier: 'severe' }), ev({ type: 'hard_accel', tier: 'minor' })],
});
const pinC = drive({
  ageDays: 40,
  id: 'c',
  miles: 30,
  watchedMiles: 30,
  exposure: exp(10, 10, 5, 1800, 2000),
  events: [
    ev({ type: 'eyes_off', tier: 'severe' }),
    ev({ type: 'hard_corner', tier: 'severe' }),
    ev({ type: 'speeding', tier: 'severe', durationS: 65, measured: { overMphS: 720 } }),
  ],
});

describe('ratingAt: the 90-day, recency-weighted, per-opportunity Safety Rating', () => {
  test('pin A: one drive today, a minor hard brake and 25 s of speeding', () => {
    expect(ratingAt([pinA], AT)).toEqual({
      rating: 83.2,
      ranked: false,
      miles: 6,
      scores: {
        braking: 72.64957264957265,
        acceleration: 87.62886597938144,
        turning: 86.69623059866963,
        speed: 84.50913652825136,
        attention: null,
      },
    });
  });

  test('pin B: A plus a 20-mi drive 10 days ago', () => {
    expect(ratingAt([pinA, pinB], AT)).toEqual({
      rating: 82.3,
      ranked: true,
      miles: 26,
      scores: {
        braking: 65.93366008869643,
        acceleration: 79.68828603627973,
        turning: 89.14703209011581,
        speed: 88.33868749246123,
        attention: null,
      },
    });
  });

  test('pin C: B plus a DashPal-watched 30-mi drive 40 days ago', () => {
    expect(ratingAt([pinA, pinB, pinC], AT)).toEqual({
      rating: 82,
      ranked: true,
      miles: 56,
      scores: {
        braking: 66.5022298398257,
        acceleration: 80.09658912192572,
        turning: 79.78673027342722,
        speed: 86.05770434358871,
        attention: 93.74047948255254,
      },
    });
  });

  test('pin D: no drives', () => {
    expect(ratingAt([], AT)).toEqual({
      rating: null,
      ranked: false,
      miles: 0,
      scores: { acceleration: null, braking: null, turning: null, attention: null, speed: null },
    });
  });

  test('pin E and F: one clean drive; ranked from 10 mi', () => {
    const clean = ratingAt([drive({ ageDays: 0 })], AT);
    expect(clean).toEqual({
      rating: 87.4,
      ranked: false,
      miles: 6,
      scores: {
        braking: 87.62886597938144,
        acceleration: 87.62886597938144,
        turning: 86.69623059866963,
        speed: 87.48261474269819,
        attention: null,
      },
    });
    expect(ratingAt([drive({ ageDays: 0, miles: 9.9 })], AT)).toMatchObject({ rating: 87.4, ranked: false, scores: clean.scores });
    expect(ratingAt([drive({ ageDays: 0, miles: 10 })], AT)).toMatchObject({ rating: 87.4, ranked: true });
  });

  test('drives in the future or 90 days old and more are left out', () => {
    const base = ratingAt([pinA], AT);
    const future = drive({ ageDays: -1 / 24, events: [ev({ type: 'hard_brake', tier: 'severe' })] });
    const old = drive({ ageDays: 90, events: [ev({ type: 'hard_brake', tier: 'severe' })] });
    expect(ratingAt([pinA, future, old], AT)).toEqual(base);
    const lastDay = drive({ ageDays: 89.99, events: [ev({ type: 'hard_brake', tier: 'severe' })] });
    expect(ratingAt([pinA, lastDay], AT).miles).toBe(12);
  });

  test('sums are order-stable: shuffled input gives identical bits', () => {
    const want = ratingAt([pinA, pinB, pinC], AT);
    expect(ratingAt([pinC, pinA, pinB], AT)).toEqual(want);
    expect(ratingAt([pinB, pinC, pinA], AT)).toEqual(want);
    const shuffledEvents = { ...pinC, events: [...pinC.events].reverse() };
    expect(ratingAt([pinA, pinB, shuffledEvents], AT)).toEqual(want);
  });

  test('a removed event weighs nothing; a stored phone event weighs nothing', () => {
    const clean = ratingAt([drive({ ageDays: 0 })], AT);
    const removed = drive({ ageDays: 0, events: [ev({ type: 'hard_brake', tier: 'severe', status: 'removed' })] });
    const phone = drive({ ageDays: 0, events: [ev({ type: 'phone_pickup' as DriveEvent['type'], tier: 'severe' })] });
    expect(ratingAt([removed], AT)).toEqual(clean);
    expect(ratingAt([phone], AT)).toEqual(clean);
  });

  test('does not mutate its input', () => {
    const drives = [pinB, pinA];
    const copy = JSON.parse(JSON.stringify(drives));
    ratingAt(drives, AT);
    expect(drives).toEqual(copy);
  });
});

describe('driveScore: the same curves over one drive, no prior, opportunities floored', () => {
  test('a clean drive is 100', () => expect(driveScore([], 6, 0, EXP6)).toBe(100));
  test('one minor hard brake on 6 mi is 89', () =>
    expect(driveScore([ev({ type: 'hard_brake', tier: 'minor' })], 6, 0, EXP6)).toBe(89));
  test('a severe hard brake on 2 mi is 84', () =>
    expect(driveScore([ev({ type: 'hard_brake', tier: 'severe' })], 2, 0, exp(4, 4, 3, 240, 300))).toBe(84));
  test('a minute at 15 over on 6 mi is 75', () =>
    expect(driveScore([ev({ type: 'speeding', tier: 'severe', durationS: 65, measured: { overMphS: 900 } })], 6, 0, EXP6)).toBe(75));
  test('a drowsy on 5 watched mi is 94', () => expect(driveScore([ev({ type: 'drowsy', tier: 'severe' })], 5, 5, EXP6)).toBe(94));
  test('no miles, no score', () => expect(driveScore([], 0, 0, EXP6)).toBeNull());
  test('the floors: a minor hard brake on 0.3 mi is 87', () =>
    expect(driveScore([ev({ type: 'hard_brake', tier: 'minor' })], 0.3, 0, exp(1, 1, 1, 108, 132))).toBe(87));
  test('a removed event changes nothing', () =>
    expect(driveScore([ev({ type: 'hard_brake', tier: 'severe', status: 'removed' })], 6, 0, EXP6)).toBe(100));
  test('Attention only on a watched drive', () => {
    expect(driveScore([ev({ type: 'drowsy', tier: 'severe' })], 5, 0, EXP6)).toBe(100);
  });
});

describe('weightedScore and categoryScore (Attention)', () => {
  test('weighted mean of the scored categories, Speed double', () => {
    expect(weightedScore({ acceleration: 90, braking: 80, turning: 70, attention: null, speed: 60 })).toBe((90 + 80 + 70 + 2 * 60) / 5);
    expect(weightedScore({ acceleration: 90, braking: 80, turning: 70, attention: 50, speed: 60 })).toBe((90 + 80 + 70 + 50 + 2 * 60) / 6);
    expect(weightedScore({})).toBeNull();
    expect(weightedScore({ speed: Number.NaN })).toBeNull();
  });

  test.each([
    [40, 10, 10, 80],
    [0, 5, 10, 100],
    [40, 2, 10, 80],
    [160, 10, 10, 50],
  ])('categoryScore(%f, %f, %f) = %f', (p, m, floor, s) => expect(categoryScore(p, m, floor)).toBe(s));

  test('a negative or non-finite penalty reads as 0; non-finite miles as the floor', () => {
    expect(categoryScore(-5, 10, 10)).toBe(100);
    expect(categoryScore(Number.NaN, 10, 10)).toBe(100);
    expect(categoryScore(40, Number.NaN, 10)).toBe(80);
  });

  test('watchedMiles: the miles × the covered share of the moving seconds', () => {
    expect(watchedMiles(10, 600, 300)).toBe(5);
    expect(watchedMiles(10, 600, 900)).toBe(10);
    expect(watchedMiles(10, 0, 300)).toBe(0);
    expect(watchedMiles(0, 600, 300)).toBe(0);
  });
});

test('the barrel exports the rating API and none of the old one', () => {
  expect(barrel.ratingAt).toBe(ratingAt);
  expect(barrel.driveScore).toBe(driveScore);
  expect(barrel.estimateExposure).toBe(estimateExposure);
  const names = Object.keys(barrel);
  for (const gone of [
    'axisPenalties',
    'zeroAxisPenalties',
    'axisScores',
    'safetyRatingOf',
    'safetyRating',
    'attentionDeficit',
    'levelForPoints',
    'MAX_LEVEL',
    'LEVEL_STEP',
    'DRIVE_SCORE_MIN_MILES',
  ]) {
    expect(names).not.toContain(gone);
  }
});
