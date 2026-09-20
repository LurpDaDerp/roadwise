import { CONSTANTS } from '@scoring';
import { createArbiter } from '@/core/alerts/arbiter';
import type { AlertDecision, Arbiter } from '@/core/alerts/types';
import { createDetectors, type TripDetectors } from '@/core/detectors';
import { T0, counterIds, limit, mph, row } from '@/core/detectors/__fixtures__/rows';
import { ROW_MS } from '@/core/detectors/common';
import type { EngineDeps, EngineSnapshot, TripSession } from '@/core/engine/engine.types';
import { PREFETCH_EVERY_M, STATIONARY_SPEED_MPS, createEngine } from '@/core/engine/machine';
import type { CameraFocusSample, FeatureRow, LimitSample } from '@/core/engine/types';

const {
  AUTO_DETECT_CONFIRM_S,
  AUTO_DETECT_WINDOW_S,
  AUTO_END_STATIONARY_S,
  CHECKPOINT_S,
  GAP_MERGE_S,
  LEARNING_PERIOD_TRIPS,
  LOCKOUT_SPEED_MPS,
  STOPPED_PANEL_S,
} = CONSTANTS;

const L35 = limit(mph(35));
const UNKNOWN: LimitSample = { limitMps: null, source: 'unknown', matchConfidence: 0, parallelRoads: false };
/** Epoch ms of second `s` of a scripted drive (row `i` sits at `at(i)`). */
const at = (s: number) => T0 + s * ROW_MS;
/** `[at(from), …, at(to - 1)]` */
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, k) => at(from + k));

/** Comfortably above the 12 mph confirm speed and the 5 mph lockout. */
const FAST = { speed: mph(20) };
/** Moving, but under everything: the confirm speed, the lockout, the stopped-panel clear. */
const CREEP = { speed: 1 };
/** Below 0.5 m/s: the C8 stationary clock runs. */
const STILL = { speed: 0.2 };
const STOPPED = { speed: 0 };
/** 45 in a 35: ten over the limit, five beyond the tolerance line. */
const OVER = { speed: mph(45) };
const HAND = { handlingScore: 0.7 };

type Overrides = Partial<FeatureRow> | ((i: number) => Partial<FeatureRow>);

interface HarnessOptions {
  tripIndex?: number;
  limit?: LimitSample | null;
  cameraAt?: (i: number) => CameraFocusSample | null;
  /** Give the engine an `onError` sink and collect what lands in it. */
  onError?: boolean;
  /** Make every detector suite's `flush` throw. */
  breakFlush?: boolean;
  /** Make the host's `onAlert` throw instead of recording the alert. */
  breakAlert?: boolean;
}

function harness(opts: HarnessOptions = {}) {
  let now = 0;
  let ids = 0;
  let rowIndex = 0;
  const alerts: AlertDecision[] = [];
  const checkpoints: Readonly<TripSession>[] = [];
  const finalized: Readonly<TripSession>[] = [];
  const detectorsMade: TripDetectors[] = [];
  const arbiters: Arbiter[] = [];
  const errors: unknown[] = [];
  const lookup = jest.fn((): LimitSample | null => (opts.limit === undefined ? L35 : opts.limit));
  const prefetch = jest.fn();
  const onCheckpoint = jest.fn(async (s: Readonly<TripSession>) => {
    checkpoints.push(s);
  });
  const onFinalize = jest.fn(async (s: Readonly<TripSession>) => {
    finalized.push(s);
  });
  const detectorFactory = jest.fn((): TripDetectors => {
    const suite = createDetectors(counterIds());
    if (opts.breakFlush) {
      suite.flush = () => {
        throw new Error('flush failed');
      };
    }
    detectorsMade.push(suite);
    return suite;
  });
  const arbiterFactory = jest.fn((): Arbiter => {
    const arbiter = createArbiter({ tripIndex: opts.tripIndex ?? LEARNING_PERIOD_TRIPS });
    arbiters.push(arbiter);
    return arbiter;
  });
  const deps: EngineDeps = {
    now: () => now,
    newId: () => `trip-${(ids += 1)}`,
    limits: { lookup, prefetch },
    createDetectors: detectorFactory,
    createArbiter: arbiterFactory,
    onAlert: (d) => {
      if (opts.breakAlert) throw new Error('alert sink failed');
      alerts.push(d);
    },
    onCheckpoint,
    onFinalize,
    ctx: () => ({
      night: false,
      precipitation: false,
      cameraFocus: opts.cameraAt ? opts.cameraAt(rowIndex) : null,
    }),
  };
  if (opts.onError) {
    deps.onError = (err) => {
      errors.push(err);
    };
  }
  const engine = createEngine(deps);

  const rowAt = (i: number, overrides: Overrides): FeatureRow =>
    row(typeof overrides === 'function' ? overrides(i) : overrides, i);

  /** Dispatch `n` rows at 1 Hz from second `from`; returns the second after the last one. */
  async function drive(from: number, n: number, overrides: Overrides = FAST): Promise<number> {
    for (let k = 0; k < n; k += 1) {
      const i = from + k;
      rowIndex = i;
      now = at(i);
      await engine.dispatch({ type: 'row', row: rowAt(i, overrides) });
    }
    return from + n;
  }

  return {
    engine,
    deps,
    drive,
    rowAt,
    alerts,
    checkpoints,
    finalized,
    detectorsMade,
    arbiters,
    errors,
    lookup,
    prefetch,
    onCheckpoint,
    onFinalize,
    detectorFactory,
    arbiterFactory,
    status: () => engine.snapshot().status,
  };
}

type Harness = ReturnType<typeof harness>;

async function armed(opts: HarnessOptions = {}) {
  const h = harness(opts);
  await h.engine.dispatch({ type: 'arm' });
  return h;
}

/** Armed and recording a manual mounted drive started at second 0, as a driver. */
async function recording(opts: HarnessOptions = {}) {
  const h = await armed(opts);
  await h.engine.dispatch({ type: 'manualStart', mode: 'mounted', passenger: false, ts: at(0) });
  return h;
}

/** One tap on End (C6): recording or ending → finalized. */
async function endNow(h: Harness, s: number) {
  await h.engine.dispatch({ type: 'end', ts: at(s) });
}

/** Recording ten fast seconds, then walking at second 10 puts the trip in `ending`. */
async function endingAt10(opts: HarnessOptions = {}) {
  const h = await recording(opts);
  await h.drive(0, 10);
  await h.engine.dispatch({ type: 'activity', automotive: false, walking: true, ts: at(10) });
  expect(h.status()).toBe('ending');
  return h;
}

const only = <T>(list: readonly T[]): T => {
  expect(list).toHaveLength(1);
  return list[0] as T;
};

/** The `ts` of the rows a checkpoint call must persist: everything after the last completed one. */
const rowsSince = (s: Readonly<TripSession>): number[] => {
  const last = s.checkpoints[s.checkpoints.length - 1] ?? -Infinity;
  return s.rows.filter((r) => r.ts > last).map((r) => r.ts);
};

describe('arm and disarm', () => {
  test('starts off; arm goes armed; disarm goes off', async () => {
    const h = harness();
    expect(h.status()).toBe('off');
    await h.engine.dispatch({ type: 'arm' });
    expect(h.status()).toBe('armed');
    await h.engine.dispatch({ type: 'disarm' });
    expect(h.status()).toBe('off');
  });

  test('rows are ignored while off or armed: no state change, no notification', async () => {
    const h = await armed();
    const seen: EngineSnapshot[] = [];
    h.engine.subscribe((s) => seen.push(s));
    await h.drive(0, 3);
    expect(h.status()).toBe('armed');
    expect(h.engine.snapshot().lastRowTs).toBeNull();
    expect(seen).toEqual([]);
  });

  test('disarm during a candidate drops it', async () => {
    const h = await armed();
    await h.engine.dispatch({ type: 'wake', reason: 'activityTransition', ts: at(0) });
    await h.drive(0, 10);
    await h.engine.dispatch({ type: 'disarm' });
    expect(h.status()).toBe('off');
    expect(h.engine.snapshot().lastRowTs).toBeNull();
    expect(h.onFinalize).not.toHaveBeenCalled();
  });

  test('arm and disarm during a trip only decide where the trip returns to', async () => {
    const h = await recording();
    await h.drive(0, 5);
    await h.engine.dispatch({ type: 'disarm' });
    expect(h.status()).toBe('recording');
    await endNow(h, 5);
    expect(h.status()).toBe('off');

    const g = harness();
    await g.engine.dispatch({ type: 'manualStart', mode: 'pocket', passenger: false, ts: at(0) });
    expect(g.status()).toBe('recording');
    await g.engine.dispatch({ type: 'arm' });
    expect(g.status()).toBe('recording');
    await endNow(g, 1);
    expect(g.status()).toBe('armed');
  });
});

