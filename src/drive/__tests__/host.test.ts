/** @jest-environment node */
import { createFakeDriveDetect, createFakeDriveSense, type DriveDetectApi } from '@drive-sense';
import { IDLE_END_S } from '@scoring';

import type { AlertDecision } from '@/core/alerts/types';
import type { AlertPlayer } from '@/core/alerts/player';
import { createDetectors } from '@/core/detectors';
import { T0 } from '@/core/detectors/__fixtures__/rows';
import { rows, START, TZ } from '@/core/engine/__fixtures__/drives';
import { appendRow, createSession } from '@/core/engine/session';
import type { FeatureRow, LimitSample } from '@/core/engine/types';
import type { SpeedLimitClient } from '@/core/speedLimits/client';
import type { WatchSpot } from '@/core/spots/types';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createEventsRepo, createQueueRepo, createSamplesRepo, createSettingsRepo, createTripsRepo, migrate, type Db } from '@/data/db';
import type { DriveDisplay, DriveDisplayState, SpeedCarry } from '@/drive/display';
import { speedTintOf } from '@/drive/displayTint';
import { isManualDrop, readDropNotice, writeDropNotice } from '@/drive/dropNotice';
import {
  createDriveHost,
  DriveEndFailedError,
  finishPendingCancel,
  JOURNAL_LINK_KEY,
  MAX_JOURNAL_REPLAY_ROWS,
  PUSH_START_RETRY_MS,
  PUSH_START_WAIT_MS,
  type PushToStartOutcome,
  type PushToStartRequest,
} from '@/drive/host';
import { CANCEL_KEY } from '@/drive/cancel';
import { NOT_DRIVING_BUDGET_MS, NOT_DRIVING_KEY, readBudget } from '@/drive/notDriving';
import type { Scheduler } from '@/drive/ticks';
import { WAIT_COUNTDOWN_MS, WAIT_POPUP_MS, WAIT_TOTAL_MS } from '@/drive/waiting';
import type { DangerAlert } from '@/features/weather/danger';
import { attachSummaryNotifier, type SummaryNotificationPort, type SummaryRequest } from '@/features/drive/summaryNotifier';

jest.mock('expo-notifications', () => ({}));

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const M_PER_DEG_LNG = 111_194.93 * Math.cos((START.lat * Math.PI) / 180);

function fakeLimits(limitMps: number | null = 35 * 0.44704): SpeedLimitClient {
  const sample: LimitSample = { limitMps, source: 'posted', matchConfidence: 0.95, parallelRoads: false };
  return {
    lookup: () => sample,
    lookupStored: async () => sample,
    startTrip: jest.fn(),
    prefetch: jest.fn(),
    resetTrip: jest.fn(),
    purgeExpired: async () => 0,
    stats: () => ({ memoryTiles: 0, requestsThisTrip: 0, pointLookupsThisTrip: 0, sqliteLoads: 0, truncatedTiles: 0 }),
  } as unknown as SpeedLimitClient;
}

function fakePlayer(): AlertPlayer & { delivered: AlertDecision[]; releases: string[] } {
  const delivered: AlertDecision[] = [];
  const releases: string[] = [];
  return {
    delivered,
    releases,
    deliver: async (d) => {
      delivered.push(d);
    },
    stopCurrent: async () => {},
    announce: async () => {},
    release: async (kind) => {
      releases.push(kind);
    },
  };
}

function fakeDisplay(running = false): DriveDisplay & { log: string[]; states: DriveDisplayState[]; carries: (SpeedCarry | null | undefined)[]; running: boolean } {
  const log: string[] = [];
  const states: DriveDisplayState[] = [];
  const carries: (SpeedCarry | null | undefined)[] = [];
  const d = {
    log,
    states,
    carries,
    running,
    start: (s: DriveDisplayState) => {
      states.push(s);
      log.push(`start ${s.speed}/${s.limit}${s.stopped ? ' stopped' : ''}`);
    },
    update: (s: DriveDisplayState, carry?: SpeedCarry | null) => {
      states.push(s);
      carries.push(carry);
      log.push(`update ${s.speed}/${s.limit}`);
    },
    refresh: (s: DriveDisplayState) => {
      states.push(s);
      log.push(`refresh ${s.notDrivingAvailable ? 'hint' : 'nohint'} ${s.weatherKind ?? '-'}`);
    },
    end: () => log.push('end'),
    isRunning: async () => d.running,
  };
  return d;
}

/** A manual scheduler: timers fire only when the test says; each keeps its delay. */
function manualScheduler(): Scheduler & { fire(): number; delays(): number[] } {
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let n = 0;
  return {
    setTimeout(fn, ms) {
      timers.set((n += 1), { fn, ms });
      return n;
    },
    clearTimeout(h) {
      timers.delete(h as number);
    },
    fire() {
      const fns = [...timers.values()];
      timers.clear();
      fns.forEach((t) => t.fn());
      return fns.length;
    },
    delays: () => [...timers.values()].map((t) => t.ms),
  };
}

function fakeAppState(initial = 'active') {
  const fns = new Set<(s: string) => void>();
  const a = {
    currentState: initial as string | null,
    addEventListener: (_t: 'change', fn: (s: string) => void) => {
      fns.add(fn);
      return { remove: () => fns.delete(fn) };
    },
    set(next: string) {
      a.currentState = next;
      for (const fn of [...fns]) fn(next);
    },
  };
  return a;
}

let db: Db;
let clock: number;
let ids: number;

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
  await createSettingsRepo(db).set('device.lastUserId', 'user-1');
  clock = T0;
  ids = 0;
});

type Over = Partial<Parameters<typeof createDriveHost>[0]>;

function build(over: Over = {}) {
  const source = createFakeDriveSense({ platform: 'android', now: () => clock });
  source.setState({ location: 'whenInUse', motion: 'granted', lockSignal: 'reliable' });
  const player = fakePlayer();
  const display = fakeDisplay();
  const scheduler = manualScheduler();
  const appState = fakeAppState();
  const errors: string[] = [];
  const host = createDriveHost({
    db,
    source,
    limits: fakeLimits(),
    player,
    display,
    now: () => clock,
    tz: () => TZ,
    newId: () => uuid((ids += 1)),
    appVersion: '2.0.0',
    permissions: async () => ({ location: 'granted' }),
    scheduler,
    appState,
    weather: async () => null,
    spots: { readWatchSpots: async () => [] },
    onError: (e, ctx) => errors.push(`${ctx}: ${e instanceof Error ? e.message : String(e)}`),
    ...over,
  });
  return { host, source, player, display, scheduler, appState, errors };
}

type H = ReturnType<typeof build>;

/** Feed `list` rows through the fake, advancing the clock to each row. */
async function feed(h: Pick<H, 'host' | 'source'>, list: readonly FeatureRow[]): Promise<void> {
  h.source.loadTrace(list);
  for (const r of list) {
    clock = r.ts;
    h.source.step();
    await h.host.settled();
  }
}

/** Android: Start, then the rows; the wait confirms on the 16th row of driving (10 mph held 15 s). */
async function drive(h: H, list: readonly FeatureRow[]): Promise<void> {
  expect(await h.host.start()).toEqual({ ok: true, waiting: true });
  await feed(h, list);
}

const tripCount = async () => (await createTripsRepo(db).count());

describe('the Start card (Android: the capture at once; the drive records from the tap, waiting for driving speed)', () => {
  test('refuses before boot, without location, approximate only or Location Services off; else the drive records from the tap, waiting, with the capture on', async () => {
    const h = build();
    expect(await h.host.start()).toEqual({ ok: false, reason: 'error' });
    expect(h.source.calls).toEqual([]);
    for (const [perms, reason] of [
      [{ location: 'denied' }, 'permission'],
      [{ location: 'granted', services: false }, 'services'],
      [{ location: 'granted', precise: false }, 'precise'],
    ] as const) {
      const r = build({ permissions: async () => perms });
      await r.host.boot();
      expect(await r.host.start()).toEqual({ ok: false, reason });
      expect(r.source.calls).toEqual([]);
    }
    const ok = build();
    await ok.host.boot();
    expect(await ok.host.start()).toEqual({ ok: true, waiting: true });
    expect(ok.source.calls).toEqual(['startCapture:mounted']);
    expect(ok.host.snapshot()).toMatchObject({
      status: 'recording',
      clientTripId: uuid(1),
      origin: 'manual',
      startedAt: T0,
      waiting: { since: T0, phase: 'waiting', deadlineAt: T0 + WAIT_POPUP_MS },
      notDrivingAvailable: false,
    });
    expect(await createTripsRepo(db).get(uuid(1))).toMatchObject({ status: 'recording', origin: 'manual', started_at: T0, start_source: 'wake' });
    // The drive's notification (the Live Activity on iPhone) from the tap.
    expect(ok.display.log[0]).toMatch(/^start /);
    // A second swipe while waiting is a touch.
    clock = T0 + 10_000;
    expect(await ok.host.start()).toEqual({ ok: true, waiting: true });
    expect(ok.host.snapshot().waiting?.since).toBe(T0 + 10_000);
    await ok.host.stop({ endOpenTrip: true });
  });

  test('the sheet at 2:00, the countdown at 4:30, a touch waits a fresh 5 min (the still end held meanwhile), the unsaved end at 5:00: nothing kept, the capture off, no notice', async () => {
    const h = build();
    await h.host.boot();
    await h.host.start();
    expect(h.scheduler.delays()).toContain(WAIT_POPUP_MS);
    clock = T0 + WAIT_POPUP_MS;
    h.scheduler.fire();
    await h.host.settled();
    expect(h.host.snapshot().waiting).toMatchObject({ phase: 'popup', deadlineAt: T0 + WAIT_COUNTDOWN_MS });
    clock = T0 + WAIT_COUNTDOWN_MS;
    h.scheduler.fire();
    await h.host.settled();
    expect(h.host.snapshot().waiting).toMatchObject({ phase: 'countdown', deadlineAt: T0 + WAIT_TOTAL_MS });
    // A touch at 4:40, then parked past the engine's own 5 min still end (from the tap): the drive goes on.
    const touched = T0 + 280_000;
    clock = touched;
    h.host.touchWaiting();
    expect(h.host.snapshot().waiting).toMatchObject({ since: touched, phase: 'waiting' });
    await feed(h, rows(140, { t0: touched + 1000, speedMps: 0 }));
    h.scheduler.fire();
    await h.host.settled();
    expect(h.host.snapshot()).toMatchObject({ status: 'recording', waiting: { since: touched, phase: 'popup' } });
    clock = touched + WAIT_TOTAL_MS;
    h.scheduler.fire();
    await h.host.settled();
    expect(h.host.snapshot()).toMatchObject({ waiting: null, status: 'idle', lastFinalized: { clientTripId: uuid(1), ok: true, dropped: 'no_movement' } });
    expect(h.source.calls).toEqual(['startCapture:mounted', 'stopCapture']);
    expect(await tripCount()).toBe(0);
    expect(await createQueueRepo(db).countByStatus('pending')).toBe(0);
    expect(await readDropNotice(db)).toBeNull();
  });

  test('Cancel (or End while waiting) ends the drive unsaved, saying nothing', async () => {
    const h = build();
    await h.host.boot();
    await h.host.start();
    expect(await h.host.end()).toBeNull();
    expect(h.host.snapshot()).toMatchObject({ waiting: null, status: 'idle', lastFinalized: { clientTripId: uuid(1), ok: true, dropped: 'no_gps' } });
    expect(h.source.calls.at(-1)).toBe('stopCapture');
    await h.host.start();
    await feed(h, rows(20, { t0: T0 + 1000, speedMps: 0 }));
    await h.host.cancelWaiting();
    expect(h.host.snapshot()).toMatchObject({ waiting: null, status: 'idle' });
    expect(await tripCount()).toBe(0);
    expect(await readDropNotice(db)).toBeNull();
  });

  test('parked, then pulling away: the wait ends on the second row at driving speed; the drive keeps every row from the tap and is kept', async () => {
    const h = build();
    await h.host.boot();
    await h.host.start();
    const parked = rows(30, { speedMps: 0 });
    const away = rows(60, { t0: T0 + 30_000, speedMps: 15 }).map((r, i) => ({ ...r, lng: START.lng + (i * 15) / M_PER_DEG_LNG }));
    await feed(h, parked);
    // The drive's own speed and limit from the first row (the sign the lock screen shows too).
    expect(h.host.snapshot()).toMatchObject({ status: 'recording', clientTripId: uuid(1), lastRowTs: T0 + 29_000, limitMph: 35, waiting: { phase: 'waiting' } });
    expect(h.display.states.at(-1)).toMatchObject({ limit: 35 });
    await feed(h, away.slice(0, 1));
    expect(h.host.snapshot().waiting).not.toBeNull();
    await feed(h, away.slice(1, 2));
    expect(h.host.snapshot()).toMatchObject({ status: 'recording', clientTripId: uuid(1), origin: 'manual', startedAt: T0, waiting: null, notDrivingAvailable: true });
    await feed(h, away.slice(2));
    clock = T0 + 91_000;
    expect(await h.host.end()).toEqual({ clientTripId: uuid(1), dropped: null });
    expect(await createTripsRepo(db).get(uuid(1))).toMatchObject({ status: 'pending', origin: 'manual', start_source: 'wake', started_at: T0 });
    expect(h.host.snapshot().lastFinalized).toMatchObject({ clientTripId: uuid(1), ok: true, status: 'pending', dropped: null, durationS: expect.any(Number), miles: expect.any(Number) });
    await h.host.stop({ endOpenTrip: false });
  });

  test('the wait never counts toward its 2 min: 90 s parked, then 40 s and 0.3 mi of driving, is too short and not kept', async () => {
    const h = build();
    await h.host.boot();
    await h.host.start();
    await feed(h, rows(90, { t0: T0 + 1000, speedMps: 0 }));
    await feed(h, rows(40, { t0: T0 + 91_000, speedMps: 12 }));
    expect(h.host.snapshot()).toMatchObject({ status: 'recording', waiting: null, startedAt: T0 });
    clock = T0 + 131_000;
    expect(await h.host.end()).toEqual({ clientTripId: uuid(1), dropped: 'too_short' });
    expect(await tripCount()).toBe(0);
    expect(await createQueueRepo(db).countByStatus('pending')).toBe(0);
    expect(await readDropNotice(db)).toMatchObject({ clientTripId: uuid(1), reason: 'too_short', origin: 'manual' });
  });

  test('"Not driving?" is never offered while the drive waits and the wait spends none of its budget; at driving speed it is offered, counted from then', async () => {
    const h = build();
    await h.host.boot();
    await h.host.start();
    h.host.setHudVisible(true);
    expect(h.host.snapshot()).toMatchObject({ waiting: { phase: 'waiting' }, notDrivingAvailable: false });
    // 90 s parked with the driving screen showing.
    await feed(h, rows(90, { t0: T0 + 1000, speedMps: 0 }));
    expect(h.host.snapshot()).toMatchObject({ status: 'recording', waiting: { phase: 'waiting' }, notDrivingAvailable: false, notDrivingSpentMs: 0 });
    expect(await h.host.cancelDrive()).toBe(false);
    expect(h.host.snapshot()).toMatchObject({ status: 'recording', waiting: { phase: 'waiting' } });
    expect(h.display.states.length).toBeGreaterThan(1);
    expect(h.display.states.every((st) => st.notDrivingAvailable !== true)).toBe(true);
    expect(await readBudget(db)).toBeNull();
    // Pulling away: the wait ends on the second row at driving speed, and the lock screen's hint comes at once.
    const away = rows(30, { t0: T0 + 91_000, speedMps: 15 });
    await feed(h, away.slice(0, 2));
    expect(h.host.snapshot()).toMatchObject({ waiting: null, notDrivingAvailable: true, notDrivingSpentMs: 0 });
    expect(h.display.log.at(-1)).toBe('refresh hint -');
    await feed(h, away.slice(2));
    expect(h.host.snapshot().notDrivingSpentMs).toBe(28_000);
    await h.host.stop({ endOpenTrip: true });
  });

  test('a Start-card drive under 0.5 mi and under 2 min is not kept: nothing stored or queued, and Home says it was too short', async () => {
    const h = build();
    await h.host.boot();
    await h.host.start();
    await feed(h, rows(30, { speedMps: 15 }).map((r, i) => ({ ...r, lng: START.lng + (i * 15) / M_PER_DEG_LNG })));
    expect(h.host.snapshot().waiting).toBeNull();
    clock = T0 + 31_000;
    expect(await h.host.end()).toEqual({ clientTripId: uuid(1), dropped: 'too_short' });
    expect(await tripCount()).toBe(0);
    expect(await createQueueRepo(db).countByStatus('pending')).toBe(0);
    expect(await readDropNotice(db)).toMatchObject({ clientTripId: uuid(1), reason: 'too_short', origin: 'manual' });
  });
});

