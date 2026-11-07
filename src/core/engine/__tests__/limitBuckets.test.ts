import { mph, row } from '@/core/detectors/__fixtures__/rows';
import {
  boundLimitBuckets,
  EMPTY_LIMIT_BUCKETS,
  HIGH_MIN_MPH,
  limitBucketOf,
  limitBucketsJson,
  LOW_MAX_MPH,
  noteLimitBuckets,
  parseLimitBuckets,
  type LimitBuckets,
} from '@/core/engine/limitBuckets';

const at = (v: number, extra: Parameters<typeof row>[0] = {}) => row({ speed: mph(v), ...extra });

test('the constants and the bucket edges: 27 low, 28 and 47 mid, 48 high', () => {
  expect([LOW_MAX_MPH, HIGH_MIN_MPH]).toEqual([27, 48]);
  expect([5, 25, 27, 28, 35, 47, 48, 65, 80].map(limitBucketOf)).toEqual(['low', 'low', 'low', 'mid', 'mid', 'mid', 'high', 'high', 'high']);
  expect(limitBucketOf(27.4)).toBe('low');
  expect(limitBucketOf(27.5)).toBe('mid');
});

test('a row with a usable limit at 10 mph or more adds a second and its distance to its limit bucket', () => {
  let b: LimitBuckets = EMPTY_LIMIT_BUCKETS;
  b = noteLimitBuckets(b, at(30), true, 25, 13.4);
  b = noteLimitBuckets(b, at(40), true, 35, 17.9);
  b = noteLimitBuckets(b, at(60), true, 65, 26.8);
  b = noteLimitBuckets(b, at(60), true, 65, 0);
  expect(b).toEqual({ low: { s: 1, m: 13.4 }, mid: { s: 1, m: 17.9 }, high: { s: 2, m: 26.8 } });
});

test('it counts exactly the rows limit time counts: none without a usable limit, under 10 mph, an untrusted or unknown speed, or no limit mph', () => {
  const b = EMPTY_LIMIT_BUCKETS;
  expect(noteLimitBuckets(b, at(30), false, 25, 10)).toBe(b);
  expect(noteLimitBuckets(b, at(9.9), true, 25, 10)).toBe(b);
  expect(noteLimitBuckets(b, at(30, { speedAcc: 3 }), true, 25, 10)).toBe(b);
  expect(noteLimitBuckets(b, at(30, { gnssValid: false }), true, 25, 10)).toBe(b);
  expect(noteLimitBuckets(b, at(30), true, null, 10)).toBe(b);
  expect(noteLimitBuckets(b, at(30), true, undefined, 10)).toBe(b);
  expect(noteLimitBuckets(b, at(10), true, 25, 10).low).toEqual({ s: 1, m: 10 });
  // A bad distance adds the second only.
  expect(noteLimitBuckets(b, at(30), true, 25, Number.NaN).low).toEqual({ s: 1, m: 0 });
});

test('frozen and replaced, never mutated', () => {
  const a = noteLimitBuckets(EMPTY_LIMIT_BUCKETS, at(30), true, 25, 5);
  const b = noteLimitBuckets(a, at(30), true, 25, 5);
  expect(Object.isFrozen(a)).toBe(true);
  expect(Object.isFrozen(a.low)).toBe(true);
  expect(a.low).toEqual({ s: 1, m: 5 });
  expect(b.low).toEqual({ s: 2, m: 10 });
});

test('bounded: whole seconds and metres, scaled down together when past the drive limit time or distance', () => {
  const raw: LimitBuckets = { low: { s: 30, m: 300.7 }, mid: { s: 60, m: 900.2 }, high: { s: 10, m: 400 } };
  expect(boundLimitBuckets(raw, 1000, 5000)).toEqual({ low: { s: 30, m: 300 }, mid: { s: 60, m: 900 }, high: { s: 10, m: 400 } });
  const held = boundLimitBuckets(raw, 50, 800);
  expect(held).toEqual({ low: { s: 15, m: 150 }, mid: { s: 30, m: 449 }, high: { s: 5, m: 199 } });
  expect(held.low.s + held.mid.s + held.high.s).toBeLessThanOrEqual(50);
  expect(held.low.m + held.mid.m + held.high.m).toBeLessThanOrEqual(800);
  expect(boundLimitBuckets(raw, 0, 0)).toEqual({ low: { s: 0, m: 0 }, mid: { s: 0, m: 0 }, high: { s: 0, m: 0 } });
  expect(boundLimitBuckets(raw, Number.NaN, Number.NaN)).toEqual({ low: { s: 0, m: 0 }, mid: { s: 0, m: 0 }, high: { s: 0, m: 0 } });
});

test('stored as JSON and read back; anything malformed is null', () => {
  const b: LimitBuckets = { low: { s: 3, m: 40 }, mid: { s: 0, m: 0 }, high: { s: 7, m: 210 } };
  const json = limitBucketsJson(b);
  expect(json).toBe('{"low":{"s":3,"m":40},"mid":{"s":0,"m":0},"high":{"s":7,"m":210}}');
  expect(parseLimitBuckets(json)).toEqual(b);
  for (const bad of [null, undefined, '', 'x', '[]', '{"low":{"s":1,"m":1},"mid":{"s":1,"m":1}}', '{"low":{"s":-1,"m":1},"mid":{"s":1,"m":1},"high":{"s":1,"m":1}}', '{"low":{"s":"1","m":1},"mid":{"s":1,"m":1},"high":{"s":1,"m":1}}']) {
    expect(parseLimitBuckets(bad)).toBeNull();
  }
});
