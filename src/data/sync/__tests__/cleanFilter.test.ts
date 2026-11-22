/** @jest-environment node */
// Drive history's Clean filter and a drive marked "Wasn't driving". The tap only sets the status
// (the stored clean flag stays, so a refused mark puts the drive back with it), and the server's
// answer clears the flag. Until that answer, and for good on a path that never gets one, the drive
// is under Passenger only, never under Clean.
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createSettingsRepo, createTripsRepo, migrate, type Db } from '@/data/db';
import { createFakeSupabase, functionsHttpError, invokeOk } from '@/data/sync/__fixtures__/fakes';
import { finishedDrive, T0, uuid } from '@/data/sync/__fixtures__/drives';
import { markNotDriving } from '@/data/sync/driveActions';
import { createSyncRunner } from '@/data/sync/runner';
import { readDriveHistory } from '@/data/queries/drives';

let db: Db;
beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
  await createSettingsRepo(db).set('device.lastUserId', 'user-1');
});

const NOW = T0 + 2_000_000;
const runner = (supabase: ReturnType<typeof createFakeSupabase>) => createSyncRunner({ db, supabase, mayDrain: () => true, isRecording: () => false, now: () => NOW });
const ids = async (filter: 'clean' | 'passenger') => (await readDriveHistory(db, filter)).map((d) => d.clientTripId);

/** A clean drive the server has scored: no events, its upload done. */
async function scoredCleanDrive(clientTripId: string): Promise<void> {
  await finishedDrive(db, clientTripId, { t0: T0 });
  await db.execute("UPDATE trips SET status = 'scored' WHERE client_trip_id = ?", [clientTripId]);
  await db.execute('DELETE FROM sync_queue');
}

test.each([
  ['the recap’s "Wasn’t driving"', {}],
  ['the notification’s "I wasn’t driving"', { via: 'notification' as const }],
])('%s: until the server answers, the drive is under Passenger and not under Clean', async (_label, opts) => {
  await scoredCleanDrive(uuid(10));
  expect(await ids('clean')).toEqual([uuid(10)]);
  expect(await markNotDriving(uuid(10), { db, now: () => NOW }, opts)).toBe('queued');
  // The stored flag is still set; the status keeps the drive out of Clean.
  expect(await createTripsRepo(db).get(uuid(10))).toMatchObject({ status: 'not_driving', clean: 1 });
  expect(await ids('clean')).toEqual([]);
  expect(await ids('passenger')).toEqual([uuid(10)]);
});

test('a refused mark puts the drive back with its clean flag: under Clean again, not under Passenger', async () => {
  await scoredCleanDrive(uuid(11));
  await markNotDriving(uuid(11), { db, now: () => NOW });
  const r = runner(createFakeSupabase({ invoke: () => functionsHttpError(403, { code: 'too_old' }) }));
  await r.start();
  await r.drainOnce();
  await r.stop();
  expect(await createTripsRepo(db).get(uuid(11))).toMatchObject({ status: 'scored', clean: 1, sync_error: 'too_old' });
  expect(await ids('clean')).toEqual([uuid(11)]);
  expect(await ids('passenger')).toEqual([]);
});

test('a mark the server accepts clears the flag: under Passenger only', async () => {
  await scoredCleanDrive(uuid(12));
  await markNotDriving(uuid(12), { db, now: () => NOW });
  const r = runner(createFakeSupabase({ invoke: () => invokeOk({ tripId: uuid(77), clientTripId: uuid(12), notDrivingLeft: 1, rating: { safetyRating: null, ranked: false } }) }));
  await r.start();
  await r.drainOnce();
  await r.stop();
  expect(await createTripsRepo(db).get(uuid(12))).toMatchObject({ status: 'not_driving', clean: null });
  expect(await ids('clean')).toEqual([]);
  expect(await ids('passenger')).toEqual([uuid(12)]);
});

test('a mark whose drive’s upload was refused for good stays on this phone with the flag never cleared: still not under Clean', async () => {
  // Marked before its upload went (the drive is pending, clean as finalize classified it).
  await finishedDrive(db, uuid(13), { t0: T0 });
  await markNotDriving(uuid(13), { db, now: () => NOW });
  const s = createFakeSupabase({
    invoke: ({ name }) => (name === 'finalize-trip' ? functionsHttpError(400, { code: 'spoofed_payload' }) : functionsHttpError(404, { code: 'not_found' })),
  });
  const r = runner(s);
  await r.start();
  await r.drainOnce();
  await r.stop();
  expect(await createTripsRepo(db).get(uuid(13))).toMatchObject({ status: 'not_driving', clean: 1, sync_error: 'spoofed_payload' });
  expect(await ids('clean')).toEqual([]);
  expect(await ids('passenger')).toEqual([uuid(13)]);
});
