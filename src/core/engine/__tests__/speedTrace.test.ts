import { mph, row, T0 } from '@/core/detectors/__fixtures__/rows';
import {
  BUCKET_START_S,
  EMPTY_SPEED_TRACE,
  MAX_BUCKETS,
  mergeBuckets,
  noteSpeedTrace,
  parseSpeedTrace,
  speedTraceJson,
  speedTraceOf,
  type SpeedTraceState,
} from '@/core/engine/speedTrace';
import type { FeatureRow } from '@/core/engine/types';

/** Rows at 1 Hz from T0 with these speeds (mph; null = no fix), each with its sign limit. */
function run(speeds: readonly (number | null)[], sign: (i: number) => number | null = () => null, over: (i: number) => Partial<FeatureRow> = () => ({})) {
  return speeds.reduce<Readonly<SpeedTraceState>>(
    (s, v, i) => noteSpeedTrace(s, row({ ...(v === null ? { gnssValid: false, speed: -1 } : { speed: mph(v) }), ...over(i) }, i), T0, sign(i)),
    EMPTY_SPEED_TRACE
  );
}
const hold = (v: number | null, n: number): (number | null)[] => Array.from({ length: n }, () => v);

test('the constants', () => {
  expect([BUCKET_START_S, MAX_BUCKETS]).toEqual([5, 720]);
});

test('no rows: no trace', () => {
  expect(speedTraceOf(EMPTY_SPEED_TRACE)).toBeNull();
  expect(speedTraceJson(EMPTY_SPEED_TRACE)).toBeNull();
});

test('5 s buckets from the start: the mean trusted speed (1 dp) and the last sign limit seen in each', () => {
  const s = run([10, 20, 30, 40, 50, 33, 33, 33.33, null, null, 7], (i) => (i === 1 ? 25 : i === 3 ? 30 : i === 6 ? 45 : null));
  expect(speedTraceOf(s)).toEqual({
    widthS: 5,
    points: [
      { t: 0, v: 30, l: 30 },
      { t: 5, v: 33.1, l: 45 },
      { t: 10, v: 7, l: null },
    ],
  });
  expect(speedTraceJson(s)).toBe('{"w":5,"p":[[0,30,30],[5,33.1,45],[10,7,null]]}');
});

test('a bucket with no trusted speed reads null; an untrusted speed (speedAcc 3) is left out of the mean', () => {
  const s = run([20, 20, 20, 20, 20, 90, 90, 90, 90, 90], () => null, (i) => (i >= 5 ? { speedAcc: 3 } : {}));
  expect(speedTraceOf(s)?.points).toEqual([
    { t: 0, v: 20, l: null },
    { t: 5, v: null, l: null },
  ]);
});

test('a row before the start counts at 0 s; a gap leaves its buckets out', () => {
  let s = noteSpeedTrace(EMPTY_SPEED_TRACE, row({ speed: mph(10) }, -3), T0, null);
  s = noteSpeedTrace(s, row({ speed: mph(20) }, 1), T0, null);
  s = noteSpeedTrace(s, row({ speed: mph(40) }, 60), T0, 35);
  expect(speedTraceOf(s)?.points).toEqual([
    { t: 0, v: 15, l: null },
    { t: 60, v: 40, l: 35 },
  ]);
});

test('the state is frozen and replaced; the old one is untouched', () => {
  const a = run([10, 10]);
  const b = noteSpeedTrace(a, row({ speed: mph(30) }, 2), T0, 25);
  expect(Object.isFrozen(a)).toBe(true);
  expect(Object.isFrozen(b.open)).toBe(true);
  expect(speedTraceOf(a)?.points).toEqual([{ t: 0, v: 10, l: null }]);
  expect(speedTraceOf(b)?.points).toEqual([{ t: 0, v: 16.7, l: 25 }]);
});

