import { mph, row } from '@/core/detectors/__fixtures__/rows';
import {
  ACCEL_DEADBAND_MPS2,
  CARRY_MAX_MS,
  carriedSpeed,
  displayFix,
  displayRow,
  EVENT_STALE_MS,
  GAP_RESET_MS,
  ROUND_HYSTERESIS,
  ROW_FIX_AGE_MS,
  sigmaOf,
  SIGMA_MAX_MPS,
  SIGMA_MIN_MPS,
  SIGMA_UNRATED_MPS,
  SPEED_HOLD_MS,
  SPEED_TICK_MS,
  STOP_DISPLAY_MAX_MPS,
  wholeSpeed,
  ZERO_MPS,
  type DisplaySpeed,
  type SpeedFix,
} from '@/core/engine/displaySpeed';
import type { FeatureRow } from '@/core/engine/types';

const T = 1_000_000;
/** A `speed` event's fix: well rated, a good position. */
const fix = (at: number, mps: number, over: Partial<SpeedFix> = {}): SpeedFix => ({ at, mps, acc: 0.5, hAcc: 5, ...over });

/** Fixes a second apart from `T`, in order; every value. */
function fixes(speeds: (number | Partial<SpeedFix> & { mps: number })[], start: DisplaySpeed | null = null): DisplaySpeed[] {
  let d = start;
  return speeds.map((s, i) => {
    d = displayFix(d, typeof s === 'number' ? fix(T + i * 1000, s) : fix(T + i * 1000, s.mps, s));
    return d;
  });
}

/** Rows a second apart (ts `T + 300 + i·1000`), a fix each unless `known` is null; every value. */
function rows(list: (Partial<FeatureRow> & { known?: number | null })[], start: DisplaySpeed | null = null, t0 = T + 300): DisplaySpeed[] {
  let d = start;
  return list.map(({ known, ...over }, i) => {
    const r = row({ ts: t0 + i * 1000, ...over });
    d = displayRow(d, r, known === undefined ? r.speed : known);
    return d;
  });
}

const last = <X>(xs: X[]): X => xs[xs.length - 1]!;

test('the thresholds', () => {
  expect(ZERO_MPS).toBeCloseTo(mph(1), 9);
  expect(STOP_DISPLAY_MAX_MPS).toBeCloseTo(mph(3), 9);
  expect(SPEED_HOLD_MS).toBe(3_000);
  expect([SPEED_TICK_MS, CARRY_MAX_MS]).toEqual([250, 1_500]);
  expect([EVENT_STALE_MS, ROW_FIX_AGE_MS, GAP_RESET_MS]).toEqual([2_500, 500, 3_000]);
});

describe('L1: each fix measures the speed as it lands, at its own time', () => {
  test('the first fix shows its own speed, standing for its own time', () => {
    const d = displayFix(null, fix(T, 20));
    expect(d).toMatchObject({ mps: 20, accel: 0, at: T, zero: false, eventAt: T });
  });

  test('a fix with no speed, an unknown or poor position (over 50 m) measures nothing', () => {
    const d = displayFix(null, fix(T, 20));
    for (const bad of [fix(T + 1000, 30, { hAcc: 51 }), fix(T + 1000, 30, { hAcc: -1 }), fix(T + 1000, -1)]) {
      const next = displayFix(d, bad);
      expect(next).toMatchObject({ mps: 20, at: T, eventAt: T + 1000 });
    }
  });

  test('a fix no newer than the last one measured changes nothing', () => {
    const d = displayFix(null, fix(T, 20));
    expect(displayFix(d, fix(T, 25))).toBe(d);
    expect(displayFix(d, fix(T - 500, 25)).mps).toBe(20);
  });

  test("while the events come, a row's own fix measures nothing (the event already did)", () => {
    const [, d] = fixes([20, 20]);
    const after = displayRow(d!, row({ ts: T + 1300, speed: 30 }), 30);
    expect(after.mps).toBeCloseTo(d!.mps, 9);
    expect(after.at).toBe(d!.at);
  });

  test('with no event for 2.5 s (a native build without them) the row stands in, timed half a second before it', () => {
    const out = rows([{ speed: 20 }, { speed: 21 }]);
    expect(out[0]).toMatchObject({ mps: 20, at: T + 300 - ROW_FIX_AGE_MS });
    expect(out[1]!.at).toBe(T + 1300 - ROW_FIX_AGE_MS);
    expect(out[1]!.mps).toBeGreaterThan(20.5);
  });
});