/** Every state a host publishes, as (status, waiting) pairs. */
function recordStates(host: H['host']): { status: string; waiting: boolean }[] {
  const seen: { status: string; waiting: boolean }[] = [];
  host.subscribe((s) => seen.push({ status: s.status, waiting: s.waiting !== null }));
  return seen;
}

/** From the tap every state is the drive: waiting first, then (at driving speed) not; never idle. */
function onScreenFromTap(seen: readonly { status: string; waiting: boolean }[]): void {
  expect(seen.length).toBeGreaterThan(1);
  expect(seen.every((x) => x.status === 'recording')).toBe(true);
  expect(seen[0]).toEqual({ status: 'recording', waiting: true });
  expect(seen.at(-1)).toEqual({ status: 'recording', waiting: false });
}

describe('a Start-card drive is on screen from the tap', () => {
  test('Android: every state published from the tap is the drive, waiting until driving speed, never idle (a publish from elsewhere meanwhile too)', async () => {
    const h = build();
    await h.host.boot();
    const seen = recordStates(h.host);
    await h.host.start();
    h.appState.set('background');
    h.appState.set('active');
    await feed(h, rows(16, { speedMps: 15 }).map((r, i) => ({ ...r, lng: START.lng + (i * 15) / M_PER_DEG_LNG })));
    expect(h.host.snapshot()).toMatchObject({ status: 'recording', waiting: null });
    onScreenFromTap(seen);
    await h.host.stop({ endOpenTrip: true });
  });
});

