/** @jest-environment node */
import { createFakeDriveSense } from '@drive-sense';

import { createDetectors } from '@/core/detectors';
import { createSession } from '@/core/engine/session';
import { AUTO_END_STOPPED_S } from '@scoring';

import type { AlertDecision } from '@/core/alerts/types';
import type { AlertPlayer } from '@/core/alerts/player';
import { T0 } from '@/core/detectors/__fixtures__/rows';
import { rows, TZ } from '@/core/engine/__fixtures__/drives';
import type { LimitSample } from '@/core/engine/types';
import type { SpeedLimitClient } from '@/core/speedLimits/client';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createEventsRepo, createQueueRepo, createSettingsRepo, createTripsRepo, migrate, type Db } from '@/data/db';
import type { DriveDisplay, DriveDisplayState } from '@/drive/display';
import { createDriveHost, type DriveHost, type DriveState } from '@/drive/host';
import type { Scheduler } from '@/drive/ticks';

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

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

function fakePlayer(): AlertPlayer & { delivered: AlertDecision[] } {
  const delivered: AlertDecision[] = [];
  return {
    delivered,
    deliver: async (d) => {
      delivered.push(d);
    },
    stopCurrent: async () => {},
    announce: async () => {},
  };
}

function fakeDisplay(): DriveDisplay & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    start: (s: DriveDisplayState) => log.push(`start ${s.speed}`),
    update: (s: DriveDisplayState) => log.push(`update ${s.speed}/${s.limit}/${s.points}${s.unit === 'km/h' ? ' km/h' : ''}`),
    end: () => log.push('end'),
  };
}

/** A manual scheduler: timers fire only when the test says. */
function manualScheduler(): Scheduler & { fire(): number } {
  const timers = new Map<number, () => void>();
  let n = 0;
  return {
    setTimeout(fn) {
      timers.set((n += 1), fn);
      return n;
    },
    clearTimeout(h) {
      timers.delete(h as number);
    },
    fire() {
      const fns = [...timers.values()];
      timers.clear();
      fns.forEach((f) => f());
      return fns.length;
    },
  };
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

function build(over: Partial<Parameters<typeof createDriveHost>[0]> = {}) {
  const source = createFakeDriveSense({ platform: 'android', now: () => clock });
  source.setState({ location: 'whenInUse', motion: 'granted', lockSignal: 'reliable' });
  const player = fakePlayer();
  const display = fakeDisplay();
  const scheduler = manualScheduler();
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
    speedProbe: async () => 0,
    permissions: async () => ({ location: 'granted' }),
    context: async () => ({ streak: 4, safeMilesEarlierToday: 0 }),
    scheduler,
    onError: (e, ctx) => errors.push(`${ctx}: ${e instanceof Error ? e.message : String(e)}`),
    ...over,
  });
  return { host, source, player, display, scheduler, errors };
}

/** Feed `list` rows through the fake, advancing the clock to each row. */
async function feed(h: { host: DriveHost; source: ReturnType<typeof createFakeDriveSense> }, list: ReturnType<typeof rows>): Promise<void> {
  h.source.loadTrace(list);
  for (const r of list) {
    clock = r.ts;
    h.source.step();
    await h.host.settled();
  }
}

test('start: refuses while moving, without location, before boot, or while busy; otherwise starts the capture and the drive', async () => {
  const h = build({ speedProbe: async () => 2 });
  expect(await h.host.start()).toEqual({ ok: false, reason: 'error' });
  await h.host.boot();
  expect(await h.host.start()).toEqual({ ok: false, reason: 'moving' });
  expect(h.source.calls).toEqual([]);

  const denied = build({ permissions: async () => ({ location: 'denied' }) });
  await denied.host.boot();
  expect(await denied.host.start()).toEqual({ ok: false, reason: 'permission' });

  const ok = build();
  await ok.host.boot();
  const started = await ok.host.start();
  expect(started).toEqual({ ok: true, clientTripId: uuid(1) });
  expect(ok.source.calls).toEqual(['startCapture:mounted']);
  expect(ok.host.snapshot()).toMatchObject({ status: 'recording', lockedOut: false, points: null, dryRun: false });
  expect(ok.display.log[0]).toBe('start null');
  expect(await ok.host.start()).toEqual({ ok: false, reason: 'busy' });
  await ok.host.stop({ endOpenTrip: true });
});