describe('armed → candidate', () => {
  test('a wake opens a candidate with no trip yet', async () => {
    const h = await armed();
    await h.engine.dispatch({ type: 'wake', reason: 'significantChange', ts: at(0) });
    expect(h.engine.snapshot()).toMatchObject({
      status: 'candidate',
      clientTripId: null,
      startedAt: null,
    });
    expect(h.detectorFactory).not.toHaveBeenCalled();
    expect(h.arbiterFactory).not.toHaveBeenCalled();
  });

  test('an automotive activity opens a candidate', async () => {
    const h = await armed();
    await h.engine.dispatch({ type: 'activity', automotive: true, walking: false, ts: at(0) });
    expect(h.status()).toBe('candidate');
  });

  test('a wake or automotive activity while already recording is ignored', async () => {
    const h = await recording();
    await h.drive(0, 3);
    const before = h.engine.snapshot();
    await h.engine.dispatch({ type: 'wake', reason: 'geofence', ts: at(3) });
    await h.engine.dispatch({ type: 'activity', automotive: true, walking: false, ts: at(3) });
    expect(h.engine.snapshot()).toEqual(before);
  });

  test('a wake while off is ignored', async () => {
    const h = harness();
    await h.engine.dispatch({ type: 'wake', reason: 'boot', ts: at(0) });
    expect(h.status()).toBe('off');
  });
});

describe('candidate confirmation (30 s over 12 mph within 180 s)', () => {
  test('confirms on the row that completes AUTO_DETECT_CONFIRM_S fast seconds', async () => {
    const h = await armed();
    await h.engine.dispatch({ type: 'wake', reason: 'activityTransition', ts: at(0) });
    await h.drive(0, AUTO_DETECT_CONFIRM_S - 1);
    expect(h.status()).toBe('candidate');
    await h.drive(AUTO_DETECT_CONFIRM_S - 1, 1);
    expect(h.engine.snapshot()).toMatchObject({
      status: 'recording',
      clientTripId: 'trip-1',
      mode: 'auto',
      role: 'driver',
      startedAt: at(0),
      lastRowTs: at(AUTO_DETECT_CONFIRM_S - 1),
    });
    expect(h.detectorFactory).toHaveBeenCalledTimes(1);
    expect(h.arbiterFactory).toHaveBeenCalledTimes(1);
  });

  test('the fast seconds are cumulative, not consecutive', async () => {
    const h = await armed();
    await h.engine.dispatch({ type: 'wake', reason: 'activityTransition', ts: at(0) });
    let s = await h.drive(0, 10, FAST);
    s = await h.drive(s, 20, CREEP);
    s = await h.drive(s, 19, FAST);
    expect(h.status()).toBe('candidate');
    await h.drive(s, 1, FAST);
    expect(h.status()).toBe('recording');
  });

  test('rows at 2 Hz count half a second each', async () => {
    const h = await armed();
    await h.engine.dispatch({ type: 'wake', reason: 'activityTransition', ts: at(0) });
    const halfSecond = (i: number) => ({ ...FAST, ts: at(0) + i * 500 });
    // The first row stands for a full row-length, every later one for the half second since the
    // row before it: 1 + 57 × 0.5 = 29.5 after 58 rows; the 59th brings 30.
    for (let i = 0; i < 58; i += 1) {
      await h.engine.dispatch({ type: 'row', row: h.rowAt(i, halfSecond(i)) });
    }
    expect(h.status()).toBe('candidate');
    await h.engine.dispatch({ type: 'row', row: h.rowAt(58, halfSecond(58)) });
    expect(h.status()).toBe('recording');
  });

  test('rows at 0.5 Hz count at most a second each', async () => {
    const h = await armed();
    await h.engine.dispatch({ type: 'wake', reason: 'activityTransition', ts: at(0) });
    const twoSeconds = (i: number) => ({ ...FAST, ts: at(0) + i * 2000 });
    // Sixteen rows span 30 s of wall clock, but a sparse fix vouches for one second at most.
    for (let i = 0; i < 16; i += 1) {
      await h.engine.dispatch({ type: 'row', row: h.rowAt(i, twoSeconds(i)) });
    }
    expect(h.status()).toBe('candidate');
    for (let i = 16; i < AUTO_DETECT_CONFIRM_S - 1; i += 1) {
      await h.engine.dispatch({ type: 'row', row: h.rowAt(i, twoSeconds(i)) });
    }
    expect(h.status()).toBe('candidate');
    await h.engine.dispatch({
      type: 'row',
      row: h.rowAt(AUTO_DETECT_CONFIRM_S - 1, twoSeconds(AUTO_DETECT_CONFIRM_S - 1)),
    });
    expect(h.status()).toBe('recording');
  });

  test('the buffered candidate rows belong to the trip once it confirms', async () => {
    const h = await armed();
    await h.engine.dispatch({ type: 'wake', reason: 'activityTransition', ts: at(0) });
    let s = await h.drive(0, 5, CREEP);
    s = await h.drive(s, AUTO_DETECT_CONFIRM_S, FAST);
    expect(h.status()).toBe('recording');
    await endNow(h, s);
    const trip = only(h.finalized);
    expect(trip.rowsCount).toBe(5 + AUTO_DETECT_CONFIRM_S);
    expect(trip.startedAt).toBe(at(0));
    expect(trip.startSource).toBe('auto');
    expect(trip.startApproximate).toBe(false);
  });

  test('a candidate that never confirms is discarded silently at the window, rows dropped', async () => {
    const h = await armed();
    await h.engine.dispatch({ type: 'wake', reason: 'activityTransition', ts: at(0) });
    let s = await h.drive(0, 20, FAST);
    s = await h.drive(s, AUTO_DETECT_WINDOW_S - 20, CREEP);
    expect(h.status()).toBe('candidate');
    // Rows 0..179 are the window's 180 seconds; the row at second 180 is the first outside it.
    await h.drive(s, 1, FAST);
    expect(h.status()).toBe('armed');
    expect(h.onFinalize).not.toHaveBeenCalled();
    expect(h.onCheckpoint).not.toHaveBeenCalled();
    expect(h.detectorFactory).not.toHaveBeenCalled();
    expect(h.engine.snapshot().lastRowTs).toBeNull();

    // The next candidate starts from nothing: no leftover fast seconds, no consumed trip id.
    await h.engine.dispatch({ type: 'wake', reason: 'activityTransition', ts: at(s + 1) });
    s = await h.drive(s + 1, AUTO_DETECT_CONFIRM_S - 1, FAST);
    expect(h.status()).toBe('candidate');
    s = await h.drive(s, 1, FAST);
    expect(h.engine.snapshot().clientTripId).toBe('trip-1');
    await endNow(h, s);
    expect(only(h.finalized).rowsCount).toBe(AUTO_DETECT_CONFIRM_S);
  });

  test('a tick past the window discards the candidate', async () => {
    const h = await armed();
    await h.engine.dispatch({ type: 'wake', reason: 'activityTransition', ts: at(0) });
    await h.drive(0, 10, FAST);
    await h.engine.dispatch({ type: 'tick', ts: at(AUTO_DETECT_WINDOW_S - 1) });
    expect(h.status()).toBe('candidate');
    await h.engine.dispatch({ type: 'tick', ts: at(AUTO_DETECT_WINDOW_S) });
    expect(h.status()).toBe('armed');
    expect(h.onFinalize).not.toHaveBeenCalled();
  });

  test('candidateStartTs backfills the start and marks it approximate', async () => {
    const h = await armed();
    await h.engine.dispatch({
      type: 'wake',
      reason: 'activityTransition',
      ts: at(0),
      candidateStartTs: at(-90),
    });
    const s = await h.drive(0, AUTO_DETECT_CONFIRM_S, FAST);
    expect(h.engine.snapshot().startedAt).toBe(at(-90));
    await endNow(h, s);
    expect(only(h.finalized)).toMatchObject({ startedAt: at(-90), startApproximate: true });
  });

  test('the window is measured from the wake, not from a backfilled start', async () => {
    const h = await armed();
    await h.engine.dispatch({
      type: 'wake',
      reason: 'activityTransition',
      ts: at(0),
      candidateStartTs: at(-170),
    });
    await h.drive(0, 20, CREEP);
    await h.drive(20, AUTO_DETECT_CONFIRM_S, FAST);
    expect(h.status()).toBe('recording');
  });

  test('walking during a candidate discards it', async () => {
    const h = await armed();
    await h.engine.dispatch({ type: 'wake', reason: 'activityTransition', ts: at(0) });
    await h.drive(0, 10, FAST);
    await h.engine.dispatch({ type: 'activity', automotive: false, walking: true, ts: at(10) });
    expect(h.status()).toBe('armed');
    expect(h.onFinalize).not.toHaveBeenCalled();
  });

  test('end during a candidate discards it', async () => {
    const h = await armed();
    await h.engine.dispatch({ type: 'wake', reason: 'activityTransition', ts: at(0) });
    await h.drive(0, 10, FAST);
    await h.engine.dispatch({ type: 'end', ts: at(10) });
    expect(h.status()).toBe('armed');
    expect(h.onFinalize).not.toHaveBeenCalled();
  });

  test('a manual start during a candidate confirms it at once, keeping the buffered rows', async () => {
    const h = await armed();
    await h.engine.dispatch({ type: 'wake', reason: 'activityTransition', ts: at(0) });
    await h.drive(0, 10, CREEP);
    await h.engine.dispatch({ type: 'manualStart', mode: 'pocket', passenger: true, ts: at(10) });
    expect(h.engine.snapshot()).toMatchObject({
      status: 'recording',
      mode: 'pocket',
      role: 'passenger',
      startedAt: at(0),
    });
    const s = await h.drive(10, 5, CREEP);
    await endNow(h, s);
    expect(only(h.finalized)).toMatchObject({ rowsCount: 15, startSource: 'manual' });
  });

  test('an invalid fix with a stale positive speed does not count towards confirmation', async () => {
    const h = await armed();
    await h.engine.dispatch({ type: 'wake', reason: 'activityTransition', ts: at(0) });
    let s = await h.drive(0, AUTO_DETECT_CONFIRM_S, { ...FAST, gnssValid: false });
    expect(h.status()).toBe('candidate');
    s = await h.drive(s, AUTO_DETECT_CONFIRM_S, { speed: -1 });
    expect(h.status()).toBe('candidate');
    // Only valid fixes vouch for the fast seconds.
    await h.drive(s, AUTO_DETECT_CONFIRM_S, FAST);
    expect(h.status()).toBe('recording');
  });

  test('a factory that throws at confirmation leaves the candidate exactly as it was', async () => {
    const h = await armed();
    await h.engine.dispatch({ type: 'wake', reason: 'activityTransition', ts: at(0) });
    await h.drive(0, 5, CREEP);
    const before = h.engine.snapshot();
    h.arbiterFactory.mockImplementationOnce(() => {
      throw new Error('no arbiter');
    });
    await expect(
      h.engine.dispatch({ type: 'manualStart', mode: 'mounted', passenger: false, ts: at(5) })
    ).rejects.toThrow('no arbiter');
    expect(h.engine.snapshot()).toEqual(before);
    expect(h.onCheckpoint).not.toHaveBeenCalled();
    // The same candidate then confirms with its buffered rows and the first trip id: nothing
    // was consumed by the failed attempt. The detector suite made beside the failed arbiter is
    // a factory side effect, not engine state, and is simply made again.
    await h.engine.dispatch({ type: 'manualStart', mode: 'mounted', passenger: false, ts: at(5) });
    expect(h.engine.snapshot()).toMatchObject({
      status: 'recording',
      clientTripId: 'trip-1',
      startedAt: at(0),
      lastRowTs: at(4),
    });
    expect(h.detectorFactory).toHaveBeenCalledTimes(2);
    await endNow(h, 5);
    expect(only(h.finalized).rowsCount).toBe(5);
  });
});

