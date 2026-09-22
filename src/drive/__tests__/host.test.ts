/** @jest-environment node */
import * as scoring from '@scoring';
import { createFakeDriveSense, parseRow, type MotionActivity } from '@drive-sense';

import type { AlertDecision } from '@/core/alerts/types';
import { T0, limit, mph, row } from '@/core/detectors/__fixtures__/rows';
import { drive, sha256, TZ } from '@/core/engine/__fixtures__/drives';
import * as finalizeModule from '@/core/engine/finalize';
import { ROLE_PRIOR_KEY, ROLE_ROUTES_KEY, routeKey } from '@/core/engine/rolePrior';
import type { FeatureRow, LimitSample } from '@/core/engine/types';
import { createSpeedLimitClient, type SpeedLimitClient } from '@/core/speedLimits/client';
import {
  createSettingsRepo,
  createTripsRepo,
  migrate,
  type Db,
  type TripRow,
} from '@/data/db';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import * as events from '@/data/events';
import { createDriveHost, playerInputs, type DriveHost, type DriveState } from '@/drive/host';
import { AUTO_DETECT_SETTING_KEY } from '@/drive/policy';
import type { Scheduler } from '@/drive/ticks';
import { geohash5 } from '@/lib/geo';

const { AUTO_END_STATIONARY_S, GAP_MERGE_S, LOCKOUT_SPEED_MPS } = scoring.CONSTANTS;

let db: Db;
beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
});

afterEach(() => {
  jest.restoreAllMocks();
});

// --- fakes ----------------------------------------------------------------------------------------

function fakeLimits(sample: LimitSample | null) {
  const calls: string[] = [];
  const client: SpeedLimitClient = {
    lookup: jest.fn(() => sample),
    prefetch: jest.fn(() => {
      calls.push('prefetch');
    }),
    lookupStored: jest.fn(async () => sample),
    startTrip: jest.fn(() => {
      calls.push('startTrip');
    }),
    resetTrip: jest.fn(() => {
      calls.push('resetTrip');
    }),
    purgeExpired: jest.fn(async () => 0),
    stats: () => ({ memoryTiles: 0, requestsThisTrip: 0, pointLookupsThisTrip: 0, sqliteLoads: 0, truncatedTiles: 0 }),
    settled: async () => {},
  };
  return { client, calls };
}

interface HarnessOptions {
  persistence?: 'full' | 'none';
  limit?: LimitSample | null;
  /** How many trace writes fail before they start succeeding. */
  writeFailures?: number;
  platform?: 'ios' | 'android';
  readFlag?: (key: 'auto_detect') => Promise<boolean>;
  appState?: import('@/data/foreground').AppStateLike;
  signedOut?: boolean;
}