test('a drive: rows publish at most once each, the display updates on change, points show only while stopped, end finalizes and queues', async () => {
  const h = build();
  await h.host.boot();
  await h.host.start();
  const published: DriveState[] = [];
  h.host.subscribe((s) => published.push(s));
  const list = rows(120, { speedMps: 15 });
  await feed(h, list);
  expect(published.filter((s) => s.status === 'recording').length).toBeGreaterThanOrEqual(120);
  expect(h.host.snapshot()).toMatchObject({ speedKnown: true, limitMph: 35, lockedOut: true, stopped: false, points: null });
  expect(h.display.log.filter((l) => l.startsWith('update'))).toContain('update 34/35/null');
  // Stopped at a light: the points estimate appears once, with the change since the last stop.
  await feed(h, rows(3, { speedMps: 0, t0: T0 + 120_000 }));
  const snap = h.host.snapshot();
  expect(snap.stopped).toBe(true);
  expect(snap.points).toEqual({ total: expect.any(Number), sinceLastStop: snap.points!.total });
  expect(h.display.log.at(-1)).toMatch(/update 0\/35\/\d+/);
  clock = T0 + 124_000;
  const ended = await h.host.end();
  expect(ended).toEqual({ clientTripId: uuid(1) });
  expect(h.host.snapshot().status).toBe('idle');
  expect(h.host.snapshot().lastFinalized).toMatchObject({ clientTripId: uuid(1), ok: true, status: 'pending' });
  expect(h.source.calls.at(-1)).toBe('stopCapture');
  expect(h.display.log.at(-1)).toBe('end');
  const trip = (await createTripsRepo(db).get(uuid(1)))!;
  expect(trip).toMatchObject({ status: 'pending', estimate: 1 });
  expect(trip.miles).toBeCloseTo(1.1, 1);
  expect(await createQueueRepo(db).countByStatus('pending')).toBe(1);
  expect(h.errors).toEqual([]);
  await h.host.stop({ endOpenTrip: false });
});

test('points clear the moment the stop is no longer confirmed, even with the fix lost while pulling away', async () => {
  const h = build();
  await h.host.boot();
  await h.host.start();
  await feed(h, rows(60, { speedMps: 15 }));
  await feed(h, rows(3, { speedMps: 0, t0: T0 + 60_000 }));
  expect(h.host.snapshot().points).not.toBeNull();
  expect(h.display.log.at(-1)).toMatch(/update 0\/35\/\d+$/);
  // Pulling away under a bridge: no fix, so no known speed — and no points on any surface.
  await feed(h, rows(3, { speedMps: 15, t0: T0 + 63_000, over: () => ({ gnssValid: false, speed: -1, hAcc: -1 }) }));
  const snap = h.host.snapshot();
  expect(snap).toMatchObject({ speedKnown: false, stopped: false, points: null });
  expect(h.display.log.at(-1)).toBe('update null/null/null'); // no fix: no speed, no limit, no points
  await h.host.stop({ endOpenTrip: true });
});

test('the background display follows the driver\'s units: km/h with speed and limit converted, read as the drive starts', async () => {
  await createSettingsRepo(db).set('units', 'km');
  const h = build();
  await h.host.boot();
  await h.host.start();
  expect(h.display.log[0]).toBe('start null');
  await feed(h, rows(5, { speedMps: 15 }));
  // 15 m/s = 33.6 mph = 54 km/h; the 35 mph limit reads 56 km/h.
  expect(h.display.log.at(-1)).toBe('update 54/56/null km/h');
  await h.host.stop({ endOpenTrip: true });
  // Switching to miles applies to the next drive, not the one under way.
  await createSettingsRepo(db).set('units', 'mi');
  const m = build();
  await m.host.boot();
  await m.host.start();
  await feed(m, rows(5, { speedMps: 15, t0: T0 + 100_000 }));
  expect(m.display.log.at(-1)).toBe('update 34/35/null');
  await m.host.stop({ endOpenTrip: true });
});

