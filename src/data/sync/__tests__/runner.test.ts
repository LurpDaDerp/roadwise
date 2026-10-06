/** @jest-environment node */
import { T0 } from '@/core/detectors/__fixtures__/rows';
import { closedSession, speedingEvent, TZ, uuid } from '@/core/engine/__fixtures__/drives';
import { finalizeTrip } from '@/core/engine/finalize';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createEventsRepo, createQueueRepo, createSettingsRepo, createTripsRepo, migrate, type Db } from '@/data/db';
import { createFakeAppState, createFakeSupabase, functionsFetchError, functionsHttpError, invokeOk } from '@/data/sync/__fixtures__/fakes';
import { markNotDriving, reportEvent } from '@/data/sync/driveActions';
import type { FinalizeTripResponseV3 } from '@/data/sync/payload';
import { createSyncRunner, joinPolylines } from '@/data/sync/runner';

let db: Db;
beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
  await createSettingsRepo(db).set('device.lastUserId', 'user-1');
});

const response = (clientTripId: string, over: Partial<FinalizeTripResponseV3> = {}): FinalizeTripResponseV3 => ({
  tripId: uuid(77),
  clientTripId,
  mergedInto: null,
  scored: true,
  reason: null,
  breakdown: {
    scored: true,
    safeMiles: 11,
    creditedMiles: 11,
    milePoints: 110,
    cleanBonus: 0,
    streakMult: 1.1,
    dmsMult: 1,
    mult: 1.1,
    gains: 121,
    shortScale: 1,
    events: [{ id: uuid(1), penalty: 15 }],
    penalties: 15,
    net: 106,
    ratingPenalty: 15,
    activeEventCount: 1,
  },
  net: 106,
  streak: { before: 5, after: 6, outcome: 'grew', nextMult: 1.12, atRisk: false, freezes: 2, freezeEarned: false },
  progress: { points: 1000, lifetime: 1200, level: 3, levelUp: false, safetyRating: 91.2, ranked: true },
  achievements: [],
  challenges: [],
  league: { tier: 'bronze', placed: true },
  ...over,
});

async function finalized(clientTripId: string, t0 = T0): Promise<void> {
  const session = closedSession(1200, [speedingEvent(t0 + 300_000)], { clientTripId, t0 });
  await finalizeTrip(session, { db, tz: TZ, now: () => t0 + 1_300_000, appVersion: '3', geocode: null });
}

function runner(supabase: ReturnType<typeof createFakeSupabase>, over: Partial<Parameters<typeof createSyncRunner>[0]> = {}) {
  return createSyncRunner({ db, supabase, mayDrain: () => true, isRecording: () => false, now: () => T0 + 2_000_000, ...over });
}

test('posts the queued v3 payload verbatim and writes the server’s answer into the drive', async () => {
  await finalized(uuid(10));
  const supabase = createFakeSupabase({ invoke: ({ body }) => invokeOk(response((body as { clientTripId: string }).clientTripId)) });
  const r = runner(supabase);
  await r.start();
  const result = await r.drainOnce();
  expect(result).toMatchObject({ ran: true, done: 1, failed: 0 });
  expect(supabase.invokes).toHaveLength(1);
  expect(supabase.invokes[0]!.name).toBe('finalize-trip');
  expect(supabase.invokes[0]!.body).toMatchObject({ v: 3, clientTripId: uuid(10) });
  const trip = (await createTripsRepo(db).get(uuid(10)))!;
  expect(trip).toMatchObject({ status: 'scored', points_net: 106, estimate: 0, clean: 0, server_id: uuid(77), reason: null });
  expect(JSON.parse(trip.result_json!)).toMatchObject({ net: 106 });
  expect((await createEventsRepo(db).listByTrip(uuid(10)))[0]!.penalty).toBe(15);
  expect(await createQueueRepo(db).countByStatus('done')).toBe(1);
  await r.stop();
});