describe('manual start', () => {
  test('confirms immediately with the given mode and role, started at the tap', async () => {
    const h = await armed();
    await h.engine.dispatch({ type: 'manualStart', mode: 'mounted', passenger: false, ts: at(7) });
    expect(h.engine.snapshot()).toMatchObject({
      status: 'recording',
      clientTripId: 'trip-1',
      mode: 'mounted',
      role: 'driver',
      startedAt: at(7),
      lastRowTs: null,
    });
  });

  test('works while auto-detect is off, and returns there afterwards', async () => {
    const h = harness();
    await h.engine.dispatch({ type: 'manualStart', mode: 'pocket', passenger: false, ts: at(0) });
    expect(h.status()).toBe('recording');
    await h.drive(0, 3);
    await endNow(h, 3);
    expect(h.status()).toBe('off');
    expect(h.onFinalize).toHaveBeenCalledTimes(1);
  });

  test('a manual start while already recording is ignored', async () => {
    const h = await recording();
    await h.drive(0, 3);
    await h.engine.dispatch({ type: 'manualStart', mode: 'pocket', passenger: true, ts: at(3) });
    expect(h.engine.snapshot()).toMatchObject({
      status: 'recording',
      clientTripId: 'trip-1',
      mode: 'mounted',
      role: 'driver',
      startedAt: at(0),
    });
    await h.drive(3, 2);
    await endNow(h, 5);
    expect(only(h.finalized).rowsCount).toBe(5);
  });

  test('a manual trip with no rows still finalizes once, without a checkpoint', async () => {
    const h = await recording();
    await endNow(h, 4);
    const trip = only(h.finalized);
    expect(trip).toMatchObject({ rowsCount: 0, startedAt: at(0), endedAt: at(4), durationS: 4 });
    expect(h.onCheckpoint).not.toHaveBeenCalled();
  });
});

