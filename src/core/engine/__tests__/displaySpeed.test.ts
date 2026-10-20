import { mph, row } from '@/core/detectors/__fixtures__/rows';
import { nextDisplaySpeed, SPEED_HOLD_MS, STOP_DISPLAY_MAX_MPS, ZERO_MPS, type DisplaySpeed } from '@/core/engine/displaySpeed';
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
