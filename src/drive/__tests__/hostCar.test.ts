/**
 * The drive host's car link (iPhone, round 14) over the fake detector: the drive's car stored on the
 * trip, "Are you driving?" (posted once when every rule holds, taken down when the car connects or
 * the drive ends; a tap's cancel accepted), and "Where you parked" (stored only after the paired car
 * left with the car stopped and the driver walked away).
 */
import { createFakeDriveDetect, createFakeDriveSense, type CarOutput, type DriveDetectApi, type MotionActivity } from '@drive-sense';

import type { AlertPlayer } from '@/core/alerts/player';
import type { RadioState } from '@/core/permissions/adapters';
import { T0 } from '@/core/detectors/__fixtures__/rows';
import { rows, START, TZ } from '@/core/engine/__fixtures__/drives';
import type { FeatureRow, LimitSample } from '@/core/engine/types';
import type { SpeedLimitClient } from '@/core/speedLimits/client';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createSettingsRepo, createTripsRepo, migrate, type Db } from '@/data/db';
import { createDriveHost } from '@/drive/host';
import { PASSENGER_ASKED_KEY } from '@/drive/passengerCheck';
import type { PassengerNotePort } from '@/drive/passengerNote';
import type { Scheduler } from '@/drive/ticks';
import { PARKED_KEY, readParkedSpot, writeParkedSpot } from '@/features/parked/model';

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NATIVE = '11111111-1111-4111-8111-111111111111';
const civic: CarOutput = { uid: '00:11:22:33:44:55-tacl', name: 'Civic', type: 'bluetoothA2DP' };
const pods: CarOutput = { uid: 'AA:BB:CC:DD:EE:FF-tacl', name: 'AirPods', type: 'bluetoothA2DP' };
const M_PER_DEG_LNG = 111_194.93 * Math.cos((START.lat * Math.PI) / 180);

function fakeLimits(): SpeedLimitClient {
  const sample: LimitSample = { limitMps: 35 * 0.44704, source: 'posted', matchConfidence: 0.95, parallelRoads: false };
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

const player: AlertPlayer = { deliver: async () => {}, stopCurrent: async () => {}, announce: async () => {}, release: async () => {} };

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
      fns.forEach((fn) => fn());
      return fns.length;
    },
  };
}

