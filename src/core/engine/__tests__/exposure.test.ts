import { mph, row, T0 } from '@/core/detectors/__fixtures__/rows';
import {
  closeExposure,
  EMPTY_EXPOSURE_STATE,
  LIMIT_MIN_MPH,
  noteExposure,
  SWING_HYSTERESIS_MPH,
  SWING_MIN_MPH,
  TURN_MIN_DEG,
  TURN_MIN_MPH,
  TURN_SETTLE_DEG,
  TURN_SETTLE_ROWS,
  TURN_WINDOW_MS,
  type ExposureState,
} from '@/core/engine/exposure';
import type { FeatureRow } from '@/core/engine/types';

/** Rows at 1 Hz from a list of [mph, course]; extra fields per row from `over`. */
function rows(points: readonly (readonly [number, number])[], over: (i: number) => Partial<FeatureRow> = () => ({})): FeatureRow[] {
  return points.map(([v, course], i) => row({ speed: mph(v), course, ...over(i) }, i));
}
/** A speed profile at a fixed course. */
const speeds = (list: readonly number[], course = 90): FeatureRow[] => rows(list.map((v) => [v, course] as const));
/** Linear steps from `a` to `b` (inclusive) of `step` mph. */
function ramp(a: number, b: number, step = 1): number[] {
  const out: number[] = [];
  const dir = b >= a ? 1 : -1;
  for (let v = a; dir > 0 ? v <= b : v >= b; v += dir * step) out.push(v);
  return out;
}
const hold = (v: number, n: number): number[] => Array.from({ length: n }, () => v);

function run(list: readonly FeatureRow[], limitUsable: (i: number) => boolean = () => false, platform: 'ios' | 'android' = 'ios'): Readonly<ExposureState> {
  return list.reduce<Readonly<ExposureState>>((s, r, i) => noteExposure(s, r, limitUsable(i), platform), EMPTY_EXPOSURE_STATE);
}
const counted = (list: readonly FeatureRow[], movingS = 0) => closeExposure(run(list), movingS);

test('the constants', () => {
  expect([SWING_MIN_MPH, SWING_HYSTERESIS_MPH]).toEqual([12, 3]);
  expect([TURN_MIN_DEG, TURN_WINDOW_MS, TURN_MIN_MPH, TURN_SETTLE_ROWS, TURN_SETTLE_DEG]).toEqual([60, 20_000, 10, 3, 5]);
  expect(LIMIT_MIN_MPH).toBe(10);
});

describe('slowdowns and speed-ups', () => {
  test('0 → 35 → 0 is one speed-up and one slowdown (the stop closes it)', () => {
    const list = speeds([...ramp(0, 35), ...hold(35, 10), ...ramp(35, 0)]);
    const open = run(list);
    expect([open.speedups, open.slowdowns]).toEqual([1, 0]);
    expect(closeExposure(open, 0)).toMatchObject({ speedups: 1, slowdowns: 1 });
  });

  test('35 → 20 → 35 counts one of each', () => {
    expect(counted(speeds([...hold(35, 5), ...ramp(35, 20), ...ramp(20, 35), ...hold(35, 5)]))).toMatchObject({ slowdowns: 1, speedups: 1 });
  });

  test('a 5 mph swing (35 → 30 → 35) counts nothing', () => {
    expect(counted(speeds([...hold(35, 5), ...ramp(35, 30), ...ramp(30, 35), ...hold(35, 5)]))).toMatchObject({ slowdowns: 0, speedups: 0 });
  });

  test('±1 mph jitter at 35 counts nothing', () => {
    const jitter = Array.from({ length: 60 }, (_, i) => 35 + ((i % 3) - 1));
    expect(counted(speeds(jitter))).toMatchObject({ slowdowns: 0, speedups: 0 });
  });

  test('a 0 → 8 → 0 crawl counts nothing', () => {
    expect(counted(speeds([...ramp(0, 8), ...ramp(8, 0), ...ramp(0, 8), ...ramp(8, 0)]))).toMatchObject({ slowdowns: 0, speedups: 0 });
  });

  test('a stop from 15 mph to 3 mph is a slowdown; a 70 → 55 highway slowdown is one too', () => {
    expect(counted(speeds([...hold(15, 3), ...ramp(15, 3), ...ramp(3, 10)]))).toMatchObject({ slowdowns: 1 });
    expect(counted(speeds([...hold(70, 5), ...ramp(70, 55), ...ramp(55, 70), ...hold(70, 5)]))).toMatchObject({ slowdowns: 1, speedups: 1 });
  });

  test('three stops in stop-and-go traffic are three slowdowns and three speed-ups', () => {
    const leg = [...ramp(0, 25), ...hold(25, 5), ...ramp(25, 0), ...hold(0, 5)];
    expect(counted(speeds([...leg, ...leg, ...leg]))).toMatchObject({ slowdowns: 3, speedups: 3 });
  });

  test('untrusted or unknown speeds change nothing', () => {
    const list = speeds([...ramp(0, 35), ...ramp(35, 0)]);
    const untrusted = list.map((r) => ({ ...r, speedAcc: 3 }));
    expect(run(untrusted)).toBe(EMPTY_EXPOSURE_STATE);
    const unknown = list.map((r) => ({ ...r, speed: -1 }));
    expect(run(unknown)).toBe(EMPTY_EXPOSURE_STATE);
    const invalid = list.map((r) => ({ ...r, gnssValid: false }));
    expect(run(invalid)).toBe(EMPTY_EXPOSURE_STATE);
    // An untrusted dip inside a hold does not reset it.
    const withDip = speeds([...ramp(0, 35), 35, 35]).map((r, i, all) => (i === all.length - 2 ? { ...r, speed: mph(0), speedAcc: 5 } : r));
    expect(counted(withDip)).toMatchObject({ speedups: 1, slowdowns: 0 });
  });

  test('a drive cut mid-acceleration counts its speed-up at the close', () => {
    expect(counted(speeds(ramp(0, 30)))).toMatchObject({ speedups: 1, slowdowns: 0 });
  });
});