describe('rows while recording', () => {
  test('looks the limit up per row and shows it in the snapshot', async () => {
    const h = await recording();
    await h.drive(0, 2, { lat: 1, lng: 2, course: 3 });
    expect(h.lookup).toHaveBeenCalledTimes(2);
    expect(h.lookup).toHaveBeenLastCalledWith(1, 2, 3);
    expect(h.engine.snapshot().limit).toEqual(L35);
  });

  test('a null lookup is an unknown limit', async () => {
    const h = await recording({ limit: null });
    await h.drive(0, 1);
    expect(h.engine.snapshot().limit).toEqual(UNKNOWN);
  });

  test('the snapshot follows the last row', async () => {
    const h = await recording();
    await h.drive(0, 3, { speed: 12 });
    expect(h.engine.snapshot()).toMatchObject({ lastRowTs: at(2), speedMps: 12 });
    await h.drive(3, 1, { speed: -1 });
    expect(h.engine.snapshot().speedMps).toBe(0);
  });

  test('a row that does not advance the clock is dropped', async () => {
    const h = await recording();
    await h.drive(0, 3);
    await h.engine.dispatch({ type: 'row', row: h.rowAt(1, FAST) });
    await h.engine.dispatch({ type: 'row', row: h.rowAt(2, FAST) });
    await endNow(h, 3);
    expect(only(h.finalized).rowsCount).toBe(3);
  });

  test('distance accumulates from the fixes', async () => {
    const h = await recording();
    const perRow = 25 / 111_194.93; // ~25 m of latitude per second
    await h.drive(0, 41, (i) => ({ ...FAST, lat: 37.7749 + i * perRow }));
    expect(h.engine.snapshot().distanceM).toBeGreaterThan(999);
    expect(h.engine.snapshot().distanceM).toBeLessThan(1001);
  });

  test('prefetches on the first fix and then once per PREFETCH_EVERY_M', async () => {
    const h = await recording();
    const perRow = 25 / 111_194.93;
    await h.drive(0, 100, (i) => ({ ...FAST, lat: 37.7749 + i * perRow, course: 0 }));
    // 0 m, then at ~1000 m and ~2000 m of the 2475 m driven.
    expect(h.prefetch).toHaveBeenCalledTimes(1 + Math.floor(2475 / PREFETCH_EVERY_M));
    expect(h.prefetch).toHaveBeenNthCalledWith(1, 37.7749, -122.4194, 0);
  });

  test('invalid fixes never prefetch', async () => {
    const h = await recording();
    await h.drive(0, 5, { gnssValid: false });
    expect(h.prefetch).not.toHaveBeenCalled();
    await h.drive(5, 1);
    expect(h.prefetch).toHaveBeenCalledTimes(1);
  });

  test('subscribers hear every change until they unsubscribe; snapshots are frozen', async () => {
    const h = await recording();
    const seen: EngineSnapshot[] = [];
    const off = h.engine.subscribe((s) => seen.push(s));
    await h.drive(0, 3);
    expect(seen.map((s) => s.lastRowTs)).toEqual([at(0), at(1), at(2)]);
    expect(seen.every((s) => Object.isFrozen(s))).toBe(true);
    off();
    await h.drive(3, 2);
    expect(seen).toHaveLength(3);
    expect(Object.isFrozen(h.engine.snapshot())).toBe(true);
  });

  test('never reads the wall clock', async () => {
    const spy = jest.spyOn(Date, 'now');
    try {
      const h = await armed();
      await h.engine.dispatch({ type: 'wake', reason: 'activityTransition', ts: at(0) });
      const s = await h.drive(0, AUTO_DETECT_CONFIRM_S + CHECKPOINT_S, FAST);
      await h.engine.dispatch({ type: 'setPassenger', passenger: true, ts: at(s) });
      await endNow(h, s);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('checkpoints', () => {
  test('floor(rows / CHECKPOINT_S) calls during the drive, each with the rows to persist', async () => {
    const h = await recording();
    const n = CHECKPOINT_S * 3 + 5;
    await h.drive(0, n);
    expect(h.onCheckpoint).toHaveBeenCalledTimes(Math.floor(n / CHECKPOINT_S));
    expect(h.checkpoints.map((s) => s.rowsCount)).toEqual([30, 60, 90]);
    expect(h.checkpoints.map((s) => s.checkpoints)).toEqual([[], [at(29)], [at(29), at(59)]]);
    const third = h.checkpoints[2]!;
    expect(rowsSince(third)).toEqual(range(60, 90));
    expect(Object.isFrozen(third)).toBe(true);
    // Finalize persists the five rows the cadence had not reached.
    await endNow(h, n);
    expect(h.onCheckpoint).toHaveBeenCalledTimes(4);
    expect(rowsSince(h.checkpoints[3]!)).toEqual(range(90, 95));
    expect(only(h.finalized).checkpoints).toEqual([at(29), at(59), at(89), at(94)]);
  });

  test('finalize persists the tail before handing the session over', async () => {
    const h = await recording();
    await h.drive(0, 45);
    await endNow(h, 45);
    expect(h.onCheckpoint).toHaveBeenCalledTimes(2);
    const tail = h.checkpoints[1]!;
    expect(tail.checkpoints).toEqual([at(29)]);
    expect(rowsSince(tail)).toEqual(range(30, 45));
    expect(h.onCheckpoint.mock.invocationCallOrder[1]).toBeLessThan(
      h.onFinalize.mock.invocationCallOrder[0]!
    );
    expect(only(h.finalized).checkpoints).toEqual([at(29), at(44)]);
  });

  test('no tail checkpoint when the last row is already covered', async () => {
    const h = await recording();
    await h.drive(0, CHECKPOINT_S);
    await endNow(h, CHECKPOINT_S);
    expect(h.onCheckpoint).toHaveBeenCalledTimes(1);
    expect(only(h.finalized).checkpoints).toEqual([at(CHECKPOINT_S - 1)]);
  });

  test('ending checkpoints the tail, so a long gap cannot evict un-persisted rows', async () => {
    const h = await recording();
    await h.drive(0, 45);
    await h.engine.dispatch({ type: 'activity', automotive: false, walking: true, ts: at(45) });
    expect(h.status()).toBe('ending');
    expect(h.onCheckpoint).toHaveBeenCalledTimes(2);
    expect(rowsSince(h.checkpoints[1]!)).toEqual(range(30, 45));
    // Nine minutes later — well past the 120 s ring — the trip resumes.
    const back = 45 + 540;
    await h.drive(back, 15, FAST);
    expect(h.status()).toBe('recording');
    expect(h.onCheckpoint).toHaveBeenCalledTimes(3);
    expect(rowsSince(h.checkpoints[2]!)).toEqual(range(back, back + 15));
    await endNow(h, back + 15);
    expect(h.onCheckpoint).toHaveBeenCalledTimes(3);
    expect(only(h.finalized).checkpoints).toEqual([at(29), at(44), at(back + 14)]);
  });

  test('the candidate rows count towards the cadence once they are replayed', async () => {
    const h = await armed();
    await h.engine.dispatch({ type: 'wake', reason: 'activityTransition', ts: at(0) });
    await h.drive(0, 35, CREEP);
    expect(h.onCheckpoint).not.toHaveBeenCalled();
    await h.drive(35, AUTO_DETECT_CONFIRM_S, FAST);
    expect(h.onCheckpoint).toHaveBeenCalledTimes(2);
    expect(h.checkpoints.map((s) => s.rowsCount)).toEqual([30, 60]);
  });

  test('a rejected checkpoint fails that dispatch, stays unrecorded, and the engine carries on', async () => {
    const h = await recording();
    h.onCheckpoint.mockRejectedValueOnce(new Error('disk full'));
    await h.drive(0, CHECKPOINT_S - 1);
    await expect(h.engine.dispatch({ type: 'row', row: h.rowAt(CHECKPOINT_S - 1, FAST) })).rejects.toThrow(
      'disk full'
    );
    expect(h.status()).toBe('recording');
    await h.drive(CHECKPOINT_S, CHECKPOINT_S);
    expect(h.onCheckpoint).toHaveBeenCalledTimes(2);
    expect(only(h.checkpoints).checkpoints).toEqual([]);
    await endNow(h, CHECKPOINT_S * 2);
    expect(only(h.finalized).checkpoints).toEqual([at(59)]);
  });
});

describe('detectors and alerts', () => {
  test('a speeding alert is delivered, tagged with the episode, and earns the correction credit', async () => {
    const h = await recording();
    let s = await h.drive(0, 12, OVER);
    s = await h.drive(s, 3, { speed: mph(30) });
    const alert = only(h.alerts);
    // overForS is seconds since the first row beyond tolerance, so the sixth over row is the first at 5.
    expect(alert).toMatchObject({ kind: 'speeding', level: 1, eventId: 'e1', ts: at(5) });
    await endNow(h, s);
    const trip = only(h.finalized);
    expect(trip.alerts).toEqual([alert]);
    expect(only(trip.events)).toMatchObject({
      id: 'e1',
      category: 'speeding',
      durationS: 12,
      corrected: true,
    });
  });

  test('the arbiter sees the plain over-limit and a tolerance-gated overForS', async () => {
    const h = await recording();
    const consider = jest.spyOn(only(h.arbiters), 'consider');
    await h.drive(0, 2, OVER);
    await h.drive(2, 1, { speed: mph(38) }); // over the limit, inside the tolerance
    await h.drive(3, 1, { speed: mph(30) });
    const inputs = consider.mock.calls.map(([input]) => [input.overMps, input.overForS, input.q]);
    expect(inputs[0]![0]).toBeCloseTo(mph(10), 9);
    expect(inputs[1]![0]).toBeCloseTo(mph(10), 9);
    expect(inputs[2]![0]).toBeCloseTo(mph(3), 9);
    expect(inputs[3]![0]).toBe(0);
    expect(inputs.map((i) => i[1])).toEqual([0, 1, 0, 0]);
    expect(inputs.map((i) => i[2])).toEqual([0.9, 0.9, 0.9, 0.9]);
    expect(consider.mock.calls[0]![0]).toMatchObject({
      ts: at(0),
      speedMps: mph(45),
      limitMps: mph(35),
      drivingS: 0,
    });
  });

  test('an unknown limit means no over-limit and no quality', async () => {
    const h = await recording({ limit: null });
    const consider = jest.spyOn(only(h.arbiters), 'consider');
    await h.drive(0, 1, OVER);
    expect(consider.mock.calls[0]![0]).toMatchObject({ limitMps: null, overMps: 0, overForS: 0, q: 0 });
  });

  test("the detector's open phone episode is offered to the arbiter, with its own id", async () => {
    const h = await recording();
    const consider = jest.spyOn(only(h.arbiters), 'consider');
    await h.drive(0, 5, { speed: 15, ...HAND });
    const alert = only(h.alerts);
    expect(alert).toMatchObject({ kind: 'phone', level: 2, ts: at(2), eventId: 'e1' });
    expect(consider.mock.calls.map(([i]) => i.phoneEpisode ?? null)).toEqual([
      null,
      null,
      { id: 'e1', durationS: 3 },
      { id: 'e1', durationS: 4 },
      { id: 'e1', durationS: 5 },
    ]);
    const s = await h.drive(5, 3, { speed: 15 });
    await endNow(h, s);
    expect(only(only(h.finalized).events)).toMatchObject({ id: 'e1', category: 'phone', startedAt: at(0) });
  });

  test('an app-switch episode in mounted mode reaches the arbiter too; pocket mode has none', async () => {
    const h = await recording();
    await h.drive(0, 3, { speed: 15, appForeground: false });
    expect(only(h.alerts)).toMatchObject({ kind: 'phone', eventId: 'e1', ts: at(2) });

    const g = await armed();
    await g.engine.dispatch({ type: 'manualStart', mode: 'pocket', passenger: false, ts: at(0) });
    await g.drive(0, 5, { speed: 15, appForeground: false });
    expect(g.alerts).toEqual([]);
  });

  test('each trip gets its own detectors and its own arbiter', async () => {
    const h = await recording();
    await h.drive(0, 5, { speed: 15, ...HAND });
    await h.drive(5, 3, { speed: 15 });
    await endNow(h, 8);
    await h.engine.dispatch({ type: 'manualStart', mode: 'mounted', passenger: false, ts: at(200) });
    await h.drive(200, 5, { speed: 15, ...HAND });
    expect(h.detectorFactory).toHaveBeenCalledTimes(2);
    expect(h.arbiterFactory).toHaveBeenCalledTimes(2);
    // Fresh ids and a fresh record: a shared suite would number this episode e2, and a shared
    // arbiter would stay silent about an id it had already alerted on.
    expect(h.alerts.map((a) => [a.kind, a.eventId, a.ts])).toEqual([
      ['phone', 'e1', at(2)],
      ['phone', 'e1', at(202)],
    ]);
  });

  test('camera focus samples drive the eyes-off and drowsy alerts and the focus events', async () => {
    const glance: CameraFocusSample = { glanceS: 2.5, kind: 'glance', q: 0.9 };
    const drowsy: CameraFocusSample = { glanceS: 0, kind: 'drowsiness', q: 0.8 };
    const h = await recording({ cameraAt: (i) => (i === 3 ? glance : i === 8 ? drowsy : null) });
    const s = await h.drive(0, 10, { speed: 15 });
    expect(h.alerts.map((a) => [a.kind, a.level, a.ts])).toEqual([
      ['eyes_off', 2, at(3)],
      ['drowsy', 3, at(8)],
    ]);
    await endNow(h, s);
    expect(only(h.finalized).events.map((e) => e.measured.focusKind)).toEqual(['glance', 'drowsiness']);
  });

  test('replayed candidate rows reach the detectors but never the arbiter', async () => {
    const h = await armed();
    await h.engine.dispatch({ type: 'wake', reason: 'activityTransition', ts: at(0) });
    const s = await h.drive(0, AUTO_DETECT_CONFIRM_S, OVER);
    // Speeding since second 0, but the first word about it is on the confirming row.
    const alert = only(h.alerts);
    expect(alert).toMatchObject({ kind: 'speeding', ts: at(AUTO_DETECT_CONFIRM_S - 1) });
    await endNow(h, s);
    expect(only(only(h.finalized).events)).toMatchObject({
      category: 'speeding',
      startedAt: at(0),
      durationS: AUTO_DETECT_CONFIRM_S,
    });
  });

  test('a throwing onAlert is reported through onError and costs the row nothing', async () => {
    const drowsy: CameraFocusSample = { glanceS: 0, kind: 'drowsiness', q: 0.8 };
    const alertRow = CHECKPOINT_S - 1;
    const h = await recording({
      onError: true,
      breakAlert: true,
      cameraAt: (i) => (i === alertRow ? drowsy : null),
    });
    await h.drive(0, alertRow, STILL);
    expect(h.engine.snapshot()).toMatchObject({ stationarySinceTs: at(0), stoppedPanel: true });
    // The alert row is also the first moving row and the CHECKPOINT_S-th row: the flags must
    // still be updated and the checkpoint still taken after the sink throws.
    await expect(h.drive(alertRow, 1, FAST)).resolves.toBe(CHECKPOINT_S);
    expect(h.errors.map((e) => (e as Error).message)).toEqual(['alert sink failed']);
    expect(h.engine.snapshot()).toMatchObject({
      status: 'recording',
      lastRowTs: at(alertRow),
      stationarySinceTs: null,
      stoppedPanel: false,
    });
    expect(h.onCheckpoint).toHaveBeenCalledTimes(1);
    await endNow(h, CHECKPOINT_S);
    // The alert itself is on the trip's record: only its delivery failed.
    expect(only(h.finalized).alerts.map((a) => a.kind)).toEqual(['drowsy']);
  });

  test('a throwing onAlert without onError is dropped silently', async () => {
    const drowsy: CameraFocusSample = { glanceS: 0, kind: 'drowsiness', q: 0.8 };
    const h = await recording({ breakAlert: true, cameraAt: (i) => (i === 1 ? drowsy : null) });
    await expect(h.drive(0, 3)).resolves.toBe(3);
    expect(h.engine.snapshot()).toMatchObject({ status: 'recording', lastRowTs: at(2) });
  });
});

describe('lockedOut and stoppedPanel', () => {
  test('lockedOut needs recording, driver role and speed over the lockout', async () => {
    const h = await armed();
    await h.engine.dispatch({ type: 'wake', reason: 'activityTransition', ts: at(0) });
    await h.drive(0, 1, { speed: LOCKOUT_SPEED_MPS + 0.1 });
    expect(h.engine.snapshot().lockedOut).toBe(false); // candidate
    await h.engine.dispatch({ type: 'manualStart', mode: 'mounted', passenger: false, ts: at(1) });
    expect(h.engine.snapshot().lockedOut).toBe(true);
    await h.drive(1, 1, { speed: LOCKOUT_SPEED_MPS });
    expect(h.engine.snapshot().lockedOut).toBe(false);
    await h.drive(2, 1, { speed: LOCKOUT_SPEED_MPS + 0.1 });
    expect(h.engine.snapshot().lockedOut).toBe(true);
    await h.engine.dispatch({ type: 'setPassenger', passenger: true, ts: at(3) });
    expect(h.engine.snapshot().lockedOut).toBe(false);
    await h.engine.dispatch({ type: 'setPassenger', passenger: false, ts: at(3) });
    expect(h.engine.snapshot().lockedOut).toBe(true);
    await h.engine.dispatch({ type: 'activity', automotive: false, walking: true, ts: at(3) });
    expect(h.engine.snapshot()).toMatchObject({ status: 'ending', lockedOut: false });
  });

  test('stoppedPanel after STOPPED_PANEL_S under 0.5 m/s, held through a creep, cleared over 3 mph', async () => {
    const h = await recording();
    let s = await h.drive(0, STOPPED_PANEL_S - 1, STILL);
    expect(h.engine.snapshot().stoppedPanel).toBe(false);
    s = await h.drive(s, 1, STOPPED); // 0 and 0.2 m/s are the same stop
    expect(h.engine.snapshot().stoppedPanel).toBe(true);
    s = await h.drive(s, 1, CREEP);
    expect(h.engine.snapshot().stoppedPanel).toBe(true);
    s = await h.drive(s, 1, { speed: mph(3) + 0.01 });
    expect(h.engine.snapshot().stoppedPanel).toBe(false);
    // The stop starts over.
    await h.drive(s, STOPPED_PANEL_S - 1, STILL);
    expect(h.engine.snapshot().stoppedPanel).toBe(false);
  });

  test('a stop broken by movement starts a fresh count', async () => {
    const h = await recording();
    let s = await h.drive(0, STOPPED_PANEL_S - 1, STILL);
    s = await h.drive(s, 1, { speed: STATIONARY_SPEED_MPS });
    await h.drive(s, STOPPED_PANEL_S - 1, STILL);
    expect(h.engine.snapshot().stoppedPanel).toBe(false);
  });

  test('neither flag survives the end of recording', async () => {
    const h = await recording();
    await h.drive(0, STOPPED_PANEL_S, STOPPED);
    expect(h.engine.snapshot().stoppedPanel).toBe(true);
    await h.engine.dispatch({ type: 'activity', automotive: false, walking: true, ts: at(STOPPED_PANEL_S) });
    expect(h.engine.snapshot()).toMatchObject({ status: 'ending', stoppedPanel: false });
  });

  // A GNSS dropout at 60 mph must not unlock the HUD (SR2) or show the stopped panel (C6): an
  // unknown speed proves nothing, so the lockout holds at the last known speed and no stop starts.
  test.each([
    ['the -1 sentinel', { speed: -1 }],
    ['an invalid fix carrying a stale positive speed', { ...FAST, gnssValid: false }],
  ])('a dropout at speed (%s) keeps lockedOut, starts no stop', async (_name, unknown) => {
    const h = await recording();
    await h.drive(0, 3, FAST);
    expect(h.engine.snapshot().lockedOut).toBe(true);
    await h.drive(3, 5, unknown);
    expect(h.engine.snapshot()).toMatchObject({
      status: 'recording',
      lockedOut: true,
      stoppedPanel: false,
      stationarySinceTs: null,
    });
    // Only a known slow row releases the lockout and starts the stationary clock.
    await h.drive(8, 1, STILL);
    expect(h.engine.snapshot()).toMatchObject({ lockedOut: false, stationarySinceTs: at(8) });
  });

  test('the lockout is judged on the last valid fix, so a dropout while slow stays unlocked', async () => {
    const h = await recording();
    await h.drive(0, 2, CREEP);
    expect(h.engine.snapshot().lockedOut).toBe(false);
    await h.drive(2, 3, { speed: -1 });
    expect(h.engine.snapshot().lockedOut).toBe(false);
    await h.drive(5, 1, FAST);
    expect(h.engine.snapshot().lockedOut).toBe(true);
  });
});

describe('ending', () => {
  test('stationary for AUTO_END_STATIONARY_S ends the trip on that row and trims the idle tail', async () => {
    const h = await recording();
    let s = await h.drive(0, 10, FAST);
    s = await h.drive(s, AUTO_END_STATIONARY_S - 1, STILL);
    expect(h.engine.snapshot()).toMatchObject({ status: 'recording', stationarySinceTs: at(10) });
    s = await h.drive(s, 1, STILL);
    expect(h.engine.snapshot()).toMatchObject({ status: 'ending', stationarySinceTs: at(10) });
    expect(h.onFinalize).not.toHaveBeenCalled();
    // The ending row persisted what the cadence had not reached.
    const last = h.checkpoints[h.checkpoints.length - 1]!;
    expect(rowsSince(last)).toEqual(range(300, 310));
    await h.engine.dispatch({ type: 'tick', ts: at(s + GAP_MERGE_S) });
    // Driving stopped at second 10; the five idle minutes are recorded but not counted.
    expect(only(h.finalized)).toMatchObject({
      rowsCount: 10 + AUTO_END_STATIONARY_S,
      endedAt: at(10),
      durationS: 10,
      gaps: [],
    });
  });

  test('the stationary clock restarts on a moving row', async () => {
    const h = await recording();
    let s = await h.drive(0, AUTO_END_STATIONARY_S - 1, STILL);
    s = await h.drive(s, 1, { speed: STATIONARY_SPEED_MPS });
    expect(h.engine.snapshot().stationarySinceTs).toBeNull();
    await h.drive(s, AUTO_END_STATIONARY_S - 1, STILL);
    expect(h.status()).toBe('recording');
  });

  test('an unknown speed cannot prove stillness either: a dropout never auto-ends the trip', async () => {
    const h = await recording();
    await h.drive(0, AUTO_END_STATIONARY_S, { speed: -1 });
    expect(h.engine.snapshot()).toMatchObject({ status: 'recording', stationarySinceTs: null });
    await h.drive(AUTO_END_STATIONARY_S, AUTO_END_STATIONARY_S, { ...FAST, gnssValid: false });
    expect(h.engine.snapshot()).toMatchObject({ status: 'recording', stationarySinceTs: null });
  });

  test('a stationary run that started before a dropout keeps counting and auto-ends at its first still row', async () => {
    const h = await recording();
    let s = await h.drive(0, 3, STILL);
    expect(h.engine.snapshot().stationarySinceTs).toBe(at(0));
    s = await h.drive(s, AUTO_END_STATIONARY_S, { speed: -1 });
    expect(h.engine.snapshot()).toMatchObject({ status: 'ending', stationarySinceTs: at(0) });
    await endNow(h, s);
    expect(only(h.finalized)).toMatchObject({ endedAt: at(0), durationS: 0 });
  });

  test('walking ends the trip; a second walking report changes nothing', async () => {
    const h = await recording();
    await h.drive(0, 5);
    await h.engine.dispatch({ type: 'activity', automotive: false, walking: true, ts: at(5) });
    expect(h.status()).toBe('ending');
    await h.engine.dispatch({ type: 'activity', automotive: false, walking: true, ts: at(6) });
    expect(h.status()).toBe('ending');
    expect(h.onFinalize).not.toHaveBeenCalled();
  });

  test('end while recording finalizes in one dispatch', async () => {
    const h = await recording();
    await h.drive(0, 5);
    await h.engine.dispatch({ type: 'end', ts: at(5) });
    expect(h.status()).toBe('armed');
    expect(only(h.finalized)).toMatchObject({ rowsCount: 5, endedAt: at(5), durationS: 5, gaps: [] });
  });

  test('end while ending finalizes, without a gap', async () => {
    const h = await endingAt10();
    await h.engine.dispatch({ type: 'end', ts: at(100) });
    expect(h.status()).toBe('armed');
    expect(only(h.finalized)).toMatchObject({ rowsCount: 10, endedAt: at(10), durationS: 10, gaps: [] });
  });

  test('end while parked trims the idle seconds too', async () => {
    const h = await recording();
    let s = await h.drive(0, 10, FAST);
    s = await h.drive(s, 20, STILL);
    await endNow(h, s);
    expect(only(h.finalized)).toMatchObject({ rowsCount: 30, endedAt: at(10), durationS: 10 });
  });
});

describe('gap-merge', () => {
  test('a fast row inside GAP_MERGE_S resumes the same trip and notes the gap', async () => {
    const h = await endingAt10();
    const resumeAt = 10 + GAP_MERGE_S - 1;
    await h.drive(resumeAt, 1, FAST);
    expect(h.engine.snapshot()).toMatchObject({ status: 'recording', clientTripId: 'trip-1' });
    await h.drive(resumeAt + 1, 4, FAST);
    await endNow(h, resumeAt + 5);
    const trip = only(h.finalized);
    expect(trip.gaps).toEqual([{ fromTs: at(10), toTs: at(resumeAt) }]);
    expect(trip.rowsCount).toBe(15);
    expect(trip.durationS).toBe(15);
    expect(trip.endedAt).toBe(at(resumeAt + 5));
  });

  test('slow rows inside the window are watched but not recorded', async () => {
    const h = await endingAt10();
    await h.drive(20, 3, CREEP);
    expect(h.engine.snapshot()).toMatchObject({ status: 'ending', lastRowTs: at(22), speedMps: 1 });
    await h.drive(23, 1, { speed: LOCKOUT_SPEED_MPS });
    expect(h.status()).toBe('ending');
    await h.engine.dispatch({ type: 'end', ts: at(24) });
    expect(only(h.finalized).rowsCount).toBe(10);
  });

  test('an unknown speed inside the window cannot resume the trip', async () => {
    const h = await endingAt10();
    await h.drive(20, 3, { ...FAST, gnssValid: false });
    expect(h.status()).toBe('ending');
    await h.drive(23, 1, { speed: -1 });
    expect(h.status()).toBe('ending');
    await h.drive(24, 1, FAST);
    expect(h.engine.snapshot()).toMatchObject({ status: 'recording', clientTripId: 'trip-1' });
  });

  test('a row that does not advance the clock is dropped in ending too', async () => {
    const h = await endingAt10();
    await h.engine.dispatch({ type: 'row', row: h.rowAt(5, FAST) });
    expect(h.engine.snapshot()).toMatchObject({ status: 'ending', lastRowTs: at(9) });
    await h.engine.dispatch({ type: 'row', row: h.rowAt(9, FAST) });
    expect(h.status()).toBe('ending');
  });

  test('an automotive activity inside the window resumes the trip', async () => {
    const h = await endingAt10();
    await h.engine.dispatch({ type: 'activity', automotive: true, walking: false, ts: at(100) });
    expect(h.engine.snapshot()).toMatchObject({ status: 'recording', clientTripId: 'trip-1' });
    await h.drive(101, 2, FAST);
    await endNow(h, 103);
    expect(only(h.finalized).gaps).toEqual([{ fromTs: at(10), toTs: at(100) }]);
  });

  test('a stationary ending puts the idle tail inside the gap', async () => {
    const h = await recording();
    const s = await h.drive(0, 10, FAST);
    await h.drive(s, AUTO_END_STATIONARY_S, STILL);
    expect(h.status()).toBe('ending');
    await h.drive(400, 5, FAST);
    expect(h.status()).toBe('recording');
    await endNow(h, 405);
    expect(only(h.finalized)).toMatchObject({
      gaps: [{ fromTs: at(10), toTs: at(400) }],
      rowsCount: 10 + AUTO_END_STATIONARY_S + 5,
      endedAt: at(405),
      durationS: 15,
    });
  });

  test('a tick past GAP_MERGE_S finalizes; one just inside does not', async () => {
    const h = await endingAt10();
    await h.engine.dispatch({ type: 'tick', ts: at(10 + GAP_MERGE_S - 1) });
    expect(h.status()).toBe('ending');
    await h.engine.dispatch({ type: 'tick', ts: at(10 + GAP_MERGE_S) });
    expect(h.status()).toBe('armed');
    const trip = only(h.finalized);
    expect(trip).toMatchObject({ clientTripId: 'trip-1', rowsCount: 10, endedAt: at(10), gaps: [] });
  });

  test('a fast row past the window finalizes the old trip and is not part of a new one', async () => {
    const h = await endingAt10();
    await h.drive(10 + GAP_MERGE_S, 1, FAST);
    expect(h.status()).toBe('armed');
    expect(only(h.finalized).rowsCount).toBe(10);
    expect(h.engine.snapshot().lastRowTs).toBeNull();
  });

  test('an automotive activity past the window finalizes and opens a fresh candidate', async () => {
    const h = await endingAt10();
    await h.engine.dispatch({
      type: 'activity',
      automotive: true,
      walking: false,
      ts: at(10 + GAP_MERGE_S),
    });
    expect(h.status()).toBe('candidate');
    expect(h.onFinalize).toHaveBeenCalledTimes(1);
    await h.drive(10 + GAP_MERGE_S, AUTO_DETECT_CONFIRM_S, FAST);
    expect(h.engine.snapshot().clientTripId).toBe('trip-2');
  });

  test('a manual start inside the window resumes with the new mode and role', async () => {
    const h = await endingAt10();
    await h.engine.dispatch({ type: 'manualStart', mode: 'pocket', passenger: true, ts: at(50) });
    expect(h.engine.snapshot()).toMatchObject({
      status: 'recording',
      clientTripId: 'trip-1',
      mode: 'pocket',
      role: 'passenger',
    });
    await endNow(h, 51);
    expect(only(h.finalized).gaps).toEqual([{ fromTs: at(10), toTs: at(50) }]);
  });

  test('a manual start past the window finalizes and starts a new trip', async () => {
    const h = await endingAt10();
    await h.engine.dispatch({
      type: 'manualStart',
      mode: 'pocket',
      passenger: false,
      ts: at(10 + GAP_MERGE_S),
    });
    expect(h.engine.snapshot()).toMatchObject({ status: 'recording', clientTripId: 'trip-2' });
    expect(h.onFinalize).toHaveBeenCalledTimes(1);
  });

  test('two gaps in one trip are both kept', async () => {
    const h = await endingAt10();
    await h.drive(100, 5, FAST);
    await h.engine.dispatch({ type: 'activity', automotive: false, walking: true, ts: at(105) });
    await h.drive(200, 5, FAST);
    await endNow(h, 205);
    expect(only(h.finalized).gaps).toEqual([
      { fromTs: at(10), toTs: at(100) },
      { fromTs: at(105), toTs: at(200) },
    ]);
  });

  test('a resume with no row before End counts the seconds driven, not less the gap', async () => {
    const h = await endingAt10();
    await h.engine.dispatch({ type: 'activity', automotive: true, walking: false, ts: at(100) });
    expect(h.status()).toBe('recording');
    await endNow(h, 200);
    // Driving stopped at second 10; the 90 s gap lies wholly after that and costs nothing.
    expect(only(h.finalized)).toMatchObject({
      endedAt: at(10),
      durationS: 10,
      gaps: [{ fromTs: at(10), toTs: at(100) }],
    });
  });

  test('the same when walking and the window close the rowless resume', async () => {
    const h = await endingAt10();
    await h.engine.dispatch({ type: 'activity', automotive: true, walking: false, ts: at(100) });
    await h.engine.dispatch({ type: 'activity', automotive: false, walking: true, ts: at(150) });
    expect(h.status()).toBe('ending');
    await h.engine.dispatch({ type: 'tick', ts: at(150 + GAP_MERGE_S) });
    expect(only(h.finalized)).toMatchObject({ endedAt: at(10), durationS: 10 });
  });

  test('a gap-merged trip keeps its detectors and its arbiter: one of each for the whole trip', async () => {
    const h = await endingAt10();
    await h.engine.dispatch({ type: 'activity', automotive: true, walking: false, ts: at(100) });
    await h.drive(100, 5, FAST);
    await endNow(h, 105);
    expect(h.detectorFactory).toHaveBeenCalledTimes(1);
    expect(h.arbiterFactory).toHaveBeenCalledTimes(1);
    expect(only(h.finalized).rowsCount).toBe(15);
  });
});

describe('finalizing', () => {
  test('onFinalize gets the closed session once, with merged events and the flush', async () => {
    const glance: CameraFocusSample = { glanceS: 2.5, kind: 'glance', q: 0.9 };
    const h = await recording({ cameraAt: (i) => (i === 2 ? glance : null) });
    // Handling on 0-4 closes as a phone event on row 6; the glance closes on row 2 on its own.
    let s = await h.drive(0, 5, { speed: 15, ...HAND });
    s = await h.drive(s, 3, { speed: 15 });
    // Speeding on 8-15 is still open when the trip ends, so it comes out of the flush.
    s = await h.drive(s, 8, OVER);
    await endNow(h, s);
    const trip = only(h.finalized);
    expect(Object.isFrozen(trip)).toBe(true);
    expect(trip).toMatchObject({
      clientTripId: 'trip-1',
      endedAt: at(s),
      rowsCount: 16,
      durationS: 16,
    });
    expect(trip.events.map((e) => [e.id, e.category, e.absorbedIds ?? null])).toEqual([
      ['e1', 'phone', ['e2']],
      ['e3', 'speeding', null],
    ]);
    expect(trip.events[0]).toMatchObject({ startedAt: at(2) - 2500, durationS: 5.5, q: 0.9 });
    expect(trip.events[1]).toMatchObject({ startedAt: at(8), durationS: 8 });
  });

  test('the engine is clean afterwards and the next trip gets its own id', async () => {
    const h = await recording();
    await h.drive(0, 5, FAST);
    await endNow(h, 5);
    expect(h.engine.snapshot()).toEqual({
      status: 'armed',
      mode: 'auto',
      role: 'driver',
      clientTripId: null,
      startedAt: null,
      lastRowTs: null,
      speedMps: 0,
      limit: UNKNOWN,
      distanceM: 0,
      stationarySinceTs: null,
      lockedOut: false,
      stoppedPanel: false,
    });
    await h.engine.dispatch({ type: 'manualStart', mode: 'mounted', passenger: false, ts: at(10) });
    expect(h.engine.snapshot().clientTripId).toBe('trip-2');
  });

  test('subscribers see finalizing while the finalizer runs', async () => {
    const h = await recording();
    const statuses: string[] = [];
    h.engine.subscribe((s) => statuses.push(s.status));
    let during: string | null = null;
    h.onFinalize.mockImplementationOnce(async () => {
      during = h.status();
    });
    await h.drive(0, 2);
    await endNow(h, 2);
    expect(during).toBe('finalizing');
    expect(statuses).toEqual(['recording', 'recording', 'finalizing', 'armed']);
  });

  test('a failing finalizer rejects the dispatch but the engine still re-arms', async () => {
    const h = await recording();
    h.onFinalize.mockRejectedValueOnce(new Error('no disk'));
    await h.drive(0, 2);
    await expect(h.engine.dispatch({ type: 'end', ts: at(2) })).rejects.toThrow('no disk');
    expect(h.status()).toBe('armed');
    await h.engine.dispatch({ type: 'manualStart', mode: 'mounted', passenger: false, ts: at(3) });
    expect(h.status()).toBe('recording');
  });

  test('with onError the failing finalizer is reported there instead', async () => {
    const h = await recording({ onError: true });
    h.onFinalize.mockRejectedValueOnce(new Error('no disk'));
    await h.drive(0, 2);
    await expect(h.engine.dispatch({ type: 'end', ts: at(2) })).resolves.toBeUndefined();
    expect(h.status()).toBe('armed');
    expect(h.errors.map((e) => (e as Error).message)).toEqual(['no disk']);
  });

  test('a failed finalizer still opens the follow-on candidate, and reports through onError', async () => {
    const h = await endingAt10({ onError: true });
    h.onFinalize.mockRejectedValueOnce(new Error('no disk'));
    await expect(
      h.engine.dispatch({ type: 'activity', automotive: true, walking: false, ts: at(10 + GAP_MERGE_S) })
    ).resolves.toBeUndefined();
    expect(h.status()).toBe('candidate');
    expect(h.errors.map((e) => (e as Error).message)).toEqual(['no disk']);
  });

  test('a failed finalizer still starts the follow-on manual trip', async () => {
    const h = await endingAt10({ onError: true });
    h.onFinalize.mockRejectedValueOnce(new Error('no disk'));
    await h.engine.dispatch({ type: 'manualStart', mode: 'pocket', passenger: false, ts: at(10 + GAP_MERGE_S) });
    expect(h.engine.snapshot()).toMatchObject({ status: 'recording', clientTripId: 'trip-2' });
    expect(h.errors.map((e) => (e as Error).message)).toEqual(['no disk']);
  });

  test('without onError the follow-on still happens and the dispatch rejects afterwards', async () => {
    const h = await endingAt10();
    h.onFinalize.mockRejectedValueOnce(new Error('no disk'));
    await expect(
      h.engine.dispatch({ type: 'activity', automotive: true, walking: false, ts: at(10 + GAP_MERGE_S) })
    ).rejects.toThrow('no disk');
    expect(h.status()).toBe('candidate');
  });

  test('a detector flush that throws still returns the engine to armed', async () => {
    const h = await recording({ breakFlush: true });
    await h.drive(0, 3);
    await expect(h.engine.dispatch({ type: 'end', ts: at(3) })).rejects.toThrow('flush failed');
    expect(h.status()).toBe('armed');
    expect(h.onFinalize).not.toHaveBeenCalled();
    await h.engine.dispatch({ type: 'manualStart', mode: 'mounted', passenger: false, ts: at(4) });
    expect(h.status()).toBe('recording');
  });

  test('a throwing subscriber never breaks a transition; its error goes to onError', async () => {
    const h = await recording({ onError: true });
    const seen: string[] = [];
    h.engine.subscribe(() => {
      throw new Error('listener bug');
    });
    h.engine.subscribe((s) => seen.push(s.status));
    await h.drive(0, 2);
    await expect(h.engine.dispatch({ type: 'end', ts: at(2) })).resolves.toBeUndefined();
    expect(h.status()).toBe('armed');
    expect(seen).toEqual(['recording', 'recording', 'finalizing', 'armed']);
    expect(h.errors.length).toBeGreaterThan(0);
    expect(h.errors.every((e) => (e as Error).message === 'listener bug')).toBe(true);
  });

  test('a throwing subscriber is dropped silently when there is no onError', async () => {
    const h = await recording();
    h.engine.subscribe(() => {
      throw new Error('listener bug');
    });
    await expect(h.drive(0, 2)).resolves.toBe(2);
    await expect(h.engine.dispatch({ type: 'end', ts: at(2) })).resolves.toBeUndefined();
    expect(h.status()).toBe('armed');
  });
});

describe('setPassenger', () => {
  test('flips the role without ending, and the finalizer sees the last value', async () => {
    const h = await recording();
    await h.drive(0, 3);
    await h.engine.dispatch({ type: 'setPassenger', passenger: true, ts: at(3) });
    expect(h.engine.snapshot()).toMatchObject({ status: 'recording', role: 'passenger' });
    await h.drive(3, 3);
    await h.engine.dispatch({ type: 'setPassenger', passenger: false, ts: at(6) });
    await h.engine.dispatch({ type: 'setPassenger', passenger: true, ts: at(6) });
    await endNow(h, 6);
    expect(only(h.finalized)).toMatchObject({ role: 'passenger', rowsCount: 6 });
  });

  test('during a candidate it applies at confirmation; it does not outlive the trip', async () => {
    const h = await armed();
    await h.engine.dispatch({ type: 'wake', reason: 'activityTransition', ts: at(0) });
    await h.engine.dispatch({ type: 'setPassenger', passenger: true, ts: at(0) });
    const s = await h.drive(0, AUTO_DETECT_CONFIRM_S, FAST);
    expect(h.engine.snapshot().role).toBe('passenger');
    await endNow(h, s);
    await h.engine.dispatch({ type: 'manualStart', mode: 'mounted', passenger: false, ts: at(s) });
    expect(h.engine.snapshot().role).toBe('driver');
  });
});

describe('dispatch is serialised', () => {
  test('a slow checkpoint holds the next row until it settles', async () => {
    const h = await recording();
    let release: () => void = () => {};
    h.onCheckpoint.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    await h.drive(0, CHECKPOINT_S - 1);
    const checkpointing = h.engine.dispatch({ type: 'row', row: h.rowAt(CHECKPOINT_S - 1, FAST) });
    const next = h.engine.dispatch({ type: 'row', row: h.rowAt(CHECKPOINT_S, FAST) });
    await Promise.resolve();
    expect(h.engine.snapshot().lastRowTs).toBe(at(CHECKPOINT_S - 1));
    release();
    await Promise.all([checkpointing, next]);
    expect(h.engine.snapshot().lastRowTs).toBe(at(CHECKPOINT_S));
  });

  test('events dispatched without awaiting are applied in order', async () => {
    const h = await armed();
    const results = [
      h.engine.dispatch({ type: 'manualStart', mode: 'mounted', passenger: false, ts: at(0) }),
      h.engine.dispatch({ type: 'row', row: h.rowAt(0, FAST) }),
      h.engine.dispatch({ type: 'setPassenger', passenger: true, ts: at(1) }),
      h.engine.dispatch({ type: 'row', row: h.rowAt(1, FAST) }),
      h.engine.dispatch({ type: 'end', ts: at(2) }),
    ];
    await Promise.all(results);
    expect(only(h.finalized)).toMatchObject({ rowsCount: 2, role: 'passenger' });
    expect(h.status()).toBe('armed');
  });
});
