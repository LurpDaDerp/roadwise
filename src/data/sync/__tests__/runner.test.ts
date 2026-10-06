/** @jest-environment node */
import { T0 } from '@/core/detectors/__fixtures__/rows';
import { closedSession, speedingEvent, TZ, uuid } from '@/core/engine/__fixtures__/drives';
import { finalizeTrip } from '@/core/engine/finalize';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createEventsRepo, createQueueRepo, createSettingsRepo, createTripsRepo, migrate, type Db } from '@/data/db';
import { createFakeAppState, createFakeSupabase, functionsFetchError, functionsHttpError, invokeOk } from '@/data/sync/__fixtures__/fakes';
import { markNotDriving, reportEvent } from '@/data/sync/driveActions';
import type { FinalizeTripResponseV3 } from '@/data/sync/payload';
import { emitDataChanged } from '@/data/events';
import { createSyncRunner, FOREIGN_OWNER_RETRY_MS, joinPolylines, NO_SESSION_RETRY_MS } from '@/data/sync/runner';
import { encodePolyline, splitRuns } from '@/lib/polyline';

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

/** A finalized drive whose one speeding event carries the id `eventId` (default: the drive's own number + 500). */
async function finalized(clientTripId: string, t0 = T0, eventId = uuid(500 + Number(clientTripId.slice(-3)))): Promise<void> {
  const session = closedSession(1200, [speedingEvent(t0 + 300_000, 20, eventId)], { clientTripId, t0 });
  await finalizeTrip(session, { db, tz: TZ, now: () => t0 + 1_300_000, appVersion: '3', geocode: null });
}

function runner(supabase: ReturnType<typeof createFakeSupabase>, over: Partial<Parameters<typeof createSyncRunner>[0]> = {}) {
  return createSyncRunner({ db, supabase, mayDrain: () => true, isRecording: () => false, now: () => T0 + 2_000_000, ...over });
}

test('posts the queued v3 payload verbatim and writes the server’s answer into the drive', async () => {
  await finalized(uuid(10), T0, uuid(1));
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
  await db.execute('UPDATE sync_queue SET next_attempt_at = 0');
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
  await db.execute('UPDATE sync_queue SET next_attempt_at = 0');
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
  await finalized(uuid(10), T0, uuid(1));
  await db.execute('DELETE FROM sync_queue');
  expect(await reportEvent(uuid(10), uuid(1), 'wrong_limit', { db })).toBe('queued');
  expect(await reportEvent(uuid(10), uuid(1), 'wrong_limit', { db })).toBe('already');
  expect((await createEventsRepo(db).get(uuid(1)))?.dispute_status).toBe('pending');
  const supabase = createFakeSupabase({
    invoke: ({ name, body }) => {
      expect(name).toBe('trip-actions');
      expect(body).toEqual({ action: 'dispute', clientTripId: uuid(10), eventId: uuid(1), reason: 'wrong_limit' });
      return invokeOk({
        tripId: uuid(77),
        eventId: uuid(1),
        status: 'accepted',
        rejectReason: null,
        net: 121,
        delta: 15,
        quotaLeft: 2,
        breakdown: { ...response(uuid(10)).breakdown, events: [], penalties: 0, net: 121, ratingPenalty: 0, activeEventCount: 0 },
        progress: { points: 1, lifetime: 1, level: 1, levelUp: false, safetyRating: null, ranked: false },
      });
    },
  });
  const r = runner(supabase);
  await r.start();
  await db.execute('UPDATE sync_queue SET next_attempt_at = 0');
  expect(await r.drainOnce()).toMatchObject({ done: 1 });
  expect(await createEventsRepo(db).get(uuid(1))).toMatchObject({ dispute_status: 'accepted', status: 'removed', penalty: 0 });
  const disputed = await createTripsRepo(db).get(uuid(10));
  expect(disputed).toMatchObject({ points_net: 121, estimate: 0 });
  // the stored breakdown is the server's re-score, so the itemised list sums to the net
  expect(JSON.parse(disputed!.breakdown_json!)).toMatchObject({ net: 121, penalties: 0, events: [] });
  await r.stop();

  await finalized(uuid(11), T0 + 5_000_000, uuid(2));
  await db.execute('DELETE FROM sync_queue');
  await reportEvent(uuid(11), uuid(2), 'hazard', { db });
  const refusing = createFakeSupabase({ invoke: () => functionsHttpError(400, { code: 'reason_mismatch' }) });
  const r2 = runner(refusing);
  await r2.start();
  await db.execute('UPDATE sync_queue SET next_attempt_at = 0');
  await r2.drainOnce();
  await r2.stop();
  expect(await createEventsRepo(db).get(uuid(2))).toMatchObject({ dispute_status: 'rejected', status: 'active', dispute_message: expect.stringContaining('reason') });
});