function harness(opts: HarnessOptions = {}) {
  let clock = T0;
  let seq = 0;
  const timers = new Map<number, { fn: () => void; at: number }>();
  const scheduler: Scheduler = {
    setTimeout(fn, ms) {
      seq += 1;
      timers.set(seq, { fn, at: clock + ms });
      return seq;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
  };
  const fake = createFakeDriveSense({ platform: opts.platform ?? 'ios', now: () => clock });
  fake.setState({ location: 'always', motion: 'granted' });
  const limits = fakeLimits(opts.limit === undefined ? limit(mph(35)) : opts.limit);
  const player = {
    deliver: jest.fn(async (_d: AlertDecision) => {}),
    stopCurrent: jest.fn(async () => {}),
    announce: jest.fn(async () => {}),
  };
  const writes: string[] = [];
  let failures = opts.writeFailures ?? 0;
  const traceWriter = {
    writeGzip: jest.fn(async (path: string) => {
      writes.push(path);
      if (failures > 0) {
        failures -= 1;
        throw new Error('disk full');
      }
    }),
    clear: async () => {},
  };
  const errors: { error: unknown; ctx: string }[] = [];
  let ids = 0;
  const host = createDriveHost({
    db,
    source: fake,
    limits: limits.client,
    player,
    scoring,
    traceWriter,
    hash: { sha256 },
    now: () => clock,
    tz: () => TZ,
    newId: () => `id-${(ids += 1)}`,
    persistence: opts.persistence,
    readFlag: opts.readFlag,
    appState: opts.appState,
    signedOut: opts.signedOut,
    scheduler,
    onError: (error, ctx) => errors.push({ error, ctx }),
  });

  /** Deliver rows as native would (only while capturing); returns how many were emitted. */
  async function feed(rows: readonly FeatureRow[]): Promise<number> {
    let emitted = 0;
    for (const r of rows) {
      clock = Math.max(clock, r.ts + 200);
      fake.loadTrace([r]);
      if (fake.step()) emitted += 1;
      await host.settled();
    }
    return emitted;
  }

  /** Move the wall clock and fire every timer due by then. */
  async function advance(ms: number): Promise<void> {
    clock += ms;
    for (const [id, t] of [...timers]) {
      if (t.at <= clock) {
        timers.delete(id);
        t.fn();
      }
    }
    await host.settled();
  }

  return {
    host,
    fake,
    limits,
    player,
    writes,
    traceWriter,
    errors,
    feed,
    advance,
    timers: () => timers.size,
    now: () => clock,
    setClock: (t: number) => {
      clock = t;
    },
  };
}

/** `n` stationary rows at the end of `after`, one second apart. */
function still(n: number, after: FeatureRow): FeatureRow[] {
  return Array.from({ length: n }, (_, i) =>
    row({ ts: after.ts + (i + 1) * 1000, lat: after.lat, lng: after.lng, speed: 0, course: -1 })
  );
}

const trips = () => createTripsRepo(db);
const last = <T>(xs: readonly T[]): T => xs[xs.length - 1] as T;
const automotive = (ts: number): MotionActivity => ({ type: 'automotive', confidence: 'high', ts });

async function armed(h: ReturnType<typeof harness>): Promise<void> {
  await h.host.start();
  await h.host.setAutoDetect(true);
  await h.host.settled();
  expect(h.host.snapshot().status).toBe('armed');
}

// --- manual ---------------------------------------------------------------------------------------

describe('a manual mounted drive, end to end', () => {
  test('capture, rows, limits, finalize and stop', async () => {
    const h = harness();
    await h.host.start();
    expect(h.host.snapshot().status).toBe('off');
    await h.host.manualStart({ mode: 'mounted', passenger: false, evidence: 'tap' });
    await h.host.settled();
    expect(h.fake.calls).toEqual(['startCapture:mounted', 'setCaptureRate:full']);
    expect(h.host.captureActive()).toBe(true);
    expect(h.host.isBusy()).toBe(true);

    const rows = drive(200);
    expect(await h.feed(rows)).toBe(200);
    const s = h.host.snapshot();
    expect(s.status).toBe('recording');
    expect(s.gps).toBe('good');
    expect(s.speedKnown).toBe(true);
    expect(h.limits.calls[0]).toBe('startTrip');
    expect(h.limits.calls.filter((c) => c === 'startTrip')).toHaveLength(1);
    // The limit adapter hands the client the row's own fix quality and speed, as the row reads
    // after `parseRow` rounds it at the bridge (D2 round 1).
    const seen = parseRow(last(rows))!;
    expect(h.limits.client.lookup).toHaveBeenLastCalledWith(
      seen.lat,
      seen.lng,
      seen.course,
      { gnssValid: true, speedMps: 10 }
    );

    await h.host.end();
    await h.host.untilIdle();
    const id = s.clientTripId as string;
    const stored = (await trips().get(id)) as TripRow;
    expect(stored.status).toBe('provisional');
    expect(stored.role_source).toBe('manual');
    expect(h.host.snapshot()).toMatchObject({
      status: 'off',
      lastFinalized: { clientTripId: id, ok: true, status: 'provisional', short: false },
    });
    expect(last(h.fake.calls)).toBe('stopCapture');
    expect(h.host.captureActive()).toBe(false);
    expect(last(h.limits.calls)).toBe('resetTrip');
    expect(h.host.snapshot().gps).toBe('none');
    expect(h.errors).toEqual([]);
  });

  test('a two-minute stop-and-go is saved and marked short', async () => {
    const h = harness();
    await h.host.start();
    await h.host.manualStart({ mode: 'pocket', passenger: false, evidence: 'tap' });
    await h.feed(drive(30));
    await h.host.end();
    await h.host.untilIdle();
    expect(h.host.snapshot().lastFinalized).toMatchObject({ ok: true, short: true });
  });

  test('rows native sends that fail the contract are dropped', async () => {
    const h = harness();
    await h.host.start();
    await h.host.manualStart({ mode: 'mounted', passenger: false, evidence: 'tap' });
    await h.host.settled();
    h.fake.emit('row', { ...row(), ts: T0 + 0.5 });
    h.fake.emit('row', { nonsense: true });
    await h.host.settled();
    expect(h.host.snapshot().lastRowTs).toBeNull();
  });
});

// --- auto -----------------------------------------------------------------------------------------

describe('auto-detect', () => {
  test('a wake with no automotive history captures nothing', async () => {
    const h = harness();
    await armed(h);
    h.fake.setMotionHistory([{ type: 'walking', confidence: 'high', ts: h.now() - 30_000 }]);
    h.fake.emit('wake', { reason: 'significantChange', ts: h.now() });
    await h.host.settled();
    expect(h.fake.queries).toContain('queryMotionHistory');
    expect(h.fake.calls).toEqual(['arm']);
    expect(h.host.snapshot().status).toBe('armed');
    expect(h.timers()).toBe(0);
  });

  test('a wake with automotive history opens a candidate and captures at full rate', async () => {
    const h = harness();
    await armed(h);
    h.fake.setMotionHistory([automotive(h.now() - 90_000)]);
    h.fake.emit('wake', { reason: 'significantChange', ts: h.now() });
    await h.host.settled();
    expect(h.host.snapshot().status).toBe('candidate');
    expect(h.fake.calls).toEqual(['arm', 'startCapture:auto', 'setCaptureRate:full']);
    expect(h.timers()).toBe(1);

    // Confirms after 30 s over 12 mph; the start is backfilled from the history.
    await h.feed(drive(40, { t0: h.now() + 1000 }));
    const s = h.host.snapshot();
    expect(s.status).toBe('recording');
    expect(s.startedAt).toBe(T0 - 90_000);
    expect(h.timers()).toBe(0);
  });

  test('the candidate is discarded at the window end and capture stops', async () => {
    const h = harness();
    await armed(h);
    h.fake.setMotionHistory([automotive(h.now() - 10_000)]);
    h.fake.emit('wake', { reason: 'activityTransition', ts: h.now() });
    await h.host.settled();
    expect(h.host.snapshot().status).toBe('candidate');
    await h.advance(scoring.CONSTANTS.AUTO_DETECT_WINDOW_S * 1000 + 2000);
    expect(h.host.snapshot().status).toBe('armed');
    expect(last(h.fake.calls)).toBe('stopCapture');
    expect(h.timers()).toBe(0);
    expect(await trips().list()).toEqual([]);
    expect(last(h.limits.calls)).toBe('resetTrip');
  });

  test('an automotive activity while armed opens a candidate too', async () => {
    const h = harness();
    await armed(h);
    h.fake.emit('activity', automotive(h.now() - 5000));
    await h.host.settled();
    expect(h.host.snapshot().status).toBe('candidate');
  });

  test('no arming without Always location, the feature flag or the setting', async () => {
    const h = harness({ readFlag: async () => false });
    await h.host.start();
    await h.host.setAutoDetect(true);
    expect(h.host.autoDetectEnabled()).toBe(true);
    expect(h.host.snapshot().status).toBe('off');
    expect(h.fake.calls).not.toContain('arm');

    const g = harness();
    g.fake.setState({ location: 'whenInUse' });
    await g.host.start();
    await g.host.setAutoDetect(true);
    expect(g.host.autoDetectEnabled()).toBe(true);
    expect(g.host.snapshot().status).toBe('off');
  });

  test('the setting persists, and a new host arms from it at start', async () => {
    const h = harness();
    await armed(h);
    expect(await createSettingsRepo(db).get(AUTO_DETECT_SETTING_KEY)).toBe(true);
    const g = harness();
    await g.host.start();
    expect(g.host.autoDetectEnabled()).toBe(true);
    expect(g.host.snapshot().status).toBe('armed');
    await g.host.setAutoDetect(false);
    expect(g.host.autoDetectEnabled()).toBe(false);
    expect(g.host.snapshot().status).toBe('off');
    expect(last(g.fake.calls)).toBe('disarm');
  });

  test('a refused arm leaves the host off and reports it', async () => {
    const h = harness();
    await h.host.start();
    h.fake.arm = async () => {
      throw new Error('E_PERMISSION');
    };
    await h.host.setAutoDetect(true);
    expect(h.host.snapshot()).toMatchObject({ status: 'off', autoDetectArmed: false });
    expect(h.errors.map((e) => e.ctx)).toContain('arm');
  });

  test('without motion access the shared predicate does not even try to arm (I4)', async () => {
    const h = harness();
    await h.host.start();
    h.fake.setState({ motion: 'denied' });
    await h.host.setAutoDetect(true);
    expect(h.host.snapshot()).toMatchObject({ status: 'off', autoDetectArmed: false });
    expect(h.fake.calls).not.toContain('arm');
  });
});

// --- ending, gap, post-gap ------------------------------------------------------------------------

async function recordingThenStill(h: ReturnType<typeof harness>) {
  await h.host.manualStart({ mode: 'mounted', passenger: false, evidence: 'tap' });
  const moving = drive(150);
  await h.feed(moving);
  const stopped = still(AUTO_END_STATIONARY_S + 2, last(moving));
  await h.feed(stopped);
  expect(h.host.snapshot().status).toBe('ending');
  return last(stopped);
}

describe('ending, the gap window and after it', () => {
  test('ending drops to the low rate, and an automotive activity brings full rate back', async () => {
    const h = harness();
    await h.host.start();
    await recordingThenStill(h);
    expect(last(h.fake.calls)).toBe('setCaptureRate:low');
    expect(h.timers()).toBe(1);
    h.fake.emit('activity', automotive(h.now()));
    await h.host.settled();
    expect(h.host.snapshot().status).toBe('recording');
    expect(last(h.fake.calls)).toBe('setCaptureRate:full');
    expect(h.timers()).toBe(0);
  });

  test('a fast row in the gap window resumes at full rate', async () => {
    const h = harness();
    await h.host.start();
    const at = await recordingThenStill(h);
    await h.feed([row({ ts: at.ts + 60_000, lat: at.lat, lng: at.lng, speed: 12 })]);
    expect(h.host.snapshot().status).toBe('recording');
    expect(last(h.fake.calls)).toBe('setCaptureRate:full');
  });

  test('the gap end finalizes and stops capture', async () => {
    const h = harness();
    await h.host.start();
    await recordingThenStill(h);
    await h.advance(GAP_MERGE_S * 1000 + 2000);
    await h.host.untilIdle();
    expect(h.host.snapshot().status).toBe('off');
    expect(h.host.snapshot().lastFinalized).toMatchObject({ ok: true });
    expect(last(h.fake.calls)).toBe('stopCapture');
    expect(h.timers()).toBe(0);
  });

  test('post-gap self-dispatch: a fast row after the window finalizes and opens the next candidate', async () => {
    const h = harness();
    await armed(h);
    const at = await recordingThenStill(h);
    const first = h.host.snapshot().clientTripId;
    const callsBefore = h.fake.calls.length;
    const after = drive(40, { t0: at.ts + (GAP_MERGE_S + 30) * 1000, speed: LOCKOUT_SPEED_MPS + 8 });
    await h.feed(after.slice(0, 1));
    expect(h.host.snapshot().status).toBe('candidate');
    expect(h.host.snapshot().lastFinalized).toMatchObject({ clientTripId: first, ok: true });
    // The capture never stopped between the two drives.
    expect(h.fake.calls.slice(callsBefore)).not.toContain('stopCapture');
    expect(last(h.fake.calls)).toBe('setCaptureRate:full');
    await h.feed(after.slice(1));
    const s = h.host.snapshot();
    expect(s.status).toBe('recording');
    expect(s.clientTripId).not.toBe(first);
    // The row that reopened it belongs to the new drive.
    expect(s.startedAt).toBe(after[0]?.ts);
  });

  test('with auto-detect off the same row only finalizes', async () => {
    const h = harness();
    await h.host.start();
    const at = await recordingThenStill(h);
    await h.feed([row({ ts: at.ts + (GAP_MERGE_S + 30) * 1000, speed: 15 })]);
    await h.host.untilIdle();
    expect(h.host.snapshot().status).toBe('off');
    expect(last(h.fake.calls)).toBe('stopCapture');
  });

  test('walking with low confidence is ignored; at medium it ends the drive', async () => {
    const h = harness();
    await h.host.start();
    await h.host.manualStart({ mode: 'pocket', passenger: false, evidence: 'tap' });
    await h.feed(drive(20));
    h.fake.emit('activity', { type: 'walking', confidence: 'low', ts: h.now() });
    await h.host.settled();
    expect(h.host.snapshot().status).toBe('recording');
    h.fake.emit('activity', { type: 'walking', confidence: 'medium', ts: h.now() });
    await h.host.settled();
    expect(h.host.snapshot().status).toBe('ending');
  });

  test('the notification End action is honoured only while stationary', async () => {
    const h = harness({ platform: 'android' });
    await h.host.start();
    await h.host.manualStart({ mode: 'mounted', passenger: false, evidence: 'tap' });
    const moving = drive(150);
    await h.feed(moving);
    expect(h.fake.notificationState).toEqual({ stationary: false, startedAt: T0, candidate: false });
    h.fake.emit('notificationAction', { action: 'endDrive', ts: h.now() });
    await h.host.settled();
    expect(h.host.snapshot().status).toBe('recording');
    await h.feed(still(5, last(moving)));
    expect(h.fake.notificationState).toEqual({ stationary: true, startedAt: T0, candidate: false });
    const sent = h.fake.calls.filter((c) => c === 'setNotificationState').length;
    await h.feed(still(3, row({ ts: last(moving).ts + 5000, lat: last(moving).lat, lng: last(moving).lng })));
    // Sent on change only, never per row.
    expect(h.fake.calls.filter((c) => c === 'setNotificationState').length).toBe(sent);
    h.fake.emit('notificationAction', { action: 'endDrive', ts: h.now() });
    await h.host.untilIdle();
    expect(h.host.snapshot().status).toBe('off');
    expect(h.host.snapshot().lastFinalized).toMatchObject({ ok: true });
  });
});

// --- adopt ----------------------------------------------------------------------------------------

/** A trip the previous process was recording, left `recording` with 90 durable rows. */
async function orphan(evidence: 'tap' | 'movingStart' = 'tap'): Promise<{ trip: TripRow; rows: FeatureRow[] }> {
  const h = harness();
  await h.host.start();
  await h.host.manualStart({ mode: 'mounted', passenger: false, evidence });
  const rows = drive(100);
  await h.feed(rows);
  await h.host.stop({ endOpenTrip: false });
  const trip = (await trips().findRecording()) as TripRow;
  expect(trip.checkpoint_ts).toBe(rows[89]?.ts);
  return { trip, rows };
}

describe('start({ adopt }) (rev1: I2)', () => {
  test('with a buffered wake already queued: exactly one recording trip, adopted before any listener', async () => {
    const { trip, rows } = await orphan();
    const h = harness();
    h.setClock(last(rows).ts + 20_000);
    // iOS relaunch: native restarted capture in the stored mode (N1: mode and rate are set while capturing).
    h.fake.setState({ capturing: true, captureWasOpen: true, mode: 'mounted', rate: 'full' });
    h.fake.setMotionHistory([automotive(h.now() - 60_000)]);
    h.fake.emit('wake', { reason: 'significantChange', ts: h.now() });
    const seen: { status: string; wakeListeners: number }[] = [];
    h.host.subscribe((s) => seen.push({ status: s.status, wakeListeners: h.fake.listenerCount('wake') }));
    await h.host.setAutoDetect(true);

    const { adopted } = await h.host.start({ adopt: trip });
    await h.host.settled();
    expect(adopted).toBe(true);
    const firstRecording = seen.find((x) => x.status === 'recording');
    expect(firstRecording?.wakeListeners).toBe(0);
    expect(h.host.snapshot()).toMatchObject({
      status: 'recording',
      clientTripId: trip.client_trip_id,
      awaitingSpeedAfterResume: true,
    });
    expect(await trips().list({ status: 'recording' })).toHaveLength(1);
    // The buffered wake met a recording engine: no history query, no candidate.
    expect(h.fake.queries).not.toContain('queryMotionHistory');
    // The JS claim (README §6): sent although native already captures in this very mode (C1).
    expect(h.fake.calls.filter((c) => c === 'startCapture:mounted')).toHaveLength(1);
    expect(h.fake.calls).not.toContain('stopCapture');
    expect(h.limits.client.lookupStored).toHaveBeenCalled();

    await h.feed(drive(60, { t0: h.now() + 1000 }));
    await h.host.end();
    await h.host.untilIdle();
    const done = (await trips().get(trip.client_trip_id)) as TripRow;
    expect(done.status).toBe('provisional');
    expect(await trips().list()).toHaveLength(1);
  });

  test('the start evidence is restored from the stored start source (N-m4)', async () => {
    const { trip, rows } = await orphan('movingStart');
    const h = harness();
    h.setClock(last(rows).ts + 5000);
    await h.host.start({ adopt: trip });
    await h.host.end();
    await h.host.untilIdle();
    expect(((await trips().get(trip.client_trip_id)) as TripRow).role_source).toBe('moving_start');
    expect(await createSettingsRepo(db).get(`engine.arbiter.${trip.client_trip_id}`)).toBeNull();
  });

  test('Android killed-app auto start: the native capture is claimed, never stopped first (C1)', async () => {
    const h = harness({ platform: 'android' });
    await h.host.setAutoDetect(true);
    // ActivityTransitionReceiver started 'auto' capture natively; the headless task boots the host.
    h.fake.setState({ capturing: true, captureWasOpen: false, mode: 'auto', rate: 'full' });
    h.fake.setMotionHistory([automotive(h.now() - 20_000)]);
    h.fake.emit('wake', { reason: 'activityTransition', ts: h.now() });
    await h.host.start();
    await h.host.settled();
    expect(h.host.snapshot().status).toBe('candidate');
    expect(h.fake.calls.filter((c) => c.startsWith('startCapture'))).toEqual(['startCapture:auto']);
    expect(h.fake.calls).not.toContain('stopCapture');
    // Rows flow on the claimed capture and the drive confirms.
    await h.feed(drive(40, { t0: h.now() + 1000 }));
    expect(h.host.snapshot().status).toBe('recording');
    expect(h.fake.calls).not.toContain('stopCapture');
  });

  test('a capture found running is stopped once its wake turns out not to be a drive', async () => {
    const h = harness({ platform: 'android' });
    await h.host.setAutoDetect(true);
    h.fake.setState({ capturing: true, mode: 'auto', rate: 'full' });
    h.fake.setMotionHistory([{ type: 'walking', confidence: 'high', ts: h.now() - 5000 }]);
    h.fake.emit('wake', { reason: 'activityTransition', ts: h.now() });
    await h.host.start();
    await h.host.settled();
    expect(h.host.snapshot().status).toBe('armed');
    expect(last(h.fake.calls)).toBe('stopCapture');
    expect(h.host.captureActive()).toBe(false);
  });

  test('a trip with no samples is not adopted', async () => {
    await trips().insert({ client_trip_id: 'empty', started_at: T0, tz: TZ, status: 'recording' }, T0);
    const h = harness();
    const trip = (await trips().get('empty')) as TripRow;
    expect(await h.host.start({ adopt: trip })).toEqual({ adopted: false });
    expect(h.host.snapshot().status).toBe('off');
  });
});

// --- learning period, mutes, alerts ---------------------------------------------------------------

describe('the learning period counts scored driver trips only', () => {
  test('provisional and final driver trips; recomputed on a hydrate change', async () => {
    const add = (id: string, status: TripRow['status'], role: string) =>
      trips().insert({ client_trip_id: id, started_at: T0, tz: TZ, status, role }, T0);
    await add('a', 'provisional', 'driver');
    await add('b', 'final', 'driver');
    await add('c', 'final', 'passenger');
    await add('d', 'unscored', 'driver');
    await add('e', 'discarded', 'driver');
    await add('f', 'recording', 'driver');
    await add('g', 'final', 'unknown');
    await add('del', 'final', 'driver');
    await trips().update('del', { deleted_at: T0 }, T0);
    const h = harness();
    await h.host.start();
    expect(h.host.snapshot().tripIndex).toBe(2);

    await add('h', 'final', 'driver');
    events.emitDataChanged({ source: 'hydrate' });
    await new Promise((r) => setTimeout(r, 5));
    await h.host.settled();
    expect(h.host.snapshot().tripIndex).toBe(3);
  });

  test('recomputed after each finalize', async () => {
    const h = harness();
    await h.host.start();
    expect(h.host.snapshot().tripIndex).toBe(0);
    await h.host.manualStart({ mode: 'mounted', passenger: false, evidence: 'tap' });
    await h.feed(drive(200));
    await h.host.end();
    await h.host.untilIdle();
    expect(h.host.snapshot().tripIndex).toBe(1);
  });
});

describe('alerts', () => {
  const speeding = () => harness({ limit: limit(mph(20)) });
  const fast = (n: number) => drive(n, { speed: 15 });

  test('a delivered alert reaches the player and shows for its level, then clears on the row clock', async () => {
    const h = speeding();
    await h.host.start();
    await h.host.manualStart({ mode: 'mounted', passenger: false, evidence: 'tap' });
    const rows = fast(20);
    let shown: DriveState['activeAlert'] = null;
    let at = -1;
    for (const [i, r] of rows.entries()) {
      await h.feed([r]);
      if (!shown && h.host.snapshot().activeAlert) {
        shown = h.host.snapshot().activeAlert;
        at = i;
      }
    }
    expect(h.player.deliver).toHaveBeenCalledTimes(1);
    expect(shown).toMatchObject({ level: 1, kind: 'speeding' });
    // L1 shows 3 s: gone by the row three seconds later.
    expect(at).toBeGreaterThan(0);
    const h2 = speeding();
    await h2.host.start();
    await h2.host.manualStart({ mode: 'mounted', passenger: false, evidence: 'tap' });
    await h2.feed(rows.slice(0, at + 1));
    expect(h2.host.snapshot().activeAlert).not.toBeNull();
    await h2.feed(rows.slice(at + 1, at + 3));
    expect(h2.host.snapshot().activeAlert).not.toBeNull();
    await h2.feed(rows.slice(at + 3, at + 4));
    expect(h2.host.snapshot().activeAlert).toBeNull();
  });

  test('mute for drive: nothing more is delivered and the state says so', async () => {
    const h = speeding();
    await h.host.start();
    await h.host.manualStart({ mode: 'mounted', passenger: false, evidence: 'tap' });
    await h.feed(fast(2));
    await h.host.muteForDrive();
    expect(h.host.snapshot().mutedForDrive).toBe(true);
    expect(h.player.stopCurrent).toHaveBeenCalled();
    await h.feed(fast(200).slice(2));
    expect(h.player.deliver).not.toHaveBeenCalled();
    await h.host.end();
    await h.host.untilIdle();
    await h.host.manualStart({ mode: 'mounted', passenger: false, evidence: 'tap' });
    await h.host.settled();
    expect(h.host.snapshot().mutedForDrive).toBe(false);
  });

  test('the long-press mute stops the sound and clears the overlay', async () => {
    const h = speeding();
    await h.host.start();
    await h.host.manualStart({ mode: 'mounted', passenger: false, evidence: 'tap' });
    const rows = fast(20);
    for (const r of rows) {
      await h.feed([r]);
      if (h.host.snapshot().activeAlert) break;
    }
    await h.host.muteCurrentAlert();
    expect(h.player.stopCurrent).toHaveBeenCalledTimes(1);
    expect(h.host.snapshot().activeAlert).toBeNull();
  });

  test('a passenger trip delivers nothing to the player', async () => {
    const h = speeding();
    await h.host.start();
    await h.host.manualStart({ mode: 'pocket', passenger: true, evidence: 'tap' });
    await h.feed(fast(60));
    expect(h.player.deliver).not.toHaveBeenCalled();
  });

  test('announce goes to the player', async () => {
    const h = harness();
    await h.host.announce('alert.recording');
    expect(h.player.announce).toHaveBeenCalledWith('alert.recording');
  });

  test('the player is released when the drive closes', async () => {
    const h = harness();
    await h.host.start();
    await h.host.manualStart({ mode: 'mounted', passenger: false, evidence: 'tap' });
    await h.feed(drive(10));
    await h.host.end();
    await h.host.untilIdle();
    expect(h.player.stopCurrent).toHaveBeenCalledTimes(1);
  });

  test('L1 honours the silent switch only when mounted, unlocked and in front', async () => {
    const appState = fakeAppState('active');
    const h = harness();
    const host = createDriveHost({ ...hostDeps(h), appState });
    await host.start();
    await host.manualStart({ mode: 'mounted', passenger: false, evidence: 'tap' });
    expect(host.l1RespectsSilentSwitch()).toBe(true);
    h.fake.emit('screen', { locked: true, on: false, ts: h.now() });
    await host.settled();
    expect(host.snapshot().screenLocked).toBe(true);
    expect(host.l1RespectsSilentSwitch()).toBe(false);
    h.fake.emit('screen', { locked: false, on: true, ts: h.now() });
    appState.set('background');
    expect(host.l1RespectsSilentSwitch()).toBe(false);
  });
});

function fakeAppState(initial: string) {
  const listeners = new Set<(s: string) => void>();
  const api = {
    currentState: initial as string | null,
    addEventListener(_type: 'change', fn: (s: string) => void) {
      listeners.add(fn);
      return { remove: () => listeners.delete(fn) };
    },
    set(s: string) {
      api.currentState = s;
      for (const fn of listeners) fn(s);
    },
    listeners: () => listeners.size,
  };
  return api;
}

/** The deps a harness host was built with, to build a second host over the same fakes. */
function hostDeps(h: ReturnType<typeof harness>) {
  return {
    db,
    source: h.fake,
    limits: h.limits.client,
    player: h.player,
    scoring,
    traceWriter: h.traceWriter,
    hash: { sha256 },
    now: h.now,
    tz: () => TZ,
    newId: (() => {
      let n = 100;
      return () => `x-${(n += 1)}`;
    })(),
  };
}

// --- device state ---------------------------------------------------------------------------------

describe('device state in the snapshot', () => {
  test('a call that ends while no alert shows releases the audio session (P2-M2)', async () => {
    const h = harness();
    await h.host.start();
    await h.host.manualStart({ mode: 'mounted', passenger: false, evidence: 'tap' });
    await h.host.settled();
    h.fake.emit('call', { active: true, ts: h.now() });
    expect(h.player.stopCurrent).not.toHaveBeenCalled();
    h.fake.emit('call', { active: false, ts: h.now() });
    expect(h.player.stopCurrent).toHaveBeenCalledTimes(1);
  });

  test('playerInputs: late-bound call, silent-switch and deliverable (not passenger) reads', async () => {
    let host: DriveHost | undefined;
    const inputs = playerInputs(() => host);
    // No host yet: the audible, deliverable defaults.
    expect(inputs).toBeDefined();
    expect(inputs.callActive()).toBe(false);
    expect(inputs.l1RespectsSilentSwitch()).toBe(false);
    expect(inputs.deliverable()).toBe(true);
    const h = harness();
    host = h.host;
    await h.host.start();
    await h.host.manualStart({ mode: 'pocket', passenger: false, evidence: 'tap' });
    expect(inputs.deliverable()).toBe(true);
    await h.host.setPassenger(true);
    expect(inputs.deliverable()).toBe(false);
    h.fake.emit('call', { active: true, ts: h.now() });
    expect(inputs.callActive()).toBe(true);
  });

  test('thermal, call and screen events', async () => {
    const h = harness();
    await h.host.start();
    await h.host.manualStart({ mode: 'mounted', passenger: false, evidence: 'tap' });
    await h.host.settled();
    h.fake.emit('thermal', { level: 'serious', ts: h.now() });
    h.fake.emit('call', { active: true, ts: h.now() });
    h.fake.emit('screen', { locked: true, on: false, ts: h.now() });
    await h.host.settled();
    expect(h.host.snapshot()).toMatchObject({ thermal: 'serious', callActive: true, screenLocked: true });
  });

  test('gps weak and none from the rows', async () => {
    const h = harness();
    await h.host.start();
    await h.host.manualStart({ mode: 'mounted', passenger: false, evidence: 'tap' });
    await h.feed([row({ ts: T0, hAcc: 35 })]);
    expect(h.host.snapshot().gps).toBe('weak');
    await h.feed([row({ ts: T0 + 1000, gnssValid: false, speed: -1 })]);
    expect(h.host.snapshot().gps).toBe('none');
  });

  test('the detector context carries the lock signal (lagged on iOS)', async () => {
    const h = harness();
    await h.host.start();
    const ctx = h.host.detectorContext();
    expect(ctx).toMatchObject({ lockReliable: true, lockLagged: true, precipitation: false });
    const g = harness({ platform: 'android' });
    await g.host.start();
    expect(g.host.detectorContext()).toMatchObject({ lockReliable: true, lockLagged: false });
  });
});

// --- persistence ----------------------------------------------------------------------------------

describe('persistence', () => {
  async function tableCounts(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const t of ['trips', 'samples', 'trip_events', 'settings', 'sync_queue', 'speed_limit_tiles']) {
      const { rows } = await db.execute(`SELECT COUNT(*) AS n FROM ${t}`);
      out[t] = Number(rows[0]?.n);
    }
    return out;
  }

  test('a dry run stores nothing and says it is one', async () => {
    const before = await tableCounts();
    const emit = jest.spyOn(events, 'emitDataChanged');
    const h = harness({ persistence: 'none' });
    await h.host.start();
    expect(h.host.snapshot().dryRun).toBe(true);
    await h.host.manualStart({ mode: 'mounted', passenger: false, evidence: 'tap' });
    await h.feed(drive(150));
    await h.host.setAutoDetect(true);
    await h.host.end();
    await h.host.untilIdle();
    expect(await tableCounts()).toEqual(before);
    expect(h.writes).toEqual([]);
    expect(h.host.snapshot().lastFinalized).toBeNull();
    expect(emit).not.toHaveBeenCalled();
  });

  test('a dry run cannot persist even when handed a storing limits client (M2)', async () => {
    const api = {
      getTiles: jest.fn(async () => {
        throw new Error('a dry run must not ask');
      }),
      lookupPoint: jest.fn(async () => {
        throw new Error('a dry run must not ask');
      }),
    };
    const real = createSpeedLimitClient({ db, api, now: () => T0 });
    const h = harness({ persistence: 'none' });
    const host = createDriveHost({ ...hostDeps(h), limits: real, persistence: 'none' });
    await host.start();
    await host.manualStart({ mode: 'mounted', passenger: false, evidence: 'tap' });
    h.fake.loadTrace(drive(150));
    while (h.fake.step()) await host.settled();
    await host.end();
    await host.untilIdle();
    await real.settled();
    expect(api.getTiles).not.toHaveBeenCalled();
    expect(api.lookupPoint).not.toHaveBeenCalled();
    const { rows } = await db.execute('SELECT COUNT(*) AS n FROM speed_limit_tiles');
    expect(Number(rows[0]?.n)).toBe(0);
  });

  test('a finalize failure: ok false, the trip row still recording, reported', async () => {
    const h = harness({ writeFailures: 1 });
    await h.host.start();
    await h.host.manualStart({ mode: 'mounted', passenger: false, evidence: 'tap' });
    await h.feed(drive(200));
    const id = h.host.snapshot().clientTripId as string;
    await h.host.end();
    await h.host.untilIdle();
    expect(h.host.snapshot().lastFinalized).toMatchObject({ clientTripId: id, ok: false });
    expect(((await trips().get(id)) as TripRow).status).toBe('recording');
    expect(h.errors.length).toBeGreaterThan(0);
    expect(h.host.snapshot().status).toBe('off');
  });

  test('never re-finalizes: not after a failure, not after a success', async () => {
    const h = harness({ writeFailures: 1 });
    await h.host.start();
    await h.host.manualStart({ mode: 'mounted', passenger: false, evidence: 'tap' });
    await h.feed(drive(200));
    const failed = h.host.snapshot().clientTripId as string;
    await h.host.end();
    await h.host.untilIdle();
    await h.host.end();
    await h.host.manualStart({ mode: 'mounted', passenger: false, evidence: 'tap' });
    await h.feed(drive(200, { t0: h.now() + 1000 }));
    const second = h.host.snapshot().clientTripId as string;
    await h.host.end();
    await h.host.untilIdle();
    await h.host.end();
    await h.host.untilIdle();
    expect(h.writes).toEqual([`${failed}.bin.gz`, `${second}.bin.gz`]);
    expect(((await trips().get(failed)) as TripRow).status).toBe('recording');
    const { rows: queued } = await db.execute('SELECT COUNT(*) AS n FROM sync_queue');
    expect(Number(queued[0]?.n)).toBe(1);
  });

  test('the change event fires once, only after the snapshot reaches armed or off', async () => {
    const statuses: string[] = [];
    let host: DriveHost | null = null;
    // finalizeTrip's own `enqueue` (D1) fires inside finalizing; the runner then sees the host busy.
    jest.spyOn(events, 'emitDataChanged').mockImplementation((e) => {
      if (e.source === 'finalize') statuses.push(`${e.source}:${host?.snapshot().status}`);
    });
    const h = harness();
    host = h.host;
    await armed(h);
    await h.host.manualStart({ mode: 'mounted', passenger: false, evidence: 'tap' });
    await h.feed(drive(200));
    expect(statuses).toEqual([]);
    await h.host.end();
    await h.host.untilIdle();
    expect(statuses).toEqual(['finalize:armed']);
  });

  test('finalize is given the role prior and the habitual route (E2)', async () => {
    const rows = drive(200);
    const first = rows[0] as FeatureRow;
    const end = last(rows);
    const settings = createSettingsRepo(db);
    await settings.set(ROLE_PRIOR_KEY, { driverAnswers: 8, answers: 8 });
    await settings.set(ROLE_ROUTES_KEY, {
      [routeKey(geohash5(first.lat, first.lng), geohash5(end.lat, end.lng))]: { driver: 2, other: 0 },
    });
    const spy = jest.spyOn(finalizeModule, 'finalizeTrip');
    const h = harness();
    await h.host.start();
    await h.host.manualStart({ mode: 'pocket', passenger: false, evidence: 'movingStart' });
    await h.feed(rows);
    await h.host.end();
    await h.host.untilIdle();
    expect(spy).toHaveBeenCalledTimes(1);
    const deps = spy.mock.calls[0]?.[1];
    expect(deps?.rolePrior).toBeCloseTo(0.9, 5);
    expect(deps?.habitualRoute).toBe(true);
  });
});

