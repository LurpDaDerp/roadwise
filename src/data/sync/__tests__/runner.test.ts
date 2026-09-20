/** @jest-environment node */
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import type { Db } from '@/data/db/driver';
import { migrate } from '@/data/db/migrate';
import { createQueueRepo, RECLAIM_AFTER_S } from '@/data/db/queue';
import { createScoreDailyCacheRepo } from '@/data/db/scoreDailyCache';
import { createTripsRepo } from '@/data/db/trips';
import type { QueueItem } from '@/data/db/types';
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
import {
  emitQueueChanged,
  enqueueFinalize,
  enqueueTraceUpload,
  finalizeIdempotencyKey,
  traceIdempotencyKey,
} from '@/data/sync/queue';
import {
  createSyncRunner,
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

const SERVER_OK = {
  tripId: 'srv-1',
  score: 74,
  status: 'final',
  day: { day: '2026-09-20', safeDay: true, goodDay: false, points: 50 },
  provisionalMismatch: false,
  replayed: false,
};

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

const itemByKey = async (key: string): Promise<QueueItem | null> => queue().byKey(key);
const finalizeItem = () => itemByKey(finalizeIdempotencyKey(TRIP_ID));
const traceItem = () => itemByKey(traceIdempotencyKey(TRIP_ID));

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
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
    server_id: 'srv-1',
    score: 74,
    status: 'final',
    sync_error: null,
  });

  await expect(createScoreDailyCacheRepo(db).get('2026-09-20')).resolves.toMatchObject({
    day: '2026-09-20',
    payload: SERVER_OK.day,
    updated_at: T0,
  });

  expect(await finalizeItem()).toMatchObject({ status: 'done', attempts: 0 });
  // The trace this pass uploaded is of no further use on the device.
  expect(fs.removals).toEqual([TRACE]);
});

test('the object key comes from the session, never from the payload', async () => {
  await seedQueuedTrip();
  supabase.setUid('someone-else');

  await runner().drainOnce(T0);

  expect(supabase.uploads[0]?.path).toBe(`someone-else/${TRIP_ID}.bin.gz`);
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

test('start drains at once, on app foreground and on queue:changed; stop unsubscribes', async () => {
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

  appState.emit('active');
  await tick();
  expect(appState.listeners).toHaveLength(1);

  sync.stop();
  expect(appState.listeners).toHaveLength(0);
  expect(appState.removals).toBe(1);

  // Nothing is drained after stop().
  const before = supabase.invokes.length;
  emitQueueChanged();
  await tick();
  expect(supabase.invokes).toHaveLength(before);
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

test('two drains never overlap', async () => {
  await seedQueuedTrip();
  let inFlight = 0;
  let overlapped = false;
  supabase = createFakeSupabase({
    uid: UID,
    invoke: () => {
      inFlight += 1;
      overlapped ||= inFlight > 1;
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
