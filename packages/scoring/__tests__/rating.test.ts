import * as barrel from '../src';
import type { DriveEvent } from '../src/drive';
import {
  ATTENTION_LENGTH_MAX,
  ATTENTION_PENALTY,
  ATTENTION_REF_S,
  AXES,
  AXIS_WEIGHT,
  BASELINE,
  DASHPAL_AXIS,
  ESTIMATE_KNOTS,
  EXPOSURE_MAX,
  HARD_EVENT_MIN_G,
  HARD_EVENT_WEIGHT,
  HARD_EVENT_WEIGHT_MAX,
  LEGACY_MEAN_OVER_MPH,
  OVER_REF_LIMIT_DIVISOR,
  OVER_REF_MPH,
  OVER_X_CAP,
  PHONE_PICKUP_WEIGHT_S,
  PHONE_DRIVE_REF_S,
  RANKED_MIN_MILES,
  RATE_AXES,
  RATING_HALF_LIFE_DAYS,
  RATING_WINDOW_DAYS,
  RECENCY_WEIGHT,
  SPEED_FACTOR,
  TYPICAL_SCORE,
  attentionWeight,
  axisOf,
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
  speedingRefMph,
  OVER_REF_MIN_LIMIT_MPH,
  speedingWeight,
  watchedMiles,
  watchedSeconds,
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
    // every category is judged per opportunity, Attention per watched second
    expect(RATE_AXES).toEqual(['acceleration', 'braking', 'turning', 'attention', 'phone', 'speed']);
    expect(DASHPAL_AXIS).toBe('attention');
  });

  test('Phone use, Speed and Attention weigh 3, Braking 2, Acceleration and Turning 1', () =>
    expect(AXIS_WEIGHT).toEqual({ speed: 3, phone: 3, attention: 3, braking: 2, acceleration: 1, turning: 1 }));

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
      braking: { rate: 0.01, prior: 60, floor: 60 },
      acceleration: { rate: 0.008, prior: 60, floor: 60 },
      turning: { rate: 0.008, prior: 60, floor: 60 },
      speed: { rate: 0.04, prior: 3600, floor: 3600 },
      phone: { rate: 0.04, prior: 3600 },
      attention: { rate: 0.024, prior: 3600, floor: 3600 },
    });
    expect(PHONE_PICKUP_WEIGHT_S).toBe(10);
    expect(PHONE_DRIVE_REF_S).toBe(240);
    expect(HARD_EVENT_WEIGHT).toEqual({ minor: 1, severe: 2 });
    expect(HARD_EVENT_WEIGHT_MAX).toBe(4);
    expect(HARD_EVENT_MIN_G).toEqual({ hard_brake: 0.36, hard_accel: 0.4, hard_corner: 0.48 });
    expect(SPEED_FACTOR).toEqual({ minMph: 10, refMph: 30, maxMph: 80 });
    expect([ATTENTION_REF_S, ATTENTION_LENGTH_MAX]).toEqual([5, 3]);
    expect([OVER_REF_LIMIT_DIVISOR, OVER_REF_MPH, OVER_X_CAP]).toEqual([7, 5, 5]);
    expect(LEGACY_MEAN_OVER_MPH).toEqual({ minor: 2, moderate: 6.5, severe: 12 });
    expect(ATTENTION_PENALTY).toEqual({ eyes_off: 40, drowsy: 80 });
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

