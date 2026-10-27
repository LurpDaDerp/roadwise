/** @jest-environment node */
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createEventsRepo, createQueueRepo, createSamplesRepo, createSettingsRepo, createTripsRepo, migrate, type Db } from '@/data/db';
import { REFUSED_NEVER } from '@/data/db/queue';
import { createFakeAppState, createFakeSupabase, functionsFetchError, functionsHttpError, invokeOk } from '@/data/sync/__fixtures__/fakes';
import { answer, finishedDrive, payloadV3, payloadV4, payloadV5, pickup, speeding, T0, uuid } from '@/data/sync/__fixtures__/drives';
import { markNotDriving, reportEvent } from '@/data/sync/driveActions';
import { emitDataChanged, onDataChanged } from '@/data/events';
import { enqueueFinalize } from '@/data/sync/queue';
import { createSyncRunner, FOREIGN_OWNER_RETRY_MS, NO_SESSION_RETRY_MS, RETRY_WAKE_MIN_MS } from '@/data/sync/runner';
import { toLocalDrive } from '@/data/queries/rows';
import { canMarkNotDriving, notDrivingRefusal } from '@/features/drives/summary';

let db: Db;
beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
  await createSettingsRepo(db).set('device.lastUserId', 'user-1');
});

/** A finished drive whose one speeding event carries the id `eventId` (default: the drive's own number + 500). */
async function finalized(clientTripId: string, t0 = T0, eventId = uuid(500 + Number(clientTripId.slice(-3)))): Promise<void> {
  await finishedDrive(db, clientTripId, { t0, events: [speeding(eventId, t0)] });
}

const response = answer;

function runner(supabase: ReturnType<typeof createFakeSupabase>, over: Partial<Parameters<typeof createSyncRunner>[0]> = {}) {
  return createSyncRunner({ db, supabase, mayDrain: () => true, isRecording: () => false, now: () => T0 + 2_000_000, ...over });
}

const samplesOf = (id: string) => createSamplesRepo(db).count(id);

test('posts the queued v5 payload and writes the server’s answer into the drive; the drive’s samples go once it is sent', async () => {
  await finalized(uuid(10), T0, uuid(1));
  expect(await samplesOf(uuid(10))).toBe(2);
  const supabase = createFakeSupabase({ invoke: ({ body }) => invokeOk(response((body as { clientTripId: string }).clientTripId, { eventIds: [uuid(1)] })) });
  const r = runner(supabase);
  await r.start();
  const result = await r.drainOnce();
  expect(result).toMatchObject({ ran: true, done: 1, failed: 0 });
  expect(supabase.invokes).toHaveLength(1);
  expect(supabase.invokes[0]!.name).toBe('finalize-trip');
  expect(supabase.invokes[0]!.body).toMatchObject({ v: 5, clientTripId: uuid(10), origin: 'manual', notDrivingExpired: false, exposure: { slowdowns: 4, phoneS: 1000 } });
  const trip = (await createTripsRepo(db).get(uuid(10)))!;
  expect(trip).toMatchObject({ status: 'scored', clean: 0, server_id: uuid(77), reason: null, sync_error: null });
  expect(JSON.parse(trip.result_json!)).toMatchObject({ rating: { safetyRating: 91.2, ranked: true }, eventIds: [uuid(1)] });
  expect(await createQueueRepo(db).countByStatus('done')).toBe(1);
  expect(await samplesOf(uuid(10))).toBe(0);
  await r.stop();
});

test('a drive an older build queued as v3 goes up as v5: its phone event and safe miles stay behind, origin manual, "Not driving?" never ran out', async () => {
  const p = payloadV3(uuid(12), { events: [speeding(uuid(1), T0)] });
  await createTripsRepo(db).insert({ client_trip_id: uuid(12), started_at: T0, tz: 'UTC', status: 'pending' }, T0);
  // An older build validated it against v3; the queue stores what it was given.
  await createQueueRepo(db).enqueue('finalize-trip', p, `trip:${uuid(12)}`, T0, undefined, 'user-1');
  const supabase = createFakeSupabase({ invoke: ({ body }) => invokeOk(response((body as { clientTripId: string }).clientTripId)) });
  const r = runner(supabase);
  await r.start();
  expect(await r.drainOnce()).toMatchObject({ done: 1 });
  const sent = supabase.invokes[0]!.body as Record<string, unknown>;
  expect(sent).toMatchObject({ v: 5, origin: 'manual', notDrivingExpired: false });
  expect(sent).not.toHaveProperty('safeMiles');
  expect(sent).not.toHaveProperty('exposure');
  expect((sent.events as { id: string }[]).map((e) => e.id)).toEqual([uuid(1)]);
  await r.stop();
});

test('a drive a build from before phone tracking queued as v4 goes up as v5 with no phone seconds (it was not watched)', async () => {
  const p = payloadV4(uuid(14), { events: [speeding(uuid(2), T0)] });
  await createTripsRepo(db).insert({ client_trip_id: uuid(14), started_at: T0, tz: 'UTC', status: 'pending' }, T0);
  await createQueueRepo(db).enqueue('finalize-trip', p, `trip:${uuid(14)}`, T0, undefined, 'user-1');
  const supabase = createFakeSupabase({ invoke: ({ body }) => invokeOk(response((body as { clientTripId: string }).clientTripId)) });
  const r = runner(supabase);
  await r.start();
  expect(await r.drainOnce()).toMatchObject({ done: 1 });
  expect(supabase.invokes[0]!.body).toMatchObject({ v: 5, exposure: { slowdowns: 4, speedups: 5, turns: 3, limitS: 900, movingS: 1100, phoneS: 0 } });
  await r.stop();
});