test('auto-end: 300 s stopped ends the drive where it stopped (the one timer covers a lost fix); walking ends a slow drive', async () => {
  const h = build();
  await h.host.boot();
  await h.host.start();
  await feed(h, rows(60, { speedMps: 15 }));
  await feed(h, rows(5, { speedMps: 0, t0: T0 + 60_000 }));
  expect(h.host.snapshot().stoppedSinceTs).toBe(T0 + 60_000);
  // No more rows (a garage): the ticker's deadline fires.
  clock = T0 + 60_000 + AUTO_END_STOPPED_S * 1000 + 2000;
  expect(h.scheduler.fire()).toBe(1);
  await h.host.untilIdle();
  expect(h.host.snapshot().status).toBe('idle');
  const trip = (await createTripsRepo(db).get(uuid(1)))!;
  expect(trip.ended_at).toBe(T0 + 60_000);

  await h.host.start();
  await feed(h, rows(40, { speedMps: 15, t0: clock }));
  h.source.emit('activity', { type: 'walking', confidence: 'high', ts: clock });
  await h.host.settled();
  expect(h.host.snapshot().status).toBe('recording'); // at 34 mph a walk report is a misfire
  await feed(h, rows(3, { speedMps: 0.5, t0: clock + 40_000 }));
  h.source.emit('activity', { type: 'walking', confidence: 'high', ts: clock + 43_000 });
  await h.host.untilIdle();
  expect(h.host.snapshot().status).toBe('idle');
  expect((await createTripsRepo(db).list())[0]!.client_trip_id).toBe(uuid(2));
  await h.host.stop({ endOpenTrip: false });
});

test('alerts go to the player as decisions (one speeding chime); a hands-free call suppresses phone events', async () => {
  const h = build();
  await h.host.boot();
  await h.host.start();
  await feed(h, rows(40, { speedMps: 15 }));
  await feed(h, rows(10, { speedMps: 22, t0: T0 + 40_000 })); // 49 mph on a 35: moderate
  await feed(h, rows(10, { speedMps: 15, t0: T0 + 50_000 }));
  expect(h.player.delivered.map((d) => d.kind)).toEqual(['speeding']);
  expect(h.host.snapshot().lastAlert).toMatchObject({ type: 'speeding', tier: 'moderate' });
  h.source.emit('call', { active: true, ts: clock });
  await feed(h, rows(10, { speedMps: 15, t0: T0 + 60_000, over: () => ({ handlingScore: 0.9, gravityStability: 0.5 }) }));
  await feed(h, rows(3, { speedMps: 15, t0: T0 + 70_000 }));
  expect(h.player.delivered.map((d) => d.kind)).toEqual(['speeding']);
  expect(h.host.snapshot().callActive).toBe(true);
  await h.host.stop({ endOpenTrip: true });
  expect(await createEventsRepo(db).listByTrip(uuid(1))).toHaveLength(1);
});

test('an adopted drive (recovery after a restart) shows the driver’s units too', async () => {
  await createSettingsRepo(db).set('units', 'km');
  const session = createSession({ clientTripId: uuid(1), startedAt: T0 - 60_000 });
  const h = build();
  await h.host.boot({ adopt: { session, detectors: createDetectors(() => 'x') } });
  expect(h.host.snapshot().status).toBe('recording');
  expect(h.display.log[0]).toBe('start null');
  await feed(h, rows(5, { speedMps: 15 }));
  expect(h.display.log.at(-1)).toBe('update 54/56/null km/h');
  await h.host.stop({ endOpenTrip: true });
});

test('boot adopts a rebuilt drive and keeps recording it; a sign-out ends an open drive', async () => {
  const h = build();
  const session = createSession({ clientTripId: uuid(9), startedAt: T0 - 60_000 });
  await h.host.boot({ adopt: { session, detectors: createDetectors(() => 'x') } });
  expect(h.host.snapshot()).toMatchObject({ status: 'recording', clientTripId: uuid(9) });
  expect(h.source.calls).toEqual(['startCapture:mounted']);
  await feed(h, rows(5, { speedMps: 15 }));
  await h.host.suspendForSignOut();
  expect(h.host.snapshot().status).toBe('idle');
  expect(h.host.signedIn()).toBe(true); // the sign-out is still settling
  h.host.signOutCompleted();
  expect(h.host.signedIn()).toBe(false);
  expect(await h.host.start()).toEqual({ ok: false, reason: 'error' });
  await h.host.resumeAfterSignIn();
  expect(h.host.signedIn()).toBe(true);
  await h.host.stop({ endOpenTrip: false });
});
