/** @jest-environment node */
// `parseRow` is the only gate between what native emits and M1's engine (R2's row contract).
import trace from '../../../src/core/__fixtures__/traces/speeding-corrected.json';
import { runTrace } from '../../../src/core/replay/runTrace';
import { parseTrace } from '../../../src/core/replay/trace';
import { parseRow, ROW_DECIMALS, roundTo } from '../src/rowSchema';
import type { FeatureRow } from '../src/types';

// Jest compiles this suite to CommonJS, so `require` is real at run time; Node's typings are not in
// the program, hence the local shapes.
declare const __dirname: string;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- see above
const { readdirSync, readFileSync } = require('node:fs') as {
  readdirSync: (dir: string) => string[];
  readFileSync: (file: string, encoding: 'utf8') => string;
};

/** A trace row as the fixtures hold it, rounded the way `parseRow` rounds. */
const rounded = (row: FeatureRow): FeatureRow => {
  const out = { ...row };
  for (const key of Object.keys(ROW_DECIMALS) as (keyof typeof ROW_DECIMALS)[]) {
    out[key] = roundTo(out[key], ROW_DECIMALS[key]);
  }
  return out;
};

const good = rounded(trace.rows[10]!);

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

  // The V2 golden replays these traces through a fake drive-sense, so its rows arrive via
  // `parseRow`: the rounded rows must detect exactly what the raw ones do.
  const dir = `${__dirname}/../../../src/core/__fixtures__/traces`;
  const names = readdirSync(dir).filter((f) => f.endsWith('.json'));
  test.each(names)('%s through parseRow detects the same events as the raw trace', (name) => {
    const raw = parseTrace(JSON.parse(readFileSync(`${dir}/${name}`, 'utf8')));
    const viaBridge = { ...raw, rows: raw.rows.map((r) => parseRow(r)!) };
    expect(viaBridge.rows.every((r) => r !== null)).toBe(true);

    const a = runTrace(raw);
    const b = runTrace(viaBridge);
    expect(b.failures).toEqual([]);
    const shape = (e: (typeof a.events)[number]) => ({
      category: e.category,
      startedAt: e.startedAt,
      durationS: e.durationS,
      status: e.status,
    });
    expect(b.events.map(shape)).toEqual(a.events.map(shape));
    b.events.forEach((e, i) => expect(Math.abs(e.q - a.events[i]!.q)).toBeLessThan(1e-3));
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

test('rejects an extra key', () => {
  expect(parseRow({ ...good, heading: 90 })).toBeNull();
});

test.each([null, undefined, 42, 'row', [], [good]])('rejects a non-object: %p', (raw) => {
  expect(parseRow(raw)).toBeNull();
});

test('returns a fresh object, not the payload', () => {
  const raw = { ...good };
  const parsed = parseRow(raw);
  expect(parsed).not.toBe(raw);
});
