/** @jest-environment node */
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import type { Db } from '@/data/db/driver';
import { migrate } from '@/data/db/migrate';
import { createQueueRepo, MAX_ATTEMPTS, RECLAIM_AFTER_S } from '@/data/db/queue';
import { createScoreDailyCacheRepo } from '@/data/db/scoreDailyCache';
import { createSettingsRepo } from '@/data/db/settings';
import { createTripsRepo } from '@/data/db/trips';
import type { QueueItem, TripStatus } from '@/data/db/types';
import {
  createFakeAppState,
  createFakeFs,
  createFakeSupabase,
  functionsFetchError,
  functionsHttpError,
  invokeOk,
  storageDuplicate,
  storageError,
  type FakeFs,
  type FakeSupabase,
} from '@/data/sync/__fixtures__/fakes';
import { T0, TRIP_ID, tripPayload } from '@/data/sync/__fixtures__/payload';
import { emitDataChanged, onDataChanged, type DataChange, type SyncApplied } from '@/data/events';
import {
  DEVICE_OWNER_KEY,
  enqueueFinalize,
  enqueueTraceUpload,
  finalizeIdempotencyKey,
  traceIdempotencyKey,
} from '@/data/sync/queue';
import {
  createSyncRunner,
  PURGE_DONE_AFTER_MS,
  RECORDING_RETRY_MS,
  TRACES_BUCKET,
  WIFI_ONLY_TRACES_KEY,
  type SyncSupabase,
} from '@/data/sync/runner';
// Type-only, so nothing of the client is loaded here; it exists to make the compiler prove that
// the runner's structural seam still fits the real client.
import type { SupabaseClient } from '@supabase/supabase-js';

const UID = 'user-1';
const TRACE = `${TRIP_ID}.bin.gz`;
const OBJECT_KEY = `${UID}/${TRIP_ID}.bin.gz`;

const SERVER_TRIP_ID = 'a3f1c2d4-5b6e-4f8a-9c0d-1e2f3a4b5c6d';

/** The §9.9 day evaluation `finalize-trip` returns, exactly as the function sends it. */
const DAY_ROW = {
  day: '2026-09-20',
  longTermScore: 81,
  band: 'gold',
  provisional: false,
  safeDay: true,
  goodDay: false,
  phoneFreeDay: true,
  cameraDay: false,
  exposure: 1.1,
  drivingS: 1200,
  tripsScored: 2,
  severeEvents: 0,
};

/** What the re-score stored on the trip; the device row follows it, not its own finalizer's. */
const SERVER_TRIP_FIELDS = {
  categoryDeductions: { phone: 0, speeding: 6, braking: 0, accel: 0, cornering: 0, focus: 0 },
  exposure: 1,
  dataQuality: 'A',
  hadSevereEvent: false,
  limitCoveragePct: 80,
};

const SERVER_OK = {
  tripId: SERVER_TRIP_ID,
  score: 74,
  status: 'final',
  day: DAY_ROW,
  trip: SERVER_TRIP_FIELDS,
  provisionalMismatch: false,
  replayed: false,
};

const cache = () => createScoreDailyCacheRepo(db);
const allCachedDays = () => cache().range('2000-01-01', '2100-01-01');

/** Run macrotasks until `predicate` holds; the drains a wake starts are not awaitable directly. */
async function waitFor(predicate: () => boolean, ticks = 50): Promise<void> {
  for (let round = 0; round < ticks; round += 1) {
    if (predicate()) return;
    await tick();
  }
  throw new Error('waitFor: the condition never held');
}

let db: Db;
let fs: FakeFs;
let supabase: FakeSupabase;
let recording: boolean;
let wifi: boolean;

const queue = () => createQueueRepo(db);
const trips = () => createTripsRepo(db);

/** Let the emitter's macrotask — and the drain it starts, which is microtasks — run out. */
const tick = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

/** A `Db` that fails any statement matching `broken` with SQLite's busy message. */
function lockingDb(inner: Db, broken: RegExp): Db {
  const wrap = (handle: Db): Db => ({
    async execute(sql: string, params: unknown[] = []) {
      if (broken.test(sql)) throw new Error('database is locked');
      return handle.execute(sql, params);
    },
    transaction: (fn) => handle.transaction((tx) => fn(wrap(tx))),
  });
  return wrap(inner);
}

function runner(overrides: Partial<Parameters<typeof createSyncRunner>[0]> = {}) {
  return createSyncRunner({
    db,
    supabase,
    fs,
    net: { isWifi: () => wifi },
    isRecording: () => recording,
    now: () => T0,
    ...overrides,
  });
}

async function seedQueuedTrip(): Promise<QueueItem> {
  await trips().insert(
    {
      client_trip_id: TRIP_ID,
      started_at: T0,
      tz: 'UTC',
      status: 'provisional',
      sync_state: 'queued',
      score: 74,
    },
    T0
  );
  return enqueueFinalize(db, tripPayload(), T0);
}

/** The trip row a queued trace belongs to; a trace whose trip is gone is dropped, not uploaded. */
const seedTrip = (clientTripId = TRIP_ID, status: TripStatus = 'provisional') =>
  trips().insert(
    { client_trip_id: clientTripId, started_at: T0, tz: 'UTC', status, sync_state: 'synced' },
    T0
  );

const itemByKey = async (key: string): Promise<QueueItem | null> => queue().byKey(key);
const finalizeItem = () => itemByKey(finalizeIdempotencyKey(TRIP_ID));
const traceItem = () => itemByKey(traceIdempotencyKey(TRIP_ID));

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
  // What the bootstrap's identity stage writes before anything can be queued; the enqueue sites
  // read it to stamp `owner_uid`, and unowned work is refused.
  await createSettingsRepo(db).set(DEVICE_OWNER_KEY, UID);
  fs = createFakeFs({ [TRACE]: '[{"ts":1}]' });
  supabase = createFakeSupabase({ uid: UID, invoke: () => invokeOk(SERVER_OK) });
  recording = false;
  wifi = true;
});

test('the app Supabase client satisfies the runner seam', () => {
  const asSeam = (client: SupabaseClient): SyncSupabase => client;
  expect(typeof asSeam).toBe('function');
});

test('uploads the trace, finalizes the trip and caches the day', async () => {
  await seedQueuedTrip();

  await expect(runner().drainOnce(T0)).resolves.toEqual({ done: 1, failed: 0, deferred: 0 });

  expect(supabase.uploads).toEqual([
    {
      bucket: TRACES_BUCKET,
      path: OBJECT_KEY,
      body: expect.any(Uint8Array),
      options: { contentType: 'application/gzip', upsert: false },
    },
  ]);
  expect(supabase.invokes).toEqual([{ name: 'finalize-trip', body: tripPayload() }]);

  const trip = await trips().get(TRIP_ID);
  expect(trip).toMatchObject({
    sync_state: 'synced',
    server_id: SERVER_TRIP_ID,
    score: 74,
    status: 'final',
    sync_error: null,
  });

  // The day row is cached under its own date — the trip's local day, not the device's.
  await expect(cache().get('2026-09-20')).resolves.toEqual({
    day: '2026-09-20',
    payload: DAY_ROW,
    updated_at: T0,
  });

  expect(await finalizeItem()).toMatchObject({ status: 'done', attempts: 0 });
  // The trace this pass uploaded is of no further use on the device.
  expect(fs.removals).toEqual([TRACE]);
});

test('the object key comes from the session, never from the payload', async () => {
  // Queued by the driver who is signed in now: the key must come from the live session, not
  // from anything the payload carries. (Work queued by *another* driver is refused outright —
  // see the owner tests — so the two rules do not meet here.)
  await createSettingsRepo(db).set(DEVICE_OWNER_KEY, 'someone-else');
  await seedQueuedTrip();
  supabase.setUid('someone-else');

  await runner().drainOnce(T0);

  expect(supabase.uploads[0]?.path).toBe(`someone-else/${TRIP_ID}.bin.gz`);
});

test('an item stamped with the signed-in user is not sent while the device still records someone else (H2 I-1 d)', async () => {
  // The slow-session handover: the device is still A's (no wipe yet), B is signed in, and an item
  // somehow carries B's uid. The session alone would let it through; the device owner does not.
  await seedTrip();
  await db.execute(
    'INSERT INTO sync_queue (kind, payload_json, idempotency_key, next_attempt_at, owner_uid, created_at)' +
      ' VALUES (?, ?, ?, ?, ?, ?)',
    ['finalize-trip', JSON.stringify(tripPayload()), finalizeIdempotencyKey(TRIP_ID), T0, 'user-b', T0]
  );
  supabase.setUid('user-b');

  await runner().drainOnce(T0);

  expect(supabase.uploads).toHaveLength(0);
  expect(supabase.invokes).toHaveLength(0);
  expect(await finalizeItem()).toMatchObject({ status: 'pending', attempts: 0 });
});