test('"wasn’t driving": optimistic locally, confirmed by the server, or put back when refused', async () => {
  await finalized(uuid(10));
  await db.execute('DELETE FROM sync_queue');
  expect(await markNotDriving(uuid(10), { db })).toBe('queued');
  expect(await markNotDriving(uuid(10), { db })).toBe('already');
  expect(await createTripsRepo(db).get(uuid(10))).toMatchObject({ status: 'not_driving', points_net: 0 });
  const refusing = createFakeSupabase({ invoke: () => functionsHttpError(403, { code: 'too_old' }) });
  const r = runner(refusing);
  await r.start();
  await db.execute('UPDATE sync_queue SET next_attempt_at = 0');
  await r.drainOnce();
  expect(refusing.invokes[0]!.body).toEqual({ action: 'not_driving', clientTripId: uuid(10) });
  expect(await createTripsRepo(db).get(uuid(10))).toMatchObject({ status: 'pending', sync_error: 'too_old' });
  await r.stop();

  // Refused → back to pending, so the user may try again later (the server decides again).
  await db.execute("UPDATE trips SET status = 'scored'");
  await db.execute('DELETE FROM sync_queue');
  expect(await markNotDriving(uuid(10), { db })).toBe('queued');
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

test('joinPolylines carries every run of both drives as separate runs, never a line across the hidden gap; over the caps the shortest go first', () => {
  expect(joinPolylines(null, null)).toBeNull();
  expect(joinPolylines('', null)).toBeNull();
  const one = encodePolyline([{ lat: 47.6, lng: -122.3 }, { lat: 47.61, lng: -122.3 }]);
  const three = encodePolyline([{ lat: 48.6, lng: -122.3 }, { lat: 48.61, lng: -122.3 }, { lat: 48.62, lng: -122.3 }]);
  const two = encodePolyline([{ lat: 49.6, lng: -122.3 }, { lat: 49.61, lng: -122.3 }]);
  expect(joinPolylines(one, null)).toBe(one);
  expect(joinPolylines(null, three)).toBe(three);
  // Target's runs first, then the new drive's: each still its own run (the strings are unchanged, so no chord is drawn).
  expect(joinPolylines(one, three)).toBe(`${one} ${three}`);
  expect(joinPolylines(`${one} ${two}`, three)).toBe(`${one} ${two} ${three}`);
  expect(splitRuns(joinPolylines(`${one} ${two}`, three))).toEqual([one, two, three]);
  // Over the run cap or the byte cap, the shortest runs are dropped and the rest keep their order.
  const shorter = one.length <= two.length ? one : two;
  const longer = shorter === one ? two : one;
  expect(joinPolylines(`${one} ${two}`, three, 16_384, 2)).toBe(`${longer} ${three}`);
  expect(joinPolylines(`${one} ${two}`, three, three.length + longer.length + 1)).toBe(`${longer} ${three}`);
  expect(joinPolylines(one, three, three.length)).toBe(three);
});

test('a reply that lands after the device changed hands writes nothing and releases the item', async () => {
  await finalized(uuid(10));
  const supabase = createFakeSupabase({
    invoke: async ({ body }) => {
      // The phone changes hands while the request is in flight.
      await createSettingsRepo(db).set('device.lastUserId', 'user-2');
      return invokeOk(response((body as { clientTripId: string }).clientTripId));
    },
  });
  const r = runner(supabase);
  await r.start();
  expect(await r.drainOnce()).toMatchObject({ done: 0, deferred: 1 });
  expect(await createTripsRepo(db).get(uuid(10))).toMatchObject({ status: 'pending', estimate: 1, result_json: null });
  const item = (await createQueueRepo(db).byKey(`trip:${uuid(10)}`))!;
  expect(item).toMatchObject({ status: 'pending', attempts: 0, next_attempt_at: T0 + 2_000_000 + FOREIGN_OWNER_RETRY_MS });
  await r.stop();
});

test('no session and a foreign owner release the item for their own retry times; the refusal write is fenced too', async () => {
  await finalized(uuid(10));
  const noSession = createFakeSupabase({ uid: null });
  const r = runner(noSession);
  await r.start();
  await r.drainOnce();
  expect((await createQueueRepo(db).byKey(`trip:${uuid(10)}`))!.next_attempt_at).toBe(T0 + 2_000_000 + NO_SESSION_RETRY_MS);
  await r.stop();
  await db.execute('UPDATE sync_queue SET next_attempt_at = 0');
  const other = createFakeSupabase({ uid: 'user-2', invoke: () => invokeOk({}) });
  const r2 = runner(other);
  await r2.start();
  await r2.drainOnce();
  expect(other.invokes).toHaveLength(0);
  expect((await createQueueRepo(db).byKey(`trip:${uuid(10)}`))!.next_attempt_at).toBe(T0 + 2_000_000 + FOREIGN_OWNER_RETRY_MS);
  await r2.stop();
  await db.execute('UPDATE sync_queue SET next_attempt_at = 0');
  const refusing = createFakeSupabase({
    invoke: async () => {
      await createSettingsRepo(db).set('device.lastUserId', 'user-2');
      return functionsHttpError(400, { code: 'spoofed_payload' });
    },
  });
  const r3 = runner(refusing);
  await r3.start();
  await r3.drainOnce();
  expect((await createQueueRepo(db).byKey(`trip:${uuid(10)}`))!.status).toBe('failed');
  expect((await createTripsRepo(db).get(uuid(10)))!.status).toBe('pending'); // the fence held the local write
  await r3.stop();
});

test('no polling during a drive: a wake while recording arms no further timer; the finalize change event wakes it', async () => {
  jest.useFakeTimers();
  try {
    let recording = true;
    const supabase = createFakeSupabase({ invoke: ({ body }) => invokeOk(response((body as { clientTripId: string }).clientTripId)) });
    const r = runner(supabase, { isRecording: () => recording });
    await r.start();
    await jest.advanceTimersByTimeAsync(10);
    expect(jest.getTimerCount()).toBe(0);
    await finalized(uuid(10));
    await jest.advanceTimersByTimeAsync(60_000);
    expect(jest.getTimerCount()).toBe(0);
    expect(supabase.invokes).toHaveLength(0);
    recording = false;
    emitDataChanged({ source: 'finalize' });
    await jest.advanceTimersByTimeAsync(10);
    await r.idle();
    expect(supabase.invokes).toHaveLength(1);
    await r.stop();
  } finally {
    jest.useRealTimers();
  }
});