// --- battery --------------------------------------------------------------------------------------

describe('battery (§3.5)', () => {
  test('no timer, query or command while armed and idle', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    try {
      const h = harness();
      await armed(h);
      const calls = h.fake.calls.length;
      const queries = h.fake.queries.length;
      await h.host.settled();
      expect(jest.getTimerCount()).toBe(0);
      expect(h.timers()).toBe(0);
      jest.advanceTimersByTime(60 * 60_000);
      await h.host.settled();
      expect(h.fake.calls.length).toBe(calls);
      expect(h.fake.queries.length).toBe(queries);
      expect(h.limits.client.lookup).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  test('stop removes every native listener', async () => {
    const h = harness();
    await h.host.start();
    expect(h.fake.listenerCount('row')).toBe(1);
    await h.host.stop({ endOpenTrip: true });
    for (const e of ['wake', 'activity', 'row', 'screen', 'thermal', 'notificationAction', 'call'] as const) {
      expect(h.fake.listenerCount(e)).toBe(0);
    }
  });

  test('stop with endOpenTrip finalizes an open drive first', async () => {
    const h = harness();
    await h.host.start();
    await h.host.manualStart({ mode: 'mounted', passenger: false, evidence: 'tap' });
    await h.feed(drive(200));
    await h.host.stop({ endOpenTrip: true });
    expect(h.host.snapshot().lastFinalized).toMatchObject({ ok: true });
    expect(last(h.fake.calls)).toBe('stopCapture');
  });
});

describe('mode and passenger', () => {
  test('setMode re-claims capture with the new mode; setPassenger reaches the engine', async () => {
    const h = harness();
    await h.host.start();
    await h.host.manualStart({ mode: 'pocket', passenger: false, evidence: 'tap' });
    const moving = drive(20, { speed: 1 });
    await h.feed(moving);
    await h.host.setMode('mounted');
    await h.host.settled();
    expect(h.host.snapshot().mode).toBe('mounted');
    expect(last(h.fake.calls)).toBe('startCapture:mounted');
    await h.host.setPassenger(true);
    expect(h.host.snapshot().role).toBe('passenger');
  });
});

// --- final review: arming follows the phone, sign-out stops recording, sound failures show ---------

describe('arming is re-applied on the foreground (final review I4)', () => {
  function withAppState() {
    const listeners: ((s: string) => void)[] = [];
    const appState = {
      currentState: 'active' as string | null,
      addEventListener: (_t: 'change', fn: (s: string) => void) => {
        listeners.push(fn);
        return { remove: () => listeners.splice(listeners.indexOf(fn), 1) };
      },
      emit: (s: string) => {
        appState.currentState = s;
        for (const fn of [...listeners]) fn(s);
      },
    };
    return appState;
  }

  test('Always granted in Settings while away: the return to the app arms, and the state says so', async () => {
    const appState = withAppState();
    const h = harness({ appState });
    h.fake.setState({ location: 'whenInUse' });
    await h.host.setAutoDetect(true);
    await h.host.start();
    expect(h.host.snapshot()).toMatchObject({ status: 'off', autoDetectArmed: false });

    appState.emit('background');
    h.fake.setState({ location: 'always' });
    appState.emit('active');
    await h.host.settled();
    expect(h.host.snapshot()).toMatchObject({ status: 'armed', autoDetectArmed: true });
  });

  test('Always revoked while away: the return disarms, never left saying on', async () => {
    const appState = withAppState();
    const h = harness({ appState });
    await h.host.setAutoDetect(true);
    await h.host.start();
    expect(h.host.snapshot().autoDetectArmed).toBe(true);
    appState.emit('background');
    h.fake.setState({ location: 'whenInUse' });
    appState.emit('active');
    await h.host.settled();
    expect(h.host.snapshot()).toMatchObject({ status: 'off', autoDetectArmed: false });
  });

  test('negative control: nothing re-reads while backgrounded (no work while armed and idle)', async () => {
    const appState = withAppState();
    const h = harness({ appState });
    await h.host.setAutoDetect(true);
    await h.host.start();
    const reads = h.fake.queries.length;
    appState.emit('background');
    await h.host.settled();
    expect(h.fake.queries.length).toBe(reads);
  });
});

describe('sign-out stops recording (final review I3)', () => {
  test('an open drive is finalized under the current owner, then auto-record is disarmed; the opt-in is kept', async () => {
    const h = harness();
    await h.host.setAutoDetect(true);
    await h.host.start();
    await h.host.manualStart({ mode: 'mounted', passenger: false, evidence: 'tap' });
    await h.feed(drive(200, { t0: h.now() + 1000 }));
    const tripId = h.host.snapshot().clientTripId as string;

    await h.host.suspendForSignOut();

    expect((await trips().get(tripId))?.status).toBe('provisional');
    expect(h.host.snapshot()).toMatchObject({ status: 'off', autoDetectArmed: false });
    expect(last(h.fake.calls)).toBe('disarm');
    expect(h.host.autoDetectEnabled()).toBe(true);
    // A wake now opens nothing.
    h.fake.setMotionHistory([automotive(h.now() - 10_000)]);
    h.fake.emit('wake', { reason: 'significantChange', ts: h.now() });
    await h.host.settled();
    expect(h.host.snapshot().status).toBe('off');

    await h.host.resumeAfterSignIn();
    expect(h.host.snapshot()).toMatchObject({ status: 'armed', autoDetectArmed: true });
  });

  test('a host started with nobody signed in never arms, whatever the opt-in', async () => {
    const h = harness({ signedOut: true });
    await h.host.setAutoDetect(true);
    await h.host.start();
    expect(h.host.snapshot()).toMatchObject({ status: 'off', autoDetectArmed: false });
    expect(h.fake.calls).not.toContain('arm');
  });
});

describe('a sound that fails during a drive marks alerts unavailable for that drive (final review I2)', () => {
  test('reported once, published, and reset when the next drive opens', async () => {
    const h = harness();
    await h.host.start();
    await h.host.manualStart({ mode: 'mounted', passenger: false, evidence: 'tap' });
    await h.feed(drive(40, { t0: h.now() + 1000 }));
    expect(h.host.snapshot().alertsAvailable).toBe(true);
    playerInputs(() => h.host).onUnavailable();
    expect(h.host.snapshot().alertsAvailable).toBe(false);
    await h.host.end();
    await h.host.untilIdle();
    await h.host.manualStart({ mode: 'mounted', passenger: false, evidence: 'tap' });
    await h.feed(drive(40, { t0: h.now() + 1000 }));
    expect(h.host.snapshot().alertsAvailable).toBe(true);
  });
});

describe('a sign-out in progress ignores auth events; a signed-out host records nothing (final-fix security I-1, M-1)', () => {
  test('a SIGNED_IN (or a token refresh passed through as one) during the sign-out never re-arms', async () => {
    const h = harness();
    await h.host.setAutoDetect(true);
    await h.host.start();
    await h.host.suspendForSignOut();
    // The flush is running: an auth event arrives now.
    await h.host.signedInAgain();
    expect(h.host.snapshot()).toMatchObject({ status: 'off', autoDetectArmed: false });

    // The sign-out completes (SIGNED_OUT): only after that does the owner's next sign-in re-arm.
    h.host.signOutCompleted();
    await h.host.signedInAgain();
    expect(h.host.snapshot()).toMatchObject({ status: 'armed', autoDetectArmed: true });
  });

  test('backing out of the sign-out resumes explicitly', async () => {
    const h = harness();
    await h.host.setAutoDetect(true);
    await h.host.start();
    await h.host.suspendForSignOut();
    await h.host.resumeAfterSignIn();
    expect(h.host.snapshot()).toMatchObject({ status: 'armed', autoDetectArmed: true });
  });

  test('while signed out, a wake opens nothing and a manual start is refused (M-1)', async () => {
    const h = harness({ signedOut: true });
    await h.host.setAutoDetect(true);
    await h.host.start();
    h.fake.setMotionHistory([automotive(h.now() - 10_000)]);
    h.fake.emit('wake', { reason: 'significantChange', ts: h.now() });
    await h.host.settled();
    expect(h.fake.queries).not.toContain('queryMotionHistory');
    await h.host.manualStart({ mode: 'mounted', passenger: false, evidence: 'tap' });
    await h.host.settled();
    expect(h.host.snapshot().status).toBe('off');
    expect(h.fake.calls.filter((c) => c.startsWith('startCapture'))).toEqual([]);
  });
});
