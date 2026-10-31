/** @jest-environment node */
// Passenger rides through the sync queue: the in-drive "Not driving?" (a passenger-ride item: the
// trip id and its day to record_passenger_ride, nothing local), and the recap notification's
// "I wasn't driving" (a not-driving action sent to mark_passenger_ride instead of trip-actions,
// resolved like "Wasn't driving", undone with its refusal). PostgREST errors are classified like a
// function's answers.
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createQueueRepo, createSettingsRepo, createTripsRepo, migrate, type Db } from '@/data/db';
import { createFakeSupabase, functionsHttpError, invokeOk } from '@/data/sync/__fixtures__/fakes';
import { answer, finishedDrive, T0, uuid } from '@/data/sync/__fixtures__/drives';
import { markNotDriving } from '@/data/sync/driveActions';
import { enqueuePassengerRide } from '@/data/sync/queue';
import { classifyRpcError } from '@/data/sync/response';
import { createSyncRunner } from '@/data/sync/runner';
import { toLocalDrive } from '@/data/queries/rows';
import { canMarkNotDriving, notDrivingRetryNote } from '@/features/drives/summary';

let db: Db;
beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
  await createSettingsRepo(db).set('device.lastUserId', 'user-1');
});

const NOW = T0 + 2_000_000;
const runner = (supabase: ReturnType<typeof createFakeSupabase>) => createSyncRunner({ db, supabase, mayDrain: () => true, isRecording: () => false, now: () => NOW });
const pgError = (code: string, message: string) => ({ data: null, error: { code, message, details: null, hint: null } });
const marked = (clientTripId: string) => ({ data: { tripId: uuid(77), clientTripId, notDrivingLeft: 2, rating: { safetyRating: 90, ranked: true } }, error: null });
const rideKey = (id: string) => 'passenger:' + id;

test('an in-drive passenger ride goes to record_passenger_ride with its id and day only, once', async () => {
  await enqueuePassengerRide(db, { clientTripId: uuid(1), localDay: '2026-10-31' }, T0);
  await enqueuePassengerRide(db, { clientTripId: uuid(1), localDay: '2026-10-31' }, T0);
  const s = createFakeSupabase({ rpc: () => ({ data: { clientTripId: uuid(1), localDay: '2026-10-31' }, error: null }) });
  const r = runner(s);
  await r.start();
  expect(await r.drainOnce()).toMatchObject({ done: 1, failed: 0 });
  expect(s.rpcs).toEqual([{ fn: 'record_passenger_ride', args: { p_client_trip_id: uuid(1), p_local_day: '2026-10-31' } }]);
  expect(s.invokes).toEqual([]);
  expect(await createQueueRepo(db).byKey(rideKey(uuid(1)))).toMatchObject({ kind: 'passenger-ride', status: 'done' });
  await r.stop();
});

test('offline, a passenger ride waits as a transport failure; a server without the RPC waits too; a refusal fails it for good', async () => {
  for (const n of [1, 2, 3]) await enqueuePassengerRide(db, { clientTripId: uuid(n), localDay: '2026-10-31' }, T0);
  const s = createFakeSupabase({
    rpc: ({ args }) => {
      const id = (args as { p_client_trip_id: string }).p_client_trip_id;
      if (id === uuid(1)) return { data: null, error: { code: '', message: 'TypeError: Network request failed' } };
      if (id === uuid(2)) return pgError('PGRST202', 'Could not find the function public.record_passenger_ride');
      return pgError('22023', 'invalid local day');
    },
  });
  const r = runner(s);
  await r.start();
  expect(await r.drainOnce()).toMatchObject({ done: 0, failed: 1 });
  const q = createQueueRepo(db);
  expect(await q.byKey(rideKey(uuid(1)))).toMatchObject({ status: 'pending', last_error: 'network' });
  expect(await q.byKey(rideKey(uuid(2)))).toMatchObject({ status: 'pending', last_error: 'http_404' });
  expect(await q.byKey(rideKey(uuid(3)))).toMatchObject({ status: 'failed', last_error: 'invalid_local_day' });
  await r.stop();
});