describe('a drive', () => {
  test('rows publish, the display wears the tint, the hint and the speed; the end finalizes and queues the upload, due at once', async () => {
    const h = build();
    await h.host.boot();
    const published: number[] = [];
    h.host.subscribe((s) => published.push(s.lastRowTs ?? -1));
    await drive(h, rows(120, { speedMps: 25 }));
    expect(h.host.snapshot()).toMatchObject({ status: 'recording', lockedOut: true, origin: 'manual', speedingTier: 'severe' });
    const update = h.display.states.at(-1)!;
    expect(update).toMatchObject({ unit: 'mph', points: null, pointsDelta: null, speeding: true, notDrivingAvailable: true, weatherKind: null, weatherText: null });
    expect(update.speedTint).toBe(speedTintOf(h.host.snapshot().speedingRatio, false));
    expect(update.speedTint).toMatch(/^#[0-9A-F]{6}$/);
    // the halo's speed goes along, for the Live Activity to carry as the halo does
    const snap = h.host.snapshot();
    expect(h.display.carries.at(-1)).toEqual({ mps: snap.speedMps, accel: snap.speedAccelMps2, at: snap.speedAt });
    expect(snap.speedMps).toBeCloseTo(25, 0);
    expect(h.display.log[0]).toMatch(/^start /);
    clock = T0 + 121_000;
    await h.host.end();
    expect(h.display.log.at(-1)).toBe('end');
    const trip = (await createTripsRepo(db).get(uuid(1)))!;
    expect(trip).toMatchObject({ status: 'pending', origin: 'manual', finalized_at: clock });
    const item = (await createQueueRepo(db).byKey(`trip:${uuid(1)}`))!;
    expect(item.next_attempt_at).toBe(clock);
    expect(h.source.calls.at(-1)).toBe('stopCapture');
    await h.host.stop({ endOpenTrip: false });
  });

  test('an unknown speed reaches the lock screen as none ("-"), never 0: at the start, and in the push-to-start state', async () => {
    const h = build();
    await h.host.boot();
    await drive(h, rows(16, { speedMps: 15 }).map((r, i) => ({ ...r, lng: START.lng + (i * 15) / M_PER_DEG_LNG })));
    // The drive opened before its first row reached the engine: no speed yet.
    const first = h.display.states[0]!;
    expect(h.display.log[0]).toMatch(/^start /);
    expect(first.speed).toBeNull();
    expect(h.display.states.some((s) => s.speed !== null && s.speed > 0)).toBe(true);
    await h.host.stop({ endOpenTrip: true });
  });

  test('alerts play only with RoadWise in front: behind, every decision is suppressed, and lastAlert still shows', async () => {
    const h = build();
    await h.host.boot();
    await drive(h, rows(40, { speedMps: 25 }));
    const front = h.player.delivered.filter((d) => d.kind === 'speeding');
    expect(front.length).toBeGreaterThan(0);
    expect(front.every((d) => d.suppressed !== true)).toBe(true);
    h.appState.set('background');
    const before = h.player.delivered.length;
    await feed(h, rows(30, { t0: T0 + 40_000, speedMps: 25 }));
    const behind = h.player.delivered.slice(before);
    expect(behind.length).toBeGreaterThan(0);
    expect(behind.every((d) => d.suppressed === true)).toBe(true);
    expect(h.host.snapshot().lastAlert).toMatchObject({ type: 'speeding' });
    await h.host.stop({ endOpenTrip: true });
  });

  test('an alert raised in front but still queued when RoadWise goes behind is no longer wanted: it is dropped unplayed', async () => {
    const h = build();
    await h.host.boot();
    await drive(h, rows(40, { speedMps: 25 }));
    const latest = h.player.delivered.filter((d) => d.kind === 'speeding').at(-1)!;
    expect(latest.suppressed).toBeUndefined();
    expect(latest.stillWanted!()).toBe(true);
    h.appState.set('background');
    expect(latest.stillWanted!()).toBe(false);
    h.appState.set('inactive');
    expect(latest.stillWanted!()).toBe(false);
    h.appState.set('active');
    expect(latest.stillWanted!()).toBe(true);
    // A hard brake (0.40 g, the GPS 2 m/s slower over the second) the same way.
    await feed(h, rows(3, { t0: T0 + 40_000, speedMps: 15, over: (i) => (i === 0 ? { speed: 13, aLonMin: -0.4 } : {}) }));
    const brake = h.player.delivered.find((d) => d.kind === 'hard_brake')!;
    expect(brake.suppressed).toBeUndefined();
    expect(brake.stillWanted!()).toBe(true);
    h.appState.set('background');
    expect(brake.stillWanted!()).toBe(false);
    await h.host.stop({ endOpenTrip: true });
  });

  test('the automatic end after 5 min still: the one timer covers rows that stop coming', async () => {
    const h = build();
    await h.host.boot();
    await drive(h, rows(60, { speedMps: 15 }));
    clock = T0 + 60_000 + IDLE_END_S * 1000 + 2000;
    h.scheduler.fire();
    await h.host.untilIdle();
    expect(h.host.snapshot().lastFinalized).toMatchObject({ clientTripId: uuid(1), ok: true, endCause: 'stopped' });
    await h.host.stop({ endOpenTrip: false });
  });

  test('a finalize that fails: end() rejects, and the next end() finalizes it from memory', async () => {
    let failWrites = false;
    const failing: Db = {
      ...db,
      transaction: ((fn: never) => (failWrites ? Promise.reject(new Error('disk full')) : db.transaction(fn))) as Db['transaction'],
    } as Db;
    const h = build({ db: failing });
    await h.host.boot();
    await drive(h, rows(60, { speedMps: 15 }));
    failWrites = true;
    clock = T0 + 61_000;
    await expect(h.host.end()).rejects.toBeInstanceOf(DriveEndFailedError);
    failWrites = false;
    expect(await h.host.end()).toEqual({ clientTripId: uuid(1), dropped: null });
    expect((await createTripsRepo(db).get(uuid(1)))?.status).toBe('pending');
    expect(await h.host.end()).toBeNull();
    await h.host.stop({ endOpenTrip: false });
  });

  test('a drive that never moved (an adopted one) is dropped with Home’s notice; the next confirmed drive clears the notice', async () => {
    const still = rows(30, { speedMps: 0 });
    const session = createSession({ clientTripId: uuid(9), startedAt: T0, origin: 'manual' });
    for (const r of still) appendRow(session, r, { unsafe: false, limitUsable: false, platform: 'ios' });
    session.pending = [];
    await createTripsRepo(db).insert({ client_trip_id: uuid(9), started_at: T0, tz: TZ, status: 'recording' }, T0);
    const h = build();
    h.source.setState({ capturing: true });
    await h.host.boot({ adopt: { session, detectors: createDetectors(() => 'x') } });
    clock = T0 + 31_000;
    expect(await h.host.end()).toEqual({ clientTripId: uuid(9), dropped: 'no_movement' });
    expect(h.host.snapshot().lastFinalized).toMatchObject({ ok: true, dropped: 'no_movement', durationS: null, miles: null });
    expect(await readDropNotice(db)).not.toBeNull();
    clock = T0 + 100_000;
    await drive(h, rows(20, { t0: T0 + 100_000, speedMps: 15 }));
    expect(await readDropNotice(db)).toBeNull();
    await h.host.stop({ endOpenTrip: true });
  });

  test('the Android notification’s End drive ends the drive at the tap; one from before the drive is ignored', async () => {
    const h = build();
    await h.host.boot();
    await drive(h, rows(60, { speedMps: 15 }));
    h.source.emit('notificationAction', { action: 'endDrive', ts: T0 - 1000 });
    await h.host.settled();
    expect(h.host.snapshot().status).toBe('recording');
    clock = T0 + 61_000;
    h.source.emit('notificationAction', { action: 'endDrive', ts: clock });
    await h.host.untilIdle();
    expect(h.host.snapshot().lastFinalized).toMatchObject({ ok: true, endCause: 'manual' });
    await h.host.stop({ endOpenTrip: false });
  });

  test('the Android notification’s End drive while a Start-card drive still waits is its Cancel: ended unsaved, Home says nothing', async () => {
    const h = build();
    await h.host.boot();
    await h.host.start();
    await feed(h, rows(30, { t0: T0 + 1000, speedMps: 0 }));
    expect(h.host.snapshot()).toMatchObject({ status: 'recording', waiting: { phase: 'waiting' } });
    h.source.emit('notificationAction', { action: 'endDrive', ts: clock });
    await h.host.untilIdle();
    expect(h.host.snapshot()).toMatchObject({ status: 'idle', waiting: null, lastFinalized: { ok: true, dropped: 'no_movement' } });
    expect(await tripCount()).toBe(0);
    expect(await readDropNotice(db)).toBeNull();
    expect(h.source.calls.at(-1)).toBe('stopCapture');
  });

  test('every native row first pumps the timers; a throwing pump is reported and the row still counts', async () => {
    let pumped = 0;
    const h = build({
      pump: () => {
        pumped += 1;
        if (pumped === 2) throw new Error('boom');
      },
    });
    await h.host.boot();
    await drive(h, rows(20, { speedMps: 15 }));
    expect(pumped).toBe(20);
    expect(h.errors.some((e) => e.startsWith('timers'))).toBe(true);
    expect(h.host.snapshot().lastRowTs).toBe(T0 + 19_000);
    await h.host.stop({ endOpenTrip: true });
  });

  test('boot adopts a rebuilt drive and keeps recording it (its budget comes back by trip id); a sign-out ends it', async () => {
    // 0.56 mi: long enough to keep (a Start-card drive under 0.5 mi and 2 min is not).
    const session = createSession({ clientTripId: uuid(9), startedAt: T0, origin: 'manual' });
    for (const r of rows(60, { speedMps: 15 })) appendRow(session, r, { unsafe: false, limitUsable: false, platform: 'ios' });
    session.pending = [];
    await createTripsRepo(db).insert({ client_trip_id: uuid(9), started_at: T0, tz: TZ, status: 'recording' }, T0);
    await createSamplesRepo(db).appendMany(uuid(9), rows(60, { speedMps: 15 }).map((r) => ({ ts: r.ts, row: r })));
    await createSettingsRepo(db).set(NOT_DRIVING_KEY, { clientTripId: uuid(9), spentMs: NOT_DRIVING_BUDGET_MS, expired: true, updatedAt: T0 });
    const h = build();
    h.source.setState({ capturing: true });
    await h.host.boot({ adopt: { session, detectors: createDetectors(() => 'x') } });
    expect(h.host.snapshot()).toMatchObject({ status: 'recording', clientTripId: uuid(9), notDrivingAvailable: false });
    // Android: nothing new reaches native at an adopt.
    expect(h.source.calls).toEqual([]);
    clock = T0 + 70_000;
    await h.host.suspendForSignOut();
    expect(h.host.snapshot().status).toBe('idle');
    expect((await createTripsRepo(db).get(uuid(9)))?.status).toBe('pending');
  });
});

// iOS: the native detector as a fake beside the fake capture.
function buildIos(over: Over = {}, opts: { appState?: string } = {}) {
  const source = createFakeDriveSense({ platform: 'ios', now: () => clock });
  // Native journals every row and emits it live; `lossy` drops the live copy (a row JS missed).
  const link = { lossy: false };
  const detect = createFakeDriveDetect({ now: () => clock, sense: { emit: (e, p) => (link.lossy ? undefined : source.emit(e, p as never)) } });
  // A JS end reaches native through stopCapture (two fakes, one phone).
  const stop = source.stopCapture.bind(source);
  source.stopCapture = async (end) => {
    await stop(end);
    detect.jsStop(end?.drivingEndedAt ?? clock);
  };
  const h = build({ source, detect: detect as DriveDetectApi, ...over });
  if (opts.appState) h.appState.set(opts.appState);
  return { ...h, source, detect, link };
}
type I = ReturnType<typeof buildIos>;
const journalRows = (list: readonly FeatureRow[]) => list.map((r) => ({ ...r }) as Record<string, unknown>);
const NATIVE = '11111111-1111-4111-8111-111111111111';

/** Native confirms a drive with these rows from its traced start; the host takes it in. */
/** Live journal rows, each reaching JS `lagMs` after its own time. */
async function feedIos(h: I, list: readonly FeatureRow[], lagMs = 0): Promise<void> {
  for (const r of list) {
    clock = r.ts + lagMs;
    h.detect.emitRows(journalRows([r]));
    await h.host.settled();
  }
}

async function confirm(h: I, list: readonly FeatureRow[], extra: Partial<Parameters<I['detect']['confirm']>[0]> = {}) {
  clock = list.at(-1)!.ts + 1000;
  h.detect.confirm({ driveId: NATIVE, startedAt: list[0]!.ts, startSource: 'trace', startLat: list[0]!.lat, startLng: list[0]!.lng, rows: journalRows(list), ...extra });
  await new Promise((r) => setTimeout(r, 0));
  await h.host.settled();
}

describe('a phone pickup (phone plan P4)', () => {
  /** A second of the phone in the hand. */
  const handled = { handlingScore: 0.9, gravityStability: 0.6 };
  /** 40 s of driving (the wait confirms on the 16th row; the rest are live), then `n` rows from T0 + 40 s, handled from `from` to `to`. */
  const pickupRows = (n: number, from = 0, to = n, t0 = T0 + 40_000) => rows(n, { t0, speedMps: 15, over: (i) => (i >= from && i < to ? handled : {}) });
  const phoneDecisions = (h: H) => h.player.delivered.filter((d) => d.kind === 'phone_pickup');

  test('with the driving screen showing (focused, RoadWise active) the pickup plays: the urgent tone, "Phone down", the haptic, shown and shaken; at 15 s in hand a repeat, tone and haptic only', async () => {
    const h = build({ voiceEnabled: () => true });
    await h.host.boot();
    h.host.setHudVisible(true);
    await drive(h, rows(40, { speedMps: 15 }));
    await feed(h, pickupRows(30, 0, 20));
    const [first, repeat, ...more] = phoneDecisions(h);
    expect(more).toEqual([]);
    expect(first).toMatchObject({ kind: 'phone_pickup', level: 3, voice: 'Phone down', intensity: 4, ts: T0 + 42_000 });
    expect(first!.suppressed).toBeUndefined();
    expect(repeat).toMatchObject({ kind: 'phone_pickup', level: 3, intensity: 4, ts: T0 + 54_000 });
    expect(repeat!.voice).toBeUndefined();
    expect(repeat!.suppressed).toBeUndefined();
    expect(h.host.snapshot().lastAlert).toMatchObject({ type: 'phone_pickup', tier: 'moderate', at: T0 + 42_000 });
    expect(h.host.snapshot().lastShake).toMatchObject({ at: T0 + 42_000, tier: 'moderate' });
    const id = h.host.snapshot().clientTripId!;
    await h.host.end();
    const pickups = (await createEventsRepo(db).listByTrip(id)).filter((e) => e.type === 'phone_pickup');
    expect(pickups).toEqual([expect.objectContaining({ started_at: T0 + 40_000, duration_s: 20, tier: 'severe' })]);
    expect((await createTripsRepo(db).get(id))!.phone_s).toBeGreaterThan(0);
  });

  test('a pickup alert still queued once the driving screen is gone (another screen, or RoadWise behind) is dropped unplayed', async () => {
    const h = build({ voiceEnabled: () => true });
    await h.host.boot();
    h.host.setHudVisible(true);
    await drive(h, rows(40, { speedMps: 15 }));
    await feed(h, pickupRows(20, 0, 5));
    const [first] = phoneDecisions(h);
    expect(first!.suppressed).toBeUndefined();
    expect(first!.stillWanted!()).toBe(true);
    h.host.setHudVisible(false);
    expect(first!.stillWanted!()).toBe(false);
    h.host.setHudVisible(true);
    h.appState.set('background');
    expect(first!.stillWanted!()).toBe(false);
    h.appState.set('active');
    expect(first!.stillWanted!()).toBe(true);
    await h.host.stop({ endOpenTrip: true });
  });

  test('RoadWise in front on another screen: nothing plays; the pickup still counts', async () => {
    const h = build();
    await h.host.boot();
    await drive(h, rows(40, { speedMps: 15 }));
    await feed(h, pickupRows(30, 0, 20));
    expect(phoneDecisions(h).length).toBe(2);
    expect(phoneDecisions(h).every((d) => d.suppressed === true)).toBe(true);
    // The other alerts keep their own rule: in front, they play.
    await feed(h, rows(30, { t0: T0 + 70_000, speedMps: 25 }));
    expect(h.player.delivered.filter((d) => d.kind === 'speeding').every((d) => d.suppressed !== true)).toBe(true);
    const id = h.host.snapshot().clientTripId!;
    await h.host.end();
    expect((await createEventsRepo(db).listByTrip(id)).map((e) => e.type)).toContain('phone_pickup');
  });

  test('on the driving screen a pickup alerts; behind, the next one is silent and never shown; back on the driving screen, the one after alerts again', async () => {
    const h = build({ voiceEnabled: () => true });
    await h.host.boot();
    h.host.setHudVisible(true);
    await drive(h, rows(40, { speedMps: 15 }));
    await feed(h, pickupRows(20, 0, 5));
    h.appState.set('background');
    await feed(h, pickupRows(20, 0, 5, T0 + 100_000));
    h.appState.set('active');
    expect(h.host.snapshot().lastAlert).toMatchObject({ type: 'phone_pickup', at: T0 + 42_000 });
    expect(h.host.snapshot().lastShake).toMatchObject({ at: T0 + 42_000 });
    await feed(h, pickupRows(20, 0, 5, T0 + 140_000));
    const [front, behind, again, ...more] = phoneDecisions(h);
    expect(more).toEqual([]);
    expect(front).toMatchObject({ ts: T0 + 42_000, voice: 'Phone down', intensity: 4 });
    expect(front!.suppressed).toBeUndefined();
    expect(behind).toMatchObject({ ts: T0 + 102_000, suppressed: true });
    expect(again).toMatchObject({ ts: T0 + 142_000, voice: 'Phone down', intensity: 4 });
    expect(again!.suppressed).toBeUndefined();
    expect(h.host.snapshot().lastAlert).toMatchObject({ type: 'phone_pickup', at: T0 + 142_000 });
    expect(h.host.snapshot().lastShake).toMatchObject({ at: T0 + 142_000 });
    const id = h.host.snapshot().clientTripId!;
    await h.host.end();
    const pickups = (await createEventsRepo(db).listByTrip(id)).filter((e) => e.type === 'phone_pickup');
    expect(pickups.map((e) => e.started_at)).toEqual([T0 + 40_000, T0 + 100_000, T0 + 140_000]);
  });

  test('RoadWise behind or locked: nothing plays and nothing is posted, and every pickup is still recorded with its time in hand', async () => {
    const h = build();
    await h.host.boot();
    h.host.setHudVisible(true);
    await drive(h, rows(40, { speedMps: 15 }));
    h.appState.set('background');
    await feed(h, pickupRows(60, 0, 20));
    // A second pickup after a put-down (11 s and more without a use row).
    await feed(h, pickupRows(20, 0, 5, T0 + 100_000));
    // Inactive (a call screen, the notification shade) counts as behind too.
    h.appState.set('inactive');
    await feed(h, pickupRows(20, 0, 5, T0 + 120_000));
    expect(phoneDecisions(h).length).toBe(4);
    expect(phoneDecisions(h).every((d) => d.suppressed === true)).toBe(true);
    const id = h.host.snapshot().clientTripId!;
    await h.host.end();
    const pickups = (await createEventsRepo(db).listByTrip(id)).filter((e) => e.type === 'phone_pickup');
    expect(pickups.map((e) => e.started_at)).toEqual([T0 + 40_000, T0 + 100_000, T0 + 120_000]);
    expect(pickups[0]).toMatchObject({ duration_s: 20, tier: 'severe' });
    expect((await createTripsRepo(db).get(id))!.phone_s).toBeGreaterThan(0);
  });

  test('with the driving screen showing, a pickup confirmed on a replayed row (a journal drained) plays nothing; a live one plays', async () => {
    const h = buildIos({ voiceEnabled: () => true });
    await h.host.boot();
    h.host.setHudVisible(true);
    await h.detect.setArmed(true, 'user-1');
    h.detect.wake();
    // Handled from the second row to the eighth: the pickup confirms (and is put down) in the journal.
    await confirm(h, rows(40, { speedMps: 15, over: (i) => (i >= 1 && i < 8 ? handled : {}) }));
    const [replayed, ...rest] = phoneDecisions(h);
    expect(rest).toEqual([]);
    expect(replayed!.ts).toBeLessThan(T0 + 15_000);
    expect(replayed!.suppressed).toBe(true);
    // Nor is it shown or shaken: the driving screen never flashes or shakes for old news.
    expect(h.host.snapshot()).toMatchObject({ lastAlert: null, lastShake: null });
    // Picked up again on live rows: it plays, shows and shakes.
    await feedIos(h, pickupRows(30, 0, 5));
    const live = phoneDecisions(h).slice(1);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ ts: T0 + 42_000, voice: 'Phone down' });
    expect(live[0]!.suppressed).toBeUndefined();
    expect(h.host.snapshot()).toMatchObject({ lastAlert: { type: 'phone_pickup', at: T0 + 42_000 }, lastShake: { at: T0 + 42_000 } });
    const id = h.host.snapshot().clientTripId!;
    await h.host.end();
    // Both still count.
    expect((await createEventsRepo(db).listByTrip(id)).filter((e) => e.type === 'phone_pickup')).toHaveLength(2);
  });

  test('on an iPhone a handled phone during a call is never a pickup; on Android it is', async () => {
    for (const [platform, count] of [
      ['ios', 0],
      ['android', 1],
    ] as const) {
      // Each drive taps Start at T0, as its rows begin.
      clock = T0;
      const h = build({ platform });
      await h.host.boot();
      await drive(h, rows(40, { speedMps: 15 }));
      await feed(h, rows(30, { t0: T0 + 40_000, speedMps: 15, over: (i) => (i < 20 ? { ...handled, call: 'live' as const } : {}) }));
      const id = h.host.snapshot().clientTripId!;
      await h.host.end();
      expect((await createEventsRepo(db).listByTrip(id)).filter((e) => e.type === 'phone_pickup')).toHaveLength(count);
    }
  });
});

