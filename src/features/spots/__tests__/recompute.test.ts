/** @jest-environment node */
import { at, DAY, NORTH, T0 } from '@/core/spots/__fixtures__/spots';
import { PRIVACY_ZONES_KEY } from '@/core/engine/privacy';
import type { Db } from '@/data/db/driver';
import { createSettingsRepo } from '@/data/db/settings';
import { createSpotsRepo, SPOTS_META_KEY } from '@/data/db/spots';
import { emitDataChanged, onDataChanged, type ChangeSource } from '@/data/events';
import { foregroundStampKey } from '@/data/foreground';
import { createTestDb, seedEvents, seedTrips } from '@/data/queries/__fixtures__/harness';
import * as queries from '@/data/queries/spots';
import { encodePolyline } from '@/lib/polyline';

import { requestSpotRecompute, startSpotJobs, type SpotJobs } from '../recompute';

jest.mock('@/data/queries/spots', () => {
  const actual = jest.requireActual<typeof import('@/data/queries/spots')>('@/data/queries/spots');
  return { ...actual, readSpotInputs: jest.fn(actual.readSpotInputs) };
});
const readInputs = queries.readSpotInputs as jest.MockedFunction<typeof queries.readSpotInputs>;
const realRead = jest.requireActual<typeof import('@/data/queries/spots')>('@/data/queries/spots').readSpotInputs;

const ROAD = encodePolyline(NORTH);
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function fakeAppState(initial: string) {
  const listeners = new Set<(s: string) => void>();
  return {
    currentState: initial as string | null,
    addEventListener(_type: 'change', l: (s: string) => void) {
      listeners.add(l);
      return { remove: () => void listeners.delete(l) };
    },
    set(s: string) {
      this.currentState = s;
      for (const l of [...listeners]) l(s);
    },
  };
}

/** Three drives north with a hard brake at each of `places` (metres along the road). */
async function seedDrives(db: Db, places: readonly number[] = [1000]) {
  await seedTrips(
    db,
    [0, 1, 2].map((i) => ({ client_trip_id: uuid(i + 1), started_at: T0 + i * DAY, tz: 'UTC', status: 'scored' as const, polyline: ROAD }))
  );
  await seedEvents(
    db,
    [0, 1, 2].flatMap((i) =>
      places.map((m, k) => ({
        id: uuid(100 + i * 10 + k),
        client_trip_id: uuid(i + 1),
        type: 'hard_brake' as const,
        tier: 'minor' as const,
        started_at: T0 + i * DAY + 60_000 + k,
        duration_s: 1,
        ...at(m, 0),
        measured_json: '{"speedMph":30}',
      }))
    )
  );
}

let db: Db;
let jobs: SpotJobs | null = null;
let now = T0 + 3 * DAY;
let busy = false;
let changes: ChangeSource[] = [];
let offChanges: () => void = () => {};

beforeEach(async () => {
  jest.useFakeTimers({ now: T0 + 3 * DAY });
  db = await createTestDb();
  now = T0 + 3 * DAY;
  busy = false;
  changes = [];
  offChanges = onDataChanged((e) => changes.push(e.source));
  readInputs.mockReset();
  readInputs.mockImplementation(realRead);
});

afterEach(() => {
  jobs?.stop();
  jobs = null;
  offChanges();
  jest.useRealTimers();
});

const listSpots = () => createSpotsRepo(db).list();
const start = (appState: ReturnType<typeof fakeAppState>, geocode: ((p: { lat: number; lng: number }) => Promise<string | null>) | null = null) => {
  jobs = startSpotJobs({ db, appState, isBusy: () => busy, now: () => now, geocode });
  return jobs;
};
/** The daily run already happened today, so only the debounce triggers. */
const stampDaily = () => createSettingsRepo(db).set(foregroundStampKey('spots'), now);