describe('turns', () => {
  /** Straight `before` rows at `from`, then `steps` rows turning by `deg` in total, then `after` straight rows. */
  function turnRows(v: number, from: number, deg: number, steps: number, before = 5, after = 5): [number, number][] {
    const out: [number, number][] = [];
    for (let i = 0; i < before; i += 1) out.push([v, from]);
    for (let i = 1; i <= steps; i += 1) out.push([v, (((from + (deg * i) / steps) % 360) + 360) % 360]);
    for (let i = 0; i < after; i += 1) out.push([v, (((from + deg) % 360) + 360) % 360]);
    return out;
  }

  test('a 90° turn at 30 mph over 4 s is one turn', () => {
    expect(counted(rows(turnRows(30, 0, 90, 4))).turns).toBe(1);
  });

  test('a U-turn (180°) is one turn, held until the heading settles', () => {
    expect(counted(rows(turnRows(15, 90, 180, 8))).turns).toBe(1);
  });

  test('two 90° corners 6 s apart are two turns', () => {
    const first = turnRows(20, 0, 90, 4, 5, 6);
    const second = turnRows(20, 90, 90, 4, 0, 5);
    expect(counted(rows([...first, ...second])).turns).toBe(2);
  });

  test('a lane change (+15°, then −15°) is no turn', () => {
    const list: [number, number][] = [...hold(0, 5).map(() => [40, 0] as [number, number]), [40, 8], [40, 15], [40, 8], [40, 0], [40, 352], [40, 345], [40, 352], [40, 0], [40, 0]];
    expect(counted(rows(list)).turns).toBe(0);
  });

  test('the same 90° turn at 8 mph is no turn (the course is noise below 10 mph)', () => {
    expect(counted(rows(turnRows(8, 0, 90, 4))).turns).toBe(0);
  });

  test('heading across north (350° → 80°) is one turn', () => {
    expect(counted(rows(turnRows(25, 350, 90, 5))).turns).toBe(1);
  });

  test('a slow drift of 60° over more than 20 s is no turn', () => {
    expect(counted(rows(turnRows(30, 0, 60, 30))).turns).toBe(0);
  });

  test('an unknown course (−1) or an invalid fix is skipped', () => {
    const list = rows(turnRows(30, 0, 90, 4)).map((r, i) => (i >= 5 && i < 9 ? { ...r, course: -1 } : r));
    // The skipped rows leave the last course in place: the next valid one still shows the 90°.
    expect(counted(list).turns).toBe(1);
    const allInvalid = rows(turnRows(30, 0, 90, 4)).map((r) => ({ ...r, course: -1 }));
    expect(counted(allInvalid).turns).toBe(0);
  });
});