test('a dispute stamped with the signed-in user is not posted while the device records someone else (H2 R1-M2)', async () => {
  await db.execute(
    'INSERT INTO sync_queue (kind, payload_json, idempotency_key, next_attempt_at, owner_uid, created_at)' +
      ' VALUES (?, ?, ?, ?, ?, ?)',
    [
      'dispute',
      JSON.stringify({ action: 'dispute', clientEventId: 'event-1', reason: 'hazard' }),
      'dispute:event-1',
      T0,
      'user-b',
      T0,
    ]
  );
  supabase.setUid('user-b');

  await runner().drainOnce(T0);

  expect(supabase.invokes).toHaveLength(0);
  expect(await itemByKey('dispute:event-1')).toMatchObject({ status: 'pending', attempts: 0 });
});

test('idle() resolves once no drain is in flight, a drain it woke included (H2 r1 m2)', async () => {
  await seedQueuedTrip();
  let release: () => void = () => {};
  supabase = createFakeSupabase({
    uid: UID,
    invoke: () =>
      new Promise((resolve) => {
        release = () => resolve(invokeOk(SERVER_OK));
      }),
  });
  const r = runner();
  await expect(r.idle()).resolves.toBeUndefined();
  const draining = r.drainOnce(T0);
  let idle = false;
  const waiting = r.idle().then(() => {
    idle = true;
  });
  await waitFor(() => supabase.invokes.length === 1);
  expect(idle).toBe(false);
  release();
  await draining;
  await waiting;
  expect(idle).toBe(true);
});

test('work this build cannot attribute is refused, never sent under whoever is signed in', async () => {
  // A database from before `owner_uid` existed: every queued item reads null.
  await seedTrip();
  await db.execute(
    'INSERT INTO sync_queue (kind, payload_json, idempotency_key, next_attempt_at, created_at)' +
      ' VALUES (?, ?, ?, ?, ?)',
    ['finalize-trip', JSON.stringify(tripPayload()), finalizeIdempotencyKey(TRIP_ID), T0, T0]
  );

  await expect(runner().drainOnce(T0)).resolves.toEqual({ done: 0, failed: 1, deferred: 0 });

  expect(supabase.uploads).toHaveLength(0);
  expect(supabase.invokes).toHaveLength(0);
  expect(await finalizeItem()).toMatchObject({ status: 'failed', last_error: 'unowned' });
});

test('a 409 from storage counts as uploaded and the finalize still runs', async () => {
  await seedQueuedTrip();
  supabase = createFakeSupabase({
    uid: UID,
    upload: () => storageDuplicate(),
    invoke: () => invokeOk(SERVER_OK),
  });

  await expect(runner().drainOnce(T0)).resolves.toEqual({ done: 1, failed: 0, deferred: 0 });
  expect(supabase.invokes).toHaveLength(1);
  expect(await trips().get(TRIP_ID)).toMatchObject({ sync_state: 'synced' });
});

test('a 5xx from storage is retryable, and the finalize is not attempted without it', async () => {
  await seedQueuedTrip();
  supabase = createFakeSupabase({ uid: UID, upload: () => storageError(500, 'boom') });

  await expect(runner().drainOnce(T0)).resolves.toEqual({ done: 0, failed: 0, deferred: 1 });
  expect(supabase.invokes).toHaveLength(0);
  expect(await finalizeItem()).toMatchObject({
    status: 'pending',
    attempts: 1,
    last_error: 'storage_500',
    trace_uploaded_at: null,
  });
});

test('a 403 from storage fails the trip terminally', async () => {
  await seedQueuedTrip();
  supabase = createFakeSupabase({ uid: UID, upload: () => storageError(403, 'not authorized') });

  await expect(runner().drainOnce(T0)).resolves.toEqual({ done: 0, failed: 1, deferred: 0 });
  expect(supabase.invokes).toHaveLength(0);
  expect(await trips().get(TRIP_ID)).toMatchObject({
    sync_state: 'failed',
    sync_error: 'storage_403',
  });
});

test('a 400 is terminal: the item fails and the trip records the server code', async () => {
  await seedQueuedTrip();
  supabase = createFakeSupabase({
    uid: UID,
    invoke: () => functionsHttpError(400, { code: 'implausible_speed', field: 'provisional' }),
  });

  await expect(runner().drainOnce(T0)).resolves.toEqual({ done: 0, failed: 1, deferred: 0 });

  expect(await finalizeItem()).toMatchObject({
    status: 'failed',
    attempts: 1,
    last_error: 'implausible_speed',
  });
  expect(await trips().get(TRIP_ID)).toMatchObject({
    sync_state: 'failed',
    sync_error: 'implausible_speed',
    server_id: null,
  });
});

test('a 503 leaves the item pending, honouring Retry-After over the backoff ladder', async () => {
  await seedQueuedTrip();
  supabase = createFakeSupabase({
    uid: UID,
    invoke: () => functionsHttpError(503, { message: 'upstream' }, { 'Retry-After': '120' }),
  });

  await expect(runner().drainOnce(T0)).resolves.toEqual({ done: 0, failed: 0, deferred: 1 });

  expect(await finalizeItem()).toMatchObject({
    status: 'pending',
    attempts: 1,
    next_attempt_at: T0 + 120_000,
  });
  expect(await trips().get(TRIP_ID)).toMatchObject({ sync_state: 'queued', sync_error: null });
});

test('a 429 without Retry-After falls back to the queue repo backoff', async () => {
  await seedQueuedTrip();
  supabase = createFakeSupabase({ uid: UID, invoke: () => functionsHttpError(429, {}) });

  await expect(runner().drainOnce(T0)).resolves.toEqual({ done: 0, failed: 0, deferred: 1 });
  expect(await finalizeItem()).toMatchObject({
    status: 'pending',
    attempts: 1,
    next_attempt_at: T0 + 30_000,
  });
});

test('a network error is retryable and never touches the trip', async () => {
  await seedQueuedTrip();
  supabase = createFakeSupabase({ uid: UID, invoke: () => functionsFetchError() });

  await expect(runner().drainOnce(T0)).resolves.toEqual({ done: 0, failed: 0, deferred: 1 });
  expect(await finalizeItem()).toMatchObject({ status: 'pending', attempts: 1 });
  expect(await trips().get(TRIP_ID)).toMatchObject({ sync_state: 'queued' });
});

test('a 401 refreshes the session once and retries the item in the same pass', async () => {
  await seedQueuedTrip();
  supabase = createFakeSupabase({
    uid: UID,
    invoke: (_call, index) =>
      index === 0 ? functionsHttpError(401, { code: 'unauthorized' }) : invokeOk(SERVER_OK),
  });

  await expect(runner().drainOnce(T0)).resolves.toEqual({ done: 1, failed: 0, deferred: 0 });

  expect(supabase.refreshes).toBe(1);
  expect(supabase.invokes).toHaveLength(2);
  // The trace was uploaded before the first 401; the retry must not upload it again.
  expect(supabase.uploads).toHaveLength(1);
  expect(await trips().get(TRIP_ID)).toMatchObject({ sync_state: 'synced' });
});

test('a second 401 after the refresh leaves the item for a later pass', async () => {
  await seedQueuedTrip();
  supabase = createFakeSupabase({
    uid: UID,
    invoke: () => functionsHttpError(401, { code: 'unauthorized' }),
  });

  await expect(runner().drainOnce(T0)).resolves.toEqual({ done: 0, failed: 0, deferred: 1 });
  expect(supabase.refreshes).toBe(1);
  expect(supabase.invokes).toHaveLength(2);
  expect(await finalizeItem()).toMatchObject({ status: 'pending', attempts: 1 });
});

test('signed out: nothing is uploaded and the claim is handed back without an attempt', async () => {
  await seedQueuedTrip();
  supabase = createFakeSupabase({ uid: null });

  await expect(runner().drainOnce(T0)).resolves.toEqual({ done: 0, failed: 0, deferred: 1 });
  expect(supabase.uploads).toHaveLength(0);
  expect(supabase.invokes).toHaveLength(0);
  expect(await finalizeItem()).toMatchObject({ status: 'pending', attempts: 0 });
});

