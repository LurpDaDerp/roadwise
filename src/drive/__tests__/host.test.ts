/** @jest-environment node */
import { createFakeDriveSense } from '@drive-sense';

import { createDetectors } from '@/core/detectors';
import { createSession } from '@/core/engine/session';
import { IDLE_END_S } from '@scoring';

import type { AlertDecision } from '@/core/alerts/types';
import type { AlertPlayer } from '@/core/alerts/player';
import { T0 } from '@/core/detectors/__fixtures__/rows';
import { rows, TZ } from '@/core/engine/__fixtures__/drives';
import type { LimitSample } from '@/core/engine/types';
import type { SpeedLimitClient } from '@/core/speedLimits/client';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createEventsRepo, createQueueRepo, createSettingsRepo, createTripsRepo, migrate, type Db } from '@/data/db';
import type { DriveDisplay, DriveDisplayState } from '@/drive/display';
import { readDropNotice, writeDropNotice } from '@/drive/dropNotice';
import { createDriveHost, type DriveHost, type DriveState } from '@/drive/host';
import type { Scheduler } from '@/drive/ticks';
import { metersToMiles } from '@/lib/units';

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

test('start: refuses without location, before boot, or while busy; otherwise starts the capture and the drive', async () => {
  const h = build();
  expect(await h.host.start()).toEqual({ ok: false, reason: 'error' });
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

// Pins Start Drive at any speed (product spec, Starting and ending a drive): the tap reads no speed,
// so whatever the car does next (no fix, stopped, 2.9, 3 or 60 mph) the drive is already open and
// the first row at that speed simply follows. Change this test only together with the spec.
const START_ANY_SPEED: [string, number | null][] = [
  ['an unknown speed (no fix)', null],
  ['stopped', 0],
  ['2.9 mph', 2.9 * 0.44704],
  ['exactly 3 mph', 3 * 0.44704],
  ['60 mph', 60 * 0.44704],
];
test.each(START_ANY_SPEED)('start with %s', async (_label, speedMps) => {
  const h = build();
  await h.host.boot();
  const result = await h.host.start();
  expect(result).toEqual({ ok: true, clientTripId: uuid(1) });
  expect(h.source.calls).toEqual(['startCapture:mounted']);
  expect(h.host.snapshot().status).toBe('recording');
  await feed(
    h,
    rows(1, speedMps === null ? { speedMps: 0, over: () => ({ gnssValid: false, speed: -1 }) } : { speedMps })
  );
  expect(h.host.snapshot()).toMatchObject({ status: 'recording', speedKnown: speedMps !== null, lockedOut: speedMps !== null && speedMps > 5 * 0.44704 });
  await h.host.stop({ endOpenTrip: true });
});

test('a start at 60 mph is locked out from its first row, with no dialog beyond the location check', async () => {
  let asked = 0;
  const h = build({
    permissions: async () => {
      asked += 1;
      return { location: 'granted' };
    },
  });
  await h.host.boot();
  expect(await h.host.start()).toMatchObject({ ok: true });
  expect(asked).toBe(1);
  expect(h.host.snapshot().lockedOut).toBe(false);
  await feed(h, rows(1, { speedMps: 60 * 0.44704 }));
  expect(h.host.snapshot().lockedOut).toBe(true);
  await h.host.stop({ endOpenTrip: true });
});

test.each([
  ['a scored drive ended 299 s before', 'scored', 299_000, true],
  ['a scored drive ended 300 s before', 'scored', 300_000, true],
  ['a scored drive ended 301 s before', 'scored', 301_000, false],
  ['a merged drive ended 60 s before (it was driven too)', 'merged', 60_000, true],
  ['a drive still recording (an orphan) "ended" 60 s before', 'recording', 60_000, false],
] as const)('a start after %s: whether it is a restart (no warm-up) is stored on the trip row', async (_label, status, agoMs, continues) => {
  await createTripsRepo(db).insert({ client_trip_id: uuid(50), started_at: T0 - 3_600_000, ended_at: T0 - agoMs, tz: TZ, status }, T0);
  const h = build();
  await h.host.boot();
  const started = await h.host.start();
  expect(started.ok).toBe(true);
  const id = started.ok ? started.clientTripId : '';
  expect((await createTripsRepo(db).get(id))!.continues).toBe(continues ? 1 : 0);
  await feed(h, rows(1, { speedMps: 0 }));
  await h.host.end();
  await h.host.stop({ endOpenTrip: false });
});

test('a first drive on the phone is no restart', async () => {
  const h = build();
  await h.host.boot();
  const started = await h.host.start();
  expect((await createTripsRepo(db).get(started.ok ? started.clientTripId : ''))!.continues).toBe(0);
  await h.host.stop({ endOpenTrip: true });
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
  expect(ended).toEqual({ clientTripId: uuid(1), dropped: null });
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

test('the automatic end: 15 min without movement ends the drive at its last movement (the one timer covers rows that stop coming); walking away ends a driven drive', async () => {
  const h = build();
  await h.host.boot();
  await h.host.start();
  await feed(h, rows(60, { speedMps: 15 }));
  await feed(h, rows(5, { speedMps: 0, t0: T0 + 60_000 }));
  expect(h.host.snapshot().autoEndAt).toBe(T0 + 60_000 + IDLE_END_S * 1000);
  // No more rows (a garage): the ticker fires; one timer only.
  clock = T0 + 60_000 + IDLE_END_S * 1000 + 1000;
  expect(h.scheduler.fire()).toBe(1);
  await h.host.untilIdle();
  expect(h.host.snapshot().status).toBe('idle');
  const trip = (await createTripsRepo(db).get(uuid(1)))!;
  expect(trip.ended_at).toBe(T0 + 60_000);
  expect(trip.miles).toBeCloseTo(metersToMiles(59 * 15), 3);
  expect(h.source.calls.at(-1)).toBe('stopCapture');

  await h.host.start();
  const t2 = clock;
  await feed(h, rows(40, { speedMps: 15, t0: t2 }));
  // A report after the fast rows (not a walk from before driving speed)…
  h.source.emit('activity', { type: 'walking', confidence: 'high', ts: t2 + 40_000 });
  await h.host.settled();
  // …that two more rows at 34 mph cancel (a misfire),
  await feed(h, rows(2, { speedMps: 15, t0: t2 + 40_000 }));
  // and a stop does not revive.
  await feed(h, rows(25, { speedMps: 0.5, t0: t2 + 42_000 }));
  expect(h.host.snapshot().status).toBe('recording');
  // A real walk-off, reported after the row at +66 s, ends the drive 20 s later.
  h.source.emit('activity', { type: 'walking', confidence: 'high', ts: t2 + 50_000 });
  await h.host.settled();
  await feed(h, rows(19, { speedMps: 0.5, t0: t2 + 67_000 }));
  expect(h.host.snapshot().status).toBe('recording');
  await feed(h, rows(1, { speedMps: 0.5, t0: t2 + 86_000 }));
  await h.host.untilIdle();
  expect(h.host.snapshot().status).toBe('idle');
  const second = (await createTripsRepo(db).get(uuid(2)))!;
  // Cut at the last movement at or before the walk: the last fast row (+41 s) ends at +42 s.
  expect(second).toMatchObject({ status: 'pending', end_cause: 'walking', ended_at: t2 + 42_000 });
  await h.host.stop({ endOpenTrip: false });
});

describe('motion activity reports reach the engine through parseActivity', () => {
  test('the walk to the car as the feed’s first report (delivered on a microtask) never ends the drive that then drives', async () => {
    const source = createFakeDriveSense({ platform: 'ios', now: () => clock, asyncDelivery: true });
    source.setState({ location: 'whenInUse', motion: 'granted', lockSignal: 'reliable' });
    const h = build({ source });
    await h.host.boot();
    await h.host.start();
    h.source.emit('activity', { type: 'walking', confidence: 'medium', ts: T0 - 30_000 });
    await Promise.resolve();
    await h.host.settled();
    await feed(h, rows(5, { speedMps: 0, t0: T0 }));
    await feed(h, rows(60, { speedMps: 15, t0: T0 + 5000 }));
    await feed(h, rows(60, { speedMps: 0, t0: T0 + 65_000 }));
    expect(h.host.snapshot().status).toBe('recording');
    expect(h.errors).toEqual([]);
    await h.host.stop({ endOpenTrip: true });
  });

  test('a malformed payload is dropped without a word; a valid one still counts', async () => {
    const h = build();
    await h.host.boot();
    await h.host.start();
    await feed(h, rows(60, { speedMps: 15 }));
    await feed(h, rows(5, { speedMps: 0, t0: T0 + 60_000 }));
    for (const bad of [null, 'walking', { type: 'walking', confidence: 'high' }, { type: 'walking', confidence: 'sure', ts: T0 + 62_000 }, { type: 'walk', confidence: 'high', ts: T0 + 62_000 }]) {
      h.source.emit('activity', bad as never);
    }
    await h.host.settled();
    await feed(h, rows(30, { speedMps: 0, t0: T0 + 65_000 }));
    expect(h.host.snapshot().status).toBe('recording');
    expect(h.errors).toEqual([]);
    h.source.emit('activity', { type: 'running', confidence: 'high', ts: T0 + 62_000, extra: 1 } as never);
    await h.host.settled();
    await feed(h, rows(21, { speedMps: 0, t0: T0 + 95_000 }));
    await h.host.untilIdle();
    expect((await createTripsRepo(db).get(uuid(1)))!).toMatchObject({ end_cause: 'walking', ended_at: T0 + 60_000 });
    expect(h.errors).toEqual([]);
    await h.host.stop({ endOpenTrip: false });
  });

  test('with motion not allowed no report comes, and the drive ends only by the 15 min rule', async () => {
    const h = build();
    h.source.setState({ location: 'whenInUse', motion: 'denied', lockSignal: 'reliable' });
    await h.host.boot();
    await h.host.start();
    await feed(h, rows(60, { speedMps: 15 }));
    await feed(h, rows(120, { speedMps: 0, t0: T0 + 60_000 }));
    expect(h.host.snapshot().status).toBe('recording');
    expect(h.host.snapshot().autoEndAt).toBe(T0 + 60_000 + IDLE_END_S * 1000);
    await h.host.stop({ endOpenTrip: false });
  });

  test('the background display shows 0 for a crawl below its own accuracy (S2), and the speed otherwise', async () => {
    const h = build();
    await h.host.boot();
    await h.host.start();
    await feed(h, rows(1, { speedMps: 0.8, over: () => ({ speedAcc: 1 }) }));
    expect(h.display.log.at(-1)).toMatch(/^update 0\//);
    expect(h.host.snapshot()).toMatchObject({ speedMps: 0, speedKnown: true });
    await feed(h, rows(1, { speedMps: 3, t0: T0 + 1000, over: () => ({ speedAcc: 1 }) }));
    expect(h.host.snapshot().speedMps).toBe(3);
    await h.host.stop({ endOpenTrip: false });
  });
});

describe('the Android notification’s End drive', () => {
  test('while recording it ends the drive by hand at the tap', async () => {
    const h = build();
    await h.host.boot();
    await h.host.start();
    await feed(h, rows(30, { speedMps: 15 }));
    await feed(h, rows(30, { speedMps: 0, t0: T0 + 30_000 }));
    h.source.emit('notificationAction', { action: 'endDrive', ts: clock });
    await h.host.untilIdle();
    const trip = (await createTripsRepo(db).get(uuid(1)))!;
    expect(trip).toMatchObject({ status: 'pending', end_cause: 'manual', ended_at: clock });
    await h.host.stop({ endOpenTrip: false });
  });

  test('after 3 min standing still it is cut at the last movement', async () => {
    const h = build();
    await h.host.boot();
    await h.host.start();
    await feed(h, rows(30, { speedMps: 15 }));
    await feed(h, rows(180, { speedMps: 0, t0: T0 + 30_000 }));
    h.source.emit('notificationAction', { action: 'endDrive', ts: clock });
    await h.host.untilIdle();
    expect((await createTripsRepo(db).get(uuid(1)))!).toMatchObject({ end_cause: 'manual_still', ended_at: T0 + 30_000 });
    await h.host.stop({ endOpenTrip: false });
  });

  test('nothing while idle; a tap from before this drive is ignored; a second tap while closing finalizes once', async () => {
    const h = build();
    await h.host.boot();
    h.source.emit('notificationAction', { action: 'endDrive', ts: clock });
    await h.host.settled();
    expect(h.host.snapshot().status).toBe('idle');
    await h.host.start();
    await feed(h, rows(30, { speedMps: 15 }));
    h.source.emit('notificationAction', { action: 'endDrive', ts: T0 - 1 });
    await h.host.settled();
    expect(h.host.snapshot().status).toBe('recording');
    h.source.emit('notificationAction', { action: 'endDrive', ts: clock });
    h.source.emit('notificationAction', { action: 'endDrive', ts: clock });
    await h.host.untilIdle();
    expect(await createTripsRepo(db).count()).toBe(1);
    expect(h.host.snapshot().status).toBe('idle');
    expect(h.errors).toEqual([]);
    await h.host.stop({ endOpenTrip: false });
  });
});

describe('a drive that never moved is not kept', () => {
  test('the hold: end() says dropped, the display ends, the capture stops, Home gets the notice; no trip row is left', async () => {
    const h = build();
    await h.host.boot();
    await h.host.start();
    await feed(h, rows(10, { speedMps: 0 }));
    clock = T0 + 20_000;
    expect(await h.host.end()).toEqual({ clientTripId: uuid(1), dropped: 'no_movement' });
    expect(h.host.snapshot().lastFinalized).toMatchObject({ clientTripId: uuid(1), ok: true, status: null, pointsNet: null, dropped: 'no_movement', endCause: 'manual' });
    expect(h.display.log.at(-1)).toBe('end');
    expect(h.source.calls.at(-1)).toBe('stopCapture');
    expect(await readDropNotice(db)).toEqual({ clientTripId: uuid(1), cause: 'manual', reason: 'no_movement', at: T0 + 20_000 });
    expect(await createTripsRepo(db).get(uuid(1))).toBeNull();
    expect(await createQueueRepo(db).countByStatus('pending')).toBe(0);
    await h.host.stop({ endOpenTrip: false });
  });

  test('a drive that moved but never reached driving speed (a jog at 8 mph) is dropped as not_driven, by hand or on foot', async () => {
    const h = build();
    await h.host.boot();
    await h.host.start();
    await feed(h, rows(60, { speedMps: 3.58 }));
    clock = T0 + 60_000;
    expect(await h.host.end()).toEqual({ clientTripId: uuid(1), dropped: 'not_driven' });
    expect(await readDropNotice(db)).toEqual({ clientTripId: uuid(1), cause: 'manual', reason: 'not_driven', at: T0 + 60_000 });
    expect(await createTripsRepo(db).get(uuid(1))).toBeNull();
    // Started while walking to the car, then 10 min on foot with the walk reported: ended and dropped.
    clock = T0 + 100_000;
    await h.host.start();
    h.source.emit('activity', { type: 'walking', confidence: 'high', ts: T0 + 90_000 });
    await h.host.settled();
    await feed(h, rows(600, { speedMps: 1.4, t0: T0 + 100_000 }));
    await h.host.untilIdle();
    expect(h.host.snapshot().lastFinalized).toMatchObject({ clientTripId: uuid(2), endCause: 'walking', dropped: 'no_movement' });
    expect(await readDropNotice(db)).toMatchObject({ clientTripId: uuid(2), cause: 'walking' });
    expect(await createTripsRepo(db).count()).toBe(0);
    expect(await createQueueRepo(db).countByStatus('pending')).toBe(0);
    await h.host.stop({ endOpenTrip: false });
  });

  test('the automatic end with no rows at all: dropped (no GPS) and the notice names the automatic end', async () => {
    const h = build();
    await h.host.boot();
    await h.host.start();
    clock = T0 + IDLE_END_S * 1000 + 1000;
    expect(h.scheduler.fire()).toBe(1);
    await h.host.untilIdle();
    expect(h.host.snapshot().lastFinalized).toMatchObject({ dropped: 'no_gps', endCause: 'stopped' });
    expect(await readDropNotice(db)).toMatchObject({ cause: 'stopped', reason: 'no_gps' });
    await h.host.stop({ endOpenTrip: false });
  });

  test('a hold that lands while an automatic drop finalizes returns dropped for that drive', async () => {
    const h = build();
    await h.host.boot();
    await h.host.start();
    await feed(h, rows(3, { speedMps: 0 }));
    clock = T0 + IDLE_END_S * 1000 + 1000;
    h.scheduler.fire();
    expect(await h.host.end()).toEqual({ clientTripId: uuid(1), dropped: 'no_movement' });
    expect(h.host.snapshot().lastFinalized).toMatchObject({ endCause: 'stopped' });
    await h.host.stop({ endOpenTrip: false });
  });

  test('a successful start clears the notice; a refused one leaves it', async () => {
    await writeDropNotice(db, { clientTripId: 'old', cause: 'stopped', reason: 'no_movement', at: T0 - 1000 });
    const denied = build({ permissions: async () => ({ location: 'denied' }) });
    await denied.host.boot();
    expect(await denied.host.start()).toEqual({ ok: false, reason: 'permission' });
    expect(await readDropNotice(db)).not.toBeNull();
    await denied.host.stop({ endOpenTrip: false });
    const h = build();
    await h.host.boot();
    expect(await h.host.start()).toMatchObject({ ok: true });
    expect(await readDropNotice(db)).toBeNull();
    await h.host.stop({ endOpenTrip: true });
  });

  test('every sign-out takes the notice down: a forced one with uploads owed, and one the server ended', async () => {
    // The driver's own sign-out (forced or not) ends the session after recording stops; the
    // SIGNED_OUT that follows reaches the host as sessionEnded, whether or not the wipe ran.
    await writeDropNotice(db, { clientTripId: 'old', cause: 'stopped', reason: 'no_movement', at: T0 - 1000 });
    const own = build();
    await own.host.boot();
    await own.host.suspendForSignOut();
    expect(await readDropNotice(db)).not.toBeNull(); // the driver may still back out here
    await own.host.sessionEnded();
    expect(await readDropNotice(db)).toBeNull();
    await own.host.stop({ endOpenTrip: false });

    // A session the driver did not end (revoked or expired): only sessionEnded.
    await writeDropNotice(db, { clientTripId: 'old', cause: 'stopped', reason: 'no_movement', at: T0 - 1000 });
    const server = build();
    await server.host.boot();
    await server.host.sessionEnded();
    expect(await readDropNotice(db)).toBeNull();
    await server.host.stop({ endOpenTrip: false });
  });

  test('a drive dropped by the sign-out itself leaves no notice behind', async () => {
    const h = build();
    await h.host.boot();
    await h.host.start();
    await feed(h, rows(5, { speedMps: 0 }));
    await h.host.suspendForSignOut();
    expect(h.host.snapshot().lastFinalized).toMatchObject({ dropped: 'no_movement' });
    await h.host.sessionEnded();
    expect(await readDropNotice(db)).toBeNull();
    await h.host.stop({ endOpenTrip: false });
  });

  test('a sign-out the driver backs out of keeps the notice', async () => {
    await writeDropNotice(db, { clientTripId: 'old', cause: 'stopped', reason: 'no_movement', at: T0 - 1000 });
    const h = build();
    await h.host.boot();
    await h.host.suspendForSignOut();
    await h.host.resumeAfterSignIn();
    expect(await readDropNotice(db)).not.toBeNull();
    await h.host.stop({ endOpenTrip: false });
  });

  test('a kept drive’s end() says dropped: null and writes no notice', async () => {
    const h = build();
    await h.host.boot();
    await h.host.start();
    await feed(h, rows(30, { speedMps: 15 }));
    expect(await h.host.end()).toEqual({ clientTripId: uuid(1), dropped: null });
    expect(h.host.snapshot().lastFinalized).toMatchObject({ dropped: null, status: 'pending', endCause: 'manual' });
    expect(await readDropNotice(db)).toBeNull();
    await h.host.stop({ endOpenTrip: false });
  });
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

test('an Android drive with navigation in front sounds no phone alert and stores no phone event', async () => {
  const h = build();
  await h.host.boot();
  await h.host.start();
  await feed(h, rows(120, { speedMps: 15, over: () => ({ locked: false, screenOn: true, appForeground: false }) }));
  await feed(h, rows(3, { speedMps: 15, t0: T0 + 120_000 }));
  const phone = (kind: string): boolean => kind === 'phone_pickup' || kind === 'phone_handling';
  expect(h.player.delivered.filter((d) => phone(d.kind))).toEqual([]);
  await h.host.stop({ endOpenTrip: true });
  expect((await createEventsRepo(db).listByTrip(uuid(1))).filter((e) => phone(e.type))).toEqual([]);
  expect(h.errors).toEqual([]);
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

describe('the DashPal hooks (plan §7.7)', () => {
  function fakeDashcam() {
    const log: string[] = [];
    let continuous = false;
    let on = false;
    return {
      log,
      setContinuous: (v: boolean) => (continuous = v),
      setOn: (v: boolean) => (on = v),
      hooks: {
        row: (_row: unknown, d: { clientTripId: string | null; recording: boolean; dryRun: boolean }) => log.push(`row:${d.recording}:${d.clientTripId}:${d.dryRun}`),
        adopt: async (id: string) => void log.push(`adopt:${id}`),
        estimateOn: (id: string | null) => {
          log.push(`estimate:${id}`);
          return on;
        },
        beforeFinalize: async (id: string, o: { dryRun: boolean }) => void log.push(`beforeFinalize:${id}:${o.dryRun}`),
        continuousAlertActive: () => continuous,
      },
    };
  }

  test('every row reaches the dashcam with the drive; the drive end waits for it before finalizing; a phone alert during a DashPal continuous alert is haptic + visual only', async () => {
    const dc = fakeDashcam();
    const h = build({ dashcam: dc.hooks });
    await h.host.boot();
    await h.host.start();
    await feed(h, rows(40, { speedMps: 15 }));
    expect(dc.log.filter((l) => l.startsWith('row:'))).toHaveLength(40);
    expect(dc.log[0]).toBe(`row:true:${uuid(1)}:false`);
    dc.setContinuous(true);
    await feed(h, rows(10, { speedMps: 22, t0: T0 + 40_000 }));
    expect(h.player.delivered.map((d) => [d.kind, d.silent ?? false])).toEqual([['speeding', true]]);
    // The stopped estimate asks whether this is a DashPal drive so far.
    await feed(h, rows(5, { speedMps: 0, t0: T0 + 50_000 }));
    expect(dc.log).toContain(`estimate:${uuid(1)}`);
    await h.host.end();
    expect(dc.log.at(-1)).toBe(`beforeFinalize:${uuid(1)}:false`);
    expect((await createTripsRepo(db).get(uuid(1)))?.status).toBe('pending');
    await h.host.stop({ endOpenTrip: false });
  });

  test('a failing hook never stops the drive', async () => {
    const h = build({
      dashcam: {
        row: () => {
          throw new Error('row boom');
        },
        adopt: async () => {},
        estimateOn: () => {
          throw new Error('estimate boom');
        },
        beforeFinalize: async () => {
          throw new Error('finalize boom');
        },
        continuousAlertActive: () => {
          throw new Error('alert boom');
        },
      },
    });
    await h.host.boot();
    await h.host.start();
    await feed(h, rows(40, { speedMps: 15 }));
    await feed(h, rows(10, { speedMps: 22, t0: T0 + 40_000 }));
    await feed(h, rows(5, { speedMps: 0, t0: T0 + 50_000 }));
    await h.host.end();
    expect((await createTripsRepo(db).get(uuid(1)))?.status).toBe('pending');
    expect(h.player.delivered.map((d) => d.kind)).toEqual(['speeding']);
    expect(h.errors.some((e) => e.includes('boom'))).toBe(true);
  });
});

test('every native row first pumps the timers (Android pauses JS timers in the background); a throwing pump is reported and the row still counts', async () => {
  let pumps = 0;
  let throwOnce = true;
  const h = build({
    pump: () => {
      pumps += 1;
      if (throwOnce) {
        throwOnce = false;
        throw new Error('timer callback');
      }
    },
  });
  await h.host.boot();
  await h.host.start();
  await feed(h, rows(5, { speedMps: 15 }));
  expect(pumps).toBe(5);
  expect(h.errors).toContain('timers: timer callback');
  const list = rows(5, { speedMps: 15 });
  expect(h.host.snapshot().lastRowTs).toBe(list[4]!.ts);
  await h.host.stop({ endOpenTrip: false });
});