test('a phone pickup goes up with its seconds in hand and speeds', async () => {
  await finishedDrive(db, uuid(15), { events: [speeding(uuid(3), T0), pickup(uuid(4), T0)] });
  const supabase = createFakeSupabase({ invoke: ({ body }) => invokeOk(response((body as { clientTripId: string }).clientTripId, { eventIds: [uuid(3), uuid(4)] })) });
  const r = runner(supabase);
  await r.start();
  expect(await r.drainOnce()).toMatchObject({ done: 1 });
  const sent = supabase.invokes[0]!.body as { events: unknown[] };
  expect(sent.events).toContainEqual(expect.objectContaining({ id: uuid(4), type: 'phone_pickup', tier: 'moderate', durationS: 12, measured: { speedMph: 35, maxSpeedMph: 41.5 } }));
  await r.stop();
});

test('enqueueFinalize refuses anything but a valid v5 upload', async () => {
  await createTripsRepo(db).insert({ client_trip_id: uuid(13), started_at: T0, tz: 'UTC', status: 'pending' }, T0);
  await expect(enqueueFinalize(db, payloadV3(uuid(13)) as never)).rejects.toThrow();
  await expect(enqueueFinalize(db, payloadV4(uuid(13)) as never)).rejects.toThrow();
  expect(await createQueueRepo(db).countByStatus('pending')).toBe(0);
});

test('an answer naming a mergedInto (an older server joined this upload to the drive before) takes the local drive away with its events and samples; the drive before is untouched', async () => {
  await finishedDrive(db, uuid(10), { t0: T0, events: [speeding(uuid(510), T0)] });
  await finishedDrive(db, uuid(11), { t0: T0 + 1_400_000, events: [speeding(uuid(511), T0 + 1_400_000)] });
  await createSamplesRepo(db).appendMany(uuid(11), [{ ts: T0 + 1_400_000, row: {} }]);
  const supabase = createFakeSupabase({
    invoke: ({ body }) => {
      const id = (body as { clientTripId: string }).clientTripId;
      return invokeOk(id === uuid(10) ? response(uuid(10), { eventIds: [uuid(510)] }) : response(uuid(11), { mergedInto: uuid(10), eventIds: [uuid(510), uuid(511)] }));
    },
  });
  const r = runner(supabase);
  await r.start();
  await db.execute('UPDATE sync_queue SET next_attempt_at = 0');
  await r.drainOnce();
  const trips = createTripsRepo(db);
  expect(await trips.get(uuid(11))).toBeNull();
  expect(await createEventsRepo(db).listByTrip(uuid(11))).toEqual([]);
  expect(await samplesOf(uuid(11))).toBe(0);
  expect(await trips.get(uuid(10))).toMatchObject({ status: 'scored', miles: 11, server_id: uuid(77) });
  expect((await createEventsRepo(db).listByTrip(uuid(10))).map((e) => e.id)).toEqual([uuid(510)]);
  expect(await createQueueRepo(db).countByStatus('pending')).toBe(0);
  await r.stop();
});

/** A local DashPal event on a finalized drive, as finalize stores it. */
async function dashpal(clientTripId: string, id: string, type: 'drowsy' | 'eyes_off', startedAt: number, over: { dispute_status?: 'none' | 'pending' } = {}): Promise<void> {
  await createEventsRepo(db).insert({
    id,
    client_trip_id: clientTripId,
    type,
    tier: 'severe',
    started_at: startedAt,
    duration_s: 4,
    lat: null,
    lng: null,
    measured_json: JSON.stringify({ source: 'dashcam', speedMph: 33 }),
    status: 'active',
    dispute_status: over.dispute_status ?? 'none',
  });
}

test('every answer: a DashPal event the server did not keep is deleted and the counts follow; a phone-recorded event and one with a report in flight stay; an unscored drive has no clean flag', async () => {
  await finalized(uuid(10), T0, uuid(1));
  await dashpal(uuid(10), uuid(600), 'drowsy', T0 + 400_000);
  await dashpal(uuid(10), uuid(601), 'eyes_off', T0 + 500_000, { dispute_status: 'pending' });
  await finalized(uuid(12), T0 + 10_000_000, uuid(2));
  await dashpal(uuid(12), uuid(602), 'drowsy', T0 + 10_400_000);
  const supabase = createFakeSupabase({
    invoke: ({ body }) => {
      const id = (body as { clientTripId: string }).clientTripId;
      if (id === uuid(10)) return invokeOk(response(uuid(10), { eventIds: [] }));
      return invokeOk(response(uuid(12), { scored: false, reason: 'too_short', eventIds: [uuid(2), uuid(602)] }));
    },
  });
  const r = runner(supabase);
  await r.start();
  await db.execute('UPDATE sync_queue SET next_attempt_at = 0');
  await r.drainOnce();
  expect((await createEventsRepo(db).listByTrip(uuid(10))).map((e) => e.id)).toEqual([uuid(1), uuid(601)]);
  expect(JSON.parse((await createTripsRepo(db).get(uuid(10)))!.counts_json!)).toMatchObject({ speeding: 1, drowsy: 0, eyesOff: 1 });
  expect((await createEventsRepo(db).listByTrip(uuid(12))).map((e) => e.id)).toEqual([uuid(2), uuid(602)]);
  expect(await createTripsRepo(db).get(uuid(12))).toMatchObject({ status: 'unscored', reason: 'too_short', clean: null });
  await r.stop();
});