describe('"Not driving?"', () => {
  test('the budget counts only with the driving screen focused and RoadWise active, on the row clock; spent, it is gone and the row says so', async () => {
    const h = build();
    await h.host.boot();
    await drive(h, rows(20, { speedMps: 15 }));
    // Not focused: nothing counts.
    await feed(h, rows(30, { t0: T0 + 20_000, speedMps: 15 }));
    expect(h.host.snapshot().notDrivingSpentMs).toBe(0);
    h.host.setHudVisible(true);
    await feed(h, rows(60, { t0: T0 + 50_000, speedMps: 15 }));
    expect(h.host.snapshot().notDrivingSpentMs).toBe(60_000);
    // Behind: nothing counts.
    h.appState.set('background');
    await feed(h, rows(30, { t0: T0 + 110_000, speedMps: 15 }));
    expect(h.host.snapshot().notDrivingSpentMs).toBe(60_000);
    h.appState.set('active');
    expect((await readBudget(db))?.spentMs).toBe(60_000);
    await feed(h, rows(70, { t0: T0 + 140_000, speedMps: 15 }));
    const s = h.host.snapshot();
    expect(s).toMatchObject({ notDrivingAvailable: false, notDrivingSpentMs: NOT_DRIVING_BUDGET_MS });
    await h.host.settled();
    expect((await createTripsRepo(db).get(uuid(1)))?.not_driving_expired).toBe(1);
    expect(h.display.log).toContain('refresh nohint -');
    expect(await h.host.cancelDrive()).toBe(false);
    clock = T0 + 211_000;
    await h.host.end();
    expect((await createQueueRepo(db).byKey(`trip:${uuid(1)}`))?.payload_json).toContain('"notDrivingExpired":true');
    await h.host.stop({ endOpenTrip: false });
  });

  test('cancels the drive: the trip, its samples and events go, nothing is queued or told; the capture stops', async () => {
    const h = build();
    await h.host.boot();
    await drive(h, rows(60, { speedMps: 25 }));
    expect(await createSamplesRepo(db).count(uuid(1))).toBeGreaterThan(0);
    expect(await h.host.cancelDrive()).toBe(true);
    expect(h.host.snapshot()).toMatchObject({ status: 'idle', lastFinalized: { clientTripId: uuid(1), ok: true, dropped: 'cancelled', status: null } });
    expect(await createTripsRepo(db).get(uuid(1))).toBeNull();
    expect(await createSamplesRepo(db).count(uuid(1))).toBe(0);
    expect(await createEventsRepo(db).listByTrip(uuid(1))).toEqual([]);
    expect(await createQueueRepo(db).countByStatus('pending')).toBe(0);
    expect(await readDropNotice(db)).toBeNull();
    expect(h.source.calls.at(-1)).toBe('stopCapture');
    expect(h.display.log.at(-1)).toBe('end');
    expect(await createSettingsRepo(db).get(CANCEL_KEY)).toBeNull();
    // Nothing to cancel any more.
    expect(await h.host.cancelDrive()).toBe(false);
  });

  test('Android: a trip that cannot be deleted still stops the capture; the marker stays for the next launch', async () => {
    let failWrites = false;
    const failing: Db = {
      ...db,
      transaction: ((fn: never) => (failWrites ? Promise.reject(new Error('disk full')) : db.transaction(fn))) as Db['transaction'],
    } as Db;
    const h = build({ db: failing });
    await h.host.boot();
    await drive(h, rows(60, { speedMps: 25 }));
    failWrites = true;
    expect(await h.host.cancelDrive()).toBe(true);
    expect(h.source.calls.at(-1)).toBe('stopCapture');
    expect(h.host.snapshot().status).toBe('idle');
    expect(await createSettingsRepo(db).get(CANCEL_KEY)).toEqual({ clientTripId: uuid(1), driveId: null });
    failWrites = false;
    expect(await finishPendingCancel(db, null)).toBe(uuid(1));
    expect(await createTripsRepo(db).get(uuid(1))).toBeNull();
  });
});

describe('every drive is a drive of its own', () => {
  test('stopped 6 min and on again 100 m on, 30 s after the end: a new trip; the one before stays as it ended, its upload due at once', async () => {
    const h = build();
    await h.host.boot();
    const first = rows(120, { speedMps: 15 });
    await drive(h, first);
    // Parked: the still end at 5 min.
    const end = first.at(-1)!;
    const parked = rows(301, { t0: T0 + 120_000, speedMps: 0 }).map((r) => ({ ...r, lng: end.lng }));
    await feed(h, parked);
    await h.host.untilIdle();
    const before = (await createTripsRepo(db).get(uuid(1)))!;
    expect(before.status).toBe('pending');
    const upload = (await createQueueRepo(db).byKey(`trip:${uuid(1)}`))!;
    expect(upload.next_attempt_at).toBe(before.finalized_at);
    // A new Start 30 s later, 100 m on: confirmed, it is a trip of its own.
    const t1 = T0 + 451_000;
    clock = t1;
    const again = rows(60, { t0: t1, speedMps: 15 }).map((r, i) => ({ ...r, lat: START.lat, lng: before.end_lng! + (100 + i * 15) / M_PER_DEG_LNG }));
    await drive(h, again);
    const second = h.host.snapshot().clientTripId!;
    expect(second).not.toBe(uuid(1));
    expect(h.host.snapshot()).toMatchObject({ status: 'recording', clientTripId: second });
    expect(await createTripsRepo(db).get(uuid(1))).toMatchObject({ status: 'pending', ended_at: before.ended_at });
    expect(await createQueueRepo(db).byKey(`trip:${uuid(1)}`)).toMatchObject({ id: upload.id, next_attempt_at: upload.next_attempt_at });
    clock = t1 + 61_000;
    await h.host.end();
    expect(await tripCount()).toBe(2);
    expect(await createTripsRepo(db).get(second)).toMatchObject({ status: 'pending', started_at: t1 });
    await h.host.stop({ endOpenTrip: false });
  });
});

describe('the weather at the car', () => {
  const rain: DangerAlert = { kind: 'heavy_rain', gustMph: null, visibilityM: null };
  const blizzard: DangerAlert = { kind: 'blizzard', gustMph: 50, visibilityM: 100 };

  test('reaches the state and the lock screen at once; dismissed it stays hidden (a more severe kind shows again); the end clears it', async () => {
    const answers: (DangerAlert | null)[] = [rain, blizzard];
    const h = build({ weather: async () => answers.shift() ?? null });
    await h.host.boot();
    await drive(h, rows(20, { speedMps: 15 }));
    await new Promise((r) => setTimeout(r, 0));
    expect(h.host.snapshot()).toMatchObject({ weather: { kind: 'heavy_rain', text: 'Heavy rain' }, weatherAlert: rain });
    expect(h.display.log).toContain('refresh hint heavy_rain');
    h.host.dismissWeather();
    expect(h.host.snapshot()).toMatchObject({ weather: null, weatherAlert: null });
    expect(h.display.log.at(-1)).toBe('refresh hint -');
    // 15 min later the next check finds a blizzard: more severe, it shows again.
    await feed(h, rows(2, { t0: T0 + 20_000 + 15 * 60_000, speedMps: 15 }));
    await new Promise((r) => setTimeout(r, 0));
    expect(h.host.snapshot().weather).toEqual({ kind: 'blizzard', text: 'Blizzard' });
    await h.host.end();
    expect(h.host.snapshot().weather).toBeNull();
    await h.host.stop({ endOpenTrip: false });
  });
});

describe('the spot nudge', () => {
  const spotAhead = (): WatchSpot => ({ id: 'speeding:e1', kind: 'speeding', lat: START.lat, lng: START.lng + 600 / M_PER_DEG_LNG, headingDeg: 90 });

  test('published as the car comes up to a spot with RoadWise in front; never behind', async () => {
    const front = build({ spots: { readWatchSpots: async () => [spotAhead()] }, limits: fakeLimits(80 * 0.44704) });
    await front.host.boot();
    await drive(front, rows(40, { speedMps: 15 }));
    expect(front.host.snapshot().spotNudge).toMatchObject({ spotId: 'speeding:e1', kind: 'speeding' });
    await front.host.stop({ endOpenTrip: true });

    const behind = build({ spots: { readWatchSpots: async () => [spotAhead()] }, limits: fakeLimits(80 * 0.44704) });
    await behind.host.boot();
    await behind.host.start();
    behind.appState.set('background');
    await feed(behind, rows(40, { speedMps: 15 }));
    expect(behind.host.snapshot().spotNudge).toBeNull();
    await behind.host.stop({ endOpenTrip: true });
  });
});

