import { CONSTANTS } from '@scoring';
import { createArbiter } from '@/core/alerts/arbiter';
import type { AlertDecision } from '@/core/alerts/types';
import { createDetectors } from '@/core/detectors';
import { T0, counterIds, limit, mph, row } from '@/core/detectors/__fixtures__/rows';
import type { EngineDeps, EngineSnapshot, TripSession } from '@/core/engine/engine.types';
import { PREFETCH_EVERY_M, STATIONARY_SPEED_MPS, createEngine } from '@/core/engine/machine';
import { ROW_MS } from '@/core/engine/session';
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
}

function harness(opts: HarnessOptions = {}) {
  let now = 0;
  let ids = 0;
  let rowIndex = 0;
  const alerts: AlertDecision[] = [];
  const checkpoints: Readonly<TripSession>[] = [];
  const finalized: Readonly<TripSession>[] = [];
  const lookup = jest.fn((): LimitSample | null => (opts.limit === undefined ? L35 : opts.limit));
  const prefetch = jest.fn();
  const onCheckpoint = jest.fn(async (s: Readonly<TripSession>) => {
    checkpoints.push(s);
  });
  const onFinalize = jest.fn(async (s: Readonly<TripSession>) => {
    finalized.push(s);
  });
  const deps: EngineDeps = {
    now: () => now,
    newId: () => `trip-${(ids += 1)}`,
    limits: { lookup, prefetch },
    detectors: createDetectors(counterIds()),
    arbiter: createArbiter({ tripIndex: opts.tripIndex ?? LEARNING_PERIOD_TRIPS }),
    onAlert: (d) => {
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
    lookup,
    prefetch,
    onCheckpoint,
    onFinalize,
    status: () => engine.snapshot().status,
    setNow: (s: number) => {
      now = at(s);
    },
  };
}

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

/** Ends whatever is open right now: `end` takes recording to ending, a second `end` finalizes. */
async function endNow(h: Awaited<ReturnType<typeof armed>>, s: number) {
  await h.engine.dispatch({ type: 'end', ts: at(s) });
  await h.engine.dispatch({ type: 'end', ts: at(s) });
}

const only = <T>(list: readonly T[]): T => {
  expect(list).toHaveLength(1);
  return list[0] as T;
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

  test('a manual trip with no rows still finalizes once', async () => {
    const h = await recording();
    await endNow(h, 4);
    const trip = only(h.finalized);
    expect(trip).toMatchObject({ rowsCount: 0, startedAt: at(0), endedAt: at(4), durationS: 4 });
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
  test('exactly floor(rows / CHECKPOINT_S) calls, each with the rows to persist', async () => {
    const h = await recording();
    const n = CHECKPOINT_S * 3 + 5;
    await h.drive(0, n);
    expect(h.onCheckpoint).toHaveBeenCalledTimes(Math.floor(n / CHECKPOINT_S));
    expect(h.checkpoints.map((s) => s.rowsCount)).toEqual([30, 60, 90]);
    expect(h.checkpoints.map((s) => s.checkpoints)).toEqual([[], [at(29)], [at(29), at(59)]]);
    const third = h.checkpoints[2]!;
    const since = third.checkpoints[third.checkpoints.length - 1] ?? -Infinity;
    expect(third.rows.filter((r) => r.ts > since).map((r) => r.ts)).toEqual(
      Array.from({ length: CHECKPOINT_S }, (_, k) => at(60 + k))
    );
    expect(Object.isFrozen(third)).toBe(true);
    await endNow(h, n);
    expect(only(h.finalized).checkpoints).toEqual([at(29), at(59), at(89)]);
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
    const consider = jest.spyOn(h.deps.arbiter, 'consider');
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
    const consider = jest.spyOn(h.deps.arbiter, 'consider');
    await h.drive(0, 1, OVER);
    expect(consider.mock.calls[0]![0]).toMatchObject({ limitMps: null, overMps: 0, overForS: 0, q: 0 });
  });

  test('a handling run is offered to the arbiter as a phone episode', async () => {
    const h = await recording();
    await h.drive(0, 5, { speed: 15, ...HAND });
    const alert = only(h.alerts);
    expect(alert).toMatchObject({ kind: 'phone', level: 2, ts: at(2), eventId: `phone@${at(0)}` });
    const s = await h.drive(5, 3, { speed: 15 });
    await endNow(h, s);
    expect(only(only(h.finalized).events)).toMatchObject({ category: 'phone', startedAt: at(0) });
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
    await h.engine.dispatch({ type: 'end', ts: at(3) });
    expect(h.engine.snapshot().lockedOut).toBe(false);
  });

  test('stoppedPanel after STOPPED_PANEL_S at zero, held through a creep, cleared over 3 mph', async () => {
    const h = await recording();
    let s = await h.drive(0, STOPPED_PANEL_S - 1, STOPPED);
    expect(h.engine.snapshot().stoppedPanel).toBe(false);
    s = await h.drive(s, 1, STOPPED);
    expect(h.engine.snapshot().stoppedPanel).toBe(true);
    s = await h.drive(s, 1, CREEP);
    expect(h.engine.snapshot().stoppedPanel).toBe(true);
    s = await h.drive(s, 1, { speed: mph(3) + 0.01 });
    expect(h.engine.snapshot().stoppedPanel).toBe(false);
    // The zero run starts over.
    await h.drive(s, STOPPED_PANEL_S - 1, STOPPED);
    expect(h.engine.snapshot().stoppedPanel).toBe(false);
  });

  test('a stop broken by movement starts a fresh count', async () => {
    const h = await recording();
    let s = await h.drive(0, STOPPED_PANEL_S - 1, STOPPED);
    s = await h.drive(s, 1, CREEP);
    await h.drive(s, STOPPED_PANEL_S - 1, STOPPED);
    expect(h.engine.snapshot().stoppedPanel).toBe(false);
  });

  test('neither flag survives the end of recording', async () => {
    const h = await recording();
    await h.drive(0, STOPPED_PANEL_S, STOPPED);
    expect(h.engine.snapshot().stoppedPanel).toBe(true);
    await h.engine.dispatch({ type: 'end', ts: at(STOPPED_PANEL_S) });
    expect(h.engine.snapshot().stoppedPanel).toBe(false);
  });
});

describe('ending', () => {
  test('stationary for AUTO_END_STATIONARY_S ends the trip on that row', async () => {
    const h = await recording();
    let s = await h.drive(0, 10, FAST);
    s = await h.drive(s, AUTO_END_STATIONARY_S - 1, STILL);
    expect(h.engine.snapshot()).toMatchObject({ status: 'recording', stationarySinceTs: at(10) });
    await h.drive(s, 1, STILL);
    expect(h.engine.snapshot()).toMatchObject({ status: 'ending', stationarySinceTs: at(10) });
    expect(h.onFinalize).not.toHaveBeenCalled();
  });

  test('the stationary clock restarts on a moving row', async () => {
    const h = await recording();
    let s = await h.drive(0, AUTO_END_STATIONARY_S - 1, STILL);
    s = await h.drive(s, 1, { speed: STATIONARY_SPEED_MPS });
    expect(h.engine.snapshot().stationarySinceTs).toBeNull();
    await h.drive(s, AUTO_END_STATIONARY_S - 1, STILL);
    expect(h.status()).toBe('recording');
  });

  test('an unknown speed cannot prove motion, so it counts as stationary', async () => {
    const h = await recording();
    await h.drive(0, AUTO_END_STATIONARY_S, { speed: -1 });
    expect(h.status()).toBe('ending');
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

  test('end goes to ending first, and a second end finalizes', async () => {
    const h = await recording();
    await h.drive(0, 5);
    await h.engine.dispatch({ type: 'end', ts: at(5) });
    expect(h.status()).toBe('ending');
    expect(h.onFinalize).not.toHaveBeenCalled();
    await h.engine.dispatch({ type: 'end', ts: at(6) });
    expect(h.status()).toBe('armed');
    expect(h.onFinalize).toHaveBeenCalledTimes(1);
  });
});

describe('gap-merge', () => {
  /** Recording, then ending at second 10 via the user's End. */
  async function endingAt10() {
    const h = await recording();
    await h.drive(0, 10);
    await h.engine.dispatch({ type: 'end', ts: at(10) });
    expect(h.status()).toBe('ending');
    return h;
  }

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

  test('an automotive activity inside the window resumes the trip', async () => {
    const h = await endingAt10();
    await h.engine.dispatch({ type: 'activity', automotive: true, walking: false, ts: at(100) });
    expect(h.engine.snapshot()).toMatchObject({ status: 'recording', clientTripId: 'trip-1' });
    await h.drive(101, 2, FAST);
    await endNow(h, 103);
    expect(only(h.finalized).gaps).toEqual([{ fromTs: at(10), toTs: at(100) }]);
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
    await h.engine.dispatch({ type: 'end', ts: at(105) });
    await h.drive(200, 5, FAST);
    await endNow(h, 205);
    expect(only(h.finalized).gaps).toEqual([
      { fromTs: at(10), toTs: at(100) },
      { fromTs: at(105), toTs: at(200) },
    ]);
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
    expect(statuses.slice(-3)).toEqual(['ending', 'finalizing', 'armed']);
  });

  test('a failing finalizer rejects the dispatch but the engine still re-arms', async () => {
    const h = await recording();
    h.onFinalize.mockRejectedValueOnce(new Error('no disk'));
    await h.drive(0, 2);
    await h.engine.dispatch({ type: 'end', ts: at(2) });
    await expect(h.engine.dispatch({ type: 'end', ts: at(2) })).rejects.toThrow('no disk');
    expect(h.status()).toBe('armed');
    await h.engine.dispatch({ type: 'manualStart', mode: 'mounted', passenger: false, ts: at(3) });
    expect(h.status()).toBe('recording');
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
      h.engine.dispatch({ type: 'end', ts: at(2) }),
    ];
    await Promise.all(results);
    expect(only(h.finalized)).toMatchObject({ rowsCount: 2, role: 'passenger' });
    expect(h.status()).toBe('armed');
  });
});
