import { mph, row } from '@/core/detectors/__fixtures__/rows';
import {
  ACCEL_DEADBAND_MPS2,
  carriedSpeed,
  FIX_LEAD_S,
  nextDisplaySpeed,
  SPEED_HOLD_MS,
  STOP_DISPLAY_MAX_MPS,
  ZERO_MPS,
  type DisplaySpeed,
} from '@/core/engine/displaySpeed';
import type { FeatureRow } from '@/core/engine/types';

const G = 9.80665;

/** Rows a second apart, a fix each unless `known` is null; every estimate in order. */
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
  expect(FIX_LEAD_S).toBe(0.5);
  expect(SPEED_HOLD_MS).toBe(3_000);
});

describe('S1: led along the acceleration', () => {
  test('cruising: the fix as it is, nothing carried', () => {
    const [, b] = run([{ speed: mph(40) }, { speed: mph(40) + 0.1 }]);
    expect(b).toMatchObject({ mps: mph(40) + 0.1, accel: 0, zero: false });
  });

  test('braking: the GPS change and the forward acceleration together, the fix led half a second', () => {
    // 20 → 17 m/s in a second (−3 m/s²), the IMU reading about −0.3 g.
    const [, b] = run([{ speed: 20 }, { speed: 17, aLonMax: -0.28, aLonMin: -0.32 }]);
    const a = (-3 + -0.3 * G) / 2;
    expect(b!.accel).toBeCloseTo(a, 6);
    expect(b!.mps).toBeCloseTo(17 + a * FIX_LEAD_S, 6);
  });

  test('before the forward axis is learned, the GPS change alone', () => {
    const [, b] = run([{ speed: 10 }, { speed: 12 }]);
    expect(b).toMatchObject({ accel: 2, mps: 13 });
  });

  test('a change under the deadband is cruising; a wild one is capped at 8 m/s²', () => {
    expect(run([{ speed: 10 }, { speed: 10 + ACCEL_DEADBAND_MPS2 * 0.9 }])[1]!.accel).toBe(0);
    expect(run([{ speed: 30 }, { speed: 10 }])[1]!.accel).toBe(-8);
  });

  test('a fix after a long gap carries no GPS change', () => {
    const d = nextDisplaySpeed({ mps: 10, accel: 0, zero: false, fixTs: 0, fixMps: 10 }, row({ ts: 10_000, speed: 20 }), 20);
    expect(d).toMatchObject({ mps: 20, accel: 0 });
  });
});

describe('S2: 0 mph reads 0', () => {
  test('under 1 mph is always 0, however well rated', () => {
    expect(run([{ speed: mph(10) }, { speed: mph(0.9), speedAcc: 0.01 }])[1]).toMatchObject({ mps: 0, accel: 0, zero: true });
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
    expect(b!.zero).toBe(false);
    expect(b!.mps).toBeGreaterThan(mph(2.5));
  });

  test('slowing to a stop lands on 0 as soon as the lead drops under 1 mph', () => {
    // 4 → 1.5 mph in a second (−1.12 m/s²): 0.67 m/s led half a second is 0.11 m/s, under 1 mph.
    const out = run([{ speed: mph(6) }, { speed: mph(4) }, { speed: mph(1.5), speedAcc: 0.2 }]);
    expect(out[1]!.zero).toBe(false);
    expect(out[2]).toMatchObject({ mps: 0, zero: true });
  });

  test('a speed under its own accuracy rating under 3 mph is 0', () => {
    expect(run([{ speed: mph(10) }, { speed: mph(2.5), speedAcc: 2 }])[1]).toMatchObject({ mps: 0, zero: true });
  });
});

describe('S3: a lost fix', () => {
  test('holds the last speed flat for up to 3 s, then nothing', () => {
    const lost = { known: null, gnssValid: false, speed: -1 };
    const out = run([{ speed: 10 }, { speed: 12 }, lost, lost, lost, lost]);
    expect(out[2]).toMatchObject({ mps: 13, accel: 0 });
    expect(out[4]).toMatchObject({ mps: 13, accel: 0 });
    expect(out[5]).toBeNull();
  });

  test('nothing to hold before the first fix', () => {
    expect(run([{ known: null }])[0]).toBeNull();
  });
});

describe('carried on between rows', () => {
  test('along the acceleration for at most the cap', () => {
    expect(carriedSpeed(20, -4, 500, 1000)).toBeCloseTo(18, 9);
    expect(carriedSpeed(20, -4, 5000, 1000)).toBeCloseTo(16, 9);
    expect(carriedSpeed(10, 2, 250, 1000)).toBeCloseTo(10.5, 9);
  });

  test('0 once a slowing car drops under 1 mph; never negative; 0 and cruising stay put', () => {
    expect(carriedSpeed(0.8, -1, 400, 1000)).toBe(0);
    expect(carriedSpeed(2, -8, 1000, 1000)).toBe(0);
    expect(carriedSpeed(0, 3, 500, 1000)).toBe(0);
    expect(carriedSpeed(15, 0, 500, 1000)).toBe(15);
  });
});