test('wifi-only traces on cellular: finalize still runs and a trace-upload item is queued', async () => {
  await seedQueuedTrip();
  wifi = false;

  await expect(runner().drainOnce(T0)).resolves.toEqual({ done: 1, failed: 0, deferred: 0 });

  expect(supabase.uploads).toHaveLength(0);
  // The payload goes up as it stands — `tracePath` included; the server does not read the object.
  expect(supabase.invokes).toEqual([{ name: 'finalize-trip', body: tripPayload() }]);
  expect(await traceItem()).toMatchObject({
    kind: 'trace-upload',
    idempotency_key: `trace:${TRIP_ID}`,
    status: 'pending',
  });
  expect(await trips().get(TRIP_ID)).toMatchObject({ sync_state: 'synced' });
  // The file stays on the device until it has actually been uploaded.
  expect(fs.removals).toEqual([]);
  expect(fs.files.has(TRACE)).toBe(true);
});

test('wifi-only can be switched off, and then the trace goes up on cellular', async () => {
  await seedQueuedTrip();
  wifi = false;
  await db.execute('INSERT INTO settings (key, value_json) VALUES (?, ?)', [
    WIFI_ONLY_TRACES_KEY,
    'false',
  ]);

  await runner().drainOnce(T0);

  expect(supabase.uploads).toHaveLength(1);
  expect(await traceItem()).toBeNull();
});

test('the deferred trace-upload item uploads on Wi-Fi and deletes the local file', async () => {
  await seedTrip();
  await enqueueTraceUpload(db, { clientTripId: TRIP_ID, tracePath: TRACE }, T0);

  await expect(runner().drainOnce(T0)).resolves.toEqual({ done: 1, failed: 0, deferred: 0 });

  expect(supabase.uploads).toEqual([
    {
      bucket: TRACES_BUCKET,
      path: OBJECT_KEY,
      body: expect.any(Uint8Array),
      options: { contentType: 'application/gzip', upsert: false },
    },
  ]);
  expect(supabase.invokes).toHaveLength(0);
  expect(fs.removals).toEqual([TRACE]);
  expect(fs.files.has(TRACE)).toBe(false);
  expect(await traceItem()).toMatchObject({ status: 'done' });
});

test('a trace-upload item waits, without burning an attempt, while the device is on cellular', async () => {
  await seedTrip();
  await enqueueTraceUpload(db, { clientTripId: TRIP_ID, tracePath: TRACE }, T0);
  wifi = false;

  await expect(runner().drainOnce(T0)).resolves.toEqual({ done: 0, failed: 0, deferred: 1 });

  expect(supabase.uploads).toHaveLength(0);
  const item = await traceItem();
  expect(item).toMatchObject({ status: 'pending', attempts: 0 });
  expect(item?.next_attempt_at).toBeGreaterThan(T0);
  expect(fs.files.has(TRACE)).toBe(true);
});

test('a crash between the upload and the finalize call does not re-upload the trace', async () => {
  await seedQueuedTrip();
  supabase = createFakeSupabase({ uid: UID, invoke: () => functionsFetchError() });
  await runner().drainOnce(T0);

  expect(supabase.uploads).toHaveLength(1);
  expect(await finalizeItem()).toMatchObject({ attempts: 1, trace_uploaded_at: T0 });

  // Second pass, once the retry time has come: the object is already in Storage.
  const later = T0 + 60_000;
  supabase = createFakeSupabase({ uid: UID, invoke: () => invokeOk(SERVER_OK) });
  await expect(runner().drainOnce(later)).resolves.toEqual({ done: 1, failed: 0, deferred: 0 });

  expect(supabase.uploads).toHaveLength(0);
  expect(supabase.invokes).toHaveLength(1);
  expect(await trips().get(TRIP_ID)).toMatchObject({ sync_state: 'synced' });
});

test('a claim a killed process left standing is reclaimed and drained', async () => {
  const item = await seedQueuedTrip();
  // The process died holding the claim.
  await queue().nextDue(T0);
  expect((await finalizeItem())?.status).toBe('inflight');

  const later = T0 + (RECLAIM_AFTER_S + 1) * 1000;
  await expect(runner().drainOnce(later)).resolves.toEqual({ done: 1, failed: 0, deferred: 0 });

  expect(await queue().get(item.id)).toMatchObject({ status: 'done', attempts: 0 });
});

test('no drain while the engine is recording', async () => {
  await seedQueuedTrip();
  recording = true;

  await expect(runner().drainOnce(T0)).resolves.toEqual({ done: 0, failed: 0, deferred: 0 });

  expect(supabase.uploads).toHaveLength(0);
  expect(supabase.invokes).toHaveLength(0);
  expect(await finalizeItem()).toMatchObject({ status: 'pending', attempts: 0, claimed_at: null });
});

test('markAttempt returning null aborts the item without side effects', async () => {
  await seedQueuedTrip();
  supabase = createFakeSupabase({
    uid: UID,
    invoke: async () => {
      // Another pass closes this claim while the request is in flight.
      const item = await finalizeItem();
      await queue().markAttempt(item!.id, false, 'closed elsewhere', T0);
      return functionsHttpError(400, { code: 'implausible_speed' });
    },
  });

  await expect(runner().drainOnce(T0)).resolves.toEqual({ done: 0, failed: 0, deferred: 1 });

  expect(await finalizeItem()).toMatchObject({
    status: 'pending',
    attempts: 1,
    last_error: 'closed elsewhere',
  });
  expect(await trips().get(TRIP_ID)).toMatchObject({ sync_state: 'queued', sync_error: null });
});

test('a locked database stops the pass and leaves the item claimable again', async () => {
  await seedQueuedTrip();
  const locked = lockingDb(db, /UPDATE trips/);

  await expect(runner({ db: locked }).drainOnce(T0)).resolves.toEqual({
    done: 0,
    failed: 0,
    deferred: 1,
  });

  expect(await finalizeItem()).toMatchObject({ status: 'pending', attempts: 0, claimed_at: null });
  expect(await trips().get(TRIP_ID)).toMatchObject({ sync_state: 'queued' });
});

test('an item whose payload no longer matches the contract fails terminally', async () => {
  await seedQueuedTrip();
  await db.execute('UPDATE sync_queue SET payload_json = ? WHERE idempotency_key = ?', [
    '{"clientTripId":"' + TRIP_ID + '"}',
    finalizeIdempotencyKey(TRIP_ID),
  ]);

  await expect(runner().drainOnce(T0)).resolves.toEqual({ done: 0, failed: 1, deferred: 0 });
  expect(await finalizeItem()).toMatchObject({ status: 'failed', last_error: 'invalid_payload' });
});

test('a trip whose trace file is gone still finalizes', async () => {
  await seedQueuedTrip();
  fs.files.delete(TRACE);

  await expect(runner().drainOnce(T0)).resolves.toEqual({ done: 1, failed: 0, deferred: 0 });
  expect(supabase.uploads).toHaveLength(0);
  expect(supabase.invokes).toHaveLength(1);
});

test('start drains at once, on app foreground and on an enqueue change; stop unsubscribes', async () => {
  const appState = createFakeAppState();
  const sync = runner({ appState });

  await seedQueuedTrip();
  sync.start();
  await tick();
  expect(supabase.invokes).toHaveLength(1);

  // A second trip, queued while the app runs: the emitter wakes the runner.
  await trips().insert(
    { client_trip_id: 'trip-2', started_at: T0, tz: 'UTC', status: 'provisional' },
    T0
  );
  await enqueueFinalize(db, tripPayload({ clientTripId: 'trip-2', tracePath: null }), T0);
  await tick();
  expect(supabase.invokes).toHaveLength(2);

  // A third trip, queued with the runner stopped from noticing (no emit reaches it because the
  // enqueue happens before the listener could coalesce another wake) — the foreground drains it.
  await trips().insert(
    { client_trip_id: 'trip-3', started_at: T0, tz: 'UTC', status: 'provisional' },
    T0
  );
  await db.execute(
    'INSERT INTO sync_queue (kind, payload_json, idempotency_key, next_attempt_at, owner_uid,' +
      ' created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [
      'finalize-trip',
      JSON.stringify(tripPayload({ clientTripId: 'trip-3', tracePath: null })),
      'trip:trip-3',
      T0,
      UID,
      T0,
    ]
  );
  appState.emit('active');
  await waitFor(() => supabase.invokes.length === 3);
  expect(appState.listeners).toHaveLength(1);

  sync.stop();
  expect(appState.listeners).toHaveLength(0);
  expect(appState.removals).toBe(1);

  // Nothing is drained after stop().
  const before = supabase.invokes.length;
  emitDataChanged({ source: 'enqueue' });
  await tick();
  expect(supabase.invokes).toHaveLength(before);
});

