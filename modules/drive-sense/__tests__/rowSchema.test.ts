/** @jest-environment node */
// `parseRow` is the only gate between what native emits and M1's engine (R2's row contract).
import trace from '../../../src/core/__fixtures__/traces/speeding-corrected.json';
import { parseRow } from '../src/rowSchema';

const good = trace.rows[10]!;

test('a trace row passes unchanged', () => {
  expect(parseRow(good)).toEqual(good);
  expect(parseRow(JSON.parse(JSON.stringify(good)))).toEqual(good);
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