describe('L2: a Kalman filter over the Doppler speeds', () => {
  test('a steady speed reads steady: fixes ±0.12 m/s around 20 m/s stay within 0.15 m/s (a third of a mph), and nothing is carried', () => {
    const noise = [0.1, -0.12, 0.05, -0.08, 0.12, -0.1, 0.07, -0.05, 0.09, -0.11];
    const out = fixes(noise.map((n) => 20 + n));
    for (const d of out.slice(3)) {
      expect(Math.abs(d.mps - 20)).toBeLessThan(0.15);
      expect(d.accel).toBe(0);
    }
  });

  test('speeding up at 2 m/s², it learns the acceleration within a few fixes and keeps up with the fixes', () => {
    const out = fixes(Array.from({ length: 8 }, (_, i) => 10 + 2 * i));
    for (const d of out.slice(4)) {
      expect(d.accel).toBeGreaterThan(1.6);
      expect(d.accel).toBeLessThan(2.4);
    }
    expect(Math.abs(last(out).mps - 24)).toBeLessThan(0.3);
  });

  test('braking from 25 m/s at 4 m/s², it follows within half a metre per second by the third fix', () => {
    const out = fixes([25, 25, 25, 21, 17, 13, 9]);
    expect(out[5]!.accel).toBeLessThan(-3);
    expect(Math.abs(out[5]!.mps - 13)).toBeLessThan(0.5);
    expect(Math.abs(out[6]!.mps - 9)).toBeLessThan(0.5);
  });

  test('each fix weighs by its own accuracy: a poorly rated jump moves the number little, a well rated one a lot', () => {
    const steady = last(fixes([20, 20, 20, 20, 20]));
    const poor = displayFix(steady, fix(T + 5000, 23, { acc: 6 }));
    const good = displayFix(steady, fix(T + 5000, 23, { acc: 0.2 }));
    expect(poor.mps - 20).toBeLessThan(1);
    expect(good.mps - 20).toBeGreaterThan(2.5);
  });

  test('sigmaOf: half the rating, held between 0.1 and 3 m/s; unrated counts as 0.3 m/s', () => {
    expect(sigmaOf(0.8)).toBeCloseTo(0.4, 9);
    expect(sigmaOf(0.05)).toBe(SIGMA_MIN_MPS);
    expect(sigmaOf(50)).toBe(SIGMA_MAX_MPS);
    expect(sigmaOf(-1)).toBe(SIGMA_UNRATED_MPS);
  });

  test('a fix after a gap of more than 3 s, or one under 1 mph, starts afresh (no acceleration carried over)', () => {
    const ramp = last(fixes([10, 12, 14, 16, 18]));
    expect(ramp.accel).toBeGreaterThan(1);
    const gap = displayFix(ramp, fix(T + 4000 + GAP_RESET_MS + 1, 25));
    expect(gap).toMatchObject({ mps: 25, accel: 0 });
    expect(gap.kf).toMatchObject({ v: 25, a: 0 });
    const stop = displayFix(ramp, fix(T + 5000, 0.2));
    expect(stop.kf).toMatchObject({ v: 0.2, a: 0 });
  });
});

describe('L3: carried on to now along the acceleration', () => {
  test('carriedSpeed: from the fix, for at most 1.5 s, never under 0, 0 under 1 mph', () => {
    expect(carriedSpeed(20, 3, 0)).toBe(20);
    expect(carriedSpeed(20, 3, 250)).toBeCloseTo(20.75, 9);
    expect(carriedSpeed(20, -3, 5_000)).toBeCloseTo(20 - 3 * 1.5, 9);
    expect(carriedSpeed(20, 3, -400)).toBe(20);
    expect(carriedSpeed(1, -3, 1_500)).toBe(0);
    expect(carriedSpeed(0, 3, 1_000)).toBe(0);
    expect(carriedSpeed(20, 0, 1_000)).toBe(20);
  });

  test('an acceleration inside the deadband is not carried', () => {
    expect(ACCEL_DEADBAND_MPS2).toBe(0.5);
    const gentle = last(fixes([20, 20.3, 20.6, 20.9, 21.2, 21.5]));
    expect(gentle.kf!.a).toBeGreaterThan(0.2);
    expect(gentle.accel).toBe(0);
  });

  test('wholeSpeed: rounds, and moves off the number shown only once 0.3 past the half', () => {
    expect(ROUND_HYSTERESIS).toBe(0.3);
    expect(wholeSpeed(null, 34.5)).toBe(35);
    expect(wholeSpeed(35, 34.4)).toBe(35);
    expect(wholeSpeed(35, 34.21)).toBe(35);
    expect(wholeSpeed(35, 34.19)).toBe(34);
    expect(wholeSpeed(34, 34.79)).toBe(34);
    expect(wholeSpeed(34, 34.81)).toBe(35);
    expect(wholeSpeed(30, 33)).toBe(33);
    expect(wholeSpeed(1, 0)).toBe(0);
  });
});