describe('limit time', () => {
  test('counts only rows the speeding detector could use, at 10 mph or more', () => {
    const list = speeds([5, 9, 10, 20, 30, 30, 30]);
    const usable = (i: number) => i !== 5;
    expect(run(list, usable).limitS).toBe(4); // rows 2, 3, 4, 6
    expect(run(list, () => false).limitS).toBe(0);
  });

  test('closeExposure keeps limitS within movingS and passes movingS through', () => {
    const s = run(speeds(hold(30, 10)), () => true);
    expect(closeExposure(s, 12)).toMatchObject({ limitS: 10, movingS: 12 });
    expect(closeExposure(s, 6)).toMatchObject({ limitS: 6, movingS: 6 });
  });
});

describe('phone time (phone plan P2): the seconds a pickup could have been seen', () => {
  /** The IMU-absent encoding: every IMU field 0. */
  const noImu = { aLonMax: 0, aLonMin: 0, aLatMax: 0, aLatMin: 0, yawRateMax: 0, jerkMax: 0, gravityStability: 0, orientationDelta: 0, handlingScore: 0 };

  test('counts every row at 10 mph or more on a trusted speed with the motion sensors read, limit or not', () => {
    expect(run(speeds([5, 9, 9.9, 10, 20, 30])).phoneS).toBe(3);
    const list = rows(
      [
        [30, 90],
        [30, 90],
        [30, 90],
        [30, 90],
        [30, 90],
        [30, 90],
      ],
      (i) => [{}, { speedAcc: 3 }, noImu, { gnssValid: false }, { speed: -1 }, { speedAcc: -1 }][i]!
    );
    // the untrusted speed, the IMU-absent row, the lost fix and the unknown speed count nothing; no speed accuracy reported is trusted
    expect(run(list).phoneS).toBe(2);
  });

  test('on an iPhone a call row is no phone time (it can never be phone use); on Android it is', () => {
    const list = speeds(hold(30, 6)).map((r, i) => (i >= 2 && i < 5 ? { ...r, call: i === 2 ? ('ring' as const) : ('live' as const) } : r));
    expect(run(list, () => false, 'ios').phoneS).toBe(3);
    expect(run(list, () => false, 'android').phoneS).toBe(6);
  });

  test('closeExposure keeps phoneS within movingS', () => {
    const s = run(speeds(hold(30, 10)));
    expect(closeExposure(s, 12)).toMatchObject({ phoneS: 10, movingS: 12 });
    expect(closeExposure(s, 6)).toMatchObject({ phoneS: 6, movingS: 6 });
  });
});

describe('the reducer is pure', () => {
  test('states are frozen and the input is never changed', () => {
    const list = rows([
      [0, 0],
      [20, 0],
      [30, 45],
      [30, 90],
    ]);
    const states: Readonly<ExposureState>[] = [];
    let s = EMPTY_EXPOSURE_STATE;
    for (const r of list) {
      const before = JSON.stringify(s);
      const next = noteExposure(s, r, true, 'ios');
      expect(JSON.stringify(s)).toBe(before);
      expect(Object.isFrozen(next)).toBe(true);
      states.push(next);
      s = next;
    }
    expect(Object.isFrozen(EMPTY_EXPOSURE_STATE)).toBe(true);
  });

  test('the same rows give the same counters (a rebuilt drive agrees with the live one)', () => {
    const list = rows([
      ...ramp(0, 30).map((v) => [v, 0] as [number, number]),
      [30, 30],
      [30, 60],
      [30, 90],
      [30, 90],
      [30, 90],
      [30, 90],
      ...ramp(30, 0).map((v) => [v, 90] as [number, number]),
    ]);
    expect(closeExposure(run(list, () => true), 60)).toEqual(closeExposure(run(list, () => true), 60));
    // limit time: 21 rows rising from 10 to 30 mph, 6 at 30, 21 falling from 30 to 10
    expect(closeExposure(run(list, () => true), 60)).toEqual({ slowdowns: 1, speedups: 1, turns: 1, limitS: 48, movingS: 60, phoneS: 48 });
  });

  test('a cut drive keeps the counters of the state it was cut at (a mark is just a state)', () => {
    const list = speeds([...ramp(0, 30), ...ramp(30, 0), ...ramp(0, 30)]);
    const mid = run(list.slice(0, 61));
    expect(closeExposure(mid, 0)).toEqual({ slowdowns: 1, speedups: 1, turns: 0, limitS: 0, movingS: 0, phoneS: 0 });
    // phone time to the cut row: 21 rows from 10 to 30 mph, 21 from 30 down to 10 (row 60 is 0 mph).
    expect(mid.phoneS).toBe(42);
    expect(T0).toBe(list[0]!.ts);
  });
});
