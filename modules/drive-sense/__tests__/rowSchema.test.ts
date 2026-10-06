/** @jest-environment node */
// `parseRow` is the only gate between what native emits and M1's engine (R2's row contract).
import { MOTION_ROW_FIELDS, parseRow, resetUnknownRowKeys, ROW_DECIMALS, roundTo, unknownRowKeys } from '../src/rowSchema';
import type { FeatureRow } from '../src/types';
import { sampleRows } from '../scripts/sampleRows';

/** A trace row as the fixtures hold it, rounded the way `parseRow` rounds. */
const rounded = (row: FeatureRow): FeatureRow => {
  const out = { ...row };
  for (const key of Object.keys(ROW_DECIMALS) as (keyof typeof ROW_DECIMALS)[]) {
    out[key] = roundTo(out[key], ROW_DECIMALS[key]);
  }
  return out;
};

const good = rounded(sampleRows(12)[10]!);

test('a row already at the kept precision passes unchanged', () => {
  expect(parseRow(good)).toEqual(good);
  expect(parseRow(JSON.parse(JSON.stringify(good)))).toEqual(good);
});

describe('rounding (ruling D2 concern 1)', () => {
  test('the table names every numeric field but ts, with the ruled precisions', () => {
    const numeric = Object.keys(good)
      .filter((k) => typeof good[k as keyof FeatureRow] === 'number' && k !== 'ts')
      .sort();
    expect(Object.keys(ROW_DECIMALS).sort()).toEqual(numeric);
    expect(ROW_DECIMALS).toEqual({
      lat: 6,
      lng: 6,
      hAcc: 1,
      speed: 2,
      speedAcc: 2,
      course: 1,
      alt: 1,
      aLonMax: 3,
      aLonMin: 3,
      aLatMax: 3,
      aLatMin: 3,
      jerkMax: 3,
      yawRateMax: 3,
      gravityStability: 3,
      orientationDelta: 3,
      handlingScore: 3,
    });
  });

  // One unrounded native value per field, and what it must become.
  test.each([
    ['lat', 47.606212345678, 47.606212],
    ['lng', -122.33304567891234, -122.333046],
    ['hAcc', 4.7812345, 4.8],
    ['speed', 13.416666666, 13.42],
    ['speedAcc', 0.4449999, 0.44],
    ['course', 89.954321, 90],
    ['alt', 52.3456789, 52.3],
    ['aLonMax', 0.123456789, 0.123],
    ['aLonMin', -0.3004999, -0.3],
    ['aLatMax', 0.0995, 0.1],
    ['aLatMin', -0.08765, -0.088],
    ['jerkMax', 1.23456, 1.235],
    ['yawRateMax', 0.21049999, 0.21],
    ['gravityStability', 0.99951, 1],
    ['orientationDelta', 0.0123456, 0.012],
    ['handlingScore', 0.3333333, 0.333],
  ] as const)('%s is kept to its precision', (key, raw, expected) => {
    const out = parseRow({ ...good, [key]: raw });
    expect(out?.[key]).toBe(expected);
  });

  test('integers, booleans and ts are untouched; the sentinels survive; -0 becomes 0', () => {
    const row = { ...good, ts: 1_700_000_000_123, speed: -1, speedAcc: -1, course: -1, hAcc: 9999, lat: 0, lng: 0, gnssValid: false, locked: true, aLonMin: -0.0004 };
    const out = parseRow(row)!;
    expect(out).toMatchObject({ ts: 1_700_000_000_123, speed: -1, speedAcc: -1, course: -1, hAcc: 9999, lat: 0, lng: 0, gnssValid: false, locked: true });
    expect(Object.is(out.aLonMin, 0)).toBe(true);
  });

  test('a rounded value prints with no binary tail (which would undo the compression)', () => {
    const out = parseRow({ ...good, aLonMax: 0.30000000000000004, speed: 0.1 + 0.2, lat: 47.1 + 0.0000001 })!;
    expect(JSON.stringify([out.aLonMax, out.speed, out.lat])).toBe('[0.3,0.3,47.1]');
  });

  test('the caller object is not modified', () => {
    const raw = { ...good, speed: 13.416666 };
    parseRow(raw);
    expect(raw.speed).toBe(13.416666);
  });

});

test('the R2 encodings are accepted: unknown speed/accuracy/course −1, no fix 0/0 + 9999, IMU zeros', () => {
  const row = {
    ...good,
    lat: 0,
    lng: 0,
    hAcc: 9999,
    speed: -1,
    speedAcc: -1,
    course: -1,
    gnssValid: false,
    aLonMax: 0,
    aLonMin: 0,
    aLatMax: 0,
    aLatMin: 0,
    yawRateMax: 0,
    jerkMax: 0,
    gravityStability: 0,
    orientationDelta: 0,
    handlingScore: 0,
  };
  expect(parseRow(row)).toEqual(row);
});