describe('iOS: the drive detector', () => {
  test('Start: native opens a journaled drive at the tap and the host takes it in at once (no capture of ours, the Live Activity from the tap); a touch moves native’s wait on; Cancel ends it unsaved and its journal goes', async () => {
    const h = buildIos();
    await h.host.boot();
    expect(await h.host.start()).toEqual({ ok: true, waiting: true });
    expect(h.source.calls).not.toContain('startCapture:mounted');
    expect(h.detect.calls).toContain('startWaiting');
    const id = h.host.snapshot().clientTripId!;
    expect(h.host.snapshot()).toMatchObject({ status: 'recording', origin: 'manual', startedAt: T0, waiting: { since: T0, phase: 'waiting' } });
    expect(h.detect.snapshot).toMatchObject({ state: 'recording', origin: 'manual', driveId: id, waitUntil: T0 + WAIT_TOTAL_MS });
    expect(await createTripsRepo(db).get(id)).toMatchObject({ status: 'recording', origin: 'manual', start_source: 'wake', started_at: T0 });
    expect(await createSettingsRepo(db).get(JOURNAL_LINK_KEY)).toEqual({ driveId: id, clientTripId: id });
    expect(h.host.captureActive()).toBe(true);
    expect(h.display.log[0]).toMatch(/^start /);
    clock = T0 + 60_000;
    h.host.touchWaiting();
    await h.host.settled();
    expect(h.detect.calls).toContain('extendWaiting');
    expect(h.detect.snapshot.waitUntil).toBe(T0 + 60_000 + WAIT_TOTAL_MS);
    // Native's rows reach the drive live: the sign is the drive's own (the Live Activity's), while it waits.
    await feedIos(h, rows(5, { t0: T0 + 61_000, speedMps: 0 }));
    expect(h.host.snapshot()).toMatchObject({ limitMph: 35, lastRowTs: T0 + 65_000, waiting: { since: T0 + 60_000 } });
    expect(h.display.states.at(-1)).toMatchObject({ limit: 35 });
    await h.host.cancelWaiting();
    expect(h.host.snapshot()).toMatchObject({ status: 'idle', waiting: null, lastFinalized: { clientTripId: id, ok: true, dropped: 'no_movement' } });
    expect(h.source.calls).toContain('stopCapture');
    expect(h.detect.snapshot.state).not.toBe('recording');
    expect(h.detect.journal.has(id)).toBe(false);
    expect(h.display.log.at(-1)).toBe('end');
    expect(await tripCount()).toBe(0);
    expect(await readDropNotice(db)).toBeNull();
    await h.host.stop({ endOpenTrip: true });
  });

  test('Start while native already records (an automatic drive JS has not taken in yet) is refused as busy; while one records here too', async () => {
    const h = buildIos();
    await h.host.boot();
    await h.detect.setArmed(true, 'user-1');
    h.detect.wake();
    h.detect.confirm({ driveId: NATIVE, startedAt: T0 });
    expect(await h.host.start()).toEqual({ ok: false, reason: 'busy' });
    await new Promise((r) => setTimeout(r, 0));
    await h.host.settled();
    expect(h.host.snapshot()).toMatchObject({ status: 'recording', clientTripId: NATIVE, origin: 'auto', waiting: null });
    expect(await h.host.start()).toEqual({ ok: false, reason: 'busy' });
    await h.host.stop({ endOpenTrip: false });
  });

  test('iOS: every state published from the tap is the drive, waiting until driving speed, never idle (a publish from elsewhere meanwhile too)', async () => {
    const h = buildIos();
    await h.host.boot();
    const seen = recordStates(h.host);
    await h.host.start();
    h.appState.set('background');
    h.appState.set('active');
    await feedIos(h, rows(16, { speedMps: 15 }).map((r, i) => ({ ...r, lng: START.lng + (i * 15) / M_PER_DEG_LNG })));
    expect(h.host.snapshot()).toMatchObject({ status: 'recording', origin: 'manual', waiting: null });
    onScreenFromTap(seen);
    await h.host.stop({ endOpenTrip: false });
  });

  test('a waiting drive’s still end waits for its wait (the touches): parked past 5 min after a touch, it records on; at its deadline it ends unsaved', async () => {
    const h = buildIos();
    await h.host.boot();
    await h.host.start();
    const touched = T0 + 240_000;
    clock = touched;
    h.host.touchWaiting();
    await feedIos(h, rows(200, { t0: T0 + 241_000, speedMps: 0 }));
    h.scheduler.fire();
    await h.host.settled();
    expect(h.host.snapshot()).toMatchObject({ status: 'recording', waiting: { since: touched } });
    clock = touched + WAIT_TOTAL_MS;
    h.scheduler.fire();
    await h.host.settled();
    expect(h.host.snapshot()).toMatchObject({ status: 'idle', waiting: null, lastFinalized: { dropped: 'no_movement' } });
    expect(await readDropNotice(db)).toBeNull();
    await h.host.stop({ endOpenTrip: false });
  });

  test('a confirmed drive is adopted from the journal: native’s id, its traced start, every row once; live rows follow in order (a gap filled, a repeat dropped)', async () => {
    const h = buildIos();
    await h.host.boot();
    await h.detect.setArmed(true, 'user-1');
    h.detect.wake();
    const list = rows(40, { speedMps: 15 });
    await confirm(h, list);
    expect(h.host.snapshot()).toMatchObject({ status: 'recording', clientTripId: NATIVE, origin: 'auto', startedAt: T0, waiting: null, lastRowTs: T0 + 39_000 });
    expect(h.source.calls).not.toContain('startCapture:mounted');
    expect(h.host.captureActive()).toBe(true);
    // A gap: seq 41 and 42 never reached JS live (journaled only); 43 arrives and the gap is read from the journal first.
    const next = rows(3, { t0: T0 + 40_000, speedMps: 15 });
    h.link.lossy = true;
    h.detect.emitRows(journalRows(next.slice(0, 2)));
    h.link.lossy = false;
    clock = T0 + 43_000;
    h.detect.emitRows(journalRows(next.slice(2)));
    await h.host.settled();
    expect(h.detect.calls).toContain(`readRows:${NATIVE}:40:300`);
    expect(h.host.snapshot().lastRowTs).toBe(T0 + 42_000);
    // A repeat (seq 43 again, or an older one) is dropped.
    h.source.emit('row', { ...next[2]!, seq: 43, ts: T0 + 50_000 } as never);
    h.source.emit('row', { ...next[0]!, seq: 3, ts: T0 + 51_000 } as never);
    await h.host.settled();
    expect(h.host.snapshot().lastRowTs).toBe(T0 + 42_000);
    // The checkpoint keeps the journal's place on the trip; the stored rows carry no `seq`.
    expect((await db.execute('SELECT last_seq FROM trips')).rows).toEqual([{ last_seq: 30 }]);
    const stored = (await db.execute('SELECT row_json FROM samples')).rows.map((r) => JSON.parse(String(r.row_json)) as Record<string, unknown>);
    expect(stored.length).toBe(30);
    expect(stored.some((r) => 'seq' in r)).toBe(false);
    await h.host.stop({ endOpenTrip: false });
  });

  test('the alerts on a journal drained as a drive is taken in (old news) neither sound nor show nor shake; live rows after them sound', async () => {
    const h = buildIos();
    await h.host.boot();
    h.host.setHudVisible(true);
    await h.detect.setArmed(true, 'user-1');
    h.detect.wake();
    // 56 mph on a 35: speeding from the journal's rows on.
    await confirm(h, rows(40, { speedMps: 25 }));
    const replayed = h.player.delivered.filter((d) => d.kind === 'speeding');
    expect(replayed.length).toBeGreaterThan(0);
    expect(replayed.every((d) => d.suppressed === true)).toBe(true);
    expect(h.host.snapshot()).toMatchObject({ speedingOver: true, lastAlert: null, lastShake: null });
    await feedIos(h, rows(20, { t0: T0 + 40_000, speedMps: 25 }));
    const live = h.player.delivered.filter((d) => d.kind === 'speeding').slice(replayed.length);
    expect(live.some((d) => d.suppressed !== true)).toBe(true);
    await h.host.stop({ endOpenTrip: false });
  });

  test('journal rows go only to the native drive they belong to: with a recovered drive open (no journal of its own), a native drive’s rows are never added to it', async () => {
    const session = createSession({ clientTripId: uuid(9), startedAt: T0, origin: 'manual' });
    const own = rows(30, { speedMps: 15 });
    for (const r of own) appendRow(session, r, { unsafe: false, limitUsable: false, platform: 'ios' });
    session.pending = [];
    await createTripsRepo(db).insert({ client_trip_id: uuid(9), started_at: T0, tz: TZ, status: 'recording' }, T0);
    await createSamplesRepo(db).appendMany(uuid(9), own.map((r) => ({ ts: r.ts, row: r })));
    const h = buildIos();
    await h.host.boot({ adopt: { session, detectors: createDetectors(() => 'x') } });
    expect(h.host.snapshot()).toMatchObject({ status: 'recording', clientTripId: uuid(9) });
    const before = h.host.snapshot().lastRowTs;
    // Native confirms a drive of its own meanwhile: refused (one is open), and its rows stay out.
    await h.detect.setArmed(true, 'user-1');
    h.detect.wake();
    await confirm(h, rows(40, { t0: T0 + 60_000, speedMps: 15 }));
    h.detect.emitRows(journalRows(rows(5, { t0: T0 + 100_000, speedMps: 15 })));
    await h.host.settled();
    expect(h.host.snapshot()).toMatchObject({ clientTripId: uuid(9), lastRowTs: before });
    expect(await createSamplesRepo(db).count(uuid(9))).toBe(30);
    expect(h.errors).toContain('driveStarted: a native drive started while another is open');
    await h.host.stop({ endOpenTrip: false });
  });

  test('an automatic drive that is not kept leaves a notice marked automatic (Home says nothing); a Start-card one is marked manual', async () => {
    const h = buildIos();
    await h.host.boot();
    await h.detect.setArmed(true, 'user-1');
    h.detect.wake();
    // Never above walking pace: not driven.
    await confirm(h, rows(40, { speedMps: 0.5 }));
    clock = T0 + 45_000;
    h.detect.endFor('walking', T0 + 45_000);
    await new Promise((r) => setTimeout(r, 0));
    await h.host.untilIdle();
    expect(h.host.snapshot().lastFinalized).toMatchObject({ ok: true, dropped: expect.any(String) });
    const auto = (await readDropNotice(db))!;
    expect(auto).toMatchObject({ clientTripId: NATIVE, origin: 'auto' });
    expect(isManualDrop(auto)).toBe(false);
    await h.host.stop({ endOpenTrip: false });

    const still = rows(30, { speedMps: 0 });
    const session = createSession({ clientTripId: uuid(9), startedAt: T0, origin: 'manual' });
    for (const r of still) appendRow(session, r, { unsafe: false, limitUsable: false, platform: 'ios' });
    session.pending = [];
    await createTripsRepo(db).insert({ client_trip_id: uuid(9), started_at: T0, tz: TZ, status: 'recording' }, T0);
    const m = build();
    m.source.setState({ capturing: true });
    await m.host.boot({ adopt: { session, detectors: createDetectors(() => 'x') } });
    clock = T0 + 31_000;
    await m.host.end();
    expect(await readDropNotice(db)).toMatchObject({ clientTripId: uuid(9), origin: 'manual' });
  });

  test('native stops on its own: the drive ends where the car last moved, is stored, and its journal is deleted; no stopCapture', async () => {
    const h = buildIos();
    await h.host.boot();
    h.detect.setPermissions({});
    await h.detect.setArmed(true, 'user-1');
    h.detect.wake();
    const list = [...rows(60, { speedMps: 15 }), ...rows(30, { t0: T0 + 60_000, speedMps: 0 }).map((r) => ({ ...r, lng: START.lng + (59 * 15) / M_PER_DEG_LNG }))];
    await confirm(h, list);
    expect(h.host.snapshot()).toMatchObject({ status: 'recording', origin: 'auto' });
    const callsBefore = h.source.calls.length;
    clock = T0 + 95_000;
    h.detect.endFor('walking', T0 + 95_000);
    await new Promise((r) => setTimeout(r, 0));
    await h.host.untilIdle();
    await h.host.settled();
    expect(h.host.snapshot().lastFinalized).toMatchObject({ clientTripId: NATIVE, ok: true, endCause: 'walking' });
    expect((await createTripsRepo(db).get(NATIVE))).toMatchObject({ status: 'pending', origin: 'auto', ended_at: T0 + 60_000 });
    expect(h.source.calls.slice(callsBefore)).not.toContain('stopCapture');
    expect(h.detect.calls).toContain(`discardDrive:${NATIVE}`);
    expect(h.detect.journal.has(NATIVE)).toBe(false);
    await h.host.stop({ endOpenTrip: false });
  });

  test('End: the engine’s end goes to native through stopCapture (the cut), then the journal is deleted', async () => {
    const h = buildIos();
    await h.host.boot();
    await h.detect.setArmed(true, 'user-1');
    h.detect.wake();
    await confirm(h, rows(60, { speedMps: 15 }));
    clock = T0 + 61_000;
    await h.host.end();
    await h.host.settled();
    expect(h.source.calls).toContain('stopCapture');
    expect(h.detect.calls).toContain(`discardDrive:${NATIVE}`);
    expect(h.detect.journal.has(NATIVE)).toBe(false);
    await h.host.stop({ endOpenTrip: false });
  });

  test('"Not driving?" tells native before the trip goes; a trip that cannot be deleted never leaves native recording, and the next launch deletes it', async () => {
    let failWrites = false;
    const failing: Db = {
      ...db,
      transaction: ((fn: never) => (failWrites ? Promise.reject(new Error('disk full')) : db.transaction(fn))) as Db['transaction'],
    } as Db;
    const h = buildIos({ db: failing });
    const tripWhenTold: unknown[] = [];
    const told = h.detect.notDriving.bind(h.detect);
    h.detect.notDriving = async () => {
      tripWhenTold.push(await createTripsRepo(db).get(NATIVE));
      expect(await createSettingsRepo(db).get(CANCEL_KEY)).toEqual({ clientTripId: NATIVE, driveId: NATIVE });
      return told();
    };
    await h.host.boot();
    await h.detect.setArmed(true, 'user-1');
    h.detect.wake();
    await confirm(h, rows(60, { speedMps: 15 }));
    failWrites = true;
    expect(await h.host.cancelDrive()).toBe(true);
    await h.host.settled();
    // Native was told first (the trip still there), and rests: nothing more records.
    expect(tripWhenTold).toEqual([expect.objectContaining({ client_trip_id: NATIVE })]);
    expect(h.detect.snapshot.state).toBe('suppressed');
    expect(h.detect.journal.has(NATIVE)).toBe(false);
    expect(h.host.snapshot()).toMatchObject({ status: 'idle', lastFinalized: { dropped: 'cancelled' } });
    // The trip could not go: the marker stays, and the next launch finishes the cancel.
    expect(await createTripsRepo(db).get(NATIVE)).not.toBeNull();
    failWrites = false;
    await h.host.stop({ endOpenTrip: false });
    expect(await finishPendingCancel(db, h.detect)).toBe(NATIVE);
    expect(await createTripsRepo(db).get(NATIVE)).toBeNull();
    expect(await createSettingsRepo(db).get(CANCEL_KEY)).toBeNull();
    expect(await finishPendingCancel(db, h.detect)).toBeNull();
  });

  test('killed between the marker and native: the next launch cancels native’s drive and deletes the trip', async () => {
    const h = buildIos();
    await h.host.boot();
    await h.detect.setArmed(true, 'user-1');
    h.detect.wake();
    await confirm(h, rows(60, { speedMps: 15 }));
    await h.host.stop({ endOpenTrip: false });
    // The process died right after writing the marker: native still records, the trip is stored.
    await createSettingsRepo(db).set(CANCEL_KEY, { clientTripId: NATIVE, driveId: NATIVE });
    expect(h.detect.snapshot).toMatchObject({ state: 'recording', driveId: NATIVE });
    expect(await finishPendingCancel(db, h.detect)).toBe(NATIVE);
    expect(h.detect.snapshot.state).toBe('suppressed');
    expect(h.detect.journal.has(NATIVE)).toBe(false);
    expect(await createTripsRepo(db).get(NATIVE)).toBeNull();
    // A fresh host finds nothing to take in.
    const next = buildIos({ detect: h.detect as DriveDetectApi, source: h.source });
    await next.host.boot();
    await next.host.settled();
    expect(next.host.snapshot().status).toBe('idle');
    expect(await tripCount()).toBe(0);
    await next.host.stop({ endOpenTrip: false });
  });

  test('"Not driving?" tells native (it discards and rests); the trip goes; no stopCapture', async () => {
    const h = buildIos();
    await h.host.boot();
    await h.detect.setArmed(true, 'user-1');
    h.detect.wake();
    await confirm(h, rows(60, { speedMps: 15 }));
    expect(await h.host.cancelDrive()).toBe(true);
    await h.host.settled();
    expect(h.detect.calls).toContain('notDriving');
    expect(h.source.calls).not.toContain('stopCapture');
    expect(await createTripsRepo(db).get(NATIVE)).toBeNull();
    expect(await createSettingsRepo(db).get(JOURNAL_LINK_KEY)).toBeNull();
    await h.host.stop({ endOpenTrip: false });
  });

  test('boot: a drive native ended while JS was away is stored from the journal and the journal deleted; a live one is adopted and keeps recording', async () => {
    const pre = buildIos();
    // A first process: native records and ends a drive, then a second one is still recording, with no JS.
    await pre.detect.setArmed(true, 'user-1');
    pre.detect.wake();
    const ended = [...rows(60, { speedMps: 15 }), ...rows(30, { t0: T0 + 60_000, speedMps: 0 }).map((r) => ({ ...r, lng: START.lng + (59 * 15) / M_PER_DEG_LNG }))];
    clock = T0 + 91_000;
    pre.detect.confirm({ driveId: uuid(70), startedAt: T0, rows: journalRows(ended) });
    pre.detect.endFor('still', T0 + 91_000);
    pre.detect.wake();
    const live = rows(40, { t0: T0 + 1_000_000, speedMps: 15 });
    clock = T0 + 1_041_000;
    pre.detect.confirm({ driveId: uuid(71), startedAt: T0 + 1_000_000, rows: journalRows(live) });

    const h = buildIos({ detect: pre.detect as DriveDetectApi, source: pre.source }, { appState: 'background' });
    h.detect.calls.length = 0;
    const pushed: PushToStartRequest[] = [];
    const host = createDriveHost({
      db,
      source: pre.source,
      detect: pre.detect,
      limits: fakeLimits(),
      player: fakePlayer(),
      display: h.display,
      now: () => clock,
      tz: () => TZ,
      newId: () => uuid((ids += 1)),
      appVersion: '2.0.0',
      scheduler: manualScheduler(),
      appState: h.appState,
      weather: async () => null,
      spots: { readWatchSpots: async () => [] },
      pushToStart: async (req) => {
        pushed.push(req);
        return true;
      },
    });
    await host.boot();
    await host.settled();
    expect(await createTripsRepo(db).get(uuid(70))).toMatchObject({ status: 'pending', ended_at: T0 + 60_000 });
    expect(pre.detect.journal.has(uuid(70))).toBe(false);
    expect(host.snapshot()).toMatchObject({ status: 'recording', clientTripId: uuid(71), origin: 'auto', lastRowTs: T0 + 1_039_000 });
    expect(host.captureActive()).toBe(true);
    // Behind: the server is asked to push-start the Live Activity, once; nothing started locally.
    await new Promise((r) => setTimeout(r, 0));
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({ clientTripId: uuid(71), startedAt: T0 + 1_000_000, state: { unit: 'mph', weatherKind: null } });
    // Pushed once the journal is in: the drive's own speed and limit (34 mph on a 35), never a made-up 0 or a blank.
    expect(pushed[0]!.state).toMatchObject({ speed: 34, limit: 35 });
    expect(h.display.log.filter((l) => l.startsWith('start'))).toEqual([]);
    // Back in front: the Live Activity is adopted (or started) here.
    h.appState.set('active');
    await host.settled();
    expect(h.display.log.some((l) => l.startsWith('start'))).toBe(true);
    await host.stop({ endOpenTrip: false });
  });

  test('signed out, native drives are refused (no trip, native left alone) and kept: the same driver signing in again takes them in', async () => {
    const h = buildIos({ signedOut: true });
    await h.host.boot();
    await h.detect.setArmed(true, 'user-1');
    // Ended while signed out (taken in nowhere), then a live one.
    h.detect.wake();
    const parkedLng = START.lng + (59 * 15) / M_PER_DEG_LNG;
    const ended = [...rows(60, { speedMps: 15 }), ...rows(30, { t0: T0 + 60_000, speedMps: 0 }).map((r) => ({ ...r, lng: parkedLng }))];
    await confirm(h, ended, { driveId: uuid(60) });
    expect(h.host.snapshot().status).toBe('idle');
    clock = T0 + 95_000;
    h.detect.endFor('still', T0 + 95_000);
    await new Promise((r) => setTimeout(r, 0));
    await h.host.settled();
    h.detect.wake();
    await confirm(h, rows(30, { t0: T0 + 2_000_000, speedMps: 15 }), { driveId: uuid(61) });
    expect(h.host.snapshot()).toMatchObject({ status: 'idle', clientTripId: null });
    expect(await tripCount()).toBe(0);
    expect(h.host.captureActive()).toBe(false);
    expect(h.source.calls).not.toContain('stopCapture');
    expect(h.detect.calls.filter((c) => c.startsWith('discardDrive') || c === 'notDriving')).toEqual([]);
    expect([...h.detect.journal.keys()].sort()).toEqual([uuid(60), uuid(61)]);
    // The same driver signs in again: the ended drive is stored, the live one adopted.
    await h.host.signedInAgain();
    await h.host.settled();
    expect(await createTripsRepo(db).get(uuid(60))).toMatchObject({ status: 'pending' });
    expect(h.host.snapshot()).toMatchObject({ status: 'recording', clientTripId: uuid(61) });
    expect(h.host.captureActive()).toBe(true);
    await h.host.stop({ endOpenTrip: false });
  });

  test('a host launched signed out leaves native’s journals for the next sign-in, and refuses a drive that starts meanwhile', async () => {
    const pre = buildIos();
    await pre.detect.setArmed(true, 'user-1');
    pre.detect.wake();
    clock = T0 + 41_000;
    pre.detect.confirm({ driveId: uuid(62), startedAt: T0, rows: journalRows(rows(40, { speedMps: 15 })) });
    const h = buildIos({ detect: pre.detect as DriveDetectApi, source: pre.source, signedOut: true });
    h.source.setState({ capturing: true });
    await h.host.boot();
    await h.host.settled();
    expect(h.host.snapshot().status).toBe('idle');
    expect(await tripCount()).toBe(0);
    // Native's capture is not ours to stop while signed out.
    expect(h.source.calls).not.toContain('stopCapture');
    expect(await h.host.start()).toEqual({ ok: false, reason: 'error' });
    await h.host.resumeAfterSignIn();
    await h.host.settled();
    expect(h.host.snapshot()).toMatchObject({ status: 'recording', clientTripId: uuid(62), lastRowTs: T0 + 39_000 });
    await h.host.stop({ endOpenTrip: false });
  });

  /** A first process: native records and ends these drives with no JS (each `rows` from its traced start, then parked). */
  function journaledWithoutJs(drives: { id: string; t0: number; moving: number }[]): I {
    const pre = buildIos();
    void pre.detect.setArmed(true, 'user-1');
    for (const d of drives) {
      pre.detect.wake();
      const moving = rows(d.moving, { t0: d.t0, speedMps: 15 });
      const parked = rows(30, { t0: d.t0 + d.moving * 1000, speedMps: 0 }).map((r) => ({ ...r, lng: moving.at(-1)!.lng }));
      clock = d.t0 + (d.moving + 30) * 1000;
      pre.detect.confirm({ driveId: d.id, startedAt: d.t0, rows: journalRows([...moving, ...parked]) });
      pre.detect.endFor('still', clock);
    }
    return pre;
  }

  test('boot: an ended journal longer than the per-launch replay budget, and a second one in the same launch, are both read to their end and stored whole', async () => {
    const pre = journaledWithoutJs([
      { id: uuid(90), t0: T0, moving: MAX_JOURNAL_REPLAY_ROWS + 300 },
      { id: uuid(91), t0: T0 + 5_000_000, moving: 120 },
    ]);
    const h = buildIos({ detect: pre.detect as DriveDetectApi, source: pre.source });
    await h.host.boot();
    await h.host.settled();
    const long = (await createTripsRepo(db).get(uuid(90)))!;
    expect(long).toMatchObject({ status: 'pending', ended_at: T0 + (MAX_JOURNAL_REPLAY_ROWS + 300) * 1000 });
    expect(long.miles).toBeCloseTo(((MAX_JOURNAL_REPLAY_ROWS + 299) * 15) / 1609.344, 1);
    expect(await createTripsRepo(db).get(uuid(91))).toMatchObject({ status: 'pending', ended_at: T0 + 5_000_000 + 120_000 });
    expect(pre.detect.journal.size).toBe(0);
    expect(await readDropNotice(db)).toBeNull();
    await h.host.stop({ endOpenTrip: false });
  });

  test('boot: an ended journal that cannot be read to its end is never finalized or deleted: stored as far as read, it is finished at the next launch', async () => {
    const pre = journaledWithoutJs([{ id: uuid(92), t0: T0, moving: 900 }]);
    const readRows = pre.detect.readRows.bind(pre.detect);
    let failAt: number | null = 600;
    pre.detect.readRows = (id, after, limit) => (failAt !== null && after >= failAt ? Promise.reject(new Error('io')) : readRows(id, after, limit));
    const first = buildIos({ detect: pre.detect as DriveDetectApi, source: pre.source });
    await first.host.boot();
    await first.host.settled();
    expect(first.host.snapshot().status).toBe('idle');
    expect(await createTripsRepo(db).get(uuid(92))).toMatchObject({ status: 'recording', last_seq: 600 });
    expect(pre.detect.journal.has(uuid(92))).toBe(true);
    expect(first.host.snapshot().lastFinalized).toBeNull();
    await first.host.stop({ endOpenTrip: false });
    // The next launch reads the rest and ends it where native did.
    failAt = null;
    const next = buildIos({ detect: pre.detect as DriveDetectApi, source: pre.source });
    await next.host.boot();
    await next.host.settled();
    expect(await createTripsRepo(db).get(uuid(92))).toMatchObject({ status: 'pending', ended_at: T0 + 900_000 });
    expect(pre.detect.journal.has(uuid(92))).toBe(false);
    await next.host.stop({ endOpenTrip: false });
  });

  test('a drive taken in behind (an automatic one) is pushed; one in front starts the Live Activity locally (a Start-card drive at the tap)', async () => {
    const pushed: PushToStartRequest[] = [];
    const h = buildIos({ pushToStart: async (req) => (pushed.push(req), true) });
    await h.host.boot();
    await h.detect.setArmed(true, 'user-1');
    h.detect.wake();
    h.appState.set('background');
    await confirm(h, rows(30, { speedMps: 15 }));
    await new Promise((r) => setTimeout(r, 0));
    expect(h.host.snapshot().origin).toBe('auto');
    expect(pushed).toEqual([expect.objectContaining({ clientTripId: NATIVE, leg: 0, startedAt: T0 })]);
    expect(h.display.log.filter((l) => l.startsWith('start'))).toEqual([]);
    await h.host.stop({ endOpenTrip: false });

    const f = buildIos({ pushToStart: async (req) => (pushed.push(req), true) });
    await f.host.boot();
    await f.host.start();
    expect(f.display.log[0]).toMatch(/^start /);
    expect(pushed.map((r) => r.clientTripId)).toEqual([NATIVE]);
    await f.host.stop({ endOpenTrip: false });
  });

  test('a Start-card drive set off within 5 min where a drive ended is a drive of its own at driving speed (native’s journal feeds it); a Start that is cancelled leaves the drive before as it was', async () => {
    const h = buildIos();
    await h.host.boot();
    await h.detect.setArmed(true, 'user-1');
    h.detect.wake();
    const parkedLng = START.lng + (59 * 15) / M_PER_DEG_LNG;
    await confirm(h, [...rows(60, { speedMps: 15 }), ...rows(30, { t0: T0 + 60_000, speedMps: 0 }).map((r) => ({ ...r, lng: parkedLng }))]);
    clock = T0 + 95_000;
    h.detect.endFor('still', T0 + 95_000);
    await new Promise((r) => setTimeout(r, 0));
    await h.host.untilIdle();
    expect(await createTripsRepo(db).get(NATIVE)).toMatchObject({ status: 'pending' });
    const upload = (await createQueueRepo(db).byKey(`trip:${NATIVE}`))!;

    // A Start 1 min later that never reaches driving speed: cancelled, the drive before untouched.
    clock = T0 + 155_000;
    await h.host.start();
    await feedIos(h, rows(5, { t0: T0 + 156_000, speedMps: 0 }).map((r) => ({ ...r, lng: parkedLng })));
    await h.host.cancelWaiting();
    expect(await createTripsRepo(db).get(NATIVE)).toMatchObject({ status: 'pending' });
    expect(await createQueueRepo(db).byKey(`trip:${NATIVE}`)).toMatchObject({ id: upload.id, next_attempt_at: upload.next_attempt_at });
    expect(await tripCount()).toBe(1);

    // Again 1 min later, and it drives off: a drive of its own, the one before as it ended.
    clock = T0 + 215_000;
    await h.host.start();
    const manual = h.host.snapshot().clientTripId!;
    expect(manual).not.toBe(NATIVE);
    await feedIos(h, rows(5, { t0: T0 + 216_000, speedMps: 0 }).map((r) => ({ ...r, lng: parkedLng })));
    expect(h.host.snapshot()).toMatchObject({ clientTripId: manual, waiting: { phase: 'waiting' } });
    await feedIos(h, rows(100, { t0: T0 + 221_000, speedMps: 15 }).map((r) => ({ ...r, lng: r.lng - START.lng + parkedLng })));
    expect(h.host.snapshot()).toMatchObject({ status: 'recording', clientTripId: manual, waiting: null, lastRowTs: T0 + 320_000 });
    expect(await createTripsRepo(db).get(manual)).toMatchObject({ status: 'recording' });
    expect(await createTripsRepo(db).get(NATIVE)).toMatchObject({ status: 'pending' });
    expect(await createSettingsRepo(db).get(JOURNAL_LINK_KEY)).toEqual({ driveId: manual, clientTripId: manual });
    // Live rows go on into it.
    await feedIos(h, rows(5, { t0: T0 + 321_000, speedMps: 15 }).map((r) => ({ ...r, lng: r.lng - START.lng + parkedLng + (100 * 15) / M_PER_DEG_LNG })));
    expect(h.host.snapshot().lastRowTs).toBe(T0 + 325_000);
    clock = T0 + 326_000;
    expect(await h.host.end()).toEqual({ clientTripId: manual, dropped: null });
    await h.host.settled();
    expect(await tripCount()).toBe(2);
    expect(await createTripsRepo(db).get(NATIVE)).toMatchObject({ status: 'pending', started_at: T0 });
    expect(await createTripsRepo(db).get(manual)).toMatchObject({ status: 'pending', origin: 'manual' });
    await h.host.stop({ endOpenTrip: false });
  });

  test('behind, a drive confirmed soon after a stop asks for its own push (leg 0; the first drive’s Live Activity ended with it)', async () => {
    const pushed: PushToStartRequest[] = [];
    const h = buildIos({ pushToStart: async (req) => (pushed.push(req), true) }, { appState: 'background' });
    await h.host.boot();
    await h.detect.setArmed(true, 'user-1');
    h.detect.wake();
    const parkedLng = START.lng + (59 * 15) / M_PER_DEG_LNG;
    const first = [...rows(60, { speedMps: 15 }), ...rows(30, { t0: T0 + 60_000, speedMps: 0 }).map((r) => ({ ...r, lng: parkedLng }))];
    await confirm(h, first);
    await new Promise((r) => setTimeout(r, 0));
    expect(pushed.map((r) => [r.clientTripId, r.leg])).toEqual([[NATIVE, 0]]);
    clock = T0 + 95_000;
    h.detect.endFor('still', T0 + 95_000);
    await new Promise((r) => setTimeout(r, 0));
    await h.host.untilIdle();
    expect(h.display.log.at(-1)).toBe('end');
    // 2 min later the car sets off again from where it parked: native's new drive is a trip of its own.
    const SECOND = '22222222-2222-4222-8222-222222222222';
    h.detect.wake();
    const again = rows(30, { t0: T0 + 215_000, speedMps: 15 }).map((r) => ({ ...r, lng: r.lng - START.lng + parkedLng }));
    await confirm(h, again, { driveId: SECOND });
    await new Promise((r) => setTimeout(r, 0));
    expect(h.host.snapshot()).toMatchObject({ status: 'recording', clientTripId: SECOND });
    expect(await createTripsRepo(db).get(NATIVE)).toMatchObject({ status: 'pending' });
    expect(pushed.map((r) => [r.clientTripId, r.leg])).toEqual([
      [NATIVE, 0],
      [SECOND, 0],
    ]);
    await h.host.stop({ endOpenTrip: false });
  });
});