describe('speedingWeight: every second over the line × (mean over / (limit / 7))², x capped at 5', () => {
  // without a limit the reference is 5 mph (a 35 mph limit's); the 0023 pgTAP pins the same digits
  test.each([
    [30, 125, 'minor', 20.833333333333336],
    [25, 160, 'moderate', 40.96],
    [65, 720, 'severe', 319.0153846153846],
    [3, 0, 'minor', 0],
    [60, 0, 'severe', 0],
    [10, 100000, 'severe', 250], // x capped at 5: 25 a second
    [30, null, 'minor', 4.800000000000001],
    [30, null, 'moderate', 50.7],
    [30, null, 'severe', 172.79999999999998],
  ] as const)('(%f s, %s mph·s, %s) = %f', (d, over, tier, w) => expect(speedingWeight(d, over, tier)).toBe(w));

  // the 0048 pgTAP pins the same digits
  test.each([
    // 5 mph over for 30 s: at 25 mph x = 1.4, at 35 mph 1, at 65 mph 0.54
    [30, 150, 'moderate', 25, 58.8],
    [30, 150, 'moderate', 35, 30],
    [30, 150, 'moderate', 65, 8.698224852071005],
    // no usable limit: the 5 mph reference
    [30, 150, 'moderate', null, 30],
    [30, 150, 'moderate', 0, 30],
    [30, 150, 'moderate', -5, 30],
    // an older event without overMphS: its tier's mean over (2, 6.5, 12) through the same formula
    [30, null, 'minor', 25, 9.407999999999998],
    [30, null, 'moderate', 25, 99.37199999999999],
    [30, null, 'severe', 25, 338.688],
    [30, null, 'minor', 65, 1.3917159763313607],
    [30, null, 'moderate', 65, 14.7],
    [30, null, 'severe', 65, 50.10177514792898],
    // x capped at 5 (25 a second): 25 over at 35 mph is the cap, just under it is not
    [10, 100000, 'severe', 65, 250],
    [10, 1000, 'severe', 25, 250],
    [10, 250, 'severe', 35, 250],
    [10, 249, 'severe', 35, 248.00399999999996],
  ] as const)('(%f s, %s mph·s, %s, limit %s) = %f', (d, over, tier, limit, w) => expect(speedingWeight(d, over, tier, limit)).toBe(w));

  test('speedingRefMph: the limit over 7; 5 mph without a finite, positive limit', () => {
    expect(speedingRefMph(35)).toBe(5);
    expect(speedingRefMph(25)).toBe(25 / 7);
    expect(speedingRefMph(65)).toBe(65 / 7);
    expect(speedingRefMph(null)).toBe(5);
    expect(speedingRefMph(0)).toBe(5);
    expect(speedingRefMph(-25)).toBe(5);
    expect(speedingRefMph(Number.NaN)).toBe(5);
    expect(speedingRefMph(Infinity)).toBe(5);
    expect(speedingWeight(30, 150, 'moderate', Number.NaN)).toBe(30);
  });

  test('a limit under 1 mph reads the 5 mph reference (0048 pins the same digits); 1 mph is a limit', () => {
    expect(OVER_REF_MIN_LIMIT_MPH).toBe(1);
    expect(speedingRefMph(0.5)).toBe(5);
    expect(speedingRefMph(1e-303)).toBe(5);
    expect(speedingRefMph(1)).toBe(1 / 7);
    expect([speedingWeight(30, 150, 'moderate', 0.5), speedingWeight(1, 1_000_000, 'severe', 1e-303), speedingWeight(30, 150, 'moderate', 1)]).toEqual([30, 25, 750]);
  });

  test('the same mph over weighs more at a lower limit', () => {
    expect(speedingWeight(30, 150, 'moderate', 25)).toBeGreaterThan(speedingWeight(30, 150, 'moderate', 35));
    expect(speedingWeight(30, 150, 'moderate', 35)).toBeGreaterThan(speedingWeight(30, 150, 'moderate', 65));
  });

  test('a non-finite overMphS reads as the tier mean; a negative one as nothing over', () => {
    expect(speedingWeight(30, Number.NaN, 'minor')).toBe(speedingWeight(30, null, 'minor'));
    expect(speedingWeight(30, Number.NaN, 'severe', 25)).toBe(speedingWeight(30, null, 'severe', 25));
    expect(speedingWeight(30, -10, 'severe')).toBe(0);
    expect(speedingWeight(30, -10, 'severe', 25)).toBe(0);
  });

  test('no grace: one second 1 mph over the line weighs a little, never nothing; longer and further over weighs more', () => {
    expect(speedingWeight(1, 1, 'minor')).toBe(0.04000000000000001);
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
    expect(hardEventWeight('hard_brake', 'minor', 0.36)).toBe(1);
    expect(hardEventWeight('hard_brake', 'severe', 0.55)).toBe((0.55 / 0.36) * (0.55 / 0.36));
    expect(hardEventWeight('hard_brake', 'severe', 0.72)).toBe(4);
    expect(hardEventWeight('hard_brake', 'severe', 2)).toBe(4);
    expect(hardEventWeight('hard_accel', 'minor', 0.5)).toBe((0.5 / 0.4) * (0.5 / 0.4));
    expect(hardEventWeight('hard_corner', 'minor', 0.6)).toBe((0.6 / 0.48) * (0.6 / 0.48));
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
    expect(attentionWeight(dc('drowsy', 5, 30))).toBe(80);
    expect(attentionWeight(dc('eyes_off', 4, 60))).toBe(80);
    expect(attentionWeight(dc('eyes_off', 10, 30))).toBe(80);
    expect(attentionWeight(dc('drowsy', 60, 90))).toBe(640);
    expect(attentionWeight(dc('drowsy', 3, 61))).toBe(162.66666666666666);
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
    expect(eventWeight(ev({ type: 'hard_brake', tier: 'minor', measured: { peakG: 0.45 } }))).toBe((0.45 / 0.36) * (0.45 / 0.36));
    expect(eventWeight(ev({ type: 'hard_brake', tier: 'severe', measured: { peakG: 'x' as unknown as number } }))).toBe(2);
  });

  test('speeding by its measured overMphS (else its tier mean) against its measured limit (else 5 mph)', () => {
    expect(eventWeight(ev({ type: 'speeding', tier: 'minor', durationS: 30, measured: { overMphS: 125 } }))).toBe(20.833333333333336);
    expect(eventWeight(ev({ type: 'speeding', tier: 'severe', durationS: 30 }))).toBe(172.79999999999998);
    expect(eventWeight(ev({ type: 'speeding', tier: 'severe', durationS: 30, measured: { overMphS: 'x' as unknown as number } }))).toBe(
      172.79999999999998
    );
    expect(eventWeight(ev({ type: 'speeding', tier: 'moderate', durationS: 30, measured: { overMphS: 150, limitMph: 25 } }))).toBe(58.8);
    // a limit that is not a number reads as none
    expect(eventWeight(ev({ type: 'speeding', tier: 'moderate', durationS: 30, measured: { overMphS: 150, limitMph: '25' as unknown as number } }))).toBe(30);
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
  test('weights, counts and opportunities per category; Attention from the DashPal events over the watched seconds', () => {
    const loads = driveLoads(
      [
        ev({ type: 'hard_brake', tier: 'minor' }),
        ev({ type: 'hard_brake', tier: 'severe' }),
        ev({ type: 'speeding', tier: 'moderate', durationS: 25, measured: { overMphS: 160 } }),
        ev({ type: 'eyes_off', tier: 'severe' }),
        ev({ type: 'drowsy', tier: 'severe' }),
        ev({ type: 'hard_corner', tier: 'severe', status: 'removed' }),
      ],
      EXP6,
      1136
    );
    expect(loads.rates.braking).toEqual({ weight: 3, count: 2, opportunities: 15 });
    expect(loads.rates.acceleration).toEqual({ weight: 0, count: 0, opportunities: 15 });
    expect(loads.rates.turning).toEqual({ weight: 0, count: 0, opportunities: 9 });
    expect(loads.rates.speed).toEqual({ weight: 40.96, count: 25, opportunities: 840 });
    expect(loads.rates.phone).toEqual({ weight: 0, count: 0, opportunities: 0 });
    // eyes off 40 + drowsy 80; the count stays 0 (only watched seconds open Attention)
    expect(loads.rates.attention).toEqual({ weight: 120, count: 0, opportunities: 1136 });
    expect(Object.keys(loads)).toEqual(['rates']);
  });

  test('Attention without watched seconds: the weight is summed, the opportunities are 0; a bad watchedS reads 0', () => {
    const events = [ev({ type: 'drowsy', tier: 'severe' })];
    expect(driveLoads(events, EXP6).rates.attention).toEqual({ weight: 80, count: 0, opportunities: 0 });
    expect(driveLoads(events, EXP6, Number.NaN).rates.attention.opportunities).toBe(0);
    expect(driveLoads(events, EXP6, -5).rates.attention.opportunities).toBe(0);
  });

  test('every event weighs by its severity: peaks, the speed a pickup was driven at, a DashPal episode\'s speed and length', () => {
    const loads = driveLoads(
      [
        ev({ type: 'hard_brake', tier: 'minor', measured: { peakG: 0.45 } }),
        ev({ type: 'hard_brake', tier: 'severe', measured: { peakG: 0.72 } }),
        ev({ type: 'hard_accel', tier: 'minor', measured: { peakG: 0.45 } }),
        ev({ type: 'phone_pickup', tier: 'moderate', durationS: 5, measured: { speedMph: 30, maxSpeedMph: 45 } }),
        ev({ type: 'eyes_off', tier: 'severe', durationS: 8, measured: { source: 'dashcam', speedMph: 60 } }),
      ],
      exp(15, 15, 9, 840, 1136, 900)
    );
    expect(loads.rates.braking).toEqual({ weight: (0.45 / 0.36) * (0.45 / 0.36) + 4, count: 2, opportunities: 15 });
    expect(loads.rates.acceleration).toEqual({ weight: (0.45 / 0.4) * (0.45 / 0.4), count: 1, opportunities: 15 });
    expect(loads.rates.phone).toEqual({ weight: 22.5, count: 5, opportunities: 900 });
    expect(loads.rates.attention).toEqual({ weight: 40 * 2 * 1.6, count: 0, opportunities: 0 });
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
    expect(loads.rates.speed).toEqual({ weight: 4.800000000000001, count: 30, opportunities: 840 });
  });
});

const drive = (p: Partial<RatingDrive> & { ageDays: number }): RatingDrive => {
  const { ageDays, ...rest } = p;
  return { startedAt: AT - ageDays * DAY, miles: 6, watchedS: 0, exposure: EXP6, events: [], ...rest };
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
  watchedS: 2000,
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
      rating: 81.4,
      ranked: false,
      miles: 6,
      scores: {
        braking: 72.64957264957265,
        acceleration: 87.62886597938144,
        turning: 86.69623059866963,
        speed: 84.47488584474887,
        attention: null,
        phone: null,
      },
    });
  });

  test('pin B: A plus a 20-mi drive 10 days ago', () => {
    expect(ratingAt([pinA, pinB], AT)).toEqual({
      rating: 79.5,
      ranked: true,
      miles: 26,
      scores: {
        braking: 65.93366008869643,
        acceleration: 79.68828603627973,
        turning: 89.14703209011581,
        speed: 88.31173295747533,
        attention: null,
        phone: null,
      },
    });
  });

  test('pin C: B plus a DashPal-watched 30-mi drive 40 days ago (2000 watched seconds)', () => {
    expect(ratingAt([pinA, pinB, pinC], AT)).toEqual({
      rating: 79.6,
      ranked: true,
      miles: 56,
      scores: {
        braking: 66.5022298398257,
        acceleration: 80.09658912192572,
        turning: 79.78673027342722,
        speed: 84.79315314921631,
        attention: 85.27547141423663,
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

  test('ranked at exactly 10.00 mi however the floats add up, as the SQL numeric sum is', () => {
    // In start order 0.10 + 8.04 + 1.86 is 9.999999999999998 in floats; the server's numeric(7,2) sum is 10.00.
    const split = (miles: number[]) => miles.map((m, i) => drive({ ageDays: 3 - i, id: `m${i}`, miles: m }));
    const ten = ratingAt(split([0.1, 8.04, 1.86]), AT);
    expect(ten.ranked).toBe(true);
    expect(ten.miles).toBeCloseTo(10, 9);
    expect(ratingAt(split([0.1, 8.03, 1.86]), AT).ranked).toBe(false);
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
  watchedS: 1800,
  exposure: exp(20, 18, 11, 1500, 1800, 1700),
  events: [
    q(1, 'hard_brake', 'minor', 60, 2, { peakG: 0.45 }),
    q(2, 'hard_brake', 'severe', 120, 2, { peakG: 0.75 }),
    q(3, 'hard_accel', 'minor', 180, 2, { peakG: 0.54 }),
    q(4, 'hard_corner', 'severe', 240, 2, { peakG: 0.66 }),
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
      rating: 66.3,
      ranked: true,
      miles: 15,
      scores: {
        acceleration: 60.56350089920356,
        braking: 42.384105960264904,
        turning: 57.58630714983263,
        attention: 64.35707191680784,
        phone: 87.4757281553398,
        speed: 87.73860574551252,
      },
    });
  });

  test('pin Q: each event weighs something', () => {
    const loads = driveLoads(pinQ.events, pinQ.exposure, pinQ.watchedS);
    expect(loads.rates.braking.weight).toBe((0.45 / 0.36) * (0.45 / 0.36) + 4);
    expect(loads.rates.acceleration.weight).toBe((0.54 / 0.4) * (0.54 / 0.4));
    expect(loads.rates.turning.weight).toBe((0.66 / 0.48) * (0.66 / 0.48));
    expect(loads.rates.speed).toEqual({ weight: 0.26999999999999996 + 17.279999999999998, count: 15, opportunities: 1500 });
    expect(loads.rates.speed.weight).toBe(17.549999999999997);
    expect(loads.rates.phone).toEqual({ weight: 28, count: 6, opportunities: 1700 });
    expect(loads.rates.attention).toEqual({ weight: 157.66666666666666 + 162.66666666666666, count: 0, opportunities: 1800 });
    expect(loads.rates.attention.weight).toBe(320.3333333333333);
  });

  test('the same event marks a drive longer than the floors down less than a short one', () => {
    // two hours: 120 slowdowns and 7200 s with a limit, past the 60 and 3600 s floors
    const sp = ev({ type: 'speeding', tier: 'moderate', durationS: 12, measured: { overMphS: 72 } });
    const short = driveScore([sp], 10, 0, exp(10, 10, 6, 1000, 1150))!;
    const long = driveScore([sp], 60, 0, exp(120, 120, 72, 7200, 8100))!;
    expect([short, long]).toEqual([99, 100]);
    const brake = ev({ type: 'hard_brake', tier: 'minor', measured: { peakG: 0.31 } });
    expect([driveScore([brake], 10, 0, exp(10, 10, 6, 1000, 1150)), driveScore([brake], 60, 0, exp(120, 120, 72, 7200, 8100))]).toEqual([92, 96]);
  });
});

describe('ratingAt: Phone use', () => {
  test('pin P: three drives watched for phone use, three pickups (one removed)', () => {
    expect(ratingAt([pinP1, pinP2, pinP3], AT)).toEqual({
      rating: 87.5,
      ranked: true,
      miles: 43,
      scores: {
        acceleration: 91.9280828053141,
        braking: 81.02731927681675,
        turning: 89.93932012720053,
        attention: null,
        phone: 86.73833371909146,
        speed: 90.79165984378409,
      },
    });
  });

  test('pin P1 alone: the phone axis by hand', () => {
    // W = (10 + 8) x 31.2 / 30 + (10 + 24) x 44.8 / 30, O = max(900, 32) = 900: r = (W + 3600 x 0.04) / (900 + 3600)
    const r = ratingAt([pinP1], AT);
    const w = (10 + 8) * (31.2 / 30) + (10 + 24) * (44.8 / 30);
    expect(r.scores.phone).toBeCloseTo(100 / (1 + ((w + 144) / 4500 / 0.04) * (15 / 85)), 12);
    expect(r.scores.phone).toBe(82.6919750951228);
    expect(r.rating).toBe(82.6);
  });

  test('pin P1 with no measured speeds (a speed factor of 1): the 0026 pgTAP stores it too', () => {
    const bare = { ...pinP1, events: pinP1.events.map(({ measured: _m, ...e }) => e) };
    // W = (10 + 8) + (10 + 24) = 52: r = (52 + 144) / 4500
    expect(ratingAt([bare], AT)).toEqual({
      rating: 83,
      ranked: false,
      miles: 6,
      scores: { acceleration: 87.62886597938144, braking: 72.64957264957265, turning: 86.69623059866963, attention: null, phone: 83.88157894736842, speed: 87.48261474269819 },
    });
    expect(ratingAt([bare], AT).scores.phone).toBe(100 / (1 + ((52 + 144) / 4500 / 0.04) * (15 / 85)));
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
      // the rating is the weighted harmonic mean of the five other categories
      const { phone: _ph, ...five } = now.scores;
      const w = { acceleration: 1, braking: 2, turning: 1, attention: 3, speed: 3 } as const;
      let den = 0;
      let inv = 0;
      for (const k of ['acceleration', 'braking', 'turning', 'attention', 'speed'] as const) {
        const s = five[k];
        if (s === null) continue;
        den += w[k];
        inv += w[k] / s;
      }
      expect(now.rating).toBe(Math.round(Math.round((den / inv) * 10 * 1e9) / 1e9) / 10);
    }
  });

  test('pins the 0026 pgTAP stores too: one pickup on a drive with no phone seconds; a drive watched with no pickup', () => {
    const lone = drive({ ageDays: 0, events: [ev({ type: 'phone_pickup', tier: 'moderate', durationS: 12 })] });
    expect(ratingAt([lone], AT)).toEqual({
      rating: 86.1,
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

// The drive floors are the priors' size: 60 slowdowns, speed-ups and turns; 3600 s for Speed, Phone use
// and Attention. EXP6P is the 6-mile city drive watched for phone use (900 s), EXP2P the 2-mile errand (200 s).
const EXP6P = exp(15, 15, 9, 840, 1136, 900);
const EXP2P = exp(4, 4, 3, 240, 300, 200);
describe('driveScore: the same curves over one drive, no prior, opportunities floored', () => {
  test('a clean drive is 100', () => {
    expect(driveScore([], 6, 0, EXP6)).toBe(100);
    expect(driveScore([], 6, 0, EXP6P)).toBe(100);
  });
  test('one minor hard brake (0.36 g) on the 6-mile drive is 94; 92 with no phone seconds', () => {
    const brake = ev({ type: 'hard_brake', tier: 'minor', measured: { peakG: 0.36 } });
    expect(driveScore([brake], 6, 0, EXP6P)).toBe(94);
    expect(driveScore([brake], 6, 0, EXP6)).toBe(92);
  });
  test('one minor hard brake on 6 mi with no phone seconds is 92', () =>
    expect(driveScore([ev({ type: 'hard_brake', tier: 'minor' })], 6, 0, EXP6)).toBe(92));
  test('a 0.55 g hard brake on the 2-mile errand is 88', () =>
    expect(driveScore([ev({ type: 'hard_brake', tier: 'severe', measured: { peakG: 0.55 } })], 2, 0, EXP2P)).toBe(88));
  test('a severe hard brake on 2 mi with no phone seconds is 86', () =>
    expect(driveScore([ev({ type: 'hard_brake', tier: 'severe' })], 2, 0, exp(4, 4, 3, 240, 300))).toBe(86));
  test('a minute over the line at a 35 mph limit on the 6-mile drive: 5 over is 98, 15 over is 83', () => {
    expect(driveScore([ev({ type: 'speeding', tier: 'moderate', durationS: 60, measured: { overMphS: 300, limitMph: 35 } })], 6, 0, EXP6P)).toBe(98);
    expect(driveScore([ev({ type: 'speeding', tier: 'severe', durationS: 60, measured: { overMphS: 900, limitMph: 35 } })], 6, 0, EXP6P)).toBe(83);
  });
  test('a minute at 15 over on 6 mi with no phone seconds is 78', () =>
    expect(driveScore([ev({ type: 'speeding', tier: 'severe', durationS: 60, measured: { overMphS: 900 } })], 6, 0, EXP6)).toBe(78));
  test('a drowsy on 1136 watched seconds reads over the 3600 s floor, 95', () => expect(driveScore([ev({ type: 'drowsy', tier: 'severe' })], 5, 1136, EXP6)).toBe(95));
  test('no miles, no score', () => expect(driveScore([], 0, 0, EXP6)).toBeNull());
  test('the floors: a minor hard brake on 0.3 mi reads over 60 slowdowns, 92 as on 6 mi', () =>
    expect(driveScore([ev({ type: 'hard_brake', tier: 'minor' })], 0.3, 0, exp(1, 1, 1, 108, 132))).toBe(92));
  test('a removed event changes nothing', () =>
    expect(driveScore([ev({ type: 'hard_brake', tier: 'severe', status: 'removed' })], 6, 0, EXP6)).toBe(100));
  test('Attention only on a watched drive', () => {
    expect(driveScore([ev({ type: 'drowsy', tier: 'severe' })], 5, 0, EXP6)).toBe(100);
  });
  test('a drive watched for phone use with no pickup is 100', () => expect(driveScore([], 6, 0, exp(15, 15, 9, 840, 1136, 900))).toBe(100));
  test('a 20 s pickup with no speed (factor 1) on 900 s at driving speed is 86', () =>
    expect(driveScore([ev({ type: 'phone_pickup', tier: 'severe', durationS: 20 })], 6, 0, exp(15, 15, 9, 840, 1136, 900))).toBe(86));
  test('20 s pickups at 30 mph on the 6-mile drive: one is 86, three are 67', () => {
    const pickup = () => ev({ type: 'phone_pickup', tier: 'severe', durationS: 20, measured: { speedMph: 30, maxSpeedMph: 30 } });
    expect(driveScore([pickup()], 6, 0, EXP6P)).toBe(86);
    expect(driveScore([pickup(), pickup(), pickup()], 6, 0, EXP6P)).toBe(67);
  });
  test('Phone use reads a fixed 240 s, not the drive: a 5 s pickup is 92 on 200 s at driving speed, on 2 hours, and with no phone seconds', () => {
    const p5 = () => ev({ type: 'phone_pickup', tier: 'moderate', durationS: 5 });
    expect(driveScore([p5()], 2, 0, exp(4, 4, 3, 200, 300, 200))).toBe(92);
    expect(driveScore([p5()], 60, 0, exp(150, 150, 90, 6600, 7200, 7200))).toBe(92);
    expect(driveScore([p5()], 6, 0, EXP6)).toBe(92);
  });
  test('pickups on a 20-minute drive (handoff 3): each costs by its time in hand and speed, the same on a 2-hour drive', () => {
    const p = (s: number, mph: number) =>
      ev({ type: 'phone_pickup', tier: s > 15 ? 'severe' : 'moderate', durationS: s, measured: { speedMph: mph, maxSpeedMph: mph } });
    const x20 = exp(25, 25, 15, 1100, 1200, 1200);
    const x2h = exp(150, 150, 90, 6600, 7200, 7200);
    const at = (events: DriveEvent[], x = x20, watchedS = 0) => driveScore(events, 10, watchedS, x);
    expect([
      at([p(3, 30)]), at([p(5, 30)]), at([p(10, 30)]), at([p(20, 30)]), at([p(20, 15)]), at([p(20, 60)]), at([p(60, 30)]),
      at([p(5, 30), p(5, 30), p(5, 30)]), at([p(20, 30), p(20, 30), p(20, 30)]), at([p(300, 30)]), at([p(20, 30)], x2h),
    ]).toEqual([93, 92, 90, 86, 92, 75, 72, 80, 67, 37, 86]);
    // with DashPal watching, Phone use is 3 of 13: 89
    expect(at([p(20, 30)], x20, 1100)).toBe(89);
    // slower pickups weigh less (the speed factor): 3 s at 10 mph is 98; 3 s at 25 mph is under 95
    expect([at([p(3, 10)]), at([p(3, 24)]), at([p(3, 25)])]).toEqual([98, 95, 94]);
  });
  test('no count term: an extra pickup, however long or slow, only lowers the drive score', () => {
    const p = (s: number, mph: number) => ev({ type: 'phone_pickup', tier: 'severe', durationS: s, measured: { maxSpeedMph: mph } });
    const x20 = exp(25, 25, 15, 1100, 1200, 1200);
    const thirty = Array.from({ length: 30 }, () => p(10, 30));
    expect([driveScore(thirty, 10, 0, x20), driveScore([...thirty, p(100, 30)], 10, 0, x20)]).toEqual([23, 20]);
    expect([driveScore([p(240, 30)], 10, 0, x20), driveScore([p(240, 30), p(600, 10)], 10, 0, x20)]).toEqual([42, 29]);
  });
  test('no phone seconds and no pickup: Phone use left out', () => {
    expect(driveScore([ev({ type: 'hard_brake', tier: 'minor' })], 6, 0, EXP6)).toBe(92);
    expect(driveScore([ev({ type: 'phone_pickup', tier: 'severe', durationS: 30, status: 'removed' })], 6, 0, EXP6)).toBe(100);
  });
});

describe('weightedScore: the weighted harmonic mean', () => {
  test('the handoff check: 95, 95, 95, Phone use 50, Speed 95, no Attention', () => {
    expect(weightedScore({ acceleration: 95, braking: 95, turning: 95, attention: null, phone: 50, speed: 95 })).toBe(74.80314960629921);
    // the arithmetic mean would be 81.5: a weak category pulls the total down harder
    expect((95 + 2 * 95 + 95 + 3 * 50 + 3 * 95) / 10).toBe(81.5);
  });

  test('Σ w / Σ (w / s), each sum in radar order (the 0048 pgTAP pins the same digits)', () => {
    expect(weightedScore({ acceleration: 90, braking: 80, turning: 70, attention: 50, phone: 40, speed: 60 })).toBe(55.22589345920432);
    expect(weightedScore({ acceleration: 90, braking: 80, turning: 70, attention: null, phone: null, speed: 60 })).toBe(69.72332015810277);
    expect(weightedScore({ acceleration: 90, braking: 80, turning: 70, attention: 50, phone: 40, speed: 60 })).toBe(
      (1 + 2 + 1 + 3 + 3 + 3) / (1 / 90 + 2 / 80 + 1 / 70 + 3 / 50 + 3 / 40 + 3 / 60)
    );
    expect(weightedScore({ acceleration: 100, braking: 100, turning: 100, attention: 100, phone: 100, speed: 100 })).toBe(100);
  });

  test('a null, missing, non-finite or non-positive score is left out of both sums; none scored is null', () => {
    expect(weightedScore({ acceleration: 90, braking: 0, turning: Number.NaN, attention: -5, phone: Infinity, speed: 60 })).toBe(65.45454545454545);
    expect(weightedScore({ acceleration: 90, speed: 60 })).toBe(65.45454545454545);
    expect(weightedScore({})).toBeNull();
    expect(weightedScore({ speed: Number.NaN })).toBeNull();
    expect(weightedScore({ speed: 0, phone: null })).toBeNull();
  });

  test('watchedMiles: the miles × the covered share of the moving seconds', () => {
    expect(watchedMiles(10, 600, 300)).toBe(5);
    expect(watchedMiles(10, 600, 900)).toBe(10);
    expect(watchedMiles(10, 0, 300)).toBe(0);
    expect(watchedMiles(0, 600, 300)).toBe(0);
  });

  test('watchedSeconds: the covered seconds held to the moving seconds, on the terms that give watched miles', () => {
    expect(watchedSeconds(10, 600, 300)).toBe(300);
    expect(watchedSeconds(10, 600, 900)).toBe(600);
    expect(watchedSeconds(10, 0, 300)).toBe(0);
    expect(watchedSeconds(0, 600, 300)).toBe(0);
    expect(watchedSeconds(10, 600, 0)).toBe(0);
    expect(watchedSeconds(Number.NaN, 600, 300)).toBe(0);
  });
});

// Scoring v13 against the server: the 0048 pgTAP stores these drives (W1..W4 for one driver, R1..R3
// and F1 for others) and pins the same digits from private.rating_at and private.wrapped_trips.
const HOUR = 3_600_000;
const wev = (start: number, n: number, type: DriveEvent['type'], tier: DriveEvent['tier'], at: number, durationS: number, measured: DriveEvent['measured'], status?: 'removed'): DriveEvent => ({
  id: `d0000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`,
  type,
  tier,
  startedAt: start + at * 1000,
  durationS,
  measured,
  ...(status ? { status } : {}),
});
const W1_START = AT - HOUR;
const W2_START = AT - 3 * DAY - 2 * HOUR;
const W3_START = AT - 20 * DAY;
const W4_START = AT - 55 * DAY;
/** An hour ago: 20 s at 25 mph a mean 5.5 over, a hard brake, a pickup, an eyes-off; DashPal watched 1500 of 1700 s. */
const pinW1 = drive({
  ageDays: 0,
  id: 'w1',
  startedAt: W1_START,
  miles: 12,
  watchedS: 1500,
  exposure: exp(24, 22, 14, 1300, 1700, 1500),
  events: [
    wev(W1_START, 11, 'speeding', 'moderate', 300, 20, { overMphS: 110, limitMph: 25 }),
    wev(W1_START, 12, 'hard_brake', 'minor', 400, 2, { peakG: 0.42 }),
    wev(W1_START, 13, 'phone_pickup', 'moderate', 500, 7, { speedMph: 28, maxSpeedMph: 36.5 }),
    wev(W1_START, 14, 'eyes_off', 'severe', 600, 6, { source: 'dashcam', speedMph: 38 }),
  ],
});
/** 3 days ago: 40 s at 65 mph, an older speeding with no overMphS at 35 mph, a drowsy, a hard start; watched 2000 of 2900 s. */
const pinW2 = drive({
  ageDays: 0,
  id: 'w2',
  startedAt: W2_START,
  miles: 30,
  watchedS: 2000,
  exposure: exp(30, 30, 12, 2500, 2900, 2700),
  events: [
    wev(W2_START, 21, 'speeding', 'severe', 200, 40, { overMphS: 520, limitMph: 65 }),
    wev(W2_START, 22, 'speeding', 'moderate', 900, 15, { limitMph: 35 }),
    wev(W2_START, 23, 'drowsy', 'severe', 1200, 9, { source: 'dashcam', speedMph: 62 }),
    wev(W2_START, 24, 'hard_accel', 'severe', 1300, 2, { peakG: 0.61 }),
  ],
});
/** 20 days ago: two pickups, a sharp turn and a removed hard brake; no DashPal. */
const pinW3 = drive({
  ageDays: 0,
  id: 'w3',
  startedAt: W3_START,
  miles: 9,
  exposure: exp(20, 20, 15, 900, 1100, 1000),
  events: [
    wev(W3_START, 31, 'phone_pickup', 'severe', 100, 25, { speedMph: 33, maxSpeedMph: 41 }),
    wev(W3_START, 32, 'phone_pickup', 'moderate', 300, 4, { speedMph: 15 }),
    wev(W3_START, 33, 'hard_corner', 'minor', 500, 2, { peakG: 0.53 }),
    wev(W3_START, 34, 'hard_brake', 'severe', 600, 2, { peakG: 0.7 }, 'removed'),
  ],
});
/** 55 days ago, before phone tracking: a speeding with no limit (the 5 mph reference) and a hard brake without a peak. */
const pinW4 = drive({
  ageDays: 0,
  id: 'w4',
  startedAt: W4_START,
  miles: 20,
  exposure: exp(35, 35, 20, 2000, 2400),
  events: [wev(W4_START, 41, 'speeding', 'minor', 400, 12, { overMphS: 30 }), wev(W4_START, 42, 'hard_brake', 'severe', 800, 2, {})],
});
const scoreOf = (d: RatingDrive): number | null => driveScore(d.events, d.miles, d.watchedS, d.exposure);
/** A 5 s DashPal episode at 30 mph, half an hour ago: its base weight (eyes off 40, drowsy 80). */
const dash = (type: 'eyes_off' | 'drowsy'): DriveEvent =>
  ev({ type, tier: 'severe', durationS: 5, startedAt: AT - 1_800_000, measured: { source: 'dashcam', speedMph: 30 } });
const pinR = (id: string, type: 'eyes_off' | 'drowsy', watchedS: number): RatingDrive =>
  drive({ ageDays: 0, id, startedAt: AT - HOUR, miles: 8, watchedS, events: [dash(type)] });

describe('scoring v13: parity pins the 0048 pgTAP stores too', () => {
  test('pin W: a full window with speeding against its limit, DashPal events and pickups, to the digit', () => {
    expect(ratingAt([pinW1, pinW2, pinW3, pinW4], AT)).toEqual({
      rating: 78.9,
      ranked: true,
      miles: 71,
      scores: {
        acceleration: 68.69727227258444,
        braking: 75.91666720301164,
        turning: 79.65581995980288,
        attention: 69.28278917626614,
        phone: 90.44662769010905,
        speed: 86.31474611197726,
      },
    });
    expect(ratingAt([pinW4, pinW2, pinW1, pinW3], AT)).toEqual(ratingAt([pinW1, pinW2, pinW3, pinW4], AT));
  });

  test("pin W: each drive's score (the server's Wrapped drive score is the same)", () => {
    expect([pinW1, pinW2, pinW3, pinW4].map(scoreOf)).toEqual([84, 81, 74, 85]);
  });

  test('pin W: the speeding weights against each limit', () => {
    expect(speedingWeight(20, 110, 'moderate', 25)).toBe(47.43199999999999);
    expect(speedingWeight(40, 520, 'severe', 65)).toBe(78.39999999999999);
    expect(speedingWeight(15, null, 'moderate', 35)).toBe(25.35);
    expect(speedingWeight(12, 30, 'minor')).toBe(3);
    expect(driveLoads(pinW2.events, pinW2.exposure, pinW2.watchedS).rates.speed.weight).toBe(78.39999999999999 + 25.35);
  });

  test('pin R: Attention per watched second with the 3600 s prior at 0.024; drowsy weighs twice eyes off', () => {
    const eyes = ratingAt([pinR('r1', 'eyes_off', 1200)], AT);
    expect(eyes.scores.attention).toBe(83.7782340862423);
    expect(eyes.scores.attention).toBe(rateScore((40 + 3600 * 0.024) / (1200 + 3600), 0.024));
    expect(eyes.rating).toBe(86.3);
    const drowsy = ratingAt([pinR('r2', 'drowsy', 1200)], AT);
    expect(drowsy.scores.attention).toBe(79.6875);
    expect(drowsy.scores.attention).toBe(rateScore((80 + 3600 * 0.024) / (1200 + 3600), 0.024));
    expect(drowsy.rating).toBe(85);
  });

  test('pin R: no watched seconds, no Attention score, even with a DashPal event; the rating leaves it out', () => {
    expect(ratingAt([pinR('r3', 'drowsy', 0)], AT)).toEqual({
      rating: 87.4,
      ranked: false,
      miles: 8,
      scores: { acceleration: 87.62886597938144, braking: 87.62886597938144, turning: 86.69623059866963, attention: null, phone: null, speed: 87.48261474269819 },
    });
  });

  test('pin R: the drive scores', () => {
    expect([pinR('r1', 'eyes_off', 1200), pinR('r2', 'drowsy', 1200), pinR('r3', 'drowsy', 0)].map(scoreOf)).toEqual([98, 95, 100]);
  });

  test("pin F: one drive's Attention reads at least 3600 watched seconds", () => {
    const f = { events: [dash('eyes_off')], miles: 3, exposure: exp(6, 6, 4, 400, 500, 450) };
    // 1800 and 3600 watched seconds both read over the 3600 s floor; 7200 reads over its own seconds
    expect(driveScore(f.events, f.miles, 1800, f.exposure)).toBe(98);
    expect(driveScore(f.events, f.miles, 3600, f.exposure)).toBe(98);
    expect(driveScore(f.events, f.miles, 7200, f.exposure)).toBe(99);
    // no watched seconds: Attention left out
    expect(driveScore(f.events, f.miles, 0, f.exposure)).toBe(100);
  });
});

// The 0038 pgTAP stores these two drives and pins the same Wrapped drive scores.
test('the 0038 Wrapped drives: one minor hard brake in 20 slowdowns is 92; a drive with every kind of event is 79', () => {
  expect(driveScore([ev({ type: 'hard_brake', tier: 'minor', durationS: 1 })], 12, 0, exp(20, 10, 5, 600, 1000))).toBe(92);
  const every = [
    ev({ type: 'speeding', tier: 'moderate', durationS: 30, measured: { overMphS: 240 } }),
    ev({ type: 'phone_pickup', tier: 'severe', durationS: 20, measured: { maxSpeedMph: 40 } }),
    ev({ type: 'hard_accel', tier: 'severe', durationS: 1, measured: { peakG: 0.5 } }),
    ev({ type: 'eyes_off', tier: 'severe', durationS: 6, measured: { speedMph: 30 } }),
  ];
  // DashPal watched 500 s, under the 3600 s floor
  expect(driveScore(every, 10, 500, exp(15, 12, 6, 800, 1000, 900))).toBe(79);
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
    'categoryScore',
    'CATEGORY_K',
    'ATTENTION_MIN_MILES',
    'DRIVE_ATTENTION_MIN_MILES',
    'OVER_CAP_MPH',
  ]) {
    expect(names).not.toContain(gone);
  }
});