test('a recompute waits for the app in front and no drive, then runs 2 s after the last ask', async () => {
  await seedDrives(db);
  await stampDaily();
  const app = fakeAppState('background');
  start(app);
  await jest.advanceTimersByTimeAsync(10_000);
  expect(readInputs).not.toHaveBeenCalled(); // behind: it waits (pending from the start)

  busy = true;
  app.set('active');
  await jest.advanceTimersByTimeAsync(5_000);
  expect(readInputs).not.toHaveBeenCalled(); // a drive is under way

  busy = false;
  emitDataChanged({ source: 'finalize' }); // the drive's end
  await jest.advanceTimersByTimeAsync(1_900);
  expect(readInputs).not.toHaveBeenCalled();
  emitDataChanged({ source: 'sync' }); // another ask restarts the 2 s
  await jest.advanceTimersByTimeAsync(1_900);
  expect(readInputs).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(200);
  expect(readInputs).toHaveBeenCalledTimes(1);
  const rows = await listSpots();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ kind: 'hard_brake', state: 'active', rank: 1, hits: 3, passes: 3, last_hit_trip: uuid(3) });
  expect(await createSettingsRepo(db).get(SPOTS_META_KEY)).toEqual({ v: 1, computedAt: now, drives: 3 });
  expect(changes).toContain('spots');
});

test('the first foreground with the recompute pending computes from the history at once (the daily run), and once', async () => {
  await seedDrives(db);
  const app = fakeAppState('active');
  start(app);
  await jest.advanceTimersByTimeAsync(5_000);
  expect(readInputs).toHaveBeenCalledTimes(1);
  expect(await listSpots()).toHaveLength(1);

  // A day later, back in front: the daily run comes round again.
  now += DAY + 1;
  jest.setSystemTime(now);
  app.set('background');
  app.set('active');
  await jest.advanceTimersByTimeAsync(5_000);
  expect(readInputs).toHaveBeenCalledTimes(2);
});

test("its own 'spots' change never triggers it", async () => {
  await seedDrives(db);
  await stampDaily();
  start(fakeAppState('active'));
  await jest.advanceTimersByTimeAsync(3_000);
  expect(readInputs).toHaveBeenCalledTimes(1);
  emitDataChanged({ source: 'spots' });
  await jest.advanceTimersByTimeAsync(5_000);
  expect(readInputs).toHaveBeenCalledTimes(1);
});

test('a wipe during a run abandons it: nothing is written', async () => {
  await seedDrives(db);
  await stampDaily();
  let release: () => void = () => {};
  readInputs.mockImplementationOnce(async (d, n) => {
    const inputs = await realRead(d, n);
    await new Promise<void>((r) => (release = r));
    return inputs;
  });
  start(fakeAppState('active'));
  await jest.advanceTimersByTimeAsync(2_000);
  expect(readInputs).toHaveBeenCalledTimes(1);
  emitDataChanged({ source: 'wipe' });
  await jest.advanceTimersByTimeAsync(10);
  release();
  await jest.advanceTimersByTimeAsync(10);
  expect(await listSpots()).toEqual([]);
  expect(await createSettingsRepo(db).get(SPOTS_META_KEY)).toBeNull();
});

test('a drive that starts mid-run abandons it, and the next ask after the drive writes', async () => {
  await seedDrives(db);
  await stampDaily();
  let release: () => void = () => {};
  readInputs.mockImplementationOnce(async (d, n) => {
    const inputs = await realRead(d, n);
    await new Promise<void>((r) => (release = r));
    return inputs;
  });
  start(fakeAppState('active'));
  await jest.advanceTimersByTimeAsync(2_000);
  busy = true;
  release();
  await jest.advanceTimersByTimeAsync(10);
  expect(await listSpots()).toEqual([]);

  busy = false;
  emitDataChanged({ source: 'finalize' });
  await jest.advanceTimersByTimeAsync(2_100);
  expect(await listSpots()).toHaveLength(1);
});