describe('the recap notification’s "I wasn’t driving"', () => {
  const server = (mark: (id: string) => { data: unknown; error: unknown }) =>
    createFakeSupabase({
      invoke: ({ body }) => invokeOk(answer((body as { clientTripId: string }).clientTripId)),
      rpc: ({ fn, args }) => (fn === 'mark_passenger_ride' ? mark((args as { p_client_trip_id: string }).p_client_trip_id) : { data: null, error: null }),
    });

  test('the upload goes first, then the mark goes to mark_passenger_ride (never trip-actions) and settles the drive', async () => {
    await finishedDrive(db, uuid(10), { t0: T0 });
    expect(await markNotDriving(uuid(10), { db, now: () => NOW }, { via: 'notification' })).toBe('queued');
    expect(await createTripsRepo(db).get(uuid(10))).toMatchObject({ status: 'not_driving' });
    const s = server(marked);
    const r = runner(s);
    await r.start();
    expect(await r.drainOnce()).toMatchObject({ done: 2, failed: 0 });
    expect(s.invokes.map((i) => i.name)).toEqual(['finalize-trip']);
    expect(s.rpcs).toEqual([{ fn: 'mark_passenger_ride', args: { p_client_trip_id: uuid(10) } }]);
    expect(await createTripsRepo(db).get(uuid(10))).toMatchObject({ status: 'not_driving', clean: null, server_id: uuid(77), sync_error: null });
    await r.stop();
  });

  test('refused as too late: the drive is put back with the reason, and "Wasn’t driving" stays on offer with a note', async () => {
    await finishedDrive(db, uuid(11), { t0: T0 });
    await markNotDriving(uuid(11), { db, now: () => NOW }, { via: 'notification' });
    const s = server(() => pgError('42501', 'the passenger mark came too late'));
    const r = runner(s);
    await r.start();
    expect(await r.drainOnce()).toMatchObject({ done: 1, failed: 1 });
    const trip = (await createTripsRepo(db).get(uuid(11)))!;
    expect(trip).toMatchObject({ status: 'scored', sync_error: 'passenger_too_late' });
    const d = toLocalDrive(trip);
    expect(canMarkNotDriving(d, (trip.ended_at ?? trip.started_at) + 60_000)).toBe(true);
    expect(notDrivingRetryNote(d)).toMatch(/still use “Wasn’t driving”/);
    await r.stop();
  });

  test('the server does not hold the drive while its upload is owed: the mark waits, nothing is undone', async () => {
    await finishedDrive(db, uuid(12), { t0: T0 });
    await markNotDriving(uuid(12), { db, now: () => NOW }, { via: 'notification' });
    const s = createFakeSupabase({ invoke: () => functionsHttpError(503, { code: 'unavailable' }), rpc: () => pgError('P0002', 'trip not found') });
    const r = runner(s);
    await r.start();
    await r.drainOnce();
    expect(await createTripsRepo(db).get(uuid(12))).toMatchObject({ status: 'not_driving', sync_error: null });
    expect(await createQueueRepo(db).byKey('not_driving:' + uuid(12))).toMatchObject({ status: 'pending', last_error: 'not_found' });
    await r.stop();
  });
});

test('classifyRpcError: no code is the network; the writers’ refusals are terminal under their codes; the rate limit and anything undecided wait', () => {
  expect(classifyRpcError({ code: '', message: 'TypeError: Network request failed' })).toMatchObject({ kind: 'retryable', code: 'network', status: null });
  expect(classifyRpcError(new Error('boom'))).toMatchObject({ kind: 'retryable', code: 'network' });
  expect(classifyRpcError({ code: 'PGRST202', message: 'Could not find the function' })).toMatchObject({ kind: 'retryable', code: 'http_404' });
  expect(classifyRpcError({ code: 'PGRST301', message: 'JWT expired' })).toMatchObject({ kind: 'unauthorized' });
  expect(classifyRpcError({ code: '42501', message: 'too many requests' })).toMatchObject({ kind: 'retryable', code: 'too_many_requests', retryAfterS: 600 });
  expect(classifyRpcError({ code: 'P0002', message: 'trip not found' })).toMatchObject({ kind: 'terminal', code: 'not_found' });
  expect(classifyRpcError({ code: '42501', message: 'the not driving option expired' })).toMatchObject({ kind: 'terminal', code: 'not_driving_expired' });
  expect(classifyRpcError({ code: '42501', message: 'not an automatic drive' })).toMatchObject({ kind: 'terminal', code: 'not_automatic' });
  expect(classifyRpcError({ code: '42501', message: 'mark_passenger_ride requires an authenticated user' })).toMatchObject({ kind: 'terminal', code: 'pg_42501' });
  expect(classifyRpcError({ code: '57014', message: 'canceling statement due to statement timeout' })).toMatchObject({ kind: 'retryable', code: 'pg_57014' });
});