test('a drop notice from before is left alone by a refused Start', async () => {
  await writeDropNotice(db, { clientTripId: 'x', cause: 'stopped', reason: 'no_movement', at: 1 });
  const h = build({ permissions: async () => ({ location: 'denied' }) });
  await h.host.boot();
  await h.host.start();
  expect(await readDropNotice(db)).not.toBeNull();
});

describe('iOS: a Start that cannot be refused by a step beside it (plan decision 8)', () => {
  /** An older native build: `startWaiting` answers `{ ok, waitUntil }` alone and waits in a manual candidate of its own. */
  function legacyNative(h: I): { cancelled: () => boolean } {
    let candidate = false;
    let cancelled = false;
    const realState = h.detect.getState.bind(h.detect);
    const realCancel = h.detect.cancelWaiting.bind(h.detect);
    h.detect.startWaiting = async () => {
      h.detect.calls.push('startWaiting');
      candidate = true;
      return { ok: true, waitUntil: clock + WAIT_TOTAL_MS, driveId: null, startedAt: null };
    };
    h.detect.getState = async () => {
      const s = await realState();
      return candidate ? { ...s, state: 'candidate', origin: 'manual' } : s;
    };
    h.detect.cancelWaiting = async () => {
      if (candidate) cancelled = true;
      candidate = false;
      return realCancel();
    };
    // While Using, as the Start card asks for (native's plain capture needs it).
    h.source.setState({ location: 'whenInUse' });
    return { cancelled: () => cancelled };
  }

  /** Rows of the plain capture (no journal `seq`), through the fake capture. */
  async function feedPlain(h: I, list: readonly FeatureRow[]): Promise<void> {
    await feed(h, list);
  }

  const moving = (n: number, t0: number) => rows(n, { t0, speedMps: 15 });

  test('an older native build (the 2-key answer): its own wait is cancelled, a plain capture records the drive from the tap, waiting; it reaches driving speed, and End stores it and stops the capture', async () => {
    const h = buildIos();
    const legacy = legacyNative(h);
    await h.host.boot();
    expect(await h.host.start()).toEqual({ ok: true, waiting: true });
    expect(legacy.cancelled()).toBe(true);
    expect(h.source.calls).toContain('startCapture:mounted');
    expect(h.host.captureActive()).toBe(true);
    const id = h.host.snapshot().clientTripId!;
    expect(id).toBe(uuid(1));
    expect(h.host.snapshot()).toMatchObject({ status: 'recording', origin: 'manual', startedAt: T0, waiting: { since: T0, phase: 'waiting' } });
    expect(await createTripsRepo(db).get(id)).toMatchObject({ status: 'recording', origin: 'manual', started_at: T0 });
    expect(h.display.log[0]).toMatch(/^start /);
    // A touch moves the wait on here; native has no wait of its own to move.
    h.host.touchWaiting();
    expect(h.host.snapshot().waiting).toMatchObject({ since: T0, phase: 'waiting' });
    expect(h.detect.calls).not.toContain('extendWaiting');
    // The capture's rows (no `seq`) reach the drive, and driving speed ends the wait.
    await feedPlain(h, moving(200, T0 + 1000));
    expect(h.host.snapshot()).toMatchObject({ status: 'recording', waiting: null, lastRowTs: T0 + 200_000 });
    clock = T0 + 201_000;
    expect(await h.host.end()).toEqual({ clientTripId: id, dropped: null });
    await h.host.settled();
    expect(h.source.calls.at(-1)).toBe('stopCapture');
    expect(h.host.captureActive()).toBe(false);
    expect(await createTripsRepo(db).get(id)).toMatchObject({ status: 'pending' });
    await h.host.stop({ endOpenTrip: false });
  });

  test('a plain-capture drive: Cancel while it waits ends it unsaved and stops the capture; "Not driving?" later stops the capture and never tells native (no detector drive)', async () => {
    const h = buildIos();
    legacyNative(h);
    await h.host.boot();
    await h.host.start();
    await h.host.cancelWaiting();
    expect(h.host.snapshot()).toMatchObject({ status: 'idle', lastFinalized: { dropped: expect.any(String) } });
    expect(h.source.calls.at(-1)).toBe('stopCapture');
    expect(await tripCount()).toBe(0);

    clock = T0 + 100_000;
    expect(await h.host.start()).toEqual({ ok: true, waiting: true });
    await feedPlain(h, moving(20, T0 + 101_000));
    expect(h.host.snapshot()).toMatchObject({ status: 'recording', waiting: null, notDrivingAvailable: true });
    expect(await h.host.cancelDrive()).toBe(true);
    await h.host.settled();
    expect(h.detect.calls).not.toContain('notDriving');
    expect(h.source.calls.at(-1)).toBe('stopCapture');
    expect(h.host.captureActive()).toBe(false);
    expect(await tripCount()).toBe(0);
    await h.host.stop({ endOpenTrip: false });
  });

  test('startWaiting rejects (an answer that could not be read) while native did open its manual drive: that drive is taken in, journaled, no capture of ours', async () => {
    const h = buildIos();
    const real = h.detect.startWaiting.bind(h.detect);
    h.detect.startWaiting = async () => {
      await real();
      throw new Error('DriveDetect.startWaiting: invalid result');
    };
    await h.host.boot();
    clock = T0 + 5_000;
    expect(await h.host.start()).toEqual({ ok: true, waiting: true });
    const native = h.detect.snapshot;
    expect(native).toMatchObject({ state: 'recording', origin: 'manual' });
    expect(h.host.snapshot()).toMatchObject({ status: 'recording', clientTripId: native.driveId, origin: 'manual', startedAt: T0 + 5_000, waiting: { since: T0 + 5_000 } });
    expect(h.source.calls).not.toContain('startCapture:mounted');
    expect(h.detect.calls).not.toContain('cancelWaiting');
    expect(await createSettingsRepo(db).get(JOURNAL_LINK_KEY)).toEqual({ driveId: native.driveId, clientTripId: native.driveId });
    expect(h.errors.some((e) => e.startsWith('startWaiting:'))).toBe(true);
    // Its rows follow live, as for any journaled Start.
    await feedIos(h, rows(3, { t0: T0 + 6_000, speedMps: 0 }));
    expect(h.host.snapshot().lastRowTs).toBe(T0 + 8_000);
    await h.host.stop({ endOpenTrip: false });
  });

  test('startWaiting rejects with nothing opened (no such method on that build), or answers unavailable: a plain capture records the drive', async () => {
    for (const answer of ['throw', 'unavailable'] as const) {
      const h = buildIos();
      h.detect.startWaiting = async () => {
        if (answer === 'throw') throw new TypeError('native.startWaiting is not a function');
        return { ok: false, reason: 'unavailable' };
      };
      h.source.setState({ location: 'whenInUse' });
      await h.host.boot();
      expect(await h.host.start()).toEqual({ ok: true, waiting: true });
      expect(h.source.calls).toContain('startCapture:mounted');
      expect(h.host.snapshot()).toMatchObject({ status: 'recording', origin: 'manual', waiting: { phase: 'waiting' } });
      await feedPlain(h, moving(3, T0 + 1000));
      expect(h.host.snapshot().lastRowTs).toBe(T0 + 3_000);
      await h.host.stop({ endOpenTrip: true });
    }
  });

  test('the plain fallback is refused when the capture does not really run (the detector’s own sensing holds the sensors), with nothing left open', async () => {
    const h = buildIos();
    h.detect.startWaiting = async () => ({ ok: false, reason: 'unavailable' });
    // iOS answers the start without capturing anything.
    h.source.setState({ location: 'whenInUse' });
    h.source.startCapture = async () => {};
    await h.host.boot();
    expect(await h.host.start()).toEqual({ ok: false, reason: 'error' });
    expect(h.host.snapshot()).toMatchObject({ status: 'idle', waiting: null });
    expect(h.host.captureActive()).toBe(false);
    expect(await tripCount()).toBe(0);
    expect(h.errors).toContain('startCapture: the Start fallback capture is not running');
    await h.host.stop({ endOpenTrip: false });
  });

  test('every real refusal is kept: native’s permission and busy, a native drive recording that this tap did not open, a capture without permission', async () => {
    const p = buildIos();
    p.detect.startWaiting = async () => ({ ok: false, reason: 'permission' });
    await p.host.boot();
    expect(await p.host.start()).toEqual({ ok: false, reason: 'permission' });
    expect(p.source.calls).not.toContain('startCapture:mounted');
    await p.host.stop({ endOpenTrip: false });

    const b = buildIos();
    b.detect.startWaiting = async () => ({ ok: false, reason: 'busy' });
    await b.host.boot();
    expect(await b.host.start()).toEqual({ ok: false, reason: 'busy' });
    await b.host.stop({ endOpenTrip: false });

    // The answer is lost and native records an automatic drive: that is a drive already running.
    const a = buildIos();
    await a.host.boot();
    const realState = a.detect.getState.bind(a.detect);
    a.detect.startWaiting = async () => {
      throw new Error('bridge');
    };
    a.detect.getState = async () => ({ ...(await realState()), state: 'recording', origin: 'auto', driveId: NATIVE, startedAt: T0 });
    expect(await a.host.start()).toEqual({ ok: false, reason: 'busy' });
    expect(a.source.calls).not.toContain('startCapture:mounted');
    expect(a.host.snapshot().status).toBe('idle');
    await a.host.stop({ endOpenTrip: false });

    // The plain fallback's capture refused for want of location.
    const l = buildIos();
    l.detect.startWaiting = async () => ({ ok: false, reason: 'unavailable' });
    l.source.setState({ location: 'none' });
    await l.host.boot();
    expect(await l.host.start()).toEqual({ ok: false, reason: 'permission' });
    await l.host.stop({ endOpenTrip: false });
  });

  test('a step beside the drive that throws never refuses the start: the cached position, the display and the permissions read (iOS and Android)', async () => {
    const throwingDisplay = (): DriveDisplay => ({
      ...fakeDisplay(),
      start: () => {
        throw new Error('display gone');
      },
      update: () => {
        throw new Error('display gone');
      },
    });
    const over: Over = {
      lastPosition: () => {
        throw new Error('no location module');
      },
      permissions: async () => {
        throw new Error('permissions module');
      },
      display: throwingDisplay(),
    };
    const i = buildIos(over);
    await i.host.boot();
    expect(await i.host.start()).toEqual({ ok: true, waiting: true });
    expect(i.host.snapshot()).toMatchObject({ status: 'recording', origin: 'manual', waiting: { phase: 'waiting' } });
    expect(i.errors).toEqual(expect.arrayContaining(['permissions: permissions module', 'lastPosition: no location module', 'display: display gone']));
    // The wait's timer runs: the sheet comes at 2:00.
    expect(i.scheduler.delays()).toContain(WAIT_POPUP_MS);
    await feedIos(i, rows(3, { t0: T0 + 1000, speedMps: 0 }));
    expect(i.host.snapshot().lastRowTs).toBe(T0 + 3_000);
    await i.host.stop({ endOpenTrip: true });

    const a = build({ ...over, display: throwingDisplay() });
    await a.host.boot();
    expect(await a.host.start()).toEqual({ ok: true, waiting: true });
    expect(a.host.snapshot()).toMatchObject({ status: 'recording', origin: 'manual' });
    await a.host.stop({ endOpenTrip: true });
  });

  test('Android: a capture refused for want of location is a permission refusal; any other failure an error', async () => {
    const l = build();
    l.source.setState({ location: 'none' });
    await l.host.boot();
    expect(await l.host.start()).toEqual({ ok: false, reason: 'permission' });
    const e = build();
    e.source.startCapture = async () => {
      throw new Error('service');
    };
    await e.host.boot();
    expect(await e.host.start()).toEqual({ ok: false, reason: 'error' });
    expect(e.host.snapshot().status).toBe('idle');
  });
});