test.each([
  ['a fractional ts', { ts: 1_700_000_000_000.5 }],
  ['a string ts', { ts: '1700000000000' }],
  ['a negative ts', { ts: -1 }],
  ['NaN', { aLonMax: Number.NaN }],
  ['Infinity', { yawRateMax: Number.POSITIVE_INFINITY }],
  ['a string number', { speed: '12' }],
  ['a numeric boolean', { gnssValid: 1 }],
  ['null for a number', { lat: null }],
])('rejects %s', (_label, patch) => {
  expect(parseRow({ ...good, ...patch })).toBeNull();
});

test('rejects a missing key', () => {
  const { handlingScore: _dropped, ...missing } = good;
  expect(parseRow(missing)).toBeNull();
});

// C0 round 1 (review-C0 C0-m1): unknown keys fail soft. A future native build that adds a field must
// not cost a drive its rows in an older bundle: the key is stripped and counted, the row kept. The
// strict key contract stays pinned where it belongs, in the native text tests and the vectors.
test('an extra key is stripped and counted, and the row is kept', () => {
  resetUnknownRowKeys();
  expect(parseRow({ ...good, heading: 90 })).toEqual(good);
  expect(unknownRowKeys()).toBe(1);
  expect(parseRow({ ...good, heading: 90, pitch: 1 })).toEqual(good);
  expect(unknownRowKeys()).toBe(3);
  resetUnknownRowKeys();
  expect(unknownRowKeys()).toBe(0);
});

test('a known key with a wrong type still rejects the row (only unknown keys are stripped)', () => {
  expect(parseRow({ ...good, heading: 90, speed: '10' })).toBeNull();
});

test.each([null, undefined, 42, 'row', [], [good]])('rejects a non-object: %p', (raw) => {
  expect(parseRow(raw)).toBeNull();
});

test('returns a fresh object, not the payload', () => {
  const raw = { ...good };
  const parsed = parseRow(raw);
  expect(parsed).not.toBe(raw);
});

// DMS calibration and stops, Task C0: the six optional motion fields (design rev4 §2.1.1, rev5 §4.3).
describe('the optional motion fields (C0)', () => {
  const withMotion = {
    ...good,
    frameAligned: true,
    aLonMean: -0.0312345,
    accRms: 0.1234567,
    gravX: 0.0012345,
    gravY: -0.7071234,
    gravZ: -0.7071067,
  };

  test('an old row without them still parses, and gains none of them (S-OLDROW)', () => {
    const r = parseRow(good);
    expect(r).toEqual(good);
    for (const k of MOTION_ROW_FIELDS) expect(k in r!).toBe(false);
  });

  test('present, they are kept and rounded to 1e-3', () => {
    expect(parseRow(withMotion)).toEqual({
      ...good,
      frameAligned: true,
      aLonMean: -0.031,
      accRms: 0.123,
      gravX: 0.001,
      gravY: -0.707,
      gravZ: -0.707,
    });
  });

  test('accRms and gravity may be null (IMU absent); frameAligned and aLonMean may not', () => {
    const absent = { ...good, frameAligned: false, aLonMean: 0, accRms: null, gravX: null, gravY: null, gravZ: null };
    expect(parseRow(absent)).toEqual(absent);
    expect(parseRow({ ...absent, frameAligned: null })).toBeNull();
    expect(parseRow({ ...absent, aLonMean: null })).toBeNull();
  });

  test.each([
    ['frameAligned', 'yes'],
    ['aLonMean', Number.NaN],
    ['accRms', Number.POSITIVE_INFINITY],
    ['gravX', '0.1'],
  ])('rejects %s = %p', (key, value) => {
    expect(parseRow({ ...withMotion, [key]: value })).toBeNull();
  });

  test('the list of motion fields is the six the design names', () => {
    expect([...MOTION_ROW_FIELDS].sort()).toEqual(['aLonMean', 'accRms', 'frameAligned', 'gravX', 'gravY', 'gravZ']);
  });
});

// v3 (plan §6): `mock` rides on the row payload beside the FeatureRow keys.
describe('the mock-location flag', () => {
  test('is kept when present, absent when native did not send it, and never counted as unknown', () => {
    resetUnknownRowKeys();
    expect(parseRow({ ...good, mock: true })).toEqual({ ...good, mock: true });
    expect(parseRow({ ...good, mock: false })).toEqual({ ...good, mock: false });
    expect(parseRow(good)).not.toHaveProperty('mock');
    expect(unknownRowKeys()).toBe(0);
  });

  test('a non-boolean mock rejects the row, like any other known key with a wrong type', () => {
    expect(parseRow({ ...good, mock: 'yes' })).toBeNull();
    expect(parseRow({ ...good, mock: 1 })).toBeNull();
    expect(parseRow({ ...good, mock: null })).toBeNull();
  });

  test('unknown keys are still stripped and counted beside it', () => {
    resetUnknownRowKeys();
    expect(parseRow({ ...good, mock: true, future: 1 })).toEqual({ ...good, mock: true });
    expect(unknownRowKeys()).toBe(1);
  });
});