describe('S2: 0 mph reads 0', () => {
  test('under 1 mph is always 0, however well rated', () => {
    const [, d] = fixes([mph(10), { mps: mph(0.9), acc: 0.01 }]);
    expect(d).toMatchObject({ mps: 0, zero: true, accel: 0 });
  });

  test('a phone standing still with up to 3 mph of drift stays at 0', () => {
    const out = fixes([0, { mps: mph(2), acc: 0.2 }, { mps: mph(2.5), acc: 0.2 }, { mps: mph(1.5), acc: 0.2 }]);
    for (const d of out) expect(d).toMatchObject({ mps: 0, zero: true });
  });

  test('a car still by the IMU reads 0 under 3 mph, even straight after moving', () => {
    const moving = displayFix(null, fix(T, mph(10)));
    const stillRow = displayRow(moving, row({ ts: T + 300, aLonMax: 0.01, aLonMin: -0.01 }), mph(10));
    const d = displayFix(stillRow, fix(T + 1000, mph(2.5), { acc: 0.2 }));
    expect(d).toMatchObject({ mps: 0, zero: true });
  });

  test('pulling away from 0 shows the speed under 3 mph once the IMU says the car is accelerating; a GPS jump alone does not', () => {
    const [, jump] = fixes([0, { mps: mph(2.5), acc: 0.2 }]);
    expect(jump).toMatchObject({ mps: 0, zero: true });
    // The row of that second reads the car accelerating (0.06 g ≈ 0.6 m/s²): the speed shows.
    const away = displayRow(jump!, row({ ts: T + 1300, aLonMax: 0.08, aLonMin: 0.04 }), mph(2.5));
    expect(away.zero).toBe(false);
    expect(away.mps).toBeGreaterThan(mph(1));
  });

  test('a speed under its own accuracy rating under 3 mph is 0', () => {
    expect(fixes([{ mps: mph(2.5), acc: 2 }])[0]).toMatchObject({ mps: 0, zero: true });
    const slowing = fixes([mph(4), { mps: mph(2.5), acc: 2 }, { mps: mph(2.5), acc: 2 }, { mps: mph(2.5), acc: 2 }]);
    expect(last(slowing)).toMatchObject({ mps: 0, zero: true });
    // Rated well, the same 2.5 mph shows (the car is moving and not still by the IMU).
    expect(last(fixes([mph(4), { mps: mph(2.5), acc: 0.2 }])).zero).toBe(false);
  });
});

describe('S3: a lost fix', () => {
  const lost = { known: null, gnssValid: false, speed: -1 };

  test('holds the last speed (nothing carried past 1.5 s) for 3 s, and past that while the car may still be moving: never "—"', () => {
    const [, d] = fixes([10, 12]);
    const out = rows([lost, lost, lost, lost, lost], d!, T + 1300);
    for (const o of out) expect(o.zero).toBe(false);
    expect(last(out).mps).toBeCloseTo(d!.mps, 9);
    expect(last(out).at).toBe(T + 1000);
  });

  test('past 3 s without a fix a still car reads 0 (a parked phone often stops reporting a speed)', () => {
    const d = displayFix(null, fix(T, 12));
    const lostStill = { ...lost, aLonMax: 0.005, aLonMin: -0.005 };
    const out = rows([lostStill, lostStill, lostStill, lostStill], d, T + 300);
    expect(out[2]).toMatchObject({ mps: 12 });
    expect(out[3]).toMatchObject({ mps: 0, zero: true });
  });

  test('a car already showing 0 keeps 0 through a lost fix, however long', () => {
    const d = displayFix(null, fix(T, 0));
    const out = rows(Array.from({ length: 20 }, () => lost), d);
    for (const o of out) expect(o).toMatchObject({ mps: 0, zero: true });
  });

  test('before the first fix it is 0', () => {
    expect(rows([lost])[0]).toMatchObject({ mps: 0, zero: true, kf: null });
  });
});