test('one change event: the runner drains on enqueue and finalize, never on sync or hydrate', async () => {
  const sync = runner();
  sync.start();
  await tick();
  await tick();

  const queueRaw = async (id: string) => {
    await trips().insert({ client_trip_id: id, started_at: T0, tz: 'UTC', status: 'provisional' }, T0);
    // Straight into the table, so no enqueue change is fired by the queueing itself.
    await db.execute(
      'INSERT INTO sync_queue (kind, payload_json, idempotency_key, next_attempt_at, owner_uid,' +
        ' created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['finalize-trip', JSON.stringify(tripPayload({ clientTripId: id, tracePath: null })), `trip:${id}`, T0, UID, T0]
    );
  };

  await queueRaw('trip-a');
  emitDataChanged({ source: 'sync', result: { done: 1, failed: 0, deferred: 0 } });
  emitDataChanged({ source: 'hydrate' });
  await tick();
  await tick();
  expect(supabase.invokes).toHaveLength(0);

  emitDataChanged({ source: 'finalize' });
  await waitFor(() => supabase.invokes.length === 1);

  await queueRaw('trip-b');
  emitDataChanged({ source: 'enqueue' });
  await waitFor(() => supabase.invokes.length === 2);
  await sync.stop();
});

test('a wake while the engine records is retried once the drive ends', async () => {
  jest.useFakeTimers();
  try {
    await seedQueuedTrip();
    recording = true;
    const sync = runner();
    sync.start();
    await Promise.resolve();
    expect(supabase.invokes).toHaveLength(0);

    recording = false;
    jest.advanceTimersByTime(RECORDING_RETRY_MS);
    await jest.advanceTimersByTimeAsync(0);
    expect(supabase.invokes).toHaveLength(1);
    sync.stop();
  } finally {
    jest.useRealTimers();
  }
});

test("the host's finalize change drains at once, before the 15 s safety net, and clears it (final review M10d)", async () => {
  jest.useFakeTimers();
  const sync = runner();
  try {
    await seedQueuedTrip();
    recording = true;
    sync.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(supabase.invokes).toHaveLength(0);
    expect(jest.getTimerCount()).toBe(1); // the safety net, and nothing else

    // The drive ends with a finalize: the host emits its change once the snapshot is idle, and
    // the queued work goes at once — no 15 s wait.
    recording = false;
    emitDataChanged({ source: 'finalize' });
    await jest.advanceTimersByTimeAsync(0);
    expect(supabase.invokes).toHaveLength(1);
    // The safety net was cleared by that drain: running the clock past it sends nothing more.
    await jest.advanceTimersByTimeAsync(RECORDING_RETRY_MS * 2);
    expect(supabase.invokes).toHaveLength(1);
  } finally {
    await sync.stop();
    jest.useRealTimers();
  }
});

test('two drains never overlap', async () => {
  await seedQueuedTrip();
  let inFlight = 0;
  let overlapped = false;
  supabase = createFakeSupabase({
    uid: UID,
    invoke: async () => {
      inFlight += 1;
      overlapped ||= inFlight > 1;
      // The flag only means anything if it is held across a turn of the event loop.
      await tick();
      inFlight -= 1;
      return invokeOk(SERVER_OK);
    },
  });
  const sync = runner();

  const [first, second] = await Promise.all([sync.drainOnce(T0), sync.drainOnce(T0)]);

  expect(overlapped).toBe(false);
  expect([first, second]).toContainEqual({ done: 1, failed: 0, deferred: 0 });
  expect([first, second]).toContainEqual({ done: 0, failed: 0, deferred: 0 });
  expect(supabase.invokes).toHaveLength(1);
});

test('the day row is refused whole when it is not the contract, and nothing is applied', async () => {
  await seedQueuedTrip();
  // What the function returned before its fix round: `day` as a bare date string.
  supabase = createFakeSupabase({
    uid: UID,
    invoke: () => invokeOk({ ...SERVER_OK, day: '2026-09-20' }),
  });

  await expect(runner().drainOnce(T0)).resolves.toEqual({ done: 0, failed: 0, deferred: 1 });

  // Retryable, not terminal: the upload was accepted, so the trip must not be failed.
  expect(await finalizeItem()).toMatchObject({
    status: 'pending',
    attempts: 1,
    last_error: 'invalid_response',
  });
  expect(await trips().get(TRIP_ID)).toMatchObject({
    sync_state: 'queued',
    server_id: null,
    sync_error: null,
  });
  await expect(allCachedDays()).resolves.toEqual([]);
});

test('a response carrying an unknown key is refused too', async () => {
  await seedQueuedTrip();
  supabase = createFakeSupabase({
    uid: UID,
    invoke: () => invokeOk({ ...SERVER_OK, longTermScore: 81 }),
  });

  await expect(runner().drainOnce(T0)).resolves.toEqual({ done: 0, failed: 0, deferred: 1 });
  expect(await trips().get(TRIP_ID)).toMatchObject({ sync_state: 'queued' });
  await expect(allCachedDays()).resolves.toEqual([]);
});

test('an unscored trip comes back with a null score and still caches its day', async () => {
  await seedQueuedTrip();
  supabase = createFakeSupabase({
    uid: UID,
    invoke: () => invokeOk({ ...SERVER_OK, score: null, status: 'unscored' }),
  });

  await expect(runner().drainOnce(T0)).resolves.toEqual({ done: 1, failed: 0, deferred: 0 });
  expect(await trips().get(TRIP_ID)).toMatchObject({
    sync_state: 'synced',
    status: 'unscored',
    score: null,
  });
  await expect(cache().get('2026-09-20')).resolves.toMatchObject({ payload: DAY_ROW });
});

test('exhausted retries fail the trip with retries_exhausted', async () => {
  const item = await seedQueuedTrip();
  await db.execute('UPDATE sync_queue SET attempts = ? WHERE id = ?', [MAX_ATTEMPTS - 1, item.id]);
  supabase = createFakeSupabase({ uid: UID, invoke: () => functionsHttpError(503, {}) });

  await expect(runner().drainOnce(T0)).resolves.toEqual({ done: 0, failed: 1, deferred: 0 });

  // The item keeps the transport code that finally beat it; the trip says why it will never go.
  expect(await finalizeItem()).toMatchObject({
    status: 'failed',
    attempts: MAX_ATTEMPTS,
    last_error: 'http_503',
  });
  expect(await trips().get(TRIP_ID)).toMatchObject({
    sync_state: 'failed',
    sync_error: 'retries_exhausted',
  });
});

// 0006: a driver who has not answered the age question yet gets 503 `age_pending`. Their drives
// must wait for the birth date, however long onboarding takes, and never walk the retry ladder.
describe('age_pending (0006)', () => {
  const HOUR = 3_600_000;
  const pendingThen = (accepted: () => boolean) => () =>
    accepted()
      ? invokeOk(SERVER_OK)
      : functionsHttpError(503, { code: 'age_pending' }, { 'Retry-After': '900' });

  test('thirty age_pending replies never exhaust or fail the item, and it goes up once the server accepts', async () => {
    await seedQueuedTrip();
    let accepted = false;
    supabase = createFakeSupabase({ uid: UID, invoke: pendingThen(() => accepted) });
    const r = runner();

    for (let i = 0; i < 30; i += 1) {
      const at = T0 + i * HOUR;
      await expect(r.drainOnce(at)).resolves.toEqual({ done: 0, failed: 0, deferred: 1 });
      // Handed back uncounted, due again after the server's Retry-After
      expect(await finalizeItem()).toMatchObject({
        status: 'pending',
        attempts: 0,
        next_attempt_at: at + 900_000,
      });
    }
    expect(await trips().get(TRIP_ID)).toMatchObject({ sync_state: 'queued', sync_error: null });

    accepted = true;
    const at = T0 + 30 * HOUR;
    await expect(r.drainOnce(at)).resolves.toEqual({ done: 1, failed: 0, deferred: 0 });
    expect(await trips().get(TRIP_ID)).toMatchObject({ sync_state: 'synced' });
  });

  test('negative control: the same wait as a plain 503 walks the ladder and fails the trip', async () => {
    await seedQueuedTrip();
    supabase = createFakeSupabase({
      uid: UID,
      invoke: () => functionsHttpError(503, { code: 'retry' }, { 'Retry-After': '900' }),
    });
    const r = runner();

    let failed = 0;
    for (let i = 0; i < 30; i += 1) failed += (await r.drainOnce(T0 + i * HOUR)).failed;

    expect(failed).toBe(1);
    expect(await finalizeItem()).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS });
    expect(await trips().get(TRIP_ID)).toMatchObject({
      sync_state: 'failed',
      sync_error: 'retries_exhausted',
    });
  });

  test('the wait follows Retry-After, held to between one minute and one hour', async () => {
    await seedQueuedTrip();
    let header = '86400';
    supabase = createFakeSupabase({
      uid: UID,
      invoke: () => functionsHttpError(503, { code: 'age_pending' }, { 'Retry-After': header }),
    });
    await runner().drainOnce(T0);
    expect((await finalizeItem())?.next_attempt_at).toBe(T0 + HOUR);

    header = '1';
    await runner().drainOnce(T0 + HOUR);
    expect((await finalizeItem())?.next_attempt_at).toBe(T0 + HOUR + 60_000);
    expect((await finalizeItem())?.attempts).toBe(0);
  });
});

