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
import type { DriveDisplay, DriveDisplayState } from '@/drive/display';
import { speedTintOf } from '@/drive/displayTint';
import { readDropNotice, writeDropNotice } from '@/drive/dropNotice';
import { createDriveHost, DriveEndFailedError, JOURNAL_LINK_KEY, type PushToStartRequest } from '@/drive/host';
import { NOT_DRIVING_BUDGET_MS, NOT_DRIVING_KEY, readBudget } from '@/drive/notDriving';
import type { Scheduler } from '@/drive/ticks';
import { WAIT_COUNTDOWN_MS, WAIT_POPUP_MS, WAIT_TOTAL_MS } from '@/drive/waiting';
import type { DangerAlert } from '@/features/weather/danger';

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

function fakeDisplay(running = false): DriveDisplay & { log: string[]; states: DriveDisplayState[]; running: boolean } {
  const log: string[] = [];
  const states: DriveDisplayState[] = [];
  const d = {
    log,
    states,
    running,
    start: (s: DriveDisplayState) => {
      states.push(s);
      log.push(`start ${s.speed}/${s.limit}${s.stopped ? ' stopped' : ''}`);
    },
    update: (s: DriveDisplayState) => {
      states.push(s);
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

describe('the Start card (Android: the capture and a JS wait)', () => {
  test('refuses before boot, without location, approximate only or Location Services off; else the wait begins with the capture on and no trip', async () => {
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
    expect(ok.host.snapshot()).toMatchObject({ status: 'idle', clientTripId: null, waiting: { since: T0, phase: 'waiting', deadlineAt: T0 + WAIT_POPUP_MS, speedMps: null }, notDrivingAvailable: false });
    expect(await tripCount()).toBe(0);
    // A second swipe while waiting is a touch.
    clock = T0 + 10_000;
    expect(await ok.host.start()).toEqual({ ok: true, waiting: true });
    expect(ok.host.snapshot().waiting?.since).toBe(T0 + 10_000);
    await ok.host.stop({ endOpenTrip: true });
  });

  test('the sheet at 2:00, the countdown at 4:30, the quiet end at 5:00: nothing stored, the capture off, no notice', async () => {
    const h = build();
    await h.host.boot();
    await h.host.start();
    expect(h.scheduler.delays()).toEqual([WAIT_POPUP_MS]);
    clock = T0 + WAIT_POPUP_MS;
    h.scheduler.fire();
    await h.host.settled();
    expect(h.host.snapshot().waiting).toMatchObject({ phase: 'popup', deadlineAt: T0 + WAIT_COUNTDOWN_MS });
    clock = T0 + WAIT_COUNTDOWN_MS;
    h.scheduler.fire();
    await h.host.settled();
    expect(h.host.snapshot().waiting).toMatchObject({ phase: 'countdown', deadlineAt: T0 + WAIT_TOTAL_MS });
    clock = T0 + WAIT_TOTAL_MS;
    h.scheduler.fire();
    await h.host.settled();
    expect(h.host.snapshot()).toMatchObject({ waiting: null, status: 'idle' });
    expect(h.source.calls).toEqual(['startCapture:mounted', 'stopCapture']);
    expect(await tripCount()).toBe(0);
    expect(await readDropNotice(db)).toBeNull();
  });

  test('any touch starts the 5 min again; Cancel (or End while waiting) ends it quietly', async () => {
    const h = build();
    await h.host.boot();
    await h.host.start();
    clock = T0 + WAIT_POPUP_MS + 5000;
    h.scheduler.fire();
    await h.host.settled();
    expect(h.host.snapshot().waiting?.phase).toBe('popup');
    h.host.touchWaiting();
    expect(h.host.snapshot().waiting).toMatchObject({ phase: 'waiting', since: clock });
    expect(await h.host.end()).toBeNull();
    expect(h.host.snapshot().waiting).toBeNull();
    expect(h.source.calls.at(-1)).toBe('stopCapture');
    await h.host.start();
    await h.host.cancelWaiting();
    expect(h.host.snapshot().waiting).toBeNull();
    expect(await tripCount()).toBe(0);
  });

  test('parked, then pulling away: the drive starts at the last stop before the rise, as a Start-card drive, with the rows from there', async () => {
    const h = build();
    await h.host.boot();
    await h.host.start();
    const parked = rows(30, { speedMps: 0 });
    const away = rows(40, { t0: T0 + 30_000, speedMps: 15 }).map((r, i) => ({ ...r, lng: START.lng + (i * 15) / M_PER_DEG_LNG }));
    await feed(h, parked);
    expect(h.host.snapshot().waiting?.speedMps).toBe(0);
    expect(h.host.snapshot().waiting?.limitMph).toBe(35);
    await feed(h, away.slice(0, 15));
    expect(h.host.snapshot().status).toBe('idle');
    await feed(h, away.slice(15, 16));
    const s = h.host.snapshot();
    expect(s).toMatchObject({ status: 'recording', clientTripId: uuid(1), origin: 'manual', startedAt: T0 + 29_000, waiting: null, notDrivingAvailable: true });
    const trip = (await createTripsRepo(db).get(uuid(1)))!;
    expect(trip).toMatchObject({ status: 'recording', origin: 'manual', start_source: 'trace', started_at: T0 + 29_000 });
    // The traced-back stop row and the 16 driving rows are in the drive.
    expect(h.host.snapshot().lastRowTs).toBe(T0 + 45_000);
    await feed(h, away.slice(16));
    clock = T0 + 71_000;
    expect(await h.host.end()).toEqual({ clientTripId: uuid(1), dropped: null });
    expect(h.host.snapshot().lastFinalized).toMatchObject({ clientTripId: uuid(1), ok: true, status: 'pending', dropped: null, durationS: expect.any(Number), miles: expect.any(Number) });
    await h.host.stop({ endOpenTrip: false });
  });
});

/** Every state a host publishes, as (status, waiting) pairs. */
function recordStates(host: H['host']): { status: string; waiting: boolean }[] {
  const seen: { status: string; waiting: boolean }[] = [];
  host.subscribe((s) => seen.push({ status: s.status, waiting: s.waiting !== null }));
  return seen;
}

/** Between the last waiting state and the first recording one, no state is idle with no wait (the driving screen would go Home). */
function noIdleGap(seen: readonly { status: string; waiting: boolean }[]): void {
  const firstRecording = seen.findIndex((x) => x.status === 'recording');
  expect(firstRecording).toBeGreaterThan(0);
  expect(seen.slice(0, firstRecording).every((x) => x.status === 'idle' && x.waiting)).toBe(true);
  expect(seen[firstRecording]).toEqual({ status: 'recording', waiting: false });
}

describe('the confirmation never shows an idle state between the wait and the drive', () => {
  test('Android: every state published across the confirmation shows the wait, then the drive (a publish from elsewhere meanwhile too)', async () => {
    let h!: H;
    // The continuation read is slow, and RoadWise goes behind meanwhile (a publish of its own).
    h = build({
      continuation: async () => {
        h.appState.set('background');
        await new Promise((r) => setTimeout(r, 0));
        return null;
      },
    });
    await h.host.boot();
    await h.host.start();
    const seen = recordStates(h.host);
    await feed(h, rows(16, { speedMps: 15 }).map((r, i) => ({ ...r, lng: START.lng + (i * 15) / M_PER_DEG_LNG })));
    expect(h.host.snapshot()).toMatchObject({ status: 'recording', waiting: null });
    noIdleGap(seen);
    await h.host.stop({ endOpenTrip: true });
  });
});

describe('a drive', () => {
  test('rows publish, the display wears the tint, the hint and the speed; the end finalizes and queues the upload held 5 min', async () => {
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
    expect(h.display.log[0]).toMatch(/^start /);
    clock = T0 + 121_000;
    await h.host.end();
    expect(h.display.log.at(-1)).toBe('end');
    const trip = (await createTripsRepo(db).get(uuid(1)))!;
    expect(trip).toMatchObject({ status: 'pending', origin: 'manual', finalized_at: clock });
    const item = (await createQueueRepo(db).byKey(`trip:${uuid(1)}`))!;
    expect(item.next_attempt_at).toBe(clock + 300_000);
    expect(h.source.calls.at(-1)).toBe('stopCapture');
    await h.host.stop({ endOpenTrip: false });
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
    for (const r of still) appendRow(session, r, { unsafe: false, limitUsable: false });
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
    const session = createSession({ clientTripId: uuid(9), startedAt: T0, origin: 'manual' });
    for (const r of rows(30, { speedMps: 15 })) appendRow(session, r, { unsafe: false, limitUsable: false });
    session.pending = [];
    await createTripsRepo(db).insert({ client_trip_id: uuid(9), started_at: T0, tz: TZ, status: 'recording' }, T0);
    await createSamplesRepo(db).appendMany(uuid(9), rows(30, { speedMps: 15 }).map((r) => ({ ts: r.ts, row: r })));
    await createSettingsRepo(db).set(NOT_DRIVING_KEY, { clientTripId: uuid(9), spentMs: NOT_DRIVING_BUDGET_MS, expired: true, updatedAt: T0 });
    const h = build();
    h.source.setState({ capturing: true });
    await h.host.boot({ adopt: { session, detectors: createDetectors(() => 'x') } });
    expect(h.host.snapshot()).toMatchObject({ status: 'recording', clientTripId: uuid(9), notDrivingAvailable: false });
    // Android: nothing new reaches native at an adopt.
    expect(h.source.calls).toEqual([]);
    clock = T0 + 40_000;
    await h.host.suspendForSignOut();
    expect(h.host.snapshot().status).toBe('idle');
    expect((await createTripsRepo(db).get(uuid(9)))?.status).toBe('pending');
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
    // Nothing to cancel any more.
    expect(await h.host.cancelDrive()).toBe(false);
  });
});

describe('a continuation re-opens the held drive', () => {
  test('stopped 6 min and on again 100 m on: one drive, one row, continuations 1', async () => {
    const h = build();
    await h.host.boot();
    const first = rows(120, { speedMps: 15 });
    await drive(h, first);
    // Parked: the still end at 5 min.
    const end = first.at(-1)!;
    const parked = rows(301, { t0: T0 + 120_000, speedMps: 0 }).map((r) => ({ ...r, lng: end.lng }));
    await feed(h, parked);
    await h.host.untilIdle();
    const held = (await createTripsRepo(db).get(uuid(1)))!;
    expect(held.status).toBe('pending');
    // A new Start 30 s later, 100 m on: confirmed, it re-opens the same trip.
    const t1 = T0 + 451_000;
    clock = t1;
    const again = rows(40, { t0: t1, speedMps: 15 }).map((r, i) => ({ ...r, lat: START.lat, lng: held.end_lng! + (100 + i * 15) / M_PER_DEG_LNG }));
    await drive(h, again);
    expect(h.host.snapshot()).toMatchObject({ status: 'recording', clientTripId: uuid(1) });
    expect(await createTripsRepo(db).get(uuid(1))).toMatchObject({ status: 'recording', continuations: 1 });
    expect(await createQueueRepo(db).byKey(`trip:${uuid(1)}`)).toBeNull();
    clock = t1 + 41_000;
    await h.host.end();
    expect(await tripCount()).toBe(1);
    expect(await createTripsRepo(db).get(uuid(1))).toMatchObject({ status: 'pending', continuations: 1, started_at: T0 });
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
  async function confirm(h: I, list: readonly FeatureRow[], extra: Partial<Parameters<I['detect']['confirm']>[0]> = {}) {
    clock = list.at(-1)!.ts + 1000;
    h.detect.confirm({ driveId: NATIVE, startedAt: list[0]!.ts, startSource: 'trace', startLat: list[0]!.lat, startLng: list[0]!.lng, rows: journalRows(list), ...extra });
    await new Promise((r) => setTimeout(r, 0));
    await h.host.settled();
  }

  test('Start waits natively (no capture of ours): the touch extends it, native’s timeout or Cancel ends it', async () => {
    const h = buildIos();
    await h.host.boot();
    expect(await h.host.start()).toEqual({ ok: true, waiting: true });
    expect(h.source.calls).not.toContain('startCapture:mounted');
    expect(h.detect.calls).toContain('startWaiting');
    expect(h.host.snapshot().waiting).toMatchObject({ since: T0, phase: 'waiting' });
    clock = T0 + 60_000;
    h.host.touchWaiting();
    await h.host.settled();
    expect(h.detect.calls).toContain('extendWaiting');
    h.detect.waitTimeout();
    await new Promise((r) => setTimeout(r, 0));
    await h.host.settled();
    expect(h.host.snapshot().waiting).toBeNull();
    await h.host.start();
    await h.host.cancelWaiting();
    expect(h.detect.calls.at(-1)).toBe('cancelWaiting');
    expect(h.host.snapshot().waiting).toBeNull();
    await h.host.stop({ endOpenTrip: true });
  });

  test('the Start card’s confirmation: every state published shows the wait, then the drive, never idle with no wait (a publish from elsewhere meanwhile too)', async () => {
    let h!: I;
    h = buildIos({
      continuation: async () => {
        h.appState.set('background');
        await new Promise((r) => setTimeout(r, 0));
        return null;
      },
    });
    await h.host.boot();
    await h.host.start();
    const seen = recordStates(h.host);
    await confirm(h, rows(30, { speedMps: 15 }));
    expect(h.host.snapshot()).toMatchObject({ status: 'recording', origin: 'manual', waiting: null });
    noIdleGap(seen);
    await h.host.stop({ endOpenTrip: false });
  });

  test('a confirmed drive is adopted from the journal: native’s id, its traced start, every row once; live rows follow in order (a gap filled, a repeat dropped)', async () => {
    const h = buildIos();
    await h.host.boot();
    await h.host.start();
    const list = rows(40, { speedMps: 15 });
    await confirm(h, list);
    expect(h.host.snapshot()).toMatchObject({ status: 'recording', clientTripId: NATIVE, origin: 'manual', startedAt: T0, waiting: null, lastRowTs: T0 + 39_000 });
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
    await h.host.start();
    await confirm(h, rows(60, { speedMps: 15 }));
    clock = T0 + 61_000;
    await h.host.end();
    await h.host.settled();
    expect(h.source.calls).toContain('stopCapture');
    expect(h.detect.calls).toContain(`discardDrive:${NATIVE}`);
    expect(h.detect.journal.has(NATIVE)).toBe(false);
    await h.host.stop({ endOpenTrip: false });
  });

  test('"Not driving?" tells native (it discards and rests); the trip goes; no stopCapture', async () => {
    const h = buildIos();
    await h.host.boot();
    await h.host.start();
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
    expect(h.display.log.filter((l) => l.startsWith('start'))).toEqual([]);
    // Back in front: the Live Activity is adopted (or started) here.
    h.appState.set('active');
    await host.settled();
    expect(h.display.log.some((l) => l.startsWith('start'))).toBe(true);
    await host.stop({ endOpenTrip: false });
  });

  test('a drive confirmed in front starts the Live Activity locally; a Start-card drive behind is never pushed', async () => {
    const pushed: PushToStartRequest[] = [];
    const h = buildIos({ pushToStart: async (req) => (pushed.push(req), true) });
    await h.host.boot();
    await h.host.start();
    h.appState.set('background');
    await confirm(h, rows(30, { speedMps: 15 }));
    expect(h.host.snapshot().origin).toBe('manual');
    expect(pushed).toEqual([]);
    await h.host.stop({ endOpenTrip: false });

    const f = buildIos({ pushToStart: async (req) => (pushed.push(req), true) });
    await f.host.boot();
    await f.detect.setArmed(true, 'user-1');
    f.detect.wake();
    await confirm(f, rows(30, { speedMps: 15 }), { driveId: uuid(80) });
    expect(f.display.log[0]).toMatch(/^start /);
    expect(pushed).toEqual([]);
    await f.host.stop({ endOpenTrip: false });
  });
});

test('a drop notice from before is left alone by a refused Start', async () => {
  await writeDropNotice(db, { clientTripId: 'x', cause: 'stopped', reason: 'no_movement', at: 1 });
  const h = build({ permissions: async () => ({ location: 'denied' }) });
  await h.host.boot();
  await h.host.start();
  expect(await readDropNotice(db)).not.toBeNull();
});