function fakeAppState(initial: string) {
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

function fakeNote(bt: RadioState | null = 'on', allowed = true): PassengerNotePort & { log: string[]; bt: RadioState | null } {
  const log: string[] = [];
  const n = {
    log,
    bt,
    bluetooth: async () => n.bt,
    notificationsAllowed: async () => allowed,
    post: async (id: string) => void log.push(`post ${id}`),
    remove: async (id: string) => void log.push(`remove ${id}`),
  };
  return n;
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

type FakeSense = ReturnType<typeof createFakeDriveSense>;
type FakeDetect = ReturnType<typeof createFakeDriveDetect>;

/** `reuse`: the last process's native side (a relaunch: a fresh host over the same detector). */
function buildIos(opts: { appState?: string; note?: PassengerNotePort | null; reuse?: { source: FakeSense; detect: FakeDetect } } = {}) {
  let source: FakeSense;
  let detect: FakeDetect;
  if (opts.reuse !== undefined) {
    ({ source, detect } = opts.reuse);
  } else {
    const fresh = createFakeDriveSense({ platform: 'ios', now: () => clock });
    fresh.setState({ location: 'whenInUse', motion: 'granted', lockSignal: 'reliable' });
    const d = createFakeDriveDetect({ now: () => clock, sense: { emit: (e, p) => fresh.emit(e, p as never) } });
    const stop = fresh.stopCapture.bind(fresh);
    fresh.stopCapture = async (end) => {
      await stop(end);
      d.jsStop(end?.drivingEndedAt ?? clock);
    };
    source = fresh;
    detect = d;
  }
  const scheduler = manualScheduler();
  const appState = fakeAppState(opts.appState ?? 'active');
  const errors: string[] = [];
  const note = opts.note === undefined ? fakeNote() : opts.note;
  const host = createDriveHost({
    db,
    source,
    limits: fakeLimits(),
    player,
    now: () => clock,
    tz: () => TZ,
    newId: () => uuid((ids += 1)),
    appVersion: '2.0.0',
    permissions: async () => ({ location: 'granted' }),
    scheduler,
    appState,
    weather: async () => null,
    spots: { readWatchSpots: async () => [] },
    detect: detect as DriveDetectApi,
    passengerNote: note,
    onError: (e, ctx) => errors.push(`${ctx}: ${e instanceof Error ? e.message : String(e)}`),
  });
  return { host, source, detect, scheduler, appState, errors, note };
}
type I = ReturnType<typeof buildIos>;

const flush = () => new Promise((r) => setTimeout(r, 0));

async function feedIos(h: I, list: readonly FeatureRow[]): Promise<void> {
  for (const r of list) {
    clock = r.ts;
    h.detect.emitRows([{ ...r } as Record<string, unknown>]);
    await h.host.settled();
  }
  await flush();
  await h.host.settled();
}

async function confirm(h: I, list: readonly FeatureRow[]): Promise<void> {
  clock = list.at(-1)!.ts + 1000;
  h.detect.confirm({ driveId: NATIVE, startedAt: list[0]!.ts, startSource: 'trace', startLat: list[0]!.lat, startLng: list[0]!.lng, rows: list.map((r) => ({ ...r }) as Record<string, unknown>) });
  await flush();
  await h.host.settled();
}

async function start(h: I): Promise<void> {
  await h.host.boot();
  await h.detect.setArmed(true, 'user-1');
  h.detect.wake();
  await confirm(h, rows(40, { speedMps: 15 }));
  expect(h.host.snapshot()).toMatchObject({ status: 'recording', clientTripId: NATIVE, origin: 'auto' });
}

async function pair(h: I, car: CarOutput): Promise<void> {
  h.detect.setCarRoute([car]);
  await h.detect.pairCar(car.uid);
}

/** A kept drive of a few days ago in `car`: the link is proven. */
async function provenIn(car: CarOutput, endedAt = T0 - 3 * 24 * 3600_000): Promise<void> {
  await createTripsRepo(db).insert({ client_trip_id: uuid(900), started_at: endedAt - 600_000, tz: TZ, status: 'scored' }, endedAt);
  await db.execute('UPDATE trips SET car_uid = ?, car_name = ?, ended_at = ? WHERE client_trip_id = ?', [car.uid, car.name, endedAt, uuid(900)]);
}

const activity = (h: I, type: MotionActivity['type'], confidence: MotionActivity['confidence'] = 'high') => h.source.emit('activity', { type, confidence, ts: clock } as never);

describe("the drive's car", () => {
  test('the paired car on the route for the whole drive is stored on the trip, by uid and name', async () => {
    const h = buildIos();
    await pair(h, civic);
    await start(h);
    await feedIos(h, rows(60, { t0: T0 + 40_000, speedMps: 15 }));
    await h.host.end();
    const trip = await createTripsRepo(db).get(NATIVE);
    expect(trip).toMatchObject({ car_uid: civic.uid, car_name: 'Civic' });
    await h.host.stop({ endOpenTrip: false });
  });

  test('no car when it was on the route for under half of it, or never; headphones are no car', async () => {
    const h = buildIos();
    await pair(h, civic);
    h.detect.setCarRoute([pods]);
    await start(h);
    await feedIos(h, rows(30, { t0: T0 + 40_000, speedMps: 15 }));
    // Connected for the last 20 s of a 90 s drive.
    h.detect.setCarRoute([civic]);
    await feedIos(h, rows(20, { t0: T0 + 70_000, speedMps: 15 }));
    await h.host.end();
    expect((await createTripsRepo(db).get(NATIVE))?.car_uid).toBeNull();
    await h.host.stop({ endOpenTrip: false });
  });
});

describe('"Are you driving?"', () => {
  /** An automatic drive behind, its paired car (proven) not on the route, 3 min past driving speed. */
  async function rideAlong(h: I): Promise<void> {
    await pair(h, civic);
    h.detect.setCarRoute([]);
    await provenIn(civic);
    await start(h);
    await feedIos(h, rows(200, { t0: T0 + 40_000, speedMps: 15 }));
  }

  test('posted once, with RoadWise behind, Bluetooth on and the link proven; the car connecting takes it down', async () => {
    const h = buildIos({ appState: 'background' });
    await rideAlong(h);
    const note = h.note as ReturnType<typeof fakeNote>;
    expect(note.log).toEqual([`post ${NATIVE}`]);
    expect(await createSettingsRepo(db).get(PASSENGER_ASKED_KEY)).toBe(NATIVE);
    // Its tap's cancel is accepted.
    expect(h.host.snapshot().notDrivingAvailable).toBe(true);
    await feedIos(h, rows(60, { t0: T0 + 240_000, speedMps: 15 }));
    expect(note.log).toEqual([`post ${NATIVE}`]);
    h.detect.setCarRoute([civic]);
    expect(note.log).toEqual([`post ${NATIVE}`, `remove ${NATIVE}`]);
    await h.host.end();
    expect(note.log).toEqual([`post ${NATIVE}`, `remove ${NATIVE}`]);
    expect(h.errors).toEqual([]);
    await h.host.stop({ endOpenTrip: false });
  });

  test('taken down when the drive ends; the tap stops the drive as "Not driving?" does', async () => {
    const h = buildIos({ appState: 'background' });
    await rideAlong(h);
    const note = h.note as ReturnType<typeof fakeNote>;
    expect(await h.host.cancelDrive()).toBe(true);
    expect(note.log).toEqual([`post ${NATIVE}`, `remove ${NATIVE}`]);
    expect(await createTripsRepo(db).get(NATIVE)).toBeNull();
    expect(h.host.snapshot().lastFinalized).toMatchObject({ dropped: 'cancelled' });
    await h.host.stop({ endOpenTrip: false });
  });

  test('with RoadWise in front it waits, and asks once it goes behind', async () => {
    const h = buildIos();
    await rideAlong(h);
    const note = h.note as ReturnType<typeof fakeNote>;
    expect(note.log).toEqual([]);
    h.appState.set('background');
    await feedIos(h, rows(2, { t0: T0 + 240_000, speedMps: 15 }));
    expect(note.log).toEqual([`post ${NATIVE}`]);
    await h.host.stop({ endOpenTrip: false });
  });

  test('never under 3 minutes at driving speed, or below 10 mph', async () => {
    const h = buildIos({ appState: 'background' });
    await pair(h, civic);
    h.detect.setCarRoute([]);
    await provenIn(civic);
    await start(h);
    await feedIos(h, rows(130, { t0: T0 + 40_000, speedMps: 15 }));
    // Past 3 minutes, crawling.
    await feedIos(h, rows(60, { t0: T0 + 170_000, speedMps: 4 }));
    expect((h.note as ReturnType<typeof fakeNote>).log).toEqual([]);
    await feedIos(h, rows(1, { t0: T0 + 230_000, speedMps: 15 }));
    expect((h.note as ReturnType<typeof fakeNote>).log).toEqual([`post ${NATIVE}`]);
    await h.host.stop({ endOpenTrip: false });
  });

  test('never with headphones (or any audio) on the route at any point', async () => {
    const h = buildIos({ appState: 'background' });
    await pair(h, civic);
    h.detect.setCarRoute([]);
    await provenIn(civic);
    await start(h);
    h.detect.setCarRoute([pods]);
    h.detect.setCarRoute([]);
    await feedIos(h, rows(200, { t0: T0 + 40_000, speedMps: 15 }));
    expect((h.note as ReturnType<typeof fakeNote>).log).toEqual([]);
    await h.host.stop({ endOpenTrip: false });
  });

  test('never when Bluetooth is off or unknown, or the notification permission is not given', async () => {
    for (const note of [fakeNote('off'), fakeNote(null), fakeNote('unauthorized'), fakeNote('on', false)]) {
      db = await createSqlJsDb();
      await migrate(db);
      await createSettingsRepo(db).set('device.lastUserId', 'user-1');
      clock = T0;
      const h = buildIos({ appState: 'background', note });
      await rideAlong(h);
      expect(note.log).toEqual([]);
      await h.host.stop({ endOpenTrip: false });
    }
  });

  test('never without a proven link (no kept drive in the car within 30 days), or with no paired car', async () => {
    const h = buildIos({ appState: 'background' });
    await pair(h, civic);
    h.detect.setCarRoute([]);
    await provenIn(civic, T0 - 31 * 24 * 3600_000);
    await start(h);
    await feedIos(h, rows(200, { t0: T0 + 40_000, speedMps: 15 }));
    expect((h.note as ReturnType<typeof fakeNote>).log).toEqual([]);
    await h.host.stop({ endOpenTrip: false });

    db = await createSqlJsDb();
    await migrate(db);
    await createSettingsRepo(db).set('device.lastUserId', 'user-1');
    clock = T0;
    const none = buildIos({ appState: 'background' });
    await start(none);
    await feedIos(none, rows(200, { t0: T0 + 40_000, speedMps: 15 }));
    expect((none.note as ReturnType<typeof fakeNote>).log).toEqual([]);
    await none.host.stop({ endOpenTrip: false });
  });

  test('RoadWise inactive (still in front: Control Center or a call over it) is not behind: it waits', async () => {
    const h = buildIos({ appState: 'inactive' });
    await rideAlong(h);
    const note = h.note as ReturnType<typeof fakeNote>;
    expect(note.log).toEqual([]);
    h.appState.set('background');
    await feedIos(h, rows(2, { t0: T0 + 240_000, speedMps: 15 }));
    expect(note.log).toEqual([`post ${NATIVE}`]);
    await h.host.stop({ endOpenTrip: false });
  });

  test('a drive taken up after a relaunch whose paired car left the route earlier (native "gone since"): never', async () => {
    const pre = buildIos({ appState: 'background' });
    await pair(pre, civic);
    await provenIn(civic);
    await start(pre);
    await pre.host.stop({ endOpenTrip: false });
    // The car's Bluetooth went mid-drive while RoadWise was away.
    pre.detect.setCarRoute([]);
    pre.detect.setCarGoneSince(T0 + 30_000);
    const h = buildIos({ appState: 'background', reuse: pre });
    await h.host.boot();
    await h.host.settled();
    expect(h.host.snapshot()).toMatchObject({ status: 'recording', clientTripId: NATIVE });
    await feedIos(h, rows(200, { t0: T0 + 40_000, speedMps: 15 }));
    expect((h.note as ReturnType<typeof fakeNote>).log).toEqual([]);
    await h.host.stop({ endOpenTrip: false });
  });

  test('posted, then RoadWise died and native ended the drive while it was away: the next launch takes the note down', async () => {
    const h = buildIos({ appState: 'background' });
    await rideAlong(h);
    expect((h.note as ReturnType<typeof fakeNote>).log).toEqual([`post ${NATIVE}`]);
    await h.host.stop({ endOpenTrip: false });
    clock += 5_000;
    h.detect.endFor('walking', clock);
    const note = fakeNote();
    const next = buildIos({ appState: 'background', note, reuse: h });
    await next.host.boot();
    await next.host.untilIdle();
    await flush();
    await next.host.settled();
    expect(note.log).toEqual([`remove ${NATIVE}`]);
    expect(await createSettingsRepo(db).get(PASSENGER_ASKED_KEY)).toBeNull();
    await next.host.stop({ endOpenTrip: false });
  });

  test('a note whose drive is gone (no drive taken in at all) is taken down at boot; the drive still recording keeps it', async () => {
    await createSettingsRepo(db).set(PASSENGER_ASKED_KEY, uuid(700));
    const h = buildIos({ appState: 'background' });
    await h.host.boot();
    await h.host.settled();
    await flush();
    expect((h.note as ReturnType<typeof fakeNote>).log).toEqual([`remove ${uuid(700)}`]);
    expect(await createSettingsRepo(db).get(PASSENGER_ASKED_KEY)).toBeNull();
    await h.host.stop({ endOpenTrip: false });

    // Asked on the drive that still records: kept through the relaunch, taken down as it ends.
    const ride = buildIos({ appState: 'background' });
    await rideAlong(ride);
    await ride.host.stop({ endOpenTrip: false });
    const note = fakeNote();
    const again = buildIos({ appState: 'background', note, reuse: ride });
    await again.host.boot();
    await again.host.settled();
    await flush();
    expect(note.log).toEqual([]);
    expect(await createSettingsRepo(db).get(PASSENGER_ASKED_KEY)).toBe(NATIVE);
    await feedIos(again, rows(40, { t0: T0 + 240_000, speedMps: 15 }));
    expect(note.log).toEqual([]);
    await again.host.end();
    expect(note.log).toEqual([`remove ${NATIVE}`]);
    await again.host.stop({ endOpenTrip: false });
  });

  test('never once "Not driving?" is used up (2 min on the driving screen)', async () => {
    const h = buildIos();
    await pair(h, civic);
    h.detect.setCarRoute([]);
    await provenIn(civic);
    await start(h);
    h.host.setHudVisible(true);
    await feedIos(h, rows(200, { t0: T0 + 40_000, speedMps: 15 }));
    expect(h.host.snapshot().notDrivingAvailable).toBe(false);
    h.appState.set('background');
    await feedIos(h, rows(5, { t0: T0 + 240_000, speedMps: 15 }));
    expect((h.note as ReturnType<typeof fakeNote>).log).toEqual([]);
    await h.host.stop({ endOpenTrip: false });
  });
});

describe('"Where you parked"', () => {
  /** A drive in the paired car, then 10 s stopped. */
  async function driveAndStop(h: I): Promise<void> {
    await pair(h, civic);
    await start(h);
    await feedIos(h, rows(60, { t0: T0 + 40_000, speedMps: 15 }));
    await feedIos(h, rows(10, { t0: T0 + 100_000, speedMps: 0 }));
  }

  test('stored after the car left the route stopped and the driver walked away for a minute', async () => {
    const h = buildIos();
    await driveAndStop(h);
    h.detect.setCarRoute([]);
    await feedIos(h, rows(3, { t0: T0 + 110_000, speedMps: 0 }));
    await h.host.end();
    clock += 5_000;
    activity(h, 'walking');
    await h.host.settled();
    expect(await readParkedSpot(db)).toBeNull();
    clock += 60_000;
    h.scheduler.fire();
    await h.host.settled();
    h.scheduler.fire();
    await h.host.settled();
    await flush();
    const spot = await readParkedSpot(db);
    const trip = await createTripsRepo(db).get(NATIVE);
    expect(spot).toMatchObject({ driveId: NATIVE, parkedAt: trip?.ended_at, label: trip?.to_label ?? null });
    expect(spot?.lat).toBeCloseTo(trip?.end_lat ?? 0, 3);
    expect(h.errors).toEqual([]);
    await h.host.stop({ endOpenTrip: false });
  });

  test('a watch still pending at a sign-out is dropped: the spot is not written after the wipe, nor after signing in again', async () => {
    const h = buildIos();
    await driveAndStop(h);
    h.detect.setCarRoute([]);
    await feedIos(h, rows(3, { t0: T0 + 110_000, speedMps: 0 }));
    await h.host.end();
    clock += 5_000;
    activity(h, 'walking');
    await h.host.settled();
    expect(await readParkedSpot(db)).toBeNull();
    await h.host.suspendForSignOut();
    // The sign-out wipe takes the key (the watch was still pending, so there is nothing yet).
    await createSettingsRepo(db).remove(PARKED_KEY);
    for (let i = 0; i < 3; i += 1) {
      clock += 60_000;
      h.scheduler.fire();
      await h.host.settled();
    }
    await flush();
    expect(await readParkedSpot(db)).toBeNull();
    await h.host.signedInAgain();
    for (let i = 0; i < 3; i += 1) {
      clock += 60_000;
      h.scheduler.fire();
      await h.host.settled();
    }
    await flush();
    expect(await readParkedSpot(db)).toBeNull();
    await h.host.stop({ endOpenTrip: false });
  });

  test('the car may leave up to 30 s after the end; later, or car motion after, or no walk: nothing', async () => {
    const h = buildIos();
    await driveAndStop(h);
    await h.host.end();
    clock += 20_000;
    h.detect.setCarRoute([]);
    clock += 2_000;
    activity(h, 'walking');
    await h.host.settled();
    clock += 60_000;
    h.scheduler.fire();
    await h.host.settled();
    await flush();
    expect(await readParkedSpot(db)).not.toBeNull();
    await h.host.stop({ endOpenTrip: false });

    for (const variant of ['late', 'automotive', 'still'] as const) {
      db = await createSqlJsDb();
      await migrate(db);
      await createSettingsRepo(db).set('device.lastUserId', 'user-1');
      clock = T0;
      const v = buildIos();
      await driveAndStop(v);
      await v.host.end();
      clock += variant === 'late' ? 31_000 : 1_000;
      v.detect.setCarRoute([]);
      clock += 2_000;
      activity(v, variant === 'still' ? 'stationary' : 'walking');
      if (variant === 'automotive') {
        clock += 20_000;
        activity(v, 'automotive', 'medium');
      }
      await v.host.settled();
      for (let i = 0; i < 6; i += 1) {
        clock += 60_000;
        v.scheduler.fire();
        await v.host.settled();
      }
      await flush();
      expect({ variant, spot: await readParkedSpot(db) }).toEqual({ variant, spot: null });
      await v.host.stop({ endOpenTrip: false });
    }
  });

  test('not when the car was moving as it left the route', async () => {
    const h = buildIos();
    await pair(h, civic);
    await start(h);
    await feedIos(h, rows(60, { t0: T0 + 40_000, speedMps: 15 }));
    h.detect.setCarRoute([]);
    await feedIos(h, rows(10, { t0: T0 + 100_000, speedMps: 0 }));
    await h.host.end();
    clock += 2_000;
    activity(h, 'walking');
    clock += 60_000;
    h.scheduler.fire();
    await h.host.settled();
    await flush();
    expect(await readParkedSpot(db)).toBeNull();
    await h.host.stop({ endOpenTrip: false });
  });

  test('the driver already walking off as the car left the route, after the walking end: stored', async () => {
    const h = buildIos();
    await pair(h, civic);
    await start(h);
    const drive = rows(60, { t0: T0 + 40_000, speedMps: 15 });
    const endLng = drive.at(-1)!.lng;
    await feedIos(h, drive);
    await feedIos(
      h,
      rows(4, { t0: T0 + 100_000, speedMps: 0 }).map((r) => ({ ...r, lng: endLng }))
    );
    clock = T0 + 104_000;
    activity(h, 'walking');
    await h.host.settled();
    // About 12 s of walking (trusted, 1.4 m/s) before the drive ends.
    await feedIos(
      h,
      rows(12, { t0: T0 + 104_000, speedMps: 1.4 }).map((r, i) => ({ ...r, lng: endLng + (i * 1.4) / M_PER_DEG_LNG }))
    );
    if (h.host.snapshot().status === 'recording') {
      clock = T0 + 116_000;
      h.detect.endFor('walking', T0 + 104_000);
      await flush();
    }
    await h.host.untilIdle();
    await h.host.settled();
    expect(h.host.snapshot().lastFinalized).toMatchObject({ clientTripId: NATIVE, ok: true });
    // The car's Bluetooth goes 10 s later (locked, or out of range).
    clock += 10_000;
    h.detect.setCarRoute([]);
    await h.host.settled();
    for (let i = 0; i < 3; i += 1) {
      clock += 30_000;
      h.scheduler.fire();
      await h.host.settled();
    }
    await flush();
    expect(await readParkedSpot(db)).toMatchObject({ driveId: NATIVE });
    expect(h.errors).toEqual([]);
    await h.host.stop({ endOpenTrip: false });
  });

  test("a later kept drive clears an earlier drive's spot", async () => {
    await writeParkedSpot(db, { lat: 1, lng: 2, parkedAt: T0 - 3600_000, label: 'Main St', driveId: uuid(800) });
    const h = buildIos();
    await start(h);
    await feedIos(h, rows(30, { t0: T0 + 40_000, speedMps: 15 }));
    await h.host.end();
    expect(await createSettingsRepo(db).get(PARKED_KEY)).toBeNull();
    await h.host.stop({ endOpenTrip: false });
  });
});