test('a wake during a drain runs exactly one more pass when that drain ends', async () => {
  await seedQueuedTrip();
  let queuedSecond = false;
  supabase = createFakeSupabase({
    uid: UID,
    // The first item fails the network, so the pass settles nothing and sends no announcement of
    // its own: only the held wake can produce the second pass.
    invoke: async (_call, index) => {
      if (!queuedSecond) {
        queuedSecond = true;
        await trips().insert(
          { client_trip_id: 'trip-2', started_at: T0, tz: 'UTC', status: 'provisional' },
          T0
        );
        await enqueueFinalize(db, tripPayload({ clientTripId: 'trip-2', tracePath: null }), T0);
        // Let the emitter's macrotask fire while this drain is still in flight.
        await tick();
        return functionsFetchError();
      }
      expect(index).toBe(1);
      return invokeOk(SERVER_OK);
    },
  });
  const sync = runner();
  sync.start();

  await waitFor(() => supabase.invokes.length === 2);
  const ids = supabase.invokes.map((call) => (call.body as { clientTripId: string }).clientTripId);
  expect(ids).toEqual([TRIP_ID, 'trip-2']);
  expect(await trips().get('trip-2')).toMatchObject({ sync_state: 'synced' });

  // Exactly one more pass, not a cascade: the second drain settled work but queued nothing.
  await tick();
  await tick();
  expect(supabase.invokes).toHaveLength(2);
  sync.stop();
});

test('a pass that settled something announces it; one that settled nothing does not', async () => {
  const seen: SyncApplied[] = [];
  const unsubscribe = onDataChanged((change) => {
    if (change.source === 'sync' && change.result) seen.push(change.result);
  });
  try {
    await seedQueuedTrip();
    await runner().drainOnce(T0);
    await tick();
    expect(seen).toEqual([{ done: 1, failed: 0, deferred: 0 }]);

    // Nothing due: no announcement.
    await runner().drainOnce(T0);
    await tick();
    expect(seen).toHaveLength(1);

    // Deferred-only is not "applied" either.
    await trips().insert(
      { client_trip_id: 'trip-2', started_at: T0, tz: 'UTC', status: 'provisional' },
      T0
    );
    await enqueueFinalize(db, tripPayload({ clientTripId: 'trip-2', tracePath: null }), T0);
    supabase = createFakeSupabase({ uid: UID, invoke: () => functionsFetchError() });
    await expect(runner().drainOnce(T0)).resolves.toMatchObject({ deferred: 1 });
    await tick();
    expect(seen).toHaveLength(1);
  } finally {
    unsubscribe();
  }
});

test('a settled pass sends one change, not two: no second event and no self-wake', async () => {
  const changes: DataChange[] = [];
  const unsubscribe = onDataChanged((change) => changes.push(change));
  try {
    await seedQueuedTrip();
    await tick();
    changes.length = 0;

    await runner().drainOnce(T0);
    await tick();
    await tick();
    expect(changes).toEqual([{ source: 'sync', result: { done: 1, failed: 0, deferred: 0 } }]);
  } finally {
    unsubscribe();
  }
});

test('a listener that throws does not break the drain that told it', async () => {
  const unsubscribe = onDataChanged((change) => {
    if (change.source === 'sync') throw new Error('boom');
  });
  const errors: string[] = [];
  try {
    await seedQueuedTrip();
    await expect(
      runner({ onError: (_error, context) => errors.push(context) }).drainOnce(T0)
    ).resolves.toEqual({ done: 1, failed: 0, deferred: 0 });
    await tick();
    expect(errors).toContain('data change listener');
  } finally {
    unsubscribe();
  }
});

test('a backlog longer than one batch is drained in a single call', async () => {
  for (let index = 0; index < 12; index += 1) {
    const id = `trip-${index}`;
    await trips().insert(
      { client_trip_id: id, started_at: T0, tz: 'UTC', status: 'provisional' },
      T0
    );
    await enqueueFinalize(db, tripPayload({ clientTripId: id, tracePath: null }), T0);
  }

  await expect(runner({ batchSize: 5 }).drainOnce(T0)).resolves.toEqual({
    done: 12,
    failed: 0,
    deferred: 0,
  });
  expect(supabase.invokes).toHaveLength(12);
});

test('a deferred-only batch never loops, however full it is', async () => {
  for (let index = 0; index < 4; index += 1) {
    const id = `trip-${index}`;
    await trips().insert(
      { client_trip_id: id, started_at: T0, tz: 'UTC', status: 'provisional' },
      T0
    );
    await enqueueFinalize(db, tripPayload({ clientTripId: id, tracePath: null }), T0);
  }
  supabase = createFakeSupabase({ uid: null });

  await expect(runner({ batchSize: 4 }).drainOnce(T0)).resolves.toEqual({
    done: 0,
    failed: 0,
    deferred: 4,
  });
});

test('an isWifi that answers neither true nor false is treated as cellular', async () => {
  await seedQueuedTrip();
  const unknown = () => undefined as unknown as boolean;

  await expect(runner({ net: { isWifi: unknown } }).drainOnce(T0)).resolves.toEqual({
    done: 1,
    failed: 0,
    deferred: 0,
  });
  expect(supabase.uploads).toHaveLength(0);
  expect(await traceItem()).toMatchObject({ kind: 'trace-upload', status: 'pending' });
  expect(fs.files.has(TRACE)).toBe(true);
});

test('a storage duplicate reported as HTTP 400 still counts as uploaded', async () => {
  await seedQueuedTrip();
  supabase = createFakeSupabase({
    uid: UID,
    upload: () => ({
      data: null,
      error: {
        name: 'StorageApiError',
        message: 'The resource already exists',
        status: 400,
        statusCode: '409',
        error: 'Duplicate',
      },
    }),
    invoke: () => invokeOk(SERVER_OK),
  });

  await expect(runner().drainOnce(T0)).resolves.toEqual({ done: 1, failed: 0, deferred: 0 });
  expect(supabase.invokes).toHaveLength(1);
});

test('payload_json that is not JSON at all fails terminally rather than retrying', async () => {
  await seedQueuedTrip();
  await db.execute('UPDATE sync_queue SET payload_json = ? WHERE idempotency_key = ?', [
    'not json{',
    finalizeIdempotencyKey(TRIP_ID),
  ]);

  await expect(runner().drainOnce(T0)).resolves.toEqual({ done: 0, failed: 1, deferred: 0 });
  expect(await finalizeItem()).toMatchObject({ status: 'failed', last_error: 'invalid_payload' });
});

test('a client trip id outside the server charset never reaches Storage', async () => {
  const id = '../../etc/passwd';
  await enqueueFinalize(db, tripPayload({ clientTripId: id, tracePath: null }), T0);

  await expect(runner().drainOnce(T0)).resolves.toEqual({ done: 0, failed: 1, deferred: 0 });
  expect(supabase.uploads).toHaveLength(0);
  expect(supabase.invokes).toHaveLength(0);
  await expect(queue().byKey(finalizeIdempotencyKey(id))).resolves.toMatchObject({
    status: 'failed',
    last_error: 'invalid_client_trip_id',
  });
});