describe('iOS: the push-to-start once the confirming rows are in (plan decision 4)', () => {
  /** Limits unknown for the first `n` lookups, then 35 mph posted. */
  function lateLimits(n: number): SpeedLimitClient {
    const base = fakeLimits();
    let calls = 0;
    const unknown: LimitSample = { limitMps: null, source: 'unknown', matchConfidence: 0, parallelRoads: false };
    // Replayed rows read the stored tiles (`lookupStored`), live ones `lookup`: the first `n` of either know nothing.
    return {
      ...base,
      lookup: (...args: Parameters<SpeedLimitClient['lookup']>) => ((calls += 1) <= n ? unknown : base.lookup(...args)),
      lookupStored: async (...args: Parameters<SpeedLimitClient['lookupStored']>) => ((calls += 1) <= n ? unknown : base.lookupStored(...args)),
    } as SpeedLimitClient;
  }

  function pushes(answers: (boolean | PushToStartOutcome)[] = []) {
    const pushed: PushToStartRequest[] = [];
    return {
      pushed,
      pushToStart: async (req: PushToStartRequest) => {
        pushed.push(req);
        return answers.length > 0 ? answers.shift()! : true;
      },
    };
  }

  async function behind(over: Over = {}) {
    const h = buildIos(over, { appState: 'background' });
    await h.host.boot();
    await h.detect.setArmed(true, 'user-1');
    h.detect.wake();
    return h;
  }

  const flush = async (h: I) => {
    await new Promise((r) => setTimeout(r, 0));
    await h.host.settled();
    await new Promise((r) => setTimeout(r, 0));
  };

  test('it goes after the journal’s rows are drained, carrying the drive’s speed and limit (34 mph on a 35)', async () => {
    const p = pushes();
    const h = await behind({ pushToStart: p.pushToStart });
    await confirm(h, rows(30, { speedMps: 15 }));
    await flush(h);
    expect(p.pushed).toHaveLength(1);
    expect(p.pushed[0]).toMatchObject({ clientTripId: NATIVE, leg: 0, startedAt: T0, state: { speed: 34, limit: 35, unit: 'mph', weatherKind: null } });
    expect(h.scheduler.delays()).not.toContain(PUSH_START_WAIT_MS);
    await h.host.stop({ endOpenTrip: false });
  });

  test('it waits up to 1.5 s for a limit: the next live row bringing it sends at once; none by then sends without it', async () => {
    const p = pushes();
    const h = await behind({ pushToStart: p.pushToStart, limits: lateLimits(30) });
    await confirm(h, rows(30, { speedMps: 15 }));
    await flush(h);
    expect(p.pushed).toHaveLength(0);
    expect(h.scheduler.delays()).toContain(PUSH_START_WAIT_MS);
    await feedIos(h, rows(1, { t0: T0 + 30_000, speedMps: 15 }));
    await flush(h);
    expect(p.pushed).toHaveLength(1);
    expect(p.pushed[0]!.state).toMatchObject({ speed: 34, limit: 35 });
    await h.host.stop({ endOpenTrip: false });

    const q = pushes();
    const g = await behind({ pushToStart: q.pushToStart, limits: lateLimits(1_000) });
    await confirm(g, rows(30, { speedMps: 15 }));
    await flush(g);
    expect(q.pushed).toHaveLength(0);
    clock += PUSH_START_WAIT_MS;
    g.scheduler.fire();
    await flush(g);
    expect(q.pushed).toHaveLength(1);
    expect(q.pushed[0]!.state).toMatchObject({ speed: 34, limit: null });
    await g.host.stop({ endOpenTrip: false });
  });

  test('a failure a retry may fix is reported with its reason and asked once more after 30 s; a final one is not; one already running asks nothing', async () => {
    const p = pushes([{ sent: false, reason: 'timeout', detail: null, retryable: true }, { sent: false, reason: 'apns_error', detail: 'TooManyRequests', retryable: true }]);
    const h = await behind({ pushToStart: p.pushToStart });
    await confirm(h, rows(30, { speedMps: 15 }));
    await flush(h);
    expect(p.pushed).toHaveLength(1);
    expect(h.errors).toContain('pushToStart: push-to-start not sent: timeout; asking again in 30 s');
    expect(h.scheduler.delays()).toContain(PUSH_START_RETRY_MS);
    // Rows meanwhile do not ask early.
    await feedIos(h, rows(2, { t0: T0 + 30_000, speedMps: 15 }));
    await flush(h);
    expect(p.pushed).toHaveLength(1);
    clock = T0 + 62_000;
    h.scheduler.fire();
    await flush(h);
    expect(p.pushed).toHaveLength(2);
    expect(p.pushed[1]).toMatchObject({ clientTripId: NATIVE, leg: 0, state: { speed: 34, limit: 35 } });
    // Only once.
    expect(h.errors).toContain('pushToStart: push-to-start not sent: apns_error (TooManyRequests)');
    expect(h.scheduler.delays()).not.toContain(PUSH_START_RETRY_MS);
    h.scheduler.fire();
    await flush(h);
    expect(p.pushed).toHaveLength(2);
    await h.host.stop({ endOpenTrip: false });

    const f = pushes([{ sent: false, reason: 'unconfigured', detail: null, retryable: false }]);
    const g = await behind({ pushToStart: f.pushToStart });
    await confirm(g, rows(30, { speedMps: 15 }));
    await flush(g);
    expect(g.errors).toContain('pushToStart: push-to-start not sent: unconfigured');
    expect(g.scheduler.delays()).not.toContain(PUSH_START_RETRY_MS);
    await g.host.stop({ endOpenTrip: false });

    // A bare false (an outcome without its reason) is asked once more too.
    const b = pushes([false]);
    const k = await behind({ pushToStart: b.pushToStart });
    await confirm(k, rows(30, { speedMps: 15 }));
    await flush(k);
    expect(k.scheduler.delays()).toContain(PUSH_START_RETRY_MS);
    await k.host.stop({ endOpenTrip: false });

    const r = pushes();
    const display = fakeDisplay(true);
    const m = await behind({ pushToStart: r.pushToStart, display });
    await confirm(m, rows(30, { speedMps: 15 }));
    await flush(m);
    expect(r.pushed).toEqual([]);
    await m.host.stop({ endOpenTrip: false });
  });

  test('RoadWise coming to the front starts the Live Activity locally and drops a push still waiting or to be asked again', async () => {
    const p = pushes();
    const h = await behind({ pushToStart: p.pushToStart, limits: lateLimits(1_000) });
    await confirm(h, rows(30, { speedMps: 15 }));
    await flush(h);
    expect(p.pushed).toHaveLength(0);
    h.appState.set('active');
    await flush(h);
    expect(h.display.log.some((l) => l.startsWith('start'))).toBe(true);
    clock += PUSH_START_WAIT_MS;
    h.scheduler.fire();
    await flush(h);
    expect(p.pushed).toHaveLength(0);
    await h.host.stop({ endOpenTrip: false });

    const q = pushes([{ sent: false, reason: 'network', detail: null, retryable: true }]);
    const g = await behind({ pushToStart: q.pushToStart });
    await confirm(g, rows(30, { speedMps: 15 }));
    await flush(g);
    expect(q.pushed).toHaveLength(1);
    g.appState.set('active');
    await flush(g);
    clock += PUSH_START_RETRY_MS;
    g.scheduler.fire();
    await flush(g);
    expect(q.pushed).toHaveLength(1);
    await g.host.stop({ endOpenTrip: false });
  });

  test('a drive that ends before its push went asks nothing more', async () => {
    const p = pushes();
    const h = await behind({ pushToStart: p.pushToStart, limits: lateLimits(1_000) });
    await confirm(h, rows(30, { speedMps: 15 }));
    await flush(h);
    clock = T0 + 31_000;
    await h.host.end();
    clock += PUSH_START_WAIT_MS;
    h.scheduler.fire();
    await flush(h);
    expect(p.pushed).toEqual([]);
    await h.host.stop({ endOpenTrip: false });
  });
});