test('merge maths: neighbours on the doubled grid join, speeds time-weighted over the rows that had one, the later limit else the earlier', () => {
  const merged = mergeBuckets(
    [
      { t: 0, sum: 100, n: 5, l: 25 },
      { t: 5, sum: 60, n: 2, l: null },
      { t: 10, sum: 0, n: 0, l: 35 },
      { t: 15, sum: 0, n: 0, l: null },
      { t: 25, sum: 30, n: 1, l: 45 },
    ],
    10
  );
  expect(merged).toEqual([
    { t: 0, sum: 160, n: 7, l: 25 },
    { t: 10, sum: 0, n: 0, l: 35 },
    { t: 20, sum: 30, n: 1, l: 45 },
  ]);
});

test('capped at 720 buckets: past 1 h of 5 s buckets the width doubles and neighbours merge; a 12 h drive keeps 80 s buckets', () => {
  // 3600 s fill exactly 720 buckets of 5 s.
  const hour = run(hold(30, 3600));
  expect(speedTraceOf(hour)?.widthS).toBe(5);
  expect(speedTraceOf(hour)?.points).toHaveLength(720);
  // The next row would make 721: 10 s buckets, 361 of them.
  const more = noteSpeedTrace(hour, row({ speed: mph(60) }, 3600), T0, 55);
  const trace = speedTraceOf(more)!;
  expect(trace.widthS).toBe(10);
  expect(trace.points).toHaveLength(361);
  expect(trace.points[0]).toEqual({ t: 0, v: 30, l: null });
  expect(trace.points[360]).toEqual({ t: 3600, v: 60, l: 55 });
  // The new row lands in the bucket that already holds rows after a merge (odd second).
  const odd = run([...hold(20, 3600), 40, 40, 40, 40, 40, 40]);
  const oddTrace = speedTraceOf(odd)!;
  expect(oddTrace.widthS).toBe(10);
  expect(oddTrace.points.at(-1)).toEqual({ t: 3600, v: 40, l: null });
  // 12 h at 1 Hz.
  let s: Readonly<SpeedTraceState> = EMPTY_SPEED_TRACE;
  for (let i = 0; i < 43_200; i += 1) s = noteSpeedTrace(s, row({ speed: mph(i < 21_600 ? 25 : 65) }, i), T0, null);
  const day = speedTraceOf(s)!;
  expect(day.widthS).toBe(80);
  expect(day.points).toHaveLength(540);
  expect(day.points.every((p, i) => p.t === i * 80)).toBe(true);
  expect(day.points[0]?.v).toBe(25);
  expect(day.points.at(-1)?.v).toBe(65);
});

test('a merged bucket that mixes speeds keeps the time-weighted mean', () => {
  // 3600 rows: the first 7 at 10 mph (bucket 0 all, bucket 5 two of five), the rest at 40.
  const s = noteSpeedTrace(run([...hold(10, 7), ...hold(40, 3593)]), row({ speed: mph(40) }, 3600), T0, null);
  const p = speedTraceOf(s)!.points;
  // 10 s bucket 0: seven rows at 10, three at 40.
  expect(p[0]).toEqual({ t: 0, v: 19, l: null });
  expect(p[1]).toEqual({ t: 10, v: 40, l: null });
});

test('parse: the stored JSON reads back; anything malformed is null', () => {
  expect(parseSpeedTrace('{"w":5,"p":[[0,30,30],[5,null,null]]}')).toEqual({
    widthS: 5,
    points: [
      { t: 0, v: 30, l: 30 },
      { t: 5, v: null, l: null },
    ],
  });
  expect(parseSpeedTrace('{"w":10,"p":[]}')).toEqual({ widthS: 10, points: [] });
  for (const bad of [null, undefined, '', 'nope', '[]', '{"p":[]}', '{"w":0,"p":[]}', '{"w":5,"p":[[0,1]]}', '{"w":5,"p":[[-1,1,1]]}', '{"w":5,"p":[[0,"x",1]]}', '{"w":5,"p":{}}']) {
    expect(parseSpeedTrace(bad)).toBeNull();
  }
  // Round trip.
  const s = run([12, 14, 16, 18, 20, 22], (i) => (i < 3 ? 25 : 35));
  expect(parseSpeedTrace(speedTraceJson(s))).toEqual(speedTraceOf(s));
});
