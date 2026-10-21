import { mph, row } from '@/core/detectors/__fixtures__/rows';
import {
  ACCEL_MAX_MPS2,
  CARRY_MAX_MS,
  carriedSpeed,
  nextDisplaySpeed,
  SPEED_HOLD_MS,
  SPEED_TICK_MS,
  STOP_DISPLAY_MAX_MPS,
  ZERO_MPS,
  type DisplaySpeed,
} from '@/core/engine/displaySpeed';
import type { FeatureRow } from '@/core/engine/types';

/** Rows a second apart, a fix each unless `known` is null; every value in order. */
function run(rows: (Partial<FeatureRow> & { known?: number | null })[]): (DisplaySpeed | null)[] {
  let d: DisplaySpeed | null = null;
  return rows.map(({ known, ...over }, i) => {
    const r = row({ ts: 1_000_000 + i * 1000, ...over });
    d = nextDisplaySpeed(d, r, known === undefined ? r.speed : known);
    return d;
  });
}

test('the thresholds', () => {
  expect(ZERO_MPS).toBeCloseTo(mph(1), 9);
  expect(STOP_DISPLAY_MAX_MPS).toBeCloseTo(mph(3), 9);
  expect(SPEED_HOLD_MS).toBe(3_000);
});

describe('S1: the fix as it is, once a row', () => {
  test('cruising, braking or speeding up, the row shows its own GPS speed', () => {
    const [a, b, c] = run([{ speed: mph(40) }, { speed: 17, aLonMax: -0.28, aLonMin: -0.32 }, { speed: 19 }]);
    expect(a).toMatchObject({ mps: mph(40), zero: false });
    expect(b).toMatchObject({ mps: 17, zero: false });
    expect(c).toMatchObject({ mps: 19, zero: false });
  });
});

describe('S1: carried on between rows along the IMU, about 3 times a second', () => {
  const G = 9.80665;
  test('the row carries its mean forward acceleration; cruising (under 0.3 m/s²) and no learned axis carry nothing', () => {
    const [brake, cruise, none] = run([
      { speed: 17, aLonMax: -0.25, aLonMin: -0.35 },
      { speed: 17, aLonMax: 0.02, aLonMin: 0 },
      { speed: 17, aLonMax: 0, aLonMin: 0 },
    ]);
    expect(brake!.accel).toBeCloseTo(-0.3 * G, 9);
    expect(cruise!.accel).toBe(0);
    expect(none!.accel).toBe(0);
  });

  test('clamped to 5 m/s²; 0 while shown as 0 or held through a lost fix', () => {
    const [jolt] = run([{ speed: 20, aLonMax: 1.2, aLonMin: 0.9 }]);
    expect(jolt!.accel).toBe(ACCEL_MAX_MPS2);
    const [, held] = run([{ speed: 20, aLonMax: 0.3, aLonMin: 0.2 }, { known: null, aLonMax: 0.3, aLonMin: 0.2 }]);
    expect(held).toMatchObject({ mps: 20, accel: 0 });
    expect(run([{ speed: mph(0.5), aLonMax: 0.3, aLonMin: 0.2 }])[0]).toMatchObject({ mps: 0, accel: 0 });
  });

  test('carriedSpeed: along the acceleration for at most two 333 ms ticks, never under 0, 0 under 1 mph', () => {
    expect([SPEED_TICK_MS, CARRY_MAX_MS]).toEqual([333, 667]);
    expect(carriedSpeed(20, 3, 0)).toBe(20);
    expect(carriedSpeed(20, 3, 333)).toBeCloseTo(20.999, 9);
    expect(carriedSpeed(20, -3, 5_000)).toBeCloseTo(20 - 3 * 0.667, 9);
    expect(carriedSpeed(1, -3, 667)).toBe(0);
    expect(carriedSpeed(0, 3, 667)).toBe(0);
    expect(carriedSpeed(20, 0, 667)).toBe(20);
  });
});

describe('S2: 0 mph reads 0', () => {
  test('under 1 mph is always 0, however well rated', () => {
    expect(run([{ speed: mph(10) }, { speed: mph(0.9), speedAcc: 0.01 }])[1]).toMatchObject({ mps: 0, zero: true });
  });

  test('a phone standing still with up to 3 mph of drift stays at 0', () => {
    const out = run([{ speed: 0 }, { speed: mph(2), speedAcc: 0.2 }, { speed: mph(2.5), speedAcc: 0.2 }, { speed: mph(1.5), speedAcc: 0.2 }]);
    for (const d of out) expect(d).toMatchObject({ mps: 0, zero: true });
  });

  test('a car still by the IMU reads 0 under 3 mph, even straight after moving', () => {
    const [, b] = run([{ speed: mph(10) }, { speed: mph(2.5), speedAcc: 0.2, aLonMax: 0.01, aLonMin: -0.01 }]);
    expect(b).toMatchObject({ mps: 0, zero: true });
  });

  test('pulling away from 0 shows the speed under 3 mph once the IMU says the car is accelerating; a GPS jump alone does not', () => {
    expect(run([{ speed: 0 }, { speed: mph(2.5), speedAcc: 0.2 }])[1]).toMatchObject({ mps: 0, zero: true });
    const [, b] = run([{ speed: 0 }, { speed: mph(2.5), speedAcc: 0.2, aLonMax: 0.08, aLonMin: 0.04 }]);
    expect(b).toMatchObject({ mps: mph(2.5), zero: false });
  });

  test('a speed under its own accuracy rating under 3 mph is 0', () => {
    expect(run([{ speed: mph(10) }, { speed: mph(2.5), speedAcc: 2 }])[1]).toMatchObject({ mps: 0, zero: true });
  });
});

describe('S3: a lost fix', () => {
  test('holds the last speed flat for 3 s, and past that while the car may still be moving: never "—"', () => {
    const lost = { known: null, gnssValid: false, speed: -1 };
    const out = run([{ speed: 10 }, { speed: 12 }, lost, lost, lost, lost, lost]);
    expect(out[2]).toMatchObject({ mps: 12 });
    expect(out[4]).toMatchObject({ mps: 12 });
    // No IMU word that the car stopped: the last speed holds.
    expect(out[5]).toMatchObject({ mps: 12, zero: false });
    expect(out[6]).toMatchObject({ mps: 12, zero: false });
  });

  test('past 3 s without a fix a still car reads 0 (a parked phone often stops reporting a speed)', () => {
    const lostStill = { known: null, gnssValid: false, speed: -1, aLonMax: 0.005, aLonMin: -0.005 };
    const out = run([{ speed: 12 }, lostStill, lostStill, lostStill, lostStill]);
    expect(out[3]).toMatchObject({ mps: 12 });
    expect(out[4]).toMatchObject({ mps: 0, zero: true });
  });

  test('a car already showing 0 keeps 0 through a lost fix, however long', () => {
    const lost = { known: null, gnssValid: false, speed: -1 };
    const out = run([{ speed: 0 }, ...Array.from({ length: 20 }, () => lost)]);
    for (const o of out) expect(o).toMatchObject({ mps: 0, zero: true });
  });

  test('before the first fix it is 0', () => {
    expect(run([{ known: null }])[0]).toMatchObject({ mps: 0, zero: true });
  });
});