describe('the speed and limit pipeline beside the rows (plan decision 6)', () => {
  test('native’s listeners are attached before the boot’s own work runs, so a live speed during the journal drain reaches the drive; events native held still queue behind the boot', async () => {
    const pre = buildIos();
    await pre.detect.setArmed(true, 'user-1');
    pre.detect.wake();
    clock = T0 + 41_000;
    pre.detect.confirm({ driveId: uuid(80), startedAt: T0, rows: journalRows(rows(40, { speedMps: 15 })) });
    const h = buildIos({ detect: pre.detect as DriveDetectApi, source: pre.source, platform: 'ios' });
    const seen: number[] = [];
    // (buildIos hands back its own fakes: the host here runs on pre's.)
    const getState = pre.source.getState.bind(pre.source);
    pre.source.getState = async () => {
      seen.push(pre.source.listenerCount('speed'));
      return getState();
    };
    const readRows = pre.detect.readRows.bind(pre.detect);
    let emitted = false;
    pre.detect.readRows = async (id, after, limit) => {
      if (!emitted) {
        emitted = true;
        pre.source.emit('speed', { ts: T0 + 40_500, speed: 20, speedAcc: 0.5, hAcc: 5, ageMs: 0 } as never);
      }
      return readRows(id, after, limit);
    };
    await h.host.boot();
    await h.host.settled();
    expect(seen[0]).toBe(1);
    expect(emitted).toBe(true);
    expect(h.host.snapshot()).toMatchObject({ status: 'recording', clientTripId: uuid(80), lastRowTs: T0 + 39_000, speedAt: T0 + 40_500 });
    await h.host.stop({ endOpenTrip: false });
  });

  test('iPhone: a speed is timed at its fix (never later than now); Android: at arrival less its age', async () => {
    const h = buildIos({ platform: 'ios' });
    await h.host.boot();
    await h.detect.setArmed(true, 'user-1');
    h.detect.wake();
    await confirm(h, rows(30, { speedMps: 15 }));
    clock = T0 + 32_000;
    h.source.emit('speed', { ts: T0 + 31_000, speed: 15, speedAcc: 0.5, hAcc: 5, ageMs: 4_000 } as never);
    expect(h.host.snapshot().speedAt).toBe(T0 + 31_000);
    h.source.emit('speed', { ts: T0 + 40_000, speed: 15, speedAcc: 0.5, hAcc: 5, ageMs: 0 } as never);
    expect(h.host.snapshot().speedAt).toBe(T0 + 32_000);
    await h.host.stop({ endOpenTrip: false });

    const a = build({ platform: 'android' });
    await a.host.boot();
    await drive(a, rows(20, { speedMps: 15 }));
    clock = T0 + 25_000;
    a.source.emit('speed', { ts: T0 + 24_000, speed: 15, speedAcc: 0.5, hAcc: 5, ageMs: 500 } as never);
    expect(a.host.snapshot().speedAt).toBe(T0 + 24_500);
    await a.host.stop({ endOpenTrip: true });
  });

  test('a gap filled from the journal yields the JS thread between pages', async () => {
    const h = buildIos();
    await h.host.boot();
    await h.detect.setArmed(true, 'user-1');
    h.detect.wake();
    await confirm(h, rows(10, { speedMps: 15 }));
    // 700 rows journaled while JS missed them live, then one arrives.
    const missed = rows(701, { t0: T0 + 10_000, speedMps: 15 }).map((r) => ({ ...r, lng: r.lng + (10 * 15) / M_PER_DEG_LNG }));
    h.link.lossy = true;
    h.detect.emitRows(journalRows(missed.slice(0, 700)));
    h.link.lossy = false;
    let ticked = false;
    const at: boolean[] = [];
    const readRows = h.detect.readRows.bind(h.detect);
    h.detect.readRows = async (id, after, limit) => {
      at.push(ticked);
      return readRows(id, after, limit);
    };
    setTimeout(() => {
      ticked = true;
    }, 0);
    clock = missed.at(-1)!.ts + 1000;
    h.detect.emitRows(journalRows(missed.slice(700)));
    await h.host.settled();
    expect(h.host.snapshot().lastRowTs).toBe(missed.at(-1)!.ts);
    expect(at.length).toBeGreaterThan(2);
    expect(at[0]).toBe(false);
    expect(at.slice(1).every(Boolean)).toBe(true);
    await h.host.stop({ endOpenTrip: false });
  });

  test('replayed rows never take the trip’s first tile batch: it is asked for where the first live row is', async () => {
    const limits = fakeLimits();
    const h = buildIos({ limits });
    await h.host.boot();
    await h.detect.setArmed(true, 'user-1');
    h.detect.wake();
    await confirm(h, rows(30, { speedMps: 15 }));
    expect(limits.startTrip).not.toHaveBeenCalled();
    const live = rows(31, { speedMps: 15 }).slice(30);
    await feedIos(h, live);
    expect(limits.startTrip).toHaveBeenCalledTimes(1);
    const [lat, lng, course] = (limits.startTrip as jest.Mock).mock.calls[0] as [number, number, number];
    expect(lat).toBeCloseTo(live[0]!.lat, 5);
    expect(lng).toBeCloseTo(live[0]!.lng, 5);
    expect(course).toBe(live[0]!.course);
    await h.host.stop({ endOpenTrip: false });
  });

  test('the end of a kept drive is on its outcome (for the recap’s age rule); none for one not kept', async () => {
    const h = buildIos();
    await h.host.boot();
    await h.detect.setArmed(true, 'user-1');
    h.detect.wake();
    await confirm(h, rows(60, { speedMps: 15 }));
    clock = T0 + 61_000;
    await h.host.end();
    const trip = (await createTripsRepo(db).get(NATIVE))!;
    expect(trip.ended_at).not.toBeNull();
    expect(h.host.snapshot().lastFinalized).toMatchObject({ clientTripId: NATIVE, ok: true, dropped: null, endedAt: trip.ended_at });
    await h.host.stop({ endOpenTrip: false });

    const d = build();
    await d.host.boot();
    await d.host.start();
    await d.host.cancelWaiting();
    expect(d.host.snapshot().lastFinalized).toMatchObject({ ok: true, dropped: expect.any(String), endedAt: null });
  });
});

describe('the recap notification with the real host (plan decision 3)', () => {
  function recapPort() {
    const scheduled: SummaryRequest[] = [];
    const port: SummaryNotificationPort = {
      permissionGranted: async () => true,
      schedule: async (r) => void scheduled.push(r),
      scheduled: async () => scheduled.map((r) => r.identifier),
      cancel: async () => {},
    };
    return { port, scheduled };
  }

  /** A first process: native records and ends a drive (60 s moving, then parked), with no JS. */
  function endedWithoutJs(id: string): I {
    const pre = buildIos();
    void pre.detect.setArmed(true, 'user-1');
    pre.detect.wake();
    const moving = rows(60, { speedMps: 15 });
    const parked = rows(30, { t0: T0 + 60_000, speedMps: 0 }).map((r) => ({ ...r, lng: moving.at(-1)!.lng }));
    clock = T0 + 91_000;
    pre.detect.confirm({ driveId: id, startedAt: T0, rows: journalRows([...moving, ...parked]) });
    pre.detect.endFor('still', clock);
    return pre;
  }

  test('attached before the boot, a drive native ended while no process ran posts its recap when it ended within 2 h; one stored hours later does not', async () => {
    for (const [launchAt, posts] of [
      [T0 + 10 * 60_000, true],
      [T0 + 3 * 60 * 60_000, false],
    ] as const) {
      const id = uuid(posts ? 95 : 96);
      const pre = endedWithoutJs(id);
      clock = launchAt;
      const h = buildIos({ detect: pre.detect as DriveDetectApi, source: pre.source }, { appState: 'background' });
      const { port, scheduled } = recapPort();
      const n = attachSummaryNotifier(h.host, { port, appState: h.appState, now: () => clock });
      await h.host.boot();
      await h.host.settled();
      await n.settled();
      expect(await createTripsRepo(db).get(id)).toMatchObject({ status: 'pending', ended_at: T0 + 60_000 });
      expect(scheduled.map((r) => r.url)).toEqual(posts ? [`/drives/${id}?fresh=1`] : []);
      n.detach();
      await h.host.stop({ endOpenTrip: false });
    }
  });

  test('an automatic drive that native ends with RoadWise behind posts its recap, which opens the fresh recap', async () => {
    const h = buildIos({}, { appState: 'background' });
    const { port, scheduled } = recapPort();
    const n = attachSummaryNotifier(h.host, { port, appState: h.appState, now: () => clock });
    await h.host.boot();
    await h.detect.setArmed(true, 'user-1');
    h.detect.wake();
    const parkedLng = START.lng + (59 * 15) / M_PER_DEG_LNG;
    await confirm(h, [...rows(60, { speedMps: 15 }), ...rows(30, { t0: T0 + 60_000, speedMps: 0 }).map((r) => ({ ...r, lng: parkedLng }))]);
    expect(scheduled).toEqual([]);
    clock = T0 + 95_000;
    h.detect.endFor('walking', T0 + 95_000);
    await new Promise((r) => setTimeout(r, 0));
    await h.host.untilIdle();
    await n.settled();
    expect(scheduled).toEqual([expect.objectContaining({ identifier: `drive-summary:${NATIVE}`, url: `/drives/${NATIVE}?fresh=1`, title: 'Your drive recap is ready' })]);
    n.detach();
    await h.host.stop({ endOpenTrip: false });
  });
});
