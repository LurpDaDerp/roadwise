// Row builders shared by the detector tests. Lives outside `__tests__/` because Jest's default
// `testMatch` treats every file in there as a suite.
import type {
  DetectedEvent,
  Detector,
  DetectorContext,
  FeatureRow,
  LimitSample,
} from '@/core/engine/types';

/** Epoch ms of row 0; row `i` sits at `T0 + i * 1000` (1 Hz). */
export const T0 = 1_700_000_000_000;

export const mph = (v: number): number => v * 0.44704;

type Overrides = Partial<FeatureRow> | ((i: number) => Partial<FeatureRow>);

/** One feature row with the brief's defaults; `i` is the 1 Hz row index that fixes `ts`. */
export function row(overrides: Partial<FeatureRow> = {}, i = 0): FeatureRow {
  return {
    ts: T0 + i * 1000,
    lat: 37.7749,
    lng: -122.4194,
    hAcc: 5,
    speed: 15,
    speedAcc: 0.5,
    course: 90,
    alt: 10,
    gnssValid: true,
    aLonMax: 0,
    aLonMin: 0,
    aLatMax: 0,
    aLatMin: 0,
    yawRateMax: 0,
    jerkMax: 0,
    gravityStability: 1,
    orientationDelta: 0,
    handlingScore: 0,
    locked: true,
    screenOn: false,
    appForeground: true,
    ...overrides,
  };
}

/**
 * Consecutive 1 Hz rows from segments of `[count, overrides]`; a function override receives the
 * absolute row index.
 */
export function seq(...segments: readonly (readonly [number, Overrides])[]): FeatureRow[] {
  const out: FeatureRow[] = [];
  for (const [count, overrides] of segments) {
    for (let k = 0; k < count; k += 1) {
      const i = out.length;
      out.push(row(typeof overrides === 'function' ? overrides(i) : overrides, i));
    }
  }
  return out;
}

export function limit(
  limitMps: number | null,
  source: LimitSample['source'] = 'posted',
  extra: Partial<LimitSample> = {}
): LimitSample {
  return { limitMps, source, matchConfidence: 1, parallelRoads: false, ...extra };
}

export const NO_LIMIT: LimitSample = limit(null, 'unknown', { matchConfidence: 0 });

export function ctx(overrides: Partial<DetectorContext> = {}): DetectorContext {
  return { mode: 'mounted', night: false, precipitation: false, ...overrides };
}

/** Deterministic ids: e1, e2, ... */
export function counterIds(): () => string {
  let n = 0;
  return () => `e${(n += 1)}`;
}

type PerRow<T> = T | ((r: FeatureRow, i: number) => T);
const at = <T>(v: PerRow<T>, r: FeatureRow, i: number): T =>
  typeof v === 'function' ? (v as (r: FeatureRow, i: number) => T)(r, i) : v;

/** Push every row, keeping what each push returned, then flush. */
export function drive(
  det: Detector,
  list: FeatureRow[],
  lim: PerRow<LimitSample> = limit(mph(35)),
  c: PerRow<DetectorContext> = ctx()
): { pushed: DetectedEvent[][]; flushed: DetectedEvent[]; all: DetectedEvent[] } {
  const pushed = list.map((r, i) => det.push(r, at(lim, r, i), at(c, r, i)));
  const flushed = det.flush();
  return { pushed, flushed, all: [...pushed.flat(), ...flushed] };
}

export function only(events: DetectedEvent[]): DetectedEvent {
  expect(events).toHaveLength(1);
  return events[0] as DetectedEvent;
}
