import * as barrel from '../src';
import type { DriveEvent } from '../src/drive';
import {
  ATTENTION_LENGTH_MAX,
  ATTENTION_MIN_MILES,
  ATTENTION_PENALTY,
  ATTENTION_REF_S,
  AXES,
  AXIS_WEIGHT,
  BASELINE,
  CATEGORY_K,
  DASHPAL_AXIS,
  DRIVE_ATTENTION_MIN_MILES,
  ESTIMATE_KNOTS,
  EXPOSURE_MAX,
  HARD_EVENT_MIN_G,
  HARD_EVENT_WEIGHT,
  HARD_EVENT_WEIGHT_MAX,
  LEGACY_MEAN_OVER_MPH,
  OVER_CAP_MPH,
  OVER_REF_MPH,
  PHONE_PICKUP_WEIGHT_S,
  RANKED_MIN_MILES,
  RATE_AXES,
  RATING_HALF_LIFE_DAYS,
  RATING_WINDOW_DAYS,
  RECENCY_WEIGHT,
  SPEED_FACTOR,
  TYPICAL_SCORE,
  attentionWeight,
  axisOf,
  categoryScore,
  clampExposure,
  driveLoads,
  driveScore,
  estimateExposure,
  eventWeight,
  hardEventWeight,
  phoneInHandS,
  phonePickupWeight,
  ratingAt,
  rateScore,
  recencyWeight,
  speedFactor,
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
const exp = (slowdowns: number, speedups: number, turns: number, limitS: number, movingS: number, phoneS = 0): Exposure => ({
  slowdowns,
  speedups,
  turns,
  limitS,
  movingS,
  phoneS,
});
const EXP6 = exp(15, 15, 9, 840, 1136);
const roundTo4 = (v: number): number => Math.round(Math.round(v * 1e4 * 1e9) / 1e9) / 1e4;

describe('categories', () => {
  test('the six axes in radar order, clockwise from the top; Attention is the DashPal one', () => {
    expect(AXES).toEqual(['acceleration', 'braking', 'turning', 'attention', 'phone', 'speed']);
    expect(RATE_AXES).toEqual(['acceleration', 'braking', 'turning', 'phone', 'speed']);
    expect(DASHPAL_AXIS).toBe('attention');
  });

  test('Speed and Phone use count double, the rest single', () =>
    expect(AXIS_WEIGHT).toEqual({ speed: 2, phone: 2, braking: 1, acceleration: 1, turning: 1, attention: 1 }));

  test('axisOf: each type to its category; anything else (a stored phone handling type) to none', () => {
    expect(axisOf('speeding')).toBe('speed');
    expect(axisOf('hard_brake')).toBe('braking');
    expect(axisOf('hard_accel')).toBe('acceleration');
    expect(axisOf('hard_corner')).toBe('turning');
    expect(axisOf('eyes_off')).toBe('attention');
    expect(axisOf('drowsy')).toBe('attention');
    expect(axisOf('phone_pickup')).toBe('phone');
    expect(axisOf('phone_handling')).toBeNull();
    expect(axisOf('tailgating')).toBeNull();
  });

  test('the constants', () => {
    expect([RATING_WINDOW_DAYS, RATING_HALF_LIFE_DAYS, RANKED_MIN_MILES, TYPICAL_SCORE]).toEqual([90, 21, 10, 85]);
    expect(BASELINE).toEqual({
      braking: { rate: 0.01, prior: 60, floor: 10 },
      acceleration: { rate: 0.008, prior: 60, floor: 10 },
      turning: { rate: 0.008, prior: 60, floor: 10 },
      speed: { rate: 0.04, prior: 3600, floor: 600 },
      phone: { rate: 0.04, prior: 3600, floor: 600 },
    });
    expect(PHONE_PICKUP_WEIGHT_S).toBe(10);
    expect(HARD_EVENT_WEIGHT).toEqual({ minor: 1, severe: 2 });
    expect(HARD_EVENT_WEIGHT_MAX).toBe(4);
    expect(HARD_EVENT_MIN_G).toEqual({ hard_brake: 0.3, hard_accel: 0.32, hard_corner: 0.4 });
    expect(SPEED_FACTOR).toEqual({ minMph: 10, refMph: 30, maxMph: 80 });
    expect([ATTENTION_REF_S, ATTENTION_LENGTH_MAX]).toEqual([5, 3]);
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

describe('speedingWeight: every second over the line × (over / 5)^1.5', () => {
  test.each([
    [30, 125, 'minor', 22.82177322938192],
    [25, 160, 'moderate', 36.20386719675123],
    [65, 720, 'severe', 214.3320213701522],
    [3, 0, 'minor', 0],
    [60, 0, 'severe', 0],
    [10, 100000, 'severe', 226.27416997969522], // the mean over capped at 40
    [30, null, 'minor', 7.58946638440411],
    [30, null, 'moderate', 44.466841578866386],
    [30, null, 'severe', 111.54192037077361],
  ] as const)('(%f s, %s mph·s, %s) = %f', (d, over, tier, w) => expect(speedingWeight(d, over, tier)).toBe(w));

  test('a non-finite overMphS reads as the tier mean; a negative one as nothing over', () => {
    expect(speedingWeight(30, Number.NaN, 'minor')).toBe(speedingWeight(30, null, 'minor'));
    expect(speedingWeight(30, -10, 'severe')).toBe(0);
  });

  test('no grace: one second 1 mph over the line weighs a little, never nothing; longer and further over weighs more', () => {
    expect(speedingWeight(1, 1, 'minor')).toBeCloseTo(0.2 * Math.sqrt(0.2), 12);
    expect(speedingWeight(1, 1, 'minor')).toBeGreaterThan(0);
    expect(speedingWeight(10, 10, 'minor')).toBeCloseTo(10 * speedingWeight(1, 1, 'minor'), 12);
    expect(speedingWeight(10, 100, 'moderate')).toBeGreaterThan(speedingWeight(10, 50, 'moderate'));
    expect(speedingWeight(20, 100, 'moderate')).toBeGreaterThan(speedingWeight(10, 50, 'moderate'));
  });
});

describe('the severity of the other events', () => {
  test('speedFactor: the speed over 30 mph, read between 10 and 80; 1 without a speed', () => {
    expect(speedFactor(30)).toBe(1);
    expect(speedFactor(60)).toBe(2);
    expect(speedFactor(10)).toBe(1 / 3);
    expect(speedFactor(4)).toBe(1 / 3);
    expect(speedFactor(120)).toBe(80 / 30);
    expect(speedFactor(null)).toBe(1);
    expect(speedFactor(Number.NaN)).toBe(1);
  });

  test('hardEventWeight: (peak / threshold)² between 1 and 4; the tier without a peak', () => {
    expect(hardEventWeight('hard_brake', 'minor', 0.3)).toBe(1);
    expect(hardEventWeight('hard_brake', 'severe', 0.45)).toBe((0.45 / 0.3) * (0.45 / 0.3));
    expect(hardEventWeight('hard_brake', 'severe', 0.6)).toBe(4);
    expect(hardEventWeight('hard_brake', 'severe', 2)).toBe(4);
    expect(hardEventWeight('hard_accel', 'minor', 0.4)).toBe((0.4 / 0.32) * (0.4 / 0.32));
    expect(hardEventWeight('hard_corner', 'minor', 0.5)).toBe((0.5 / 0.4) * (0.5 / 0.4));
    expect(hardEventWeight('hard_corner', 'minor', 0.2)).toBe(1);
    expect(hardEventWeight('hard_brake', 'minor', null)).toBe(1);
    expect(hardEventWeight('hard_brake', 'severe', null)).toBe(2);
    expect(hardEventWeight('hard_brake', 'moderate', Number.NaN)).toBe(1);
  });

  test('phonePickupWeight: (10 + seconds in hand) × the speed factor of its top speed (else its start speed, else 1)', () => {
    expect(phonePickupWeight(ev({ type: 'phone_pickup', tier: 'moderate', durationS: 5, measured: { speedMph: 20, maxSpeedMph: 30 } }))).toBe(15);
    expect(phonePickupWeight(ev({ type: 'phone_pickup', tier: 'severe', durationS: 20, measured: { speedMph: 40, maxSpeedMph: 60 } }))).toBe(60);
    expect(phonePickupWeight(ev({ type: 'phone_pickup', tier: 'moderate', durationS: 5, measured: { speedMph: 10, maxSpeedMph: 10 } }))).toBe(5);
    expect(phonePickupWeight(ev({ type: 'phone_pickup', tier: 'moderate', durationS: 5, measured: { speedMph: 45 } }))).toBe(22.5);
    expect(phonePickupWeight(ev({ type: 'phone_pickup', tier: 'moderate', durationS: 5 }))).toBe(15);
  });

  test('attentionWeight: the base × the speed factor × its length over 5 s (between 1 and 3); 0 for anything else', () => {
    const dc = (type: 'eyes_off' | 'drowsy', durationS: number, speedMph?: number, status?: 'removed') =>
      ev({ type, tier: 'severe', durationS, status, measured: speedMph === undefined ? { source: 'dashcam' } : { source: 'dashcam', speedMph } });
    expect(attentionWeight(dc('eyes_off', 4, 30))).toBe(40);
    expect(attentionWeight(dc('drowsy', 5, 30))).toBe(50);
    expect(attentionWeight(dc('eyes_off', 4, 60))).toBe(80);
    expect(attentionWeight(dc('eyes_off', 10, 30))).toBe(80);
    expect(attentionWeight(dc('drowsy', 60, 90))).toBe(50 * (80 / 30) * 3);
    expect(attentionWeight(dc('eyes_off', 4))).toBe(40);
    expect(attentionWeight(dc('eyes_off', Number.NaN, 15))).toBe(40 * 0.5);
    expect(attentionWeight(dc('drowsy', 10, 30, 'removed'))).toBe(0);
    expect(attentionWeight(ev({ type: 'hard_brake', tier: 'severe' }))).toBe(0);
  });
});

describe('eventWeight', () => {
  test('hard events by their peak; without one, minor 1 / severe 2 (a two-level type reads moderate as minor)', () => {
    expect(eventWeight(ev({ type: 'hard_brake', tier: 'minor' }))).toBe(1);
    expect(eventWeight(ev({ type: 'hard_accel', tier: 'severe' }))).toBe(2);
    expect(eventWeight(ev({ type: 'hard_corner', tier: 'moderate' }))).toBe(1);
    expect(eventWeight(ev({ type: 'hard_brake', tier: 'minor', measured: { peakG: 0.36 } }))).toBe((0.36 / 0.3) * (0.36 / 0.3));
    expect(eventWeight(ev({ type: 'hard_brake', tier: 'severe', measured: { peakG: 'x' as unknown as number } }))).toBe(2);
  });

  test('speeding by its measured overMphS, else its tier mean', () => {
    expect(eventWeight(ev({ type: 'speeding', tier: 'minor', durationS: 30, measured: { overMphS: 125 } }))).toBe(22.82177322938192);
    expect(eventWeight(ev({ type: 'speeding', tier: 'severe', durationS: 30 }))).toBe(111.54192037077361);
    expect(eventWeight(ev({ type: 'speeding', tier: 'severe', durationS: 30, measured: { overMphS: 'x' as unknown as number } }))).toBe(
      111.54192037077361
    );
  });

  test('a phone pickup without a speed: 10 plus its seconds in hand, whatever its tier', () => {
    expect(eventWeight(ev({ type: 'phone_pickup', tier: 'moderate', durationS: 1 }))).toBe(11);
    expect(eventWeight(ev({ type: 'phone_pickup', tier: 'moderate', durationS: 15 }))).toBe(25);
    expect(eventWeight(ev({ type: 'phone_pickup', tier: 'severe', durationS: 24 }))).toBe(34);
    expect(eventWeight(ev({ type: 'phone_pickup', tier: 'severe', durationS: 2.5 }))).toBe(12.5);
  });

  test("a pickup's seconds in hand are finite and clamped to 0..43 200", () => {
    expect(phoneInHandS(24)).toBe(24);
    expect(phoneInHandS(-3)).toBe(0);
    expect(phoneInHandS(50_000)).toBe(43_200);
    expect(phoneInHandS(Number.NaN)).toBe(0);
    expect(phoneInHandS(Infinity)).toBe(0);
    expect(eventWeight(ev({ type: 'phone_pickup', tier: 'severe', durationS: Number.NaN }))).toBe(10);
    expect(eventWeight(ev({ type: 'phone_pickup', tier: 'severe', durationS: 1e9 }))).toBe(43_210);
    expect(eventWeight(ev({ type: 'phone_pickup', tier: 'moderate', durationS: -5 }))).toBe(10);
  });

  test('DashPal (weighed on Attention), removed and stored phone handling events weigh 0', () => {
    expect(eventWeight(ev({ type: 'drowsy', tier: 'severe' }))).toBe(0);
    expect(eventWeight(ev({ type: 'hard_brake', tier: 'severe', status: 'removed' }))).toBe(0);
    expect(eventWeight(ev({ type: 'phone_pickup', tier: 'severe', durationS: 30, status: 'removed' }))).toBe(0);
    expect(eventWeight(ev({ type: 'phone_handling' as DriveEvent['type'], tier: 'severe' }))).toBe(0);
  });
});

describe('exposure', () => {
  test('clampExposure: finite whole numbers, capped, limitS ≤ movingS and phoneS ≤ movingS', () => {
    expect(clampExposure({ slowdowns: 3.9, speedups: -2, turns: Number.NaN, limitS: 500, movingS: 400 })).toEqual(exp(3, 0, 0, 400, 400));
    expect(clampExposure({ slowdowns: 1e9, speedups: 20_001, turns: Infinity, limitS: 1e9, movingS: 1e9, phoneS: 1e9 })).toEqual(
      exp(20_000, 20_000, 0, 43_200, 43_200, 43_200)
    );
    expect(clampExposure({ ...EXP6, phoneS: 1200 })).toEqual({ ...EXP6, phoneS: 1136 });
    expect(clampExposure({ ...EXP6, phoneS: 900.7 })).toEqual({ ...EXP6, phoneS: 900 });
    expect(clampExposure({ ...EXP6, phoneS: -1 })).toEqual({ ...EXP6, phoneS: 0 });
    expect(clampExposure({ ...EXP6, phoneS: Number.NaN })).toEqual({ ...EXP6, phoneS: 0 });
    // counters from before phone use was tracked have no phoneS: it reads 0
    const { phoneS: _p, ...noPhone } = EXP6;
    expect(clampExposure(noPhone)).toEqual({ ...EXP6, phoneS: 0 });
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

  test('the estimate never claims phone seconds: such a drive was not watched for phone use', () => {
    for (const [mi, s] of [
      [8, 1600],
      [40, 2900],
      [500, 200_000],
    ] as const) {
      expect(estimateExposure(mi, s).phoneS).toBe(0);
    }
  });

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
    expect(loads.rates.speed).toEqual({ weight: 36.20386719675123, count: 25, opportunities: 840 });
    expect(loads.rates.phone).toEqual({ weight: 0, count: 0, opportunities: 0 });
    expect(loads.attentionPenalty).toBe(90);
  });

  test('every event weighs by its severity: peaks, the speed a pickup was driven at, a DashPal episode\'s speed and length', () => {
    const loads = driveLoads(
      [
        ev({ type: 'hard_brake', tier: 'minor', measured: { peakG: 0.36 } }),
        ev({ type: 'hard_brake', tier: 'severe', measured: { peakG: 0.6 } }),
        ev({ type: 'hard_accel', tier: 'minor', measured: { peakG: 0.32 } }),
        ev({ type: 'phone_pickup', tier: 'moderate', durationS: 5, measured: { speedMph: 30, maxSpeedMph: 45 } }),
        ev({ type: 'eyes_off', tier: 'severe', durationS: 8, measured: { source: 'dashcam', speedMph: 60 } }),
      ],
      exp(15, 15, 9, 840, 1136, 900)
    );
    expect(loads.rates.braking).toEqual({ weight: (0.36 / 0.3) * (0.36 / 0.3) + 4, count: 2, opportunities: 15 });
    expect(loads.rates.acceleration).toEqual({ weight: 1, count: 1, opportunities: 15 });
    expect(loads.rates.phone).toEqual({ weight: 22.5, count: 5, opportunities: 900 });
    expect(loads.attentionPenalty).toBe(40 * 2 * 1.6);
  });

  test('phone: weight sum of (10 + seconds in hand), count sum of seconds in hand, opportunities phoneS', () => {
    const loads = driveLoads(
      [
        ev({ type: 'phone_pickup', tier: 'moderate', durationS: 8 }),
        ev({ type: 'phone_pickup', tier: 'severe', durationS: 24 }),
        ev({ type: 'phone_pickup', tier: 'severe', durationS: 40, status: 'removed' }),
        ev({ type: 'hard_brake', tier: 'minor' }),
      ],
      exp(15, 15, 9, 840, 1136, 900)
    );
    expect(loads.rates.phone).toEqual({ weight: 52, count: 32, opportunities: 900 });
    expect(loads.rates.braking).toEqual({ weight: 1, count: 1, opportunities: 15 });
  });

  test('a legacy speeding event (no overMphS) uses its tier mean', () => {
    const loads = driveLoads([ev({ type: 'speeding', tier: 'minor', durationS: 30 })], EXP6);
    expect(loads.rates.speed).toEqual({ weight: 7.58946638440411, count: 30, opportunities: 840 });
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
      rating: 83.3,
      ranked: false,
      miles: 6,
      scores: {
        braking: 72.64957264957265,
        acceleration: 87.62886597938144,
        turning: 86.69623059866963,
        speed: 84.8134771697258,
        attention: null,
        phone: null,
      },
    });
  });

  test('pin B: A plus a 20-mi drive 10 days ago', () => {
    expect(ratingAt([pinA, pinB], AT)).toEqual({
      rating: 82.4,
      ranked: true,
      miles: 26,
      scores: {
        braking: 65.93366008869643,
        acceleration: 79.68828603627973,
        turning: 89.14703209011581,
        speed: 88.57795986947009,
        attention: null,
        phone: null,
      },
    });
  });

  test('pin C: B plus a DashPal-watched 30-mi drive 40 days ago', () => {
    expect(ratingAt([pinA, pinB, pinC], AT)).toEqual({
      rating: 82.1,
      ranked: true,
      miles: 56,
      scores: {
        braking: 66.5022298398257,
        acceleration: 80.09658912192572,
        turning: 79.78673027342722,
        speed: 86.38393595803475,
        attention: 93.74047948255254,
        phone: null,
      },
    });
  });

  test('pin D: no drives', () => {
    expect(ratingAt([], AT)).toEqual({
      rating: null,
      ranked: false,
      miles: 0,
      scores: { acceleration: null, braking: null, turning: null, attention: null, phone: null, speed: null },
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
        phone: null,
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

  test('a removed event weighs nothing; a stored phone handling event weighs nothing', () => {
    const clean = ratingAt([drive({ ageDays: 0 })], AT);
    const removed = drive({ ageDays: 0, events: [ev({ type: 'hard_brake', tier: 'severe', status: 'removed' })] });
    const phone = drive({ ageDays: 0, events: [ev({ type: 'phone_handling' as DriveEvent['type'], tier: 'severe' })] });
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

// Phone use: pickups per second at driving speed. P1 today (900 s at driving speed, an 8 s and a
// 24 s pickup), P2 5 days ago (2700 s, one 40 s pickup and a removed one), P3 30 days ago (watched
// for phone use, no pickup). The 0026 pgTAP stores the same drives and pins the same digits.
const pinP1 = drive({
  ageDays: 0,
  id: 'p1',
  exposure: exp(15, 15, 9, 840, 1136, 900),
  events: [
    ev({ type: 'phone_pickup', tier: 'moderate', durationS: 8, startedAt: AT - 3_000_000, measured: { speedMph: 24.5, maxSpeedMph: 31.2 } }),
    ev({ type: 'hard_brake', tier: 'minor', startedAt: AT - 2_900_000 }),
    ev({ type: 'phone_pickup', tier: 'severe', durationS: 24, startedAt: AT - 2_800_000, measured: { speedMph: 40.1, maxSpeedMph: 44.8 } }),
  ],
});
const pinP2 = drive({
  ageDays: 5,
  id: 'p2',
  miles: 25,
  exposure: exp(45, 45, 25, 2400, 3300, 2700),
  events: [
    ev({ type: 'phone_pickup', tier: 'severe', durationS: 40 }),
    ev({ type: 'phone_pickup', tier: 'severe', durationS: 60, status: 'removed' }),
    ev({ type: 'speeding', tier: 'minor', durationS: 30, measured: { overMphS: 125 } }),
  ],
});
const pinP3 = drive({ ageDays: 30, id: 'p3', miles: 12, exposure: exp(20, 20, 12, 1500, 1900, 1600) });

/** Pin Q: one drive an hour old, every kind of event at its own severity, watched by DashPal (0028's SQL test pins it too). */
const Q_START = AT - 3_600_000;
const q = (n: number, type: DriveEvent['type'], tier: DriveEvent['tier'], at: number, durationS: number, measured: DriveEvent['measured']): DriveEvent => ({
  id: `a1000000-0000-4000-8000-00000000000${n}`,
  type,
  tier,
  startedAt: Q_START + at * 1000,
  durationS,
  measured,
});
const pinQ = drive({
  ageDays: 0,
  id: 'q',
  startedAt: Q_START,
  miles: 15,
  watchedMiles: 15,
  exposure: exp(20, 18, 11, 1500, 1800, 1700),
  events: [
    q(1, 'hard_brake', 'minor', 60, 2, { peakG: 0.36 }),
    q(2, 'hard_brake', 'severe', 120, 2, { peakG: 0.62 }),
    q(3, 'hard_accel', 'minor', 180, 2, { peakG: 0.4 }),
    q(4, 'hard_corner', 'severe', 240, 2, { peakG: 0.5 }),
    q(5, 'speeding', 'minor', 300, 3, { overMphS: 4.5 }),
    q(6, 'speeding', 'moderate', 400, 12, { overMphS: 72 }),
    q(7, 'phone_pickup', 'moderate', 500, 6, { speedMph: 22, maxSpeedMph: 52.5 }),
    q(8, 'eyes_off', 'severe', 600, 12.5, { source: 'dashcam', speedMph: 47.3 }),
    q(9, 'drowsy', 'severe', 700, 3, { source: 'dashcam', speedMph: 61 }),
  ],
});

describe('ratingAt: every event at its own severity', () => {
  test('pin Q: peaks, a short speeding, a fast pickup and two DashPal episodes, to the digit', () => {
    expect(ratingAt([pinQ], AT)).toEqual({
      rating: 70.8,
      ranked: true,
      miles: 15,
      scores: {
        acceleration: 63.38621493232948,
        braking: 42.875157629255995,
        turning: 61.17781227230969,
        attention: 48.06408544726301,
        phone: 87.4757281553398,
        speed: 87.82410285072866,
      },
    });
  });

  test('pin Q: each event weighs something', () => {
    const loads = driveLoads(pinQ.events, pinQ.exposure);
    expect(loads.rates.braking.weight).toBe(1.44 + 4);
    expect(loads.rates.acceleration.weight).toBe(1.5625);
    expect(loads.rates.turning.weight).toBe(1.5625);
    expect(loads.rates.speed).toEqual({ weight: 0.49295030175464943 + 15.774409656148782, count: 15, opportunities: 1500 });
    expect(loads.rates.phone).toEqual({ weight: 28, count: 6, opportunities: 1700 });
    expect(loads.attentionPenalty).toBe(157.66666666666666 + 101.66666666666666);
  });

  test('the same event marks a long drive down less than a short one', () => {
    const sp = ev({ type: 'speeding', tier: 'moderate', durationS: 12, measured: { overMphS: 72 } });
    const short = driveScore([sp], 10, 0, exp(10, 10, 6, 1000, 1150))!;
    const long = driveScore([sp], 60, 0, exp(60, 60, 36, 6000, 6900))!;
    expect(long).toBeGreaterThan(short);
    expect(short).toBeLessThan(100);
    const brake = ev({ type: 'hard_brake', tier: 'minor', measured: { peakG: 0.31 } });
    expect(driveScore([brake], 60, 0, exp(60, 60, 36, 6000, 6900))!).toBeGreaterThan(driveScore([brake], 10, 0, exp(10, 10, 6, 1000, 1150))!);
  });
});

describe('ratingAt: Phone use', () => {
  test('pin P: three drives watched for phone use, three pickups (one removed)', () => {
    expect(ratingAt([pinP1, pinP2, pinP3], AT)).toEqual({
      rating: 88.3,
      ranked: true,
      miles: 43,
      scores: {
        acceleration: 91.9280828053141,
        braking: 81.02731927681675,
        turning: 89.93932012720053,
        attention: null,
        phone: 86.73833371909146,
        speed: 90.7045529239451,
      },
    });
  });

  test('pin P1 alone: the phone axis by hand', () => {
    // W = (10 + 8) x 31.2 / 30 + (10 + 24) x 44.8 / 30, O = max(900, 32) = 900: r = (W + 3600 x 0.04) / (900 + 3600)
    const r = ratingAt([pinP1], AT);
    const w = (10 + 8) * (31.2 / 30) + (10 + 24) * (44.8 / 30);
    expect(r.scores.phone).toBeCloseTo(100 / (1 + ((w + 144) / 4500 / 0.04) * (15 / 85)), 12);
    expect(r.scores.phone).toBe(82.6919750951228);
    expect(r.rating).toBe(83.9);
  });

  test('not tracked, no score: Phone use is null while the window has no phone seconds and no pickups', () => {
    expect(ratingAt([drive({ ageDays: 0 })], AT).scores.phone).toBeNull();
    expect(ratingAt([pinA, pinB, pinC], AT).scores.phone).toBeNull();
    // one drive watched for phone use (even with no pickup) scores it for the whole window
    const watched = ratingAt([pinA, pinB, pinC, pinP3], AT);
    expect(watched.scores.phone).toBe(86.84607964455184);
    // a pickup on a drive with no phone seconds still counts: its seconds in hand are its opportunities
    const lone = ratingAt([drive({ ageDays: 0, events: [ev({ type: 'phone_pickup', tier: 'moderate', durationS: 12 })] })], AT);
    expect(lone.scores.phone).toBe(100 / (1 + ((22 + 144) / (12 + 3600) / 0.04) * (15 / 85)));
    // a removed pickup on such a drive leaves nothing to judge
    const removed = drive({ ageDays: 0, events: [ev({ type: 'phone_pickup', tier: 'severe', durationS: 30, status: 'removed' })] });
    expect(ratingAt([removed], AT).scores.phone).toBeNull();
  });

  test('every drive recorded before phone tracking (phoneS 0, no pickups) scores exactly as before', () => {
    // pins A-F hold their pre-phone values above; here the same drives with the counter absent
    const strip = (d: RatingDrive): RatingDrive => {
      const { phoneS: _p, ...rest } = d.exposure;
      return { ...d, exposure: rest as Exposure };
    };
    for (const set of [[pinA], [pinA, pinB], [pinA, pinB, pinC], [drive({ ageDays: 0 })]]) {
      const now = ratingAt(set, AT);
      expect(ratingAt(set.map(strip), AT)).toEqual(now);
      expect(now.scores.phone).toBeNull();
      // the rating is the five-category weighted mean it always was
      const { phone: _ph, ...five } = now.scores;
      const w = { acceleration: 1, braking: 1, turning: 1, attention: 1, speed: 2 } as const;
      let num = 0;
      let den = 0;
      for (const k of ['acceleration', 'braking', 'turning', 'attention', 'speed'] as const) {
        const s = five[k];
        if (s === null) continue;
        num += w[k] * s;
        den += w[k];
      }
      expect(now.rating).toBe(Math.round(Math.round((num / den) * 10 * 1e9) / 1e9) / 10);
    }
  });

  test('pins the 0026 pgTAP stores too: one pickup on a drive with no phone seconds; a drive watched with no pickup', () => {
    const lone = drive({ ageDays: 0, events: [ev({ type: 'phone_pickup', tier: 'moderate', durationS: 12 })] });
    expect(ratingAt([lone], AT)).toEqual({
      rating: 86.2,
      ranked: false,
      miles: 6,
      scores: { acceleration: 87.62886597938144, braking: 87.62886597938144, turning: 86.69623059866963, attention: null, phone: 83.14241611828743, speed: 87.48261474269819 },
    });
    const quiet = drive({ ageDays: 0, exposure: exp(15, 15, 9, 840, 1136, 900) });
    expect(ratingAt([quiet], AT)).toEqual({
      rating: 87.5,
      ranked: false,
      miles: 6,
      scores: { acceleration: 87.62886597938144, braking: 87.62886597938144, turning: 86.69623059866963, attention: null, phone: 87.62886597938144, speed: 87.48261474269819 },
    });
  });

  test('sums are order-stable with pickups too', () => {
    const want = ratingAt([pinP1, pinP2, pinP3], AT);
    expect(ratingAt([pinP3, pinP2, pinP1], AT)).toEqual(want);
    expect(ratingAt([{ ...pinP1, events: [...pinP1.events].reverse() }, pinP2, pinP3], AT)).toEqual(want);
  });
});

describe('driveScore: the same curves over one drive, no prior, opportunities floored', () => {
  test('a clean drive is 100', () => expect(driveScore([], 6, 0, EXP6)).toBe(100));
  test('one minor hard brake on 6 mi is 89', () =>
    expect(driveScore([ev({ type: 'hard_brake', tier: 'minor' })], 6, 0, EXP6)).toBe(89));
  test('a severe hard brake on 2 mi is 84', () =>
    expect(driveScore([ev({ type: 'hard_brake', tier: 'severe' })], 2, 0, exp(4, 4, 3, 240, 300))).toBe(84));
  test('a minute at 15 over on 6 mi is 75', () =>
    expect(driveScore([ev({ type: 'speeding', tier: 'severe', durationS: 60, measured: { overMphS: 900 } })], 6, 0, EXP6)).toBe(75));
  test('a drowsy on 5 watched mi is 94', () => expect(driveScore([ev({ type: 'drowsy', tier: 'severe' })], 5, 5, EXP6)).toBe(94));
  test('no miles, no score', () => expect(driveScore([], 0, 0, EXP6)).toBeNull());
  test('the floors: a minor hard brake on 0.3 mi is 87', () =>
    expect(driveScore([ev({ type: 'hard_brake', tier: 'minor' })], 0.3, 0, exp(1, 1, 1, 108, 132))).toBe(87));
  test('a removed event changes nothing', () =>
    expect(driveScore([ev({ type: 'hard_brake', tier: 'severe', status: 'removed' })], 6, 0, EXP6)).toBe(100));
  test('Attention only on a watched drive', () => {
    expect(driveScore([ev({ type: 'drowsy', tier: 'severe' })], 5, 0, EXP6)).toBe(100);
  });
  test('a drive watched for phone use with no pickup is 100', () => expect(driveScore([], 6, 0, exp(15, 15, 9, 840, 1136, 900))).toBe(100));
  test('a 20 s pickup on 900 s at driving speed is 96', () =>
    expect(driveScore([ev({ type: 'phone_pickup', tier: 'severe', durationS: 20 })], 6, 0, exp(15, 15, 9, 840, 1136, 900))).toBe(96));
  test('the floor: a 5 s pickup on 200 s at driving speed reads over 600 s, 97', () =>
    expect(driveScore([ev({ type: 'phone_pickup', tier: 'moderate', durationS: 5 })], 2, 0, exp(4, 4, 3, 200, 300, 200))).toBe(97));
  test('a pickup on a drive with no phone seconds still scores Phone use (over the 600 s floor), 97', () =>
    expect(driveScore([ev({ type: 'phone_pickup', tier: 'moderate', durationS: 5 })], 6, 0, EXP6)).toBe(97));
  test('no phone seconds and no pickup: Phone use left out, the drive scores as before', () => {
    expect(driveScore([ev({ type: 'hard_brake', tier: 'minor' })], 6, 0, EXP6)).toBe(89);
    expect(driveScore([ev({ type: 'phone_pickup', tier: 'severe', durationS: 30, status: 'removed' })], 6, 0, EXP6)).toBe(100);
  });
});

describe('weightedScore and categoryScore (Attention)', () => {
  test('weighted mean of the scored categories, Speed and Phone use double', () => {
    expect(weightedScore({ acceleration: 90, braking: 80, turning: 70, attention: null, speed: 60 })).toBe((90 + 80 + 70 + 2 * 60) / 5);
    expect(weightedScore({ acceleration: 90, braking: 80, turning: 70, attention: 50, speed: 60 })).toBe((90 + 80 + 70 + 50 + 2 * 60) / 6);
    expect(weightedScore({ acceleration: 90, braking: 80, turning: 70, attention: null, phone: 40, speed: 60 })).toBe((90 + 80 + 70 + 2 * 40 + 2 * 60) / 7);
    expect(weightedScore({ acceleration: 90, braking: 80, turning: 70, attention: 50, phone: 40, speed: 60 })).toBe((90 + 80 + 70 + 50 + 2 * 40 + 2 * 60) / 8);
    expect(weightedScore({ acceleration: 90, braking: 80, turning: 70, attention: null, phone: null, speed: 60 })).toBe((90 + 80 + 70 + 2 * 60) / 5);
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