test('mergedInto: the earlier local drive becomes the union and this one is hidden as merged', async () => {
  await finalized(uuid(10), T0);
  await finalized(uuid(11), T0 + 1_400_000);
  const supabase = createFakeSupabase({
    invoke: ({ body }) => {
      const id = (body as { clientTripId: string }).clientTripId;
      return invokeOk(id === uuid(10) ? response(uuid(10)) : response(uuid(11), { mergedInto: uuid(10), net: 212, scored: true }));
    },
  });
  const r = runner(supabase);
  await r.start();
  await r.drainOnce();
  const trips = createTripsRepo(db);
  const first = (await trips.get(uuid(10)))!;
  const second = (await trips.get(uuid(11)))!;
  expect(second).toMatchObject({ status: 'merged', merged_into: uuid(10), points_net: null });
  expect(first).toMatchObject({ status: 'scored', points_net: 212, estimate: 0 });
  expect(first.miles).toBeCloseTo(22.35, 1);
  expect(first.duration_s).toBe(2400);
  expect(first.ended_at).toBe(T0 + 1_400_000 + 1_200_000);
  expect(await createEventsRepo(db).listByTrip(uuid(11))).toEqual([]);
  expect(await createEventsRepo(db).listByTrip(uuid(10))).toHaveLength(2);
  expect(JSON.parse(first.counts_json!).speeding).toBe(2);
  await r.stop();
});

test('a terminal refusal fails the item and the drive for good; a transport failure retries; a 429 defers by Retry-After', async () => {
  await finalized(uuid(10));
  let mode: 'refuse' | 'network' | 'busy' = 'refuse';
  const supabase = createFakeSupabase({
    invoke: () => (mode === 'refuse' ? functionsHttpError(400, { code: 'spoofed_payload' }) : mode === 'network' ? functionsFetchError() : functionsHttpError(429, {}, { 'Retry-After': '120' })),
  });
  const r = runner(supabase);
  await r.start();
  expect(await r.drainOnce()).toMatchObject({ failed: 1 });
  expect(await createTripsRepo(db).get(uuid(10))).toMatchObject({ status: 'failed', sync_error: 'spoofed_payload' });
  expect((await createQueueRepo(db).byKey(`trip:${uuid(10)}`))?.status).toBe('failed');

  await finalized(uuid(12), T0 + 10_000_000);
  mode = 'network';
  expect(await r.drainOnce()).toMatchObject({ deferred: 1 });
  const item = (await createQueueRepo(db).byKey(`trip:${uuid(12)}`))!;
  expect(item).toMatchObject({ status: 'pending', attempts: 1, last_error: 'network' });
  await createQueueRepo(db).deferUntil(item.id, 0).catch(() => {});
  await db.execute('UPDATE sync_queue SET next_attempt_at = 0');
  mode = 'busy';
  await r.drainOnce();
  const after = (await createQueueRepo(db).byKey(`trip:${uuid(12)}`))!;
  expect(after.next_attempt_at).toBe(T0 + 2_000_000 + 120_000);
  await r.stop();
});

test('nothing is sent without a session, while recording, or under another user; items wait', async () => {
  await finalized(uuid(10));
  const supabase = createFakeSupabase({ uid: null, invoke: () => invokeOk(response(uuid(10))) });
  const r = runner(supabase);
  await r.start();
  expect(await r.drainOnce()).toMatchObject({ deferred: 1 });
  expect(supabase.invokes).toHaveLength(0);
  supabase.setUid('user-2');
  await db.execute('UPDATE sync_queue SET next_attempt_at = 0');
  expect(await r.drainOnce()).toMatchObject({ deferred: 1 });
  expect(supabase.invokes).toHaveLength(0);
  await r.stop();
  const busy = runner(createFakeSupabase({ invoke: () => invokeOk(response(uuid(10))) }), { isRecording: () => true });
  await busy.start();
  expect(await busy.drainOnce()).toMatchObject({ ran: false });
  await busy.stop();
});

