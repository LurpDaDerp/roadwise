/** @jest-environment node */
import { uuid } from '@/core/engine/__fixtures__/drives';
import { archiveDue, type Db } from '@/data/db';
import { createTestDb, seedEvents, seedTrips } from '@/data/queries/__fixtures__/harness';
import { readScoredDrives, readWindowEvents } from '@/data/queries/analytics';
import { readArchivedKinds } from '@/data/queries/archived';
import {
  readDriveCount,
  readDriveDetail,
  readDriveEvents,
  readDriveHistory,
  readRecentDrives,
  readRoutePolylines,
  readRoutePool,
  readStatSums,
} from '@/data/queries/drives';
import { DRIVE_HISTORY_FILTERS } from '@/data/queries/keys';
import { readSpotInputs } from '@/data/queries/spots';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const counts = (speeding: number) => JSON.stringify({ speeding, hardBrake: 0, hardAccel: 0, hardCorner: 0 });

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
  const drive = (n: number, daysAgo: number, over: Record<string, unknown> = {}) => ({
    client_trip_id: uuid(n),
    started_at: NOW - daysAgo * DAY - 1_200_000,
    ended_at: NOW - daysAgo * DAY,
    tz: 'UTC',
    status: 'scored' as const,
    miles: n,
    night_miles: n / 4,
    duration_s: 1200,
    clean: 1 as const,
    counts_json: counts(0),
    polyline: `route-${n}`,
    from_label: 'Home',
    to_label: 'Work',
    start_lat: 47.6,
    start_lng: -122.3,
    ...over,
  });
  await seedTrips(db, [
    drive(1, 2),
    drive(2, 40, { clean: 0, counts_json: counts(1) }),
    drive(3, 200, { clean: 0, counts_json: counts(1) }),
    drive(4, 300),
    drive(5, 250, { status: 'not_driving', clean: null }),
    drive(6, 400, { status: 'unscored', reason: 'too_short', clean: null }),
  ]);
  await seedEvents(db, [
    { id: uuid(21), client_trip_id: uuid(2), type: 'speeding', tier: 'minor', started_at: NOW - 40 * DAY - 600_000, duration_s: 8, lat: 47.61, lng: -122.31, measured_json: '{"overMphS":9}' },
    { id: uuid(23), client_trip_id: uuid(3), type: 'speeding', tier: 'moderate', started_at: NOW - 200 * DAY - 600_000, duration_s: 20, lat: 47.62, lng: -122.32, measured_json: '{"overMphS":90}' },
  ]);
});

/** Every stat reader, all time and over a year and its 90 days. */
async function stats() {
  const year = NOW - 365 * DAY;
  const scored = await readScoredDrives(db, null);
  return {
    sumsAll: await readStatSums(db, null),
    sumsYear: await readStatSums(db, year),
    sums30: await readStatSums(db, NOW - 30 * DAY),
    count: await readDriveCount(db),
    // what the stats read of each drive (not its route, labels or places)
    scored: scored.map(({ polyline: _p, fromLabel: _f, toLabel: _t, archived: _a, ...numbers }) => numbers),
    eventsAll: await readWindowEvents(db, null),
    eventsYear: await readWindowEvents(db, year - 90 * DAY),
  };
}

test('every stat reader answers the same once the drives past the 183 days are archived', async () => {
  const before = await stats();
  expect(await archiveDue(db, NOW)).toBe(4);
  expect(await stats()).toEqual(before);
  expect(before.count).toBe(4);
  expect(before.sumsAll).toMatchObject({ drives: 4, miles: 10, speeding: 2 });
});

test('the lists and a drive’s own read leave an archived drive out', async () => {
  await archiveDue(db, NOW);
  expect((await readRecentDrives(db, 10)).map((d) => d.clientTripId)).toEqual([uuid(1), uuid(2)]);
  expect((await readDriveHistory(db, 'all')).map((d) => d.clientTripId)).toEqual([uuid(1), uuid(2)]);
  for (const filter of DRIVE_HISTORY_FILTERS) {
    expect((await readDriveHistory(db, filter)).every((d) => d.archived !== true)).toBe(true);
  }
  expect(await readDriveHistory(db, 'passenger')).toEqual([]);
  // A recap link to an archived drive (an old notification, a deep link) finds no drive.
  expect(await readDriveDetail(db, uuid(3))).toBeNull();
  expect(await readDriveDetail(db, uuid(1))).not.toBeNull();
  // A stat read still carries it, marked.
  expect((await readScoredDrives(db, null)).find((d) => d.clientTripId === uuid(3))).toMatchObject({ archived: true, polyline: null, fromLabel: null });
  // Its events keep no place.
  expect((await readDriveEvents(db, [uuid(3)])).get(uuid(3))).toEqual([expect.objectContaining({ type: 'speeding', lat: null, lng: null })]);
});

test('Drive history learns which kinds of drive are archived (its empty titles): any, clean, “Wasn’t driving”', async () => {
  expect(await readArchivedKinds(db)).toEqual({ all: false, clean: false, passenger: false });
  await archiveDue(db, NOW);
  // Drive 4 (clean) and 5 ("Wasn't driving") are among the archived.
  expect(await readArchivedKinds(db)).toEqual({ all: true, clean: true, passenger: true });
});

test('all time, the routes are the drives’ own and then the pool’s: a scored archived drive’s line is still drawn', async () => {
  const before = await readRoutePolylines(db, null);
  await archiveDue(db, NOW);
  expect(await readRoutePool(db)).toEqual(expect.arrayContaining(['route-3', 'route-4']));
  expect((await readRoutePool(db)).sort()).toEqual(['route-3', 'route-4']);
  expect(await readRoutePolylines(db, null)).toEqual(['route-1', 'route-2', 'route-3', 'route-4']);
  // "Wasn't driving" and unscored routes are drawn by no map: archived, they are gone.
  expect(before).toEqual(['route-1', 'route-2', 'route-3', 'route-5', 'route-4', 'route-6']);
  // A window never holds a pool line (it has no date).
  expect(await readRoutePolylines(db, NOW - 30 * DAY)).toEqual(['route-1']);
});

test('the problem spots (120 days) read the same before and after, and skip a drive or event without a place', async () => {
  const before = await readSpotInputs(db, NOW);
  await archiveDue(db, NOW);
  expect(await readSpotInputs(db, NOW)).toEqual(before);
  // A year on, everything is archived: no route and no place, so nothing to read, and nothing breaks.
  await archiveDue(db, NOW + 365 * DAY);
  expect(await readSpotInputs(db, NOW + 100 * DAY)).toEqual({ drives: [], events: [] });
});