test('a locked database while closing the claim leaves the item claimable, not stuck', async () => {
  await seedQueuedTrip();
  // The write that closes a successful claim is the one that meets the recorder's lock.
  const locked = lockingDb(db, /SET status = 'done'/);
  const errors: string[] = [];

  await expect(
    runner({ db: locked, onError: (_error, context) => errors.push(context) }).drainOnce(T0)
  ).resolves.toEqual({ done: 0, failed: 0, deferred: 1 });

  expect(errors.some((context) => context.startsWith('settle'))).toBe(true);
  // Claimable again at once rather than standing until reclaimInflight five minutes later.
  expect(await finalizeItem()).toMatchObject({ status: 'pending', attempts: 0, claimed_at: null });
  // The server did accept it, and the local apply committed before the claim was closed; the
  // retry replays it (`replayed: true`) onto the same rows.
  expect(await trips().get(TRIP_ID)).toMatchObject({ sync_state: 'synced' });
});

test('a trace whose trip is no longer on the device is dropped, not uploaded', async () => {
  // Deleted outright while the trace waited for Wi-Fi.
  await enqueueTraceUpload(db, { clientTripId: TRIP_ID, tracePath: TRACE }, T0);

  await expect(runner().drainOnce(T0)).resolves.toEqual({ done: 1, failed: 0, deferred: 0 });

  expect(supabase.uploads).toHaveLength(0);
  expect(fs.removals).toEqual([TRACE]);
  expect(await traceItem()).toMatchObject({ status: 'done' });
});

test('a trace belonging to a discarded trip never reaches Storage', async () => {
  await seedTrip(TRIP_ID, 'discarded');
  await enqueueTraceUpload(db, { clientTripId: TRIP_ID, tracePath: TRACE }, T0);

  await expect(runner().drainOnce(T0)).resolves.toEqual({ done: 1, failed: 0, deferred: 0 });
  expect(supabase.uploads).toHaveLength(0);
  expect(fs.files.has(TRACE)).toBe(false);
});

test('a deleted drive never uploads its trace or its summary', async () => {
  await seedTrip();
  await db.execute('UPDATE trips SET deleted_at = ?', [T0]);
  await enqueueFinalize(db, tripPayload(), T0);

  await expect(runner().drainOnce(T0)).resolves.toEqual({ done: 1, failed: 0, deferred: 0 });

  expect(supabase.uploads).toHaveLength(0);
  expect(supabase.invokes).toHaveLength(0);
  // The local file goes with it: nothing will ever read it again.
  expect(fs.files.has(TRACE)).toBe(false);
});

test('a trace belonging to a soft-deleted trip is dropped', async () => {
  await seedTrip();
  await enqueueTraceUpload(db, { clientTripId: TRIP_ID, tracePath: TRACE }, T0);

  // Still present, so it goes up as usual.
  await expect(runner().drainOnce(T0)).resolves.toEqual({ done: 1, failed: 0, deferred: 0 });
  expect(supabase.uploads).toHaveLength(1);

  // Now soft-deleted: a second trace, queued again, is dropped instead.
  fs.files.set(TRACE, new TextEncoder().encode('[]'));
  await db.execute('DELETE FROM sync_queue');
  await db.execute('UPDATE trips SET deleted_at = ?', [T0]);
  await enqueueTraceUpload(db, { clientTripId: TRIP_ID, tracePath: TRACE }, T0);

  await expect(runner().drainOnce(T0)).resolves.toEqual({ done: 1, failed: 0, deferred: 0 });
  expect(supabase.uploads).toHaveLength(1);
  expect(fs.files.has(TRACE)).toBe(false);
});

test('a trace whose trip is gone is dropped even signed out on cellular', async () => {
  wifi = false;
  supabase = createFakeSupabase({ uid: null });
  await enqueueTraceUpload(db, { clientTripId: TRIP_ID, tracePath: TRACE }, T0);

  await expect(runner().drainOnce(T0)).resolves.toEqual({ done: 1, failed: 0, deferred: 0 });
  expect(supabase.uploads).toHaveLength(0);
  expect(fs.files.has(TRACE)).toBe(false);
});

test("the server's severe flag reaches the trip on finalize, not only on a dispute", async () => {
  // The device uploads its own flag; the server ORs it with what the scored speeding events
  // prove and may raise it. The row has to follow, on this path as on the other two.
  await trips().insert(
    {
      client_trip_id: TRIP_ID,
      started_at: T0,
      tz: 'UTC',
      status: 'provisional',
      conditions_json: JSON.stringify({ night: true, precipitation: false, hadSevereEvent: false }),
    },
    T0
  );
  await enqueueFinalize(db, tripPayload(), T0);
  supabase = createFakeSupabase({
    uid: UID,
    invoke: () => invokeOk({ ...SERVER_OK, trip: { ...SERVER_TRIP_FIELDS, hadSevereEvent: true } }),
  });

  await expect(runner().drainOnce(T0)).resolves.toEqual({ done: 1, failed: 0, deferred: 0 });

  const stored = await trips().get(TRIP_ID);
  // The server's verdict replaces the device's; the observations beside it are untouched.
  expect(JSON.parse(stored?.conditions_json ?? '{}')).toEqual({
    night: true,
    precipitation: false,
    hadSevereEvent: true,
  });
});

describe('housekeeping', () => {
  test('a settled item is purged within a day, so the route it carries is not kept for ever', async () => {
    await seedTrip();
    await enqueueFinalize(db, tripPayload(), T0);

    await expect(runner().drainOnce(T0)).resolves.toEqual({ done: 1, failed: 0, deferred: 0 });
    // Still there right after it settled: a pass that crashed between the answer and the local
    // write is the reason to keep it at all.
    expect(await createQueueRepo(db).byKey('trip:' + TRIP_ID)).toMatchObject({ status: 'done' });

    // A day later, gone — with its polyline and every event coordinate.
    await runner().drainOnce(T0 + PURGE_DONE_AFTER_MS + 1);
    expect(await createQueueRepo(db).byKey('trip:' + TRIP_ID)).toBeNull();
  });

  test('a failed item is not purged: it is the record the driver can retry from', async () => {
    await seedTrip();
    await enqueueFinalize(db, tripPayload(), T0);
    const item = await createQueueRepo(db).byKey('trip:' + TRIP_ID);
    await createQueueRepo(db).markFailed(item?.id ?? 0, 'trip_too_old');

    await runner().drainOnce(T0 + PURGE_DONE_AFTER_MS + 1);

    expect(await createQueueRepo(db).byKey('trip:' + TRIP_ID)).toMatchObject({ status: 'failed' });
  });

  test('a trace file with no drive behind it is swept, whatever left it there', async () => {
    // What a process killed between a delete's commit and its file removal leaves on disk.
    fs.files.set('ghost.bin.gz', new TextEncoder().encode('[]'));
    fs.files.set('not-a-trace.txt', new TextEncoder().encode('x'));
    await seedTrip();
    fs.files.set(TRACE, new TextEncoder().encode('[]'));

    await runner().drainOnce(T0);

    expect(fs.files.has('ghost.bin.gz')).toBe(false);
    // The drive that still exists keeps its trace, and nothing else in the directory is touched.
    expect(fs.files.has(TRACE)).toBe(true);
    expect(fs.files.has('not-a-trace.txt')).toBe(true);
  });
});

describe('a device that changes hands mid-pass', () => {
  test('a pass still in flight when stop() lands writes nothing into the database behind it', async () => {
    // The real sequence: an auth event stops the runner and the host wipes and rebuilds the
    // database while a finalize is still waiting on its round trip. `stop()` unsubscribes but
    // cannot cancel that call, so the fence has to refuse the write when it comes back.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    supabase = createFakeSupabase({
      uid: UID,
      invoke: async () => {
        await held;
        return invokeOk(SERVER_OK);
      },
    });
    const sync = runner();
    await seedQueuedTrip();

    const inFlight = sync.drainOnce(T0);
    await tick();

    // The handover: the runner is stopped, and the database it was working in is emptied.
    sync.stop();
    await db.execute('DELETE FROM trips');
    await db.execute('DELETE FROM sync_queue');
    release();
    await inFlight;

    // The previous driver's day row is the dangerous one: `days.put` inserts, so it would appear
    // in the new driver's empty cache.
    expect(await allCachedDays()).toEqual([]);
    const { rows } = await db.execute('SELECT count(*) AS n FROM trips');
    expect(rows[0]?.n).toBe(0);
  });

  test('a stopped runner does not upload under the session that replaced it', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    supabase = createFakeSupabase({
      uid: UID,
      upload: async () => {
        await held;
        return { data: { path: 'x' }, error: null };
      },
      invoke: () => invokeOk(SERVER_OK),
    });
    const sync = runner();
    await seedQueuedTrip();

    const inFlight = sync.drainOnce(T0);
    await tick();
    sync.stop();
    supabase.setUid('the-next-driver');
    release();
    await inFlight;

    // The trace was already in flight when the handover landed; what must not follow it is the
    // summary, which would be stored as the new user's trip.
    expect(supabase.invokes).toHaveLength(0);
  });
});