test('names the spots one at a time 1.2 s apart, never inside a privacy zone, then announces the names', async () => {
  await seedDrives(db, [500, 1000, 1500]);
  await stampDaily();
  // A zone over the third place: that spot is left out, and no request is made for it.
  await createSettingsRepo(db).set(PRIVACY_ZONES_KEY, [{ id: 'z', name: 'Home', ...at(1500, 0), radiusM: 200 }]);
  const calls: { at: number; p: { lat: number; lng: number } }[] = [];
  const geocode = jest.fn(async (p: { lat: number; lng: number }) => {
    calls.push({ at: Date.now(), p });
    return calls.length === 1 ? 'Dexter Ave N' : null;
  });
  start(fakeAppState('active'), geocode);
  await jest.advanceTimersByTimeAsync(2_100);
  expect(await listSpots()).toHaveLength(2);
  const before = changes.filter((c) => c === 'spots').length;
  expect(before).toBeGreaterThanOrEqual(1);
  await jest.advanceTimersByTimeAsync(5_000);
  expect(geocode).toHaveBeenCalledTimes(2);
  expect(calls[1]!.at - calls[0]!.at).toBeGreaterThanOrEqual(1_200);
  const rows = await listSpots();
  expect(rows.find((r) => Math.abs(r.lat - at(1500, 0).lat) < 1e-4)).toBeUndefined();
  const named = rows.filter((r) => r.label_at !== null);
  expect(named).toHaveLength(2);
  expect(named.map((r) => r.label).sort()).toEqual(['Dexter Ave N', null]);
  expect(changes.filter((c) => c === 'spots').length).toBeGreaterThan(before);

  // A failed name is not asked again within the day; the found one never.
  emitDataChanged({ source: 'sync' });
  await jest.advanceTimersByTimeAsync(10_000);
  expect(geocode).toHaveBeenCalledTimes(2);
  now += DAY + 1;
  jest.setSystemTime(now);
  emitDataChanged({ source: 'sync' });
  await jest.advanceTimersByTimeAsync(10_000);
  expect(geocode).toHaveBeenCalledTimes(3);
});

test('a spot inside a privacy zone takes no rank; a change of zones recomputes', async () => {
  await seedDrives(db, [500, 1000]);
  await stampDaily();
  start(fakeAppState('active'));
  await jest.advanceTimersByTimeAsync(2_100);
  expect((await listSpots()).map((r) => r.rank).sort()).toEqual([1, 2]);
  // A zone added around the place at 1 km: asked for at once, its spot is gone and the other is 1.
  await createSettingsRepo(db).set(PRIVACY_ZONES_KEY, [{ id: 'z', name: 'Home', ...at(1000, 0), radiusM: 200 }]);
  requestSpotRecompute();
  await jest.advanceTimersByTimeAsync(2_100);
  const rows = await listSpots();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ rank: 1 });
  expect(Math.abs(rows[0]!.lat - at(500, 0).lat)).toBeLessThan(1e-4);
});

test("a run whose inputs are the last run's, before any of its time limits, writes nothing again", async () => {
  await seedDrives(db);
  await stampDaily();
  start(fakeAppState('active'));
  await jest.advanceTimersByTimeAsync(2_100);
  const first = await createSettingsRepo(db).get(SPOTS_META_KEY);
  const spotChanges = () => changes.filter((c) => c === 'spots').length;
  const before = spotChanges();
  // A sync that changed nothing the spots read: read, then skipped.
  now += 60_000;
  emitDataChanged({ source: 'sync' });
  await jest.advanceTimersByTimeAsync(2_100);
  expect(readInputs).toHaveBeenCalledTimes(2);
  expect(await createSettingsRepo(db).get(SPOTS_META_KEY)).toEqual(first);
  expect(spotChanges()).toBe(before);
  // A new event is a new input: it recomputes.
  await seedEvents(db, [
    { id: uuid(900), client_trip_id: uuid(3), type: 'hard_brake', tier: 'minor', started_at: T0 + 2 * DAY + 90_000, duration_s: 1, ...at(1000, 0), measured_json: '{"speedMph":30}' },
  ]);
  emitDataChanged({ source: 'sync' });
  await jest.advanceTimersByTimeAsync(2_100);
  expect(await createSettingsRepo(db).get(SPOTS_META_KEY)).toEqual({ v: 1, computedAt: now, drives: 3 });
  expect(spotChanges()).toBeGreaterThan(before);
});

test('after a wipe the next run computes, even from the same inputs', async () => {
  await seedDrives(db);
  await stampDaily();
  start(fakeAppState('active'));
  await jest.advanceTimersByTimeAsync(2_100);
  await createSettingsRepo(db).remove(SPOTS_META_KEY);
  emitDataChanged({ source: 'wipe' });
  emitDataChanged({ source: 'sync' });
  await jest.advanceTimersByTimeAsync(2_100);
  expect(await createSettingsRepo(db).get(SPOTS_META_KEY)).toEqual({ v: 1, computedAt: now, drives: 3 });
});

test('stop ends it: no more runs', async () => {
  await seedDrives(db);
  await stampDaily();
  const j = start(fakeAppState('active'));
  j.stop();
  emitDataChanged({ source: 'sync' });
  await jest.advanceTimersByTimeAsync(5_000);
  expect(readInputs).not.toHaveBeenCalled();
  await j.runNow();
  expect(readInputs).not.toHaveBeenCalled();
});