test('a drive whose row reads recording when its answer lands is left as it is', async () => {
  await finalized(uuid(10));
  const supabase = createFakeSupabase({
    invoke: async ({ body }) => {
      await db.execute("UPDATE trips SET status = 'recording', ended_at = NULL WHERE client_trip_id = ?", [uuid(10)]);
      return invokeOk(response((body as { clientTripId: string }).clientTripId));
    },
  });
  const r = runner(supabase);
  await r.start();
  expect(await r.drainOnce()).toMatchObject({ done: 1 });
  expect(await createTripsRepo(db).get(uuid(10))).toMatchObject({ status: 'recording', result_json: null, server_id: null });
  expect(await samplesOf(uuid(10))).toBe(2);
  await r.stop();
});

test('a server older than the upload (a 400 that refuses the contract version) is retried, never a refusal: the drive stays pending', async () => {
  await finalized(uuid(10));
  const r = runner(createFakeSupabase({ invoke: () => functionsHttpError(400, { code: 'invalid_payload', issues: [{ path: 'v', message: 'Invalid input: expected 3' }, { path: '', message: 'Unrecognized keys' }] }) }));
  await r.start();
  expect(await r.drainOnce()).toMatchObject({ failed: 0, deferred: 1 });
  expect(await createTripsRepo(db).get(uuid(10))).toMatchObject({ status: 'pending', sync_error: null });
  expect(await createQueueRepo(db).byKey(`trip:${uuid(10)}`)).toMatchObject({ status: 'pending', attempts: 1, last_error: 'server_behind' });
  await r.stop();
});

test('an upload that ran out of retries on server answers is still owed: the drive stays pending and a sign-out would not take it as nothing left', async () => {
  await finalized(uuid(10));
  const behind = functionsHttpError(400, { code: 'invalid_payload', issues: [{ path: 'v', message: 'Invalid input: expected 5' }] });
  let clock = T0 + 2_000_000;
  const r = createSyncRunner({ db, supabase: createFakeSupabase({ invoke: () => behind }), mayDrain: () => true, isRecording: () => false, now: () => clock });
  await r.start();
  for (let n = 0; n < 25; n += 1) {
    await r.drainOnce();
    clock += 3_600_000 + 1000;
  }
  expect(await createQueueRepo(db).byKey(`trip:${uuid(10)}`)).toMatchObject({ status: 'failed', attempts: 20, last_error: 'server_behind' });
  expect((await createTripsRepo(db).get(uuid(10)))?.status).toBe('pending');
  expect(await createQueueRepo(db).reopenRetryable(clock)).toBe(0);
  expect(await r.owed()).toBe(1);
  await r.stop();
});

