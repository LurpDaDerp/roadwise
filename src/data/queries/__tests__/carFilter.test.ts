/** @jest-environment node */
import { uuid } from '@/core/engine/__fixtures__/drives';
import type { Db } from '@/data/db';
import { archiveDue } from '@/data/db/archive';
import { createTestDb, seedTrips } from '@/data/queries/__fixtures__/harness';
import { readDriveHistory } from '@/data/queries/drives';
import { carFilterUid, carHistoryFilter, DRIVE_HISTORY_FILTERS, queryKeys } from '@/data/queries/keys';
import { matchesHistoryFilter } from '@/data/queries/rows';

const T0 = 1_700_000_000_000;
const DAY = 86_400_000;
// A car's uid as the audio route gives it (a Bluetooth address and a port suffix: colons inside).
const HONDA = '00:1A:7D:DA:71:13-tacl';
const VOLVO = '9C:8C:6E:11:22:33-tacl';

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
  await seedTrips(db, [
    { client_trip_id: uuid(1), started_at: T0 - 1000, tz: 'UTC', status: 'scored', clean: 1, car_uid: HONDA, car_name: 'Honda' },
    { client_trip_id: uuid(2), started_at: T0 - 2000, tz: 'UTC', status: 'pending', car_uid: VOLVO, car_name: 'Volvo' },
    { client_trip_id: uuid(3), started_at: T0 - 3000, tz: 'UTC', status: 'not_driving', car_uid: HONDA, car_name: 'Honda' },
    // Still recording: in no list, its car or not.
    { client_trip_id: uuid(4), started_at: T0 - 4000, tz: 'UTC', status: 'recording', car_uid: HONDA },
    // No car: in no car's list.
    { client_trip_id: uuid(5), started_at: T0 - 5000, tz: 'UTC', status: 'scored' },
    { client_trip_id: uuid(6), started_at: T0 - 6000, tz: 'UTC', status: 'unscored', reason: 'too_short', car_uid: HONDA, car_name: 'Old name' },
  ]);
});

test('a car filter names its car; every other filter names none', () => {
  expect(carHistoryFilter(HONDA)).toBe(`car:${HONDA}`);
  expect(carFilterUid(carHistoryFilter(HONDA))).toBe(HONDA);
  expect(carFilterUid('car:')).toBeNull();
  for (const f of DRIVE_HISTORY_FILTERS) expect(carFilterUid(f)).toBeNull();
  // The fixed filters stay the three every phone has; the cars come and go with the pairing.
  expect(DRIVE_HISTORY_FILTERS).toEqual(['all', 'clean', 'passenger']);
  // Each car's list has its own cache entry, under the drives root every change refreshes.
  expect(queryKeys.driveHistory(carHistoryFilter(HONDA))).toEqual(['drives', 'history', `car:${HONDA}`]);
  expect(queryKeys.driveHistory(carHistoryFilter(VOLVO))).not.toEqual(queryKeys.driveHistory(carHistoryFilter(HONDA)));
});

test("a car's history holds the listed drives made in it, newest first, whatever their state", async () => {
  expect((await readDriveHistory(db, carHistoryFilter(HONDA))).map((d) => d.clientTripId)).toEqual([uuid(1), uuid(3), uuid(6)]);
  expect((await readDriveHistory(db, carHistoryFilter(VOLVO))).map((d) => d.clientTripId)).toEqual([uuid(2)]);
  expect(await readDriveHistory(db, carHistoryFilter('not-a-paired-car'))).toEqual([]);
  // The other filters are unchanged by the cars.
  expect((await readDriveHistory(db, 'all')).map((d) => d.clientTripId)).toEqual([uuid(1), uuid(2), uuid(3), uuid(5), uuid(6)]);
  expect((await readDriveHistory(db, 'clean')).map((d) => d.clientTripId)).toEqual([uuid(1)]);
  expect((await readDriveHistory(db, 'passenger')).map((d) => d.clientTripId)).toEqual([uuid(3)]);
});

test('the car match is exact: no prefix, no case folding, no empty uid', () => {
  const d = { status: 'scored' as const, clean: true, carUid: HONDA };
  expect(matchesHistoryFilter(d, carHistoryFilter(HONDA))).toBe(true);
  expect(matchesHistoryFilter(d, carHistoryFilter(HONDA.toLowerCase()))).toBe(false);
  expect(matchesHistoryFilter(d, carHistoryFilter(HONDA.slice(0, 8)))).toBe(false);
  expect(matchesHistoryFilter({ ...d, carUid: '' }, 'car:')).toBe(false);
  expect(matchesHistoryFilter({ ...d, carUid: null }, carHistoryFilter(HONDA))).toBe(false);
  expect(matchesHistoryFilter({ status: 'scored', clean: true }, carHistoryFilter(HONDA))).toBe(false);
  // Listed only: a recording or an archived drive is in no car's list.
  expect(matchesHistoryFilter({ ...d, status: 'recording' }, carHistoryFilter(HONDA))).toBe(false);
  expect(matchesHistoryFilter({ ...d, archived: true }, carHistoryFilter(HONDA))).toBe(false);
});

test("an archived drive leaves its car's list (the archive clears the car)", async () => {
  await seedTrips(db, [{ client_trip_id: uuid(7), started_at: T0 - 200 * DAY, ended_at: T0 - 200 * DAY + 60_000, tz: 'UTC', status: 'scored', car_uid: HONDA, car_name: 'Honda' }]);
  expect((await readDriveHistory(db, carHistoryFilter(HONDA))).map((d) => d.clientTripId)).toContain(uuid(7));
  await archiveDue(db, T0);
  expect((await readDriveHistory(db, carHistoryFilter(HONDA))).map((d) => d.clientTripId)).toEqual([uuid(1), uuid(3), uuid(6)]);
  const { rows } = await db.execute('SELECT car_uid, car_name FROM trips WHERE client_trip_id = ?', [uuid(7)]);
  expect(rows[0]).toEqual({ car_uid: null, car_name: null });
});