describe('owner re-checks inside a pass (carry-over 4)', () => {
  test('a session that changes while the finalize call is in flight: the answer is not written', async () => {
    // No stop(), no generation change: only the session moved, which is all the owner check sees.
    supabase = createFakeSupabase({
      uid: UID,
      invoke: () => {
        supabase.setUid('the-next-driver');
        return invokeOk(SERVER_OK);
      },
    });
    await seedQueuedTrip();

    await expect(runner().drainOnce(T0)).resolves.toEqual({ done: 0, failed: 0, deferred: 1 });
    expect(await allCachedDays()).toEqual([]);
    expect(await trips().get(TRIP_ID)).toMatchObject({ sync_state: 'queued', server_id: null });
    expect(await finalizeItem()).toMatchObject({ status: 'pending', attempts: 0 });
  });

  test('a wipe that lands while the call is in flight: the commit sees the new owner and writes nothing', async () => {
    supabase = createFakeSupabase({
      uid: UID,
      invoke: async () => {
        // The handover's identity stage, with the old session object still answering: the
        // device now records someone else. Only the in-transaction fence can see this.
        await createSettingsRepo(db).set(DEVICE_OWNER_KEY, 'the-next-driver');
        return invokeOk(SERVER_OK);
      },
    });
    await seedQueuedTrip();

    await expect(runner().drainOnce(T0)).resolves.toMatchObject({ done: 0, deferred: 1 });
    expect(await allCachedDays()).toEqual([]);
    expect(await trips().get(TRIP_ID)).toMatchObject({ sync_state: 'queued', server_id: null });
  });

  test('a session that changes while the trace uploads: no upload mark, and no summary', async () => {
    supabase = createFakeSupabase({
      uid: UID,
      upload: () => {
        supabase.setUid('the-next-driver');
        return { data: { path: 'x' }, error: null };
      },
      invoke: () => invokeOk(SERVER_OK),
    });
    await seedQueuedTrip();

    await expect(runner().drainOnce(T0)).resolves.toMatchObject({ done: 0, deferred: 1 });
    expect(supabase.invokes).toHaveLength(0);
    expect(await finalizeItem()).toMatchObject({ trace_uploaded_at: null });
  });

  test('a deferred trace: a session change during its upload leaves the item unmarked', async () => {
    await seedTrip();
    await enqueueTraceUpload(db, { clientTripId: TRIP_ID, tracePath: TRACE }, T0);
    supabase = createFakeSupabase({
      uid: UID,
      upload: () => {
        supabase.setUid('the-next-driver');
        return { data: { path: 'x' }, error: null };
      },
    });

    await expect(runner().drainOnce(T0)).resolves.toMatchObject({ done: 0, deferred: 1 });
    expect(await traceItem()).toMatchObject({ status: 'pending', trace_uploaded_at: null });
    // The file is kept for the owner it belongs to.
    expect(fs.files.has(TRACE)).toBe(true);
  });
});

describe('fix round 1', () => {
  const deleteOk = () =>
    invokeOk({
      tripId: SERVER_TRIP_ID,
      deleted: true,
      days: [DAY_ROW],
      replayed: false,
    });

  test('M-1: flushDeletes sends every delete owed, due or not, and nothing else', async () => {
    supabase = createFakeSupabase({ uid: UID, invoke: () => deleteOk() });
    await seedQueuedTrip();
    await queue().enqueue('delete-trip', { action: 'delete', clientTripId: 'a' }, 'delete:a', T0 + 3_600_000, undefined, UID);
    await queue().enqueue('delete-trip', { action: 'delete', clientTripId: 'b' }, 'delete:b', T0, undefined, UID);

    await expect(runner().flushDeletes(T0)).resolves.toEqual({ sent: 2, left: 0 });
    expect(supabase.invokes.map((call) => (call.body as { action: string }).action)).toEqual(['delete', 'delete']);
    // The trip's own upload is not the flush's business.
    expect(await finalizeItem()).toMatchObject({ status: 'pending', attempts: 0 });
  });

  test('M-1: what cannot be sent is counted for the sign-out warning', async () => {
    supabase = createFakeSupabase({ uid: UID, invoke: () => functionsFetchError() });
    await queue().enqueue('delete-trip', { action: 'delete', clientTripId: 'a' }, 'delete:a', T0, undefined, UID);
    await expect(runner().flushDeletes(T0)).resolves.toEqual({ sent: 0, left: 1 });
  });

  test('M-1: a flush never runs over a drive, and waits for a pass in flight', async () => {
    recording = true;
    await queue().enqueue('delete-trip', { action: 'delete', clientTripId: 'a' }, 'delete:a', T0, undefined, UID);
    await expect(runner().flushDeletes(T0)).resolves.toEqual({ sent: 0, left: 1 });
    expect(supabase.invokes).toHaveLength(0);
  });

  test('M-3: a trace item carries the finalize item owner, and is not written past a handover', async () => {
    wifi = false;
    await seedQueuedTrip();
    await runner().drainOnce(T0);
    expect(await traceItem()).toMatchObject({ owner_uid: UID });
  });

  test('M-3: the device changing hands before the trace item is written leaves none', async () => {
    wifi = false;
    // The finalize item is still the session user's, but the device now records someone else:
    // only the in-transaction check sees it.
    await seedQueuedTrip();
    await createSettingsRepo(db).set(DEVICE_OWNER_KEY, 'the-next-driver');
    await expect(runner().drainOnce(T0)).resolves.toMatchObject({ done: 0, deferred: 1 });
    expect(await traceItem()).toBeNull();
    expect(supabase.invokes).toHaveLength(0);
  });
});