test('a Retry-After past an hour is held to the hour', async () => {
  await finalized(uuid(10));
  const r = runner(createFakeSupabase({ invoke: () => functionsHttpError(503, {}, { 'Retry-After': '86400' }) }));
  await r.start();
  await r.drainOnce();
  expect((await createQueueRepo(db).byKey(`trip:${uuid(10)}`))?.next_attempt_at).toBe(T0 + 2_000_000 + 3_600_000);
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

test('a 404 (the function not deployed yet) is no refusal: the drive stays pending and the upload retries; a drive an earlier build failed on one is picked up again', async () => {
  await finalized(uuid(10));
  const r = runner(createFakeSupabase({ invoke: () => functionsHttpError(404, {}) }));
  await r.start();
  expect(await r.drainOnce()).toMatchObject({ failed: 0, deferred: 1 });
  expect(await createTripsRepo(db).get(uuid(10))).toMatchObject({ status: 'pending', sync_error: null });
  expect(await createQueueRepo(db).byKey(`trip:${uuid(10)}`)).toMatchObject({ status: 'pending', attempts: 1, last_error: 'http_404' });
  await r.stop();

  // What an earlier build left behind: the item refused for good on the 404, the drive `failed` with it.
  await db.execute("UPDATE sync_queue SET status = 'failed', next_attempt_at = ?, last_error = 'http_404'", [REFUSED_NEVER]);
  await createTripsRepo(db).update(uuid(10), { status: 'failed', sync_error: 'http_404' });
  const deployed = runner(createFakeSupabase({ invoke: ({ body }) => invokeOk(response((body as { clientTripId: string }).clientTripId)) }));
  await deployed.start();
  expect(await deployed.drainOnce()).toMatchObject({ done: 1 });
  expect(await createTripsRepo(db).get(uuid(10))).toMatchObject({ status: 'scored', sync_error: null });
  await deployed.stop();
});

test('a report on an event the server does not hold (404 not_found) reads as refused and is never reopened', async () => {
  await finalized(uuid(10), T0, uuid(1));
  await db.execute('DELETE FROM sync_queue');
  await reportEvent(uuid(10), uuid(1), 'wrong_limit', { db });
  const r = runner(createFakeSupabase({ invoke: () => functionsHttpError(404, { code: 'not_found' }) }));
  await r.start();
  await db.execute('UPDATE sync_queue SET next_attempt_at = 0');
  expect(await r.drainOnce()).toMatchObject({ failed: 1 });
  expect(await createEventsRepo(db).get(uuid(1))).toMatchObject({ dispute_status: 'rejected', dispute_message: 'This event is no longer on the server.' });
  expect(await createQueueRepo(db).reopenRetryable(T0 + 9_000_000_000)).toBe(0);
  expect(await r.owed()).toBe(0);
  await r.stop();
});

describe('"Wasn’t driving" or a report before the drive’s upload has gone (review I5)', () => {
  /** A server that holds a drive only once its upload arrived: an action on any other is `not_found`. */
  function server(opts: { uploads?: () => 'ok' | 'down' } = {}) {
    const stored = new Set<string>();
    return createFakeSupabase({
      invoke: ({ name, body }) => {
        const b = body as { clientTripId: string; action?: string };
        if (name === 'finalize-trip') {
          if ((opts.uploads?.() ?? 'ok') === 'down') return functionsHttpError(503, { code: 'unavailable' });
          stored.add(b.clientTripId);
          return invokeOk(response(b.clientTripId));
        }
        if (!stored.has(b.clientTripId)) return functionsHttpError(404, { code: 'not_found' });
        if (b.action === 'not_driving') return invokeOk({ tripId: uuid(77), clientTripId: b.clientTripId, notDrivingLeft: 1, rating: { safetyRating: null, ranked: false } });
        return invokeOk({ eventId: uuid(1), status: 'accepted', message: null });
      },
    });
  }

  /** A finished drive whose upload has not gone yet (it waits, say for a session): due 5 min from its finalize. */
  async function waitingDrive(): Promise<number> {
    await finalized(uuid(10), T0, uuid(1));
    const item = (await createQueueRepo(db).byKey(`trip:${uuid(10)}`))!;
    await createQueueRepo(db).deferUntil(item.id, item.next_attempt_at + 300_000);
    return item.next_attempt_at;
  }

  test('"Wasn’t driving" a minute after the end: the waiting upload is due at once and goes first, then the mark lands', async () => {
    const finalizedAt = await waitingDrive();
    const tap = finalizedAt + 60_000;
    expect(await markNotDriving(uuid(10), { db, now: () => tap })).toBe('queued');
    expect((await createQueueRepo(db).byKey(`trip:${uuid(10)}`))?.next_attempt_at).toBe(tap);
    const s = server();
    const r = runner(s, { now: () => tap + 1000 });
    await r.start();
    expect(await r.drainOnce()).toMatchObject({ done: 2, failed: 0 });
    expect(s.invokes.map((i) => i.name)).toEqual(['finalize-trip', 'trip-actions']);
    expect(await createTripsRepo(db).get(uuid(10))).toMatchObject({ status: 'not_driving', server_id: uuid(77) });
    await r.stop();
  });

  test('a report a minute after the end: the upload goes first and the report is settled, never rejected as missing', async () => {
    const finalizedAt = await waitingDrive();
    const tap = finalizedAt + 60_000;
    expect(await reportEvent(uuid(10), uuid(1), 'wrong_limit', { db, now: () => tap })).toBe('queued');
    const s = server();
    const r = runner(s, { now: () => tap + 1000 });
    await r.start();
    await r.drainOnce();
    expect(s.invokes.map((i) => i.name)).toEqual(['finalize-trip', 'trip-actions']);
    expect((await createEventsRepo(db).get(uuid(1)))?.dispute_status).not.toBe('rejected');
    await r.stop();
  });

  /** A server that stores uploads and answers each "Wasn't driving" with `mark()`. */
  function marking(mark: () => ReturnType<typeof invokeOk>, uploads: () => 'ok' | 'lost' = () => 'ok') {
    const stored = new Set<string>();
    return createFakeSupabase({
      invoke: ({ name, body }) => {
        const b = body as { clientTripId: string };
        if (name === 'finalize-trip') {
          stored.add(b.clientTripId);
          return uploads() === 'lost' ? functionsFetchError() : invokeOk(response(b.clientTripId, { scored: false, reason: 'too_short' }));
        }
        return stored.has(b.clientTripId) ? mark() : functionsHttpError(404, { code: 'not_found' });
      },
    });
  }

  test('"Wasn’t driving" before the upload went, refused for good after the upload answered: back to the upload’s status with the reason, never offered again silently', async () => {
    const finalizedAt = await waitingDrive();
    const tap = finalizedAt + 60_000;
    await markNotDriving(uuid(10), { db, now: () => tap });
    const s = marking(() => functionsHttpError(403, { code: 'no_uses_left' }));
    const r = runner(s, { now: () => tap + 1000 });
    await r.start();
    expect(await r.drainOnce()).toMatchObject({ done: 1, failed: 1 });
    expect(s.invokes.map((i) => i.name)).toEqual(['finalize-trip', 'trip-actions']);
    const trip = (await createTripsRepo(db).get(uuid(10)))!;
    expect(trip).toMatchObject({ status: 'unscored', clean: null, reason: 'too_short', server_id: uuid(77), sync_error: 'no_uses_left' });
    expect(notDrivingRefusal(toLocalDrive(trip))).not.toBeNull();
    expect(canMarkNotDriving(toLocalDrive(trip), tap + 2000)).toBe(false);
    await r.stop();
  });

  test('"Wasn’t driving" before the upload went, whose mark fails on a blip: the upload’s answer keeps the drive marked while the mark retries, then it lands', async () => {
    const finalizedAt = await waitingDrive();
    const tap = finalizedAt + 60_000;
    await markNotDriving(uuid(10), { db, now: () => tap });
    let up = false;
    const s = marking(() =>
      up ? invokeOk({ tripId: uuid(77), clientTripId: uuid(10), notDrivingLeft: 1, rating: { safetyRating: null, ranked: false } }) : functionsHttpError(503, { code: 'unavailable' })
    );
    let clock = tap + 1000;
    const r = runner(s, { now: () => clock });
    await r.start();
    expect(await r.drainOnce()).toMatchObject({ done: 1, failed: 0, deferred: 1 });
    expect(await createTripsRepo(db).get(uuid(10))).toMatchObject({ status: 'not_driving', clean: null, reason: 'too_short', server_id: uuid(77), sync_error: null });
    up = true;
    clock += 120_000;
    expect(await r.drainOnce()).toMatchObject({ done: 1 });
    expect(await createTripsRepo(db).get(uuid(10))).toMatchObject({ status: 'not_driving', clean: null });
    await r.stop();
  });

  test('a refusal that comes before the upload’s answer (its first answer lost) survives that answer', async () => {
    const finalizedAt = await waitingDrive();
    const tap = finalizedAt + 60_000;
    await markNotDriving(uuid(10), { db, now: () => tap });
    let uploads: 'ok' | 'lost' = 'lost';
    const s = marking(() => functionsHttpError(403, { code: 'no_uses_left' }), () => uploads);
    let clock = tap + 1000;
    const r = runner(s, { now: () => clock });
    await r.start();
    expect(await r.drainOnce()).toMatchObject({ failed: 1, deferred: 1 });
    expect(await createTripsRepo(db).get(uuid(10))).toMatchObject({ status: 'pending', sync_error: 'no_uses_left' });
    uploads = 'ok';
    clock += 120_000;
    expect(await r.drainOnce()).toMatchObject({ done: 1 });
    expect(await createTripsRepo(db).get(uuid(10))).toMatchObject({ status: 'unscored', server_id: uuid(77), sync_error: 'no_uses_left' });
    await r.stop();
  });

  test('not_found while the drive’s upload is still owed is no refusal: nothing is undone, and the mark goes once the drive is up; a failed mark tapped again is really sent', async () => {
    const finalizedAt = await waitingDrive();
    const tap = finalizedAt + 60_000;
    await markNotDriving(uuid(10), { db, now: () => tap });
    // The upload fails on a server blip; the action reaches the server first and is told not_found.
    let uploads: 'ok' | 'down' = 'down';
    const s = server({ uploads: () => uploads });
    let clock = tap + 1000;
    const r = runner(s, { now: () => clock });
    await r.start();
    expect(await r.drainOnce()).toMatchObject({ done: 0, failed: 0, deferred: 2 });
    expect(await createTripsRepo(db).get(uuid(10))).toMatchObject({ status: 'not_driving', sync_error: null });
    expect((await createQueueRepo(db).byKey(`not_driving:${uuid(10)}`))).toMatchObject({ status: 'pending', last_error: 'not_found' });
    uploads = 'ok';
    clock += 120_000;
    expect(await r.drainOnce()).toMatchObject({ done: 2, failed: 0 });
    expect(await createTripsRepo(db).get(uuid(10))).toMatchObject({ status: 'not_driving', server_id: uuid(77) });
    await r.stop();

    // A mark the server refused for good (the drive really is not there): undone, and the next
    // tap re-arms the failed item, so it is sent again rather than silently kept failed.
    await finalized(uuid(11), T0, uuid(2));
    await db.execute("DELETE FROM sync_queue WHERE idempotency_key = ?", [`trip:${uuid(11)}`]);
    await markNotDriving(uuid(11), { db, now: () => clock });
    const r2 = runner(s, { now: () => clock });
    await r2.start();
    expect(await r2.drainOnce()).toMatchObject({ failed: 1 });
    expect(await createTripsRepo(db).get(uuid(11))).toMatchObject({ status: 'pending', sync_error: 'not_found' });
    expect(await markNotDriving(uuid(11), { db, now: () => clock })).toBe('queued');
    expect(await createQueueRepo(db).byKey(`not_driving:${uuid(11)}`)).toMatchObject({ status: 'pending', attempts: 0, next_attempt_at: clock });
    await r2.stop();
  });
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

test('"My phone was mounted" is a phone pickup’s report only: queued as the dispute, refused on any other event', async () => {
  await finishedDrive(db, uuid(10), { events: [speeding(uuid(1), T0), pickup(uuid(2), T0)] });
  await db.execute('DELETE FROM sync_queue');
  expect(await reportEvent(uuid(10), uuid(1), 'mounted', { db })).toBe('missing');
  expect((await createEventsRepo(db).get(uuid(1)))?.dispute_status).toBe('none');
  expect(await reportEvent(uuid(10), uuid(2), 'mounted', { db })).toBe('queued');
  expect(await createEventsRepo(db).get(uuid(2))).toMatchObject({ dispute_status: 'pending', dispute_reason: 'mounted' });
  const item = (await createQueueRepo(db).byKey(`dispute:${uuid(2)}`)) ?? null;
  expect(item === null ? null : JSON.parse(item.payload_json)).toEqual({ action: 'dispute', clientTripId: uuid(10), eventId: uuid(2), reason: 'mounted' });
});

test('drive actions: a report goes pending, the server’s acceptance removes the event and recounts the drive; a refusal reads as rejected', async () => {
  await finalized(uuid(10), T0, uuid(1));
  await db.execute('DELETE FROM sync_queue');
  expect(await reportEvent(uuid(10), uuid(1), 'wrong_limit', { db })).toBe('queued');
  expect(await reportEvent(uuid(10), uuid(1), 'wrong_limit', { db })).toBe('already');
  expect((await createEventsRepo(db).get(uuid(1)))?.dispute_status).toBe('pending');
  const supabase = createFakeSupabase({
    invoke: ({ name, body }) => {
      expect(name).toBe('trip-actions');
      expect(body).toEqual({ action: 'dispute', clientTripId: uuid(10), eventId: uuid(1), reason: 'wrong_limit' });
      return invokeOk({ tripId: uuid(77), eventId: uuid(1), status: 'accepted', rejectReason: null, quotaLeft: 2, clean: true, rating: { safetyRating: null, ranked: false } });
    },
  });
  const r = runner(supabase);
  await r.start();
  await db.execute('UPDATE sync_queue SET next_attempt_at = 0');
  expect(await r.drainOnce()).toMatchObject({ done: 1 });
  expect(await createEventsRepo(db).get(uuid(1))).toMatchObject({ dispute_status: 'accepted', status: 'removed' });
  const disputed = (await createTripsRepo(db).get(uuid(10)))!;
  expect(JSON.parse(disputed.counts_json!)).toMatchObject({ speeding: 0 });
  // not on the server yet as a scored drive: its own clean flag stands until the upload answers
  expect(disputed.clean).toBe(0);
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

test('a scored drive takes the server’s clean flag when a report is accepted; one over the weekly quota reads as turned down', async () => {
  await finalized(uuid(10), T0, uuid(1));
  const sync = createFakeSupabase({ invoke: () => invokeOk(response(uuid(10), { eventIds: [uuid(1)] })) });
  const r = runner(sync);
  await r.start();
  await r.drainOnce();
  await r.stop();
  expect(await createTripsRepo(db).get(uuid(10))).toMatchObject({ status: 'scored', clean: 0 });
  await reportEvent(uuid(10), uuid(1), 'wrong_limit', { db });
  const accepting = createFakeSupabase({
    invoke: () => invokeOk({ tripId: uuid(77), eventId: uuid(1), status: 'accepted', rejectReason: null, quotaLeft: 2, clean: true, rating: { safetyRating: 90, ranked: true } }),
  });
  const r2 = runner(accepting);
  await r2.start();
  await db.execute('UPDATE sync_queue SET next_attempt_at = 0');
  expect(await r2.drainOnce()).toMatchObject({ done: 1 });
  await r2.stop();
  expect(await createTripsRepo(db).get(uuid(10))).toMatchObject({ clean: 1 });

  await finalized(uuid(11), T0 + 5_000_000, uuid(2));
  await db.execute('DELETE FROM sync_queue');
  await reportEvent(uuid(11), uuid(2), 'hazard', { db });
  const quota = createFakeSupabase({
    invoke: () => invokeOk({ tripId: uuid(78), eventId: uuid(2), status: 'rejected', rejectReason: 'quota', quotaLeft: 0, clean: false, rating: { safetyRating: 90, ranked: true } }),
  });
  const r3 = runner(quota);
  await r3.start();
  await db.execute('UPDATE sync_queue SET next_attempt_at = 0');
  expect(await r3.drainOnce()).toMatchObject({ done: 1 });
  await r3.stop();
  expect(await createEventsRepo(db).get(uuid(2))).toMatchObject({ dispute_status: 'rejected', status: 'active', dispute_message: 'Weekly report limit reached.' });
});

test('"wasn’t driving": optimistic locally, confirmed by the server, or put back when refused', async () => {
  await finalized(uuid(10));
  await db.execute('DELETE FROM sync_queue');
  expect(await markNotDriving(uuid(10), { db })).toBe('queued');
  expect(await markNotDriving(uuid(10), { db })).toBe('already');
  expect(await createTripsRepo(db).get(uuid(10))).toMatchObject({ status: 'not_driving' });
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
    invoke: () => invokeOk({ tripId: uuid(77), clientTripId: uuid(10), notDrivingLeft: 1, rating: { safetyRating: null, ranked: false } }),
  });
  const r2 = runner(ok);
  await r2.start();
  await db.execute('UPDATE sync_queue SET next_attempt_at = 0');
  expect(await r2.drainOnce()).toMatchObject({ done: 1 });
  expect(await createTripsRepo(db).get(uuid(10))).toMatchObject({ status: 'not_driving', clean: null, server_id: uuid(77) });
  await r2.stop();
});

test('"wasn’t driving" on a drive whose "Not driving?" ran out is refused by the server and the drive is put back with the reason', async () => {
  await finalized(uuid(10));
  await db.execute("UPDATE trips SET status = 'scored', not_driving_expired = 1");
  await db.execute('DELETE FROM sync_queue');
  await markNotDriving(uuid(10), { db });
  const r = runner(createFakeSupabase({ invoke: () => functionsHttpError(403, { code: 'not_driving_expired' }) }));
  await r.start();
  await db.execute('UPDATE sync_queue SET next_attempt_at = 0');
  expect(await r.drainOnce()).toMatchObject({ failed: 1 });
  expect(await createTripsRepo(db).get(uuid(10))).toMatchObject({ status: 'scored', sync_error: 'not_driving_expired', not_driving_expired: 1 });
  await r.stop();
});

/** The server's copy of a local drive as `list_my_drives` lists it. */
async function serverCopy(clientTripId: string, over: Record<string, unknown> = {}, eventStatus: 'active' | 'removed' = 'active') {
  const trip = (await createTripsRepo(db).get(clientTripId))!;
  const events = await createEventsRepo(db).listByTrip(clientTripId);
  return {
    tripId: uuid(77),
    clientTripId,
    startedAt: trip.started_at,
    endedAt: trip.ended_at,
    tz: trip.tz,
    localDay: trip.local_day,
    miles: trip.miles,
    nightMiles: 0,
    durationS: trip.duration_s,
    polyline: null,
    scored: true,
    reason: null,
    notDriving: false,
    clean: false,
    origin: 'manual',
    notDrivingExpired: false,
    result: response(clientTripId),
    events: events.map((e) => ({ id: e.id, type: e.type, tier: e.tier, startedAt: e.started_at, durationS: e.duration_s, status: eventStatus })),
    ...over,
  };
}

describe('an action the server already holds (409: a retry whose first answer was lost) is never undone', () => {
  test('"wasn’t driving": the drive stays marked, the item settles, and the server’s copy is read back', async () => {
    await finalized(uuid(10));
    await db.execute('DELETE FROM sync_queue');
    await markNotDriving(uuid(10), { db });
    const copy = await serverCopy(uuid(10), { notDriving: true });
    const supabase = createFakeSupabase({ invoke: () => functionsHttpError(409, { code: 'already_marked' }), rpc: () => ({ data: [copy], error: null }) });
    const r = runner(supabase);
    await r.start();
    await db.execute('UPDATE sync_queue SET next_attempt_at = 0');
    expect(await r.drainOnce()).toMatchObject({ done: 1, failed: 0 });
    expect(supabase.rpcs[0]!.fn).toBe('list_my_drives');
    expect(await createTripsRepo(db).get(uuid(10))).toMatchObject({ status: 'not_driving', server_id: uuid(77), sync_error: null });
    expect(await r.owed()).toBe(0);
    await r.stop();
  });

  test('"wasn’t driving" with no way to read the server back still settles and keeps the mark (the newer code too)', async () => {
    await finalized(uuid(10));
    await db.execute('DELETE FROM sync_queue');
    await markNotDriving(uuid(10), { db });
    const supabase = createFakeSupabase({ invoke: () => functionsHttpError(409, { code: 'already_not_driving' }), rpc: () => ({ data: null, error: new Error('offline') }) });
    const r = runner(supabase);
    await r.start();
    await db.execute('UPDATE sync_queue SET next_attempt_at = 0');
    expect(await r.drainOnce()).toMatchObject({ done: 1 });
    expect(await createTripsRepo(db).get(uuid(10))).toMatchObject({ status: 'not_driving' });
    await r.stop();
  });

  test('a report: the server’s outcome is read back (removed reads as accepted, still active as turned down)', async () => {
    await finalized(uuid(10), T0, uuid(1));
    await db.execute('DELETE FROM sync_queue');
    await reportEvent(uuid(10), uuid(1), 'wrong_limit', { db });
    const accepted = await serverCopy(uuid(10), { clean: true }, 'removed');
    const supabase = createFakeSupabase({ invoke: () => functionsHttpError(409, { code: 'already_disputed' }), rpc: () => ({ data: [accepted], error: null }) });
    const r = runner(supabase);
    await r.start();
    await db.execute('UPDATE sync_queue SET next_attempt_at = 0');
    expect(await r.drainOnce()).toMatchObject({ done: 1 });
    expect(await createEventsRepo(db).get(uuid(1))).toMatchObject({ dispute_status: 'accepted', status: 'removed' });
    expect(await createTripsRepo(db).get(uuid(10))).toMatchObject({ status: 'scored', clean: 1 });
    await r.stop();

    await finalized(uuid(11), T0 + 5_000_000, uuid(2));
    await db.execute('DELETE FROM sync_queue');
    await reportEvent(uuid(11), uuid(2), 'hazard', { db });
    const turnedDown = await serverCopy(uuid(11));
    const r2 = runner(createFakeSupabase({ invoke: () => functionsHttpError(409, { code: 'already_disputed' }), rpc: () => ({ data: [turnedDown], error: null }) }));
    await r2.start();
    await db.execute('UPDATE sync_queue SET next_attempt_at = 0');
    await r2.drainOnce();
    expect(await createEventsRepo(db).get(uuid(2))).toMatchObject({ dispute_status: 'rejected', status: 'active' });
    await r2.stop();
  });

  test('a report whose outcome cannot be read yet stays pending and is tried again, never shown as refused', async () => {
    await finalized(uuid(10), T0, uuid(1));
    await db.execute('DELETE FROM sync_queue');
    await reportEvent(uuid(10), uuid(1), 'wrong_limit', { db });
    const r = runner(createFakeSupabase({ invoke: () => functionsHttpError(409, { code: 'already_disputed' }), rpc: () => ({ data: [], error: null }) }));
    await r.start();
    await db.execute('UPDATE sync_queue SET next_attempt_at = 0');
    expect(await r.drainOnce()).toMatchObject({ failed: 0, deferred: 1 });
    expect(await createEventsRepo(db).get(uuid(1))).toMatchObject({ dispute_status: 'pending' });
    expect(await createQueueRepo(db).countByStatus('pending')).toBe(1);
    await r.stop();
  });
});

test('an upload queued inside a caller’s transaction is not announced (the caller announces once it commits); one queued alone is', async () => {
  const heard: string[] = [];
  const off = onDataChanged((c) => heard.push(c.source));
  await db.transaction((tx) => enqueueFinalize(db, payloadV5(uuid(30)), T0, tx));
  await new Promise((r) => setTimeout(r, 0));
  expect(heard).toEqual([]);
  await enqueueFinalize(db, payloadV5(uuid(31)), T0);
  await new Promise((r) => setTimeout(r, 0));
  expect(heard).toEqual(['enqueue']);
  off();
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
  expect(await createTripsRepo(db).get(uuid(10))).toMatchObject({ status: 'pending', result_json: null });
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

test('a sign-in sends what waited only for a session at once; a back-off keeps its time', async () => {
  jest.useFakeTimers();
  try {
    await finalized(uuid(10));
    const supabase = createFakeSupabase({ uid: null, invoke: ({ body }) => invokeOk(response((body as { clientTripId: string }).clientTripId)) });
    const r = runner(supabase);
    await r.start();
    await jest.advanceTimersByTimeAsync(10);
    await r.idle();
    expect(supabase.invokes).toHaveLength(0);
    expect((await createQueueRepo(db).byKey(`trip:${uuid(10)}`))!.next_attempt_at).toBe(T0 + 2_000_000 + NO_SESSION_RETRY_MS);
    // A drive whose upload failed once is in its back-off: the sign-in does not cut it short.
    await finalized(uuid(11), T0 + 5_000_000);
    await db.execute("UPDATE sync_queue SET attempts = 1, next_attempt_at = ? WHERE idempotency_key = ?", [T0 + 9_000_000, `trip:${uuid(11)}`]);
    supabase.setUid('user-1');
    await r.signedIn();
    await jest.advanceTimersByTimeAsync(10);
    await r.idle();
    expect(supabase.invokes.map((i) => (i.body as { clientTripId: string }).clientTripId)).toEqual([uuid(10)]);
    await r.stop();
  } finally {
    jest.useRealTimers();
  }
});

test('while the app is open, an upload that failed on a blip is tried again when its back-off ends, not at the next foreground; in the background nothing waits', async () => {
  jest.useFakeTimers();
  try {
    let clock = T0 + 2_000_000;
    let fail = true;
    const supabase = createFakeSupabase({ invoke: ({ body }) => (fail ? functionsFetchError() : invokeOk(response((body as { clientTripId: string }).clientTripId))) });
    const appState = createFakeAppState('active');
    const r = runner(supabase, { appState, now: () => clock });
    await finalized(uuid(10));
    await r.start();
    await jest.advanceTimersByTimeAsync(10);
    await r.idle();
    expect(supabase.invokes).toHaveLength(1);
    fail = false;
    clock += 30_000;
    await jest.advanceTimersByTimeAsync(30_000);
    await r.idle();
    expect(supabase.invokes).toHaveLength(2);
    expect(await r.owed()).toBe(0);
    await jest.advanceTimersByTimeAsync(10);
    expect(jest.getTimerCount()).toBe(0);

    // In the background the retry timer goes: the next foreground wakes the runner instead.
    fail = true;
    clock = T0 + 7_000_000;
    await finalized(uuid(11), T0 + 5_000_000);
    await jest.advanceTimersByTimeAsync(10);
    await r.idle();
    expect(supabase.invokes).toHaveLength(3);
    await jest.advanceTimersByTimeAsync(RETRY_WAKE_MIN_MS);
    appState.set('background');
    expect(jest.getTimerCount()).toBe(0);
    await r.stop();
  } finally {
    jest.useRealTimers();
  }
});