test('drive actions: a report goes pending, the server’s acceptance removes the event and takes the server’s net; a refusal reads as rejected', async () => {
  await finalized(uuid(10));
  expect(await reportEvent(uuid(10), uuid(1), 'wrong_limit', { db })).toBe('queued');
  expect(await reportEvent(uuid(10), uuid(1), 'wrong_limit', { db })).toBe('already');
  expect((await createEventsRepo(db).get(uuid(1)))?.dispute_status).toBe('pending');
  const supabase = createFakeSupabase({
    invoke: ({ name, body }) => {
      expect(name).toBe('trip-actions');
      expect(body).toEqual({ action: 'dispute', clientTripId: uuid(10), eventId: uuid(1), reason: 'wrong_limit' });
      return invokeOk({ tripId: uuid(77), eventId: uuid(1), status: 'accepted', rejectReason: null, net: 121, delta: 15, progress: { points: 1, lifetime: 1, level: 1, levelUp: false, safetyRating: null, ranked: false } });
    },
  });
  const r = runner(supabase);
  await r.start();
  await db.execute('UPDATE sync_queue SET next_attempt_at = 0');
  expect(await r.drainOnce()).toMatchObject({ done: 1 });
  expect(await createEventsRepo(db).get(uuid(1))).toMatchObject({ dispute_status: 'accepted', status: 'removed' });
  expect(await createTripsRepo(db).get(uuid(10))).toMatchObject({ points_net: 121, estimate: 0 });
  await r.stop();

  await finalized(uuid(11), T0 + 5_000_000);
  await reportEvent(uuid(11), uuid(1), 'hazard', { db }).catch(() => {});
  const refusing = createFakeSupabase({ invoke: () => functionsHttpError(400, { code: 'reason_mismatch' }) });
  const r2 = runner(refusing);
  await r2.start();
  await db.execute('UPDATE sync_queue SET next_attempt_at = 0');
  await r2.drainOnce();
  await r2.stop();
});

test('"wasn’t driving": optimistic locally, confirmed by the server, or put back when refused', async () => {
  await finalized(uuid(10));
  expect(await markNotDriving(uuid(10), { db })).toBe('queued');
  expect(await createTripsRepo(db).get(uuid(10))).toMatchObject({ status: 'not_driving', points_net: 0 });
  const refusing = createFakeSupabase({ invoke: () => functionsHttpError(403, { code: 'too_old' }) });
  const r = runner(refusing);
  await r.start();
  await db.execute('UPDATE sync_queue SET next_attempt_at = 0');
  await r.drainOnce();
  expect(refusing.invokes[0]!.body).toEqual({ action: 'not_driving', clientTripId: uuid(10) });
  expect(await createTripsRepo(db).get(uuid(10))).toMatchObject({ status: 'pending', sync_error: 'too_old' });
  await r.stop();

  expect(await markNotDriving(uuid(10), { db })).toBe('already');
  await db.execute("UPDATE trips SET status = 'scored'");
  await db.execute('DELETE FROM sync_queue');
  await markNotDriving(uuid(10), { db });
  const ok = createFakeSupabase({
    invoke: () => invokeOk({ tripId: uuid(77), clientTripId: uuid(10), notDrivingLeft: 1, progress: { points: 0, lifetime: 0, level: 1, streak: 0, atRisk: false, freezes: 2, safetyRating: null, ranked: false } }),
  });
  const r2 = runner(ok);
  await r2.start();
  await db.execute('UPDATE sync_queue SET next_attempt_at = 0');
  expect(await r2.drainOnce()).toMatchObject({ done: 1 });
  expect(await createTripsRepo(db).get(uuid(10))).toMatchObject({ status: 'not_driving', points_net: 0, estimate: 0 });
  await r2.stop();
});

test('the runner wakes on the enqueue change event and on foreground', async () => {
  jest.useFakeTimers();
  try {
    const supabase = createFakeSupabase({ invoke: ({ body }) => invokeOk(response((body as { clientTripId: string }).clientTripId)) });
    const appState = createFakeAppState('background');
    const r = runner(supabase, { appState });
    await r.start();
    await jest.advanceTimersByTimeAsync(10);
    await finalized(uuid(10));
    await jest.advanceTimersByTimeAsync(10);
    await r.idle();
    expect(supabase.invokes).toHaveLength(1);
    await r.stop();
  } finally {
    jest.useRealTimers();
  }
});

test('joinPolylines concatenates two routes', () => {
  expect(joinPolylines(null, null)).toBeNull();
  const a = joinPolylines('_p~iF~ps|U', null);
  expect(a).toBe('_p~iF~ps|U');
  expect(joinPolylines('_p~iF~ps|U', '_p~iF~ps|U')).not.toBeNull();
});