describe('D2: network state and the drain policy', () => {
  /** A `NetAdapter` a test can flip, with its subscribers visible. */
  function fakeNet(initial: { online: boolean; wifi: boolean }) {
    let state = { ...initial };
    const listeners = new Set<(s: { online: boolean; wifi: boolean }) => void>();
    return {
      isOnline: () => state.online,
      isWifi: () => state.wifi,
      subscribe(fn: (s: { online: boolean; wifi: boolean }) => void) {
        listeners.add(fn);
        return () => {
          listeners.delete(fn);
        };
      },
      listeners,
      set(next: { online: boolean; wifi: boolean }) {
        state = { ...next };
        for (const l of [...listeners]) l(state);
      },
    };
  }

  const OFFLINE = { online: false, wifi: false };
  const WIFI = { online: true, wifi: true };
  const CELL = { online: true, wifi: false };

  /** An upload that gave up because the device stayed offline for its whole ladder. */
  async function exhaustedUpload(): Promise<QueueItem> {
    const item = await seedQueuedTrip();
    await db.execute(
      "UPDATE sync_queue SET status = 'failed', attempts = ?, last_error = 'network' WHERE id = ?",
      [MAX_ATTEMPTS, item.id]
    );
    await trips().update(TRIP_ID, { sync_state: 'failed', sync_error: 'retries_exhausted' }, T0);
    return item;
  }

  /** A role answer the server refused for good. */
  async function refusedRoleAnswer(): Promise<QueueItem> {
    const item = await queue().enqueue(
      'set-role',
      { action: 'set-role', clientTripId: TRIP_ID, role: 'driver' },
      `role:${TRIP_ID}:1`,
      T0,
      undefined,
      UID
    );
    await queue().nextDueOfKind('set-role', T0);
    await queue().markAttempt(item.id, false, 'trip_not_found', T0);
    await queue().markFailed(item.id, 'trip_not_found');
    return item;
  }

  test('mayDrain false: nothing is claimed, sent or counted', async () => {
    const item = await seedQueuedTrip();
    const r = runner({ mayDrain: () => false });

    await expect(r.drainOnce(T0)).resolves.toEqual({ done: 0, failed: 0, deferred: 0 });

    expect(supabase.invokes).toHaveLength(0);
    expect(supabase.uploads).toHaveLength(0);
    expect(await queue().get(item.id)).toMatchObject({
      status: 'pending',
      attempts: 0,
      claimed_at: null,
    });
  });

  test('mayDrain false: a wake from new work or the foreground does nothing, and no timer is left', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'queueMicrotask', 'nextTick'] });
    try {
      let allowed = false;
      const appState = createFakeAppState();
      const r = runner({ mayDrain: () => allowed, appState });
      r.start();
      await seedQueuedTrip();
      emitDataChanged({ source: 'enqueue' });
      appState.emit('active');
      await jest.advanceTimersByTimeAsync(RECORDING_RETRY_MS * 4);
      expect(supabase.invokes).toHaveLength(0);
      expect(jest.getTimerCount()).toBe(0);

      // Nor during a drive: the wake that would otherwise retry in 15 s is dropped, not postponed.
      recording = true;
      emitDataChanged({ source: 'enqueue' });
      await jest.advanceTimersByTimeAsync(10);
      expect(jest.getTimerCount()).toBe(0);
      recording = false;

      // The host's policy allows it again (the app came to the foreground): the next wake drains.
      allowed = true;
      appState.emit('active');
      await jest.advanceTimersByTimeAsync(10);
      await waitFor(() => supabase.invokes.length === 1);
      await r.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  test('mayDrain defaults to always', async () => {
    await seedQueuedTrip();
    await expect(runner().drainOnce(T0)).resolves.toMatchObject({ done: 1 });
  });

  test('offline to online reopens only the retry-class items, and drains them once', async () => {
    const exhausted = await exhaustedUpload();
    const refused = await refusedRoleAnswer();
    const net = fakeNet(OFFLINE);
    const r = runner({ net });
    r.start();
    for (let i = 0; i < 5; i += 1) await tick();
    // Offline: the start-up wake claims nothing, reopens nothing and asks nobody anything.
    expect(supabase.invokes).toHaveLength(0);
    expect(supabase.sessions).toBe(0);
    expect(await queue().get(exhausted.id)).toMatchObject({ status: 'failed' });

    net.set(WIFI);
    await waitFor(() => supabase.invokes.length > 0);
    for (let i = 0; i < 5; i += 1) await tick();

    expect(supabase.invokes).toEqual([{ name: 'finalize-trip', body: tripPayload() }]);
    expect(supabase.uploads).toHaveLength(1);
    expect(await queue().get(exhausted.id)).toMatchObject({ status: 'done', attempts: 0 });
    expect(await trips().get(TRIP_ID)).toMatchObject({ sync_state: 'synced', sync_error: null });
    expect(await queue().get(refused.id)).toMatchObject({
      status: 'failed',
      last_error: 'trip_not_found',
    });
    await r.stop();
  });

  test('a change that is not offline to online reopens nothing', async () => {
    const net = fakeNet(CELL);
    const r = runner({ net });
    r.start();
    for (let i = 0; i < 5; i += 1) await tick();
    // The launch's own reopen pass has run (and found nothing). Now an upload gives up.
    const exhausted = await exhaustedUpload();

    net.set(WIFI); // online already: a better link, not a reconnect
    net.set(CELL);
    for (let i = 0; i < 5; i += 1) await tick();

    expect(await queue().get(exhausted.id)).toMatchObject({ status: 'failed' });
    expect(supabase.invokes).toHaveLength(0);
    await r.stop();
  });

  test('a reconnect while mayDrain is false touches nothing until the host allows a drain', async () => {
    const exhausted = await exhaustedUpload();
    let allowed = false;
    const appState = createFakeAppState();
    const net = fakeNet(OFFLINE);
    const r = runner({ net, appState, mayDrain: () => allowed });
    r.start();

    net.set(WIFI);
    for (let i = 0; i < 5; i += 1) await tick();
    // Armed and idle in the background: no query and no request (design §3.5).
    expect(await queue().get(exhausted.id)).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS });
    expect(supabase.invokes).toHaveLength(0);

    // The reconnect is remembered: the next drain the host allows reopens first, then sends.
    allowed = true;
    appState.emit('active');
    await waitFor(() => supabase.invokes.length === 1);
    await r.stop();
  });

  test('a reconnect during a drive is remembered and handled at the next drain', async () => {
    const exhausted = await exhaustedUpload();
    recording = true;
    const net = fakeNet(OFFLINE);
    const r = runner({ net });
    r.start();
    net.set(CELL);
    for (let i = 0; i < 5; i += 1) await tick();
    expect(await queue().get(exhausted.id)).toMatchObject({ status: 'failed' });

    recording = false;
    await r.drainOnce(T0);
    expect(supabase.invokes).toHaveLength(1);
    expect(await queue().get(exhausted.id)).toMatchObject({ status: 'done' });
    await r.stop();
  });

  test('stop() lets go of the network subscription', async () => {
    const net = fakeNet(WIFI);
    const r = runner({ net });
    r.start();
    expect(net.listeners.size).toBe(1);
    await r.stop();
    expect(net.listeners.size).toBe(0);
  });

  test('a plain NetStatus (no subscribe) still works: no reconnect handling, same drain', async () => {
    await seedQueuedTrip();
    const r = runner({ net: { isWifi: () => true } });
    await expect(r.drainOnce(T0)).resolves.toMatchObject({ done: 1 });
  });
});

describe('D2 round 2: offline drains and the launch reopen (review D2 I1)', () => {
  function netAt(online: boolean) {
    let state = { online, wifi: online };
    const listeners = new Set<(s: { online: boolean; wifi: boolean }) => void>();
    return {
      isOnline: () => state.online,
      isWifi: () => state.wifi,
      subscribe(fn: (s: { online: boolean; wifi: boolean }) => void) {
        listeners.add(fn);
        return () => listeners.delete(fn) as unknown as void;
      },
      set(next: boolean) {
        state = { online: next, wifi: next };
        for (const l of [...listeners]) l(state);
      },
    };
  }

  test('offline, a drain claims nothing and counts no attempt', async () => {
    const item = await seedQueuedTrip();
    const r = runner({ net: netAt(false) });

    await expect(r.drainOnce(T0)).resolves.toEqual({ done: 0, failed: 0, deferred: 0 });
    await expect(r.drainOnce(T0 + 60_000)).resolves.toEqual({ done: 0, failed: 0, deferred: 0 });

    expect(supabase.invokes).toHaveLength(0);
    expect(await queue().get(item.id)).toMatchObject({ status: 'pending', attempts: 0, claimed_at: null });
  });

  test('a launch that is online from the start reopens what ran out while the app was dead', async () => {
    // Exhausted in an earlier process that was killed offline: this one never sees the edge.
    const item = await seedQueuedTrip();
    await db.execute(
      "UPDATE sync_queue SET status = 'failed', attempts = ?, last_error = 'network' WHERE id = ?",
      [MAX_ATTEMPTS, item.id]
    );
    const r = runner({ net: netAt(true) });
    r.start();
    await waitFor(() => supabase.invokes.length === 1);
    for (let i = 0; i < 5; i += 1) await tick();

    expect(await queue().get(item.id)).toMatchObject({ status: 'done' });
    expect(supabase.invokes).toHaveLength(1);
    await r.stop();
  });

  test('the launch reopen runs once per lifetime, not on every drain', async () => {
    const r = runner({ net: netAt(true) });
    r.start();
    for (let i = 0; i < 5; i += 1) await tick();
    // An upload gives up after the launch pass; later drains on the same lifetime leave it.
    const item = await seedQueuedTrip();
    await db.execute(
      "UPDATE sync_queue SET status = 'failed', attempts = ?, last_error = 'network' WHERE id = ?",
      [MAX_ATTEMPTS, item.id]
    );
    await r.drainOnce(T0 + 1);
    expect(await queue().get(item.id)).toMatchObject({ status: 'failed' });
    await r.stop();
  });

  test('the first drain sweeps reports whose event is gone (security review D2 R1-M1)', async () => {
    await queue().enqueue(
      'dispute',
      { action: 'dispute', clientEventId: 'gone', reason: 'hazard', note: 'private words' },
      'dispute:gone',
      T0,
      undefined,
      UID
    );
    await db.execute("UPDATE sync_queue SET status = 'failed', attempts = 3 WHERE idempotency_key = 'dispute:gone'");
    const r = runner({ net: netAt(true) });
    r.start();
    for (let i = 0; i < 10; i += 1) await tick();

    expect(await queue().byKey('dispute:gone')).toBeNull();
    expect(supabase.invokes).toHaveLength(0);
    await r.stop();
  });
});
