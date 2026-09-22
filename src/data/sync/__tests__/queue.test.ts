/** @jest-environment node */
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import type { Db } from '@/data/db/driver';
import { migrate } from '@/data/db/migrate';
import { createQueueRepo } from '@/data/db/queue';
import { createSettingsRepo } from '@/data/db/settings';
import { onDataChanged } from '@/data/events';
import type { FinalizeTripPayload } from '@/data/sync/payload';
import { isSyncKind, SYNC_KINDS } from '@/data/sync/kinds';
import {
  DEVICE_OWNER_KEY,
  deviceOwnerIs,
  enqueueFinalize,
  enqueueTraceUpload,
  FINALIZE_KIND,
  finalizeIdempotencyKey,
  findFinalize,
  TRACE_UPLOAD_KIND,
  traceIdempotencyKey,
} from '@/data/sync/queue';

const T0 = 1_700_000_000_000;
const ID = '123e4567-e89b-42d3-a456-426614174000';

const payload = (overrides: Partial<FinalizeTripPayload> = {}): FinalizeTripPayload => ({
  clientTripId: ID,
  startedAt: T0,
  endedAt: T0 + 120_000,
  tz: 'UTC',
  distanceM: 900,
  durationS: 120,
  role: 'driver',
  roleConfidence: null,
  roleSource: 'manual',
  mode: 'mounted',
  cameraSession: false,
  limitCoveragePct: 80,
  provisional: {
    score: 100,
    status: 'final',
    exposure: 0.75,
    dataQuality: 'A',
    categoryDeductions: { phone: 0, speeding: 0, braking: 0, accel: 0, cornering: 0, focus: 0 },
    eventDeductions: {},
    scoringVersion: 1,
  },
  events: [],
  rowsDigest: {
    count: 120,
    validGnssPct: 100,
    imuPresent: true,
    maxSustainedSpeedMps: 8,
    sha256: 'a'.repeat(64),
  },
  startGeohash5: '9q8yy',
  endGeohash5: '9q8yy',
  polyline: '',
  tracePath: `${ID}.bin.gz`,
  hadSevereEvent: false,
  incomplete: false,
  ...overrides,
});

let db: Db;

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
});

test('the idempotency key is deterministic per trip', () => {
  expect(finalizeIdempotencyKey(ID)).toBe(`trip:${ID}`);
  expect(finalizeIdempotencyKey(ID)).toBe(finalizeIdempotencyKey(ID));
});

test('enqueueFinalize queues one pending finalize-trip item keyed by the trip', async () => {
  const item = await enqueueFinalize(db, payload(), T0);
  expect(item).toMatchObject({
    kind: FINALIZE_KIND,
    idempotency_key: `trip:${ID}`,
    status: 'pending',
    attempts: 0,
    next_attempt_at: T0,
    created_at: T0,
  });
  expect(JSON.parse(item.payload_json)).toEqual(payload());
  await expect(createQueueRepo(db).countByStatus('pending')).resolves.toBe(1);
});

test('enqueueing the same trip again keeps the first item, whatever the second payload says', async () => {
  const first = await enqueueFinalize(db, payload(), T0);
  const second = await enqueueFinalize(db, payload({ distanceM: 1 }), T0 + 5000);
  expect(second.id).toBe(first.id);
  expect(JSON.parse(second.payload_json)).toEqual(payload());
  await expect(createQueueRepo(db).countByStatus('pending')).resolves.toBe(1);
});

test('enqueueFinalize refuses a payload that does not match the contract', async () => {
  await expect(enqueueFinalize(db, { ...payload(), distanceM: -5 }, T0)).rejects.toThrow();
  await expect(createQueueRepo(db).countByStatus('pending')).resolves.toBe(0);
});

test('findFinalize returns the queued payload for a trip, or null', async () => {
  await expect(findFinalize(db, ID)).resolves.toBeNull();
  await enqueueFinalize(db, payload(), T0);
  await expect(findFinalize(db, ID)).resolves.toEqual(payload());
  await expect(findFinalize(db, 'other')).resolves.toBeNull();
});

test('enqueueFinalize on a transaction handle is part of that transaction', async () => {
  await expect(
    db.transaction(async (tx) => {
      await enqueueFinalize(db, payload(), T0, tx);
      throw new Error('boom');
    })
  ).rejects.toThrow('boom');
  await expect(findFinalize(db, ID)).resolves.toBeNull();

  await db.transaction(async (tx) => {
    await enqueueFinalize(db, payload(), T0, tx);
  });
  await expect(findFinalize(db, ID)).resolves.toEqual(payload());
});

test('findFinalize still finds the payload once the item is done', async () => {
  const item = await enqueueFinalize(db, payload(), T0);
  const queue = createQueueRepo(db);
  await queue.nextDue(T0);
  await queue.markAttempt(item.id, true, null, T0);
  await expect(findFinalize(db, ID)).resolves.toEqual(payload());
});

test('the trace key is distinct from the trip key, so both can be queued at once', () => {
  expect(traceIdempotencyKey(ID)).toBe(`trace:${ID}`);
  expect(traceIdempotencyKey(ID)).not.toBe(finalizeIdempotencyKey(ID));
});

test('enqueueTraceUpload queues one pending trace-upload item keyed by the trip', async () => {
  const item = await enqueueTraceUpload(db, { clientTripId: ID, tracePath: `${ID}.bin.gz` }, T0);

  expect(item).toMatchObject({
    kind: TRACE_UPLOAD_KIND,
    idempotency_key: `trace:${ID}`,
    status: 'pending',
    attempts: 0,
    trace_uploaded_at: null,
  });
  expect(JSON.parse(item.payload_json)).toEqual({
    clientTripId: ID,
    tracePath: `${ID}.bin.gz`,
  });

  // Idempotent: a finalize retried before the trace goes up does not queue a second one.
  const again = await enqueueTraceUpload(
    db,
    { clientTripId: ID, tracePath: `${ID}.bin.gz` },
    T0 + 5000
  );
  expect(again.id).toBe(item.id);
  await expect(createQueueRepo(db).countByStatus('pending')).resolves.toBe(1);
});

test('enqueueTraceUpload refuses anything but the two keys it knows', async () => {
  await expect(enqueueTraceUpload(db, { clientTripId: '', tracePath: 'x' }, T0)).rejects.toThrow();
  await expect(
    enqueueTraceUpload(
      db,
      { clientTripId: ID, tracePath: 'x', uid: 'nice try' } as never,
      T0
    )
  ).rejects.toThrow();
  await expect(createQueueRepo(db).countByStatus('pending')).resolves.toBe(0);
});

test('every queued kind is one the runner knows about', () => {
  expect(SYNC_KINDS).toEqual([
    'finalize-trip',
    'trace-upload',
    'dispute',
    'set-role',
    'delete-trip',
  ]);
  expect(isSyncKind(FINALIZE_KIND)).toBe(true);
  expect(isSyncKind(TRACE_UPLOAD_KIND)).toBe(true);
  expect(isSyncKind('nonsense')).toBe(false);
});

test('an enqueue change fires once per batch, after the enqueueing transaction commits', async () => {
  const seen: string[] = [];
  const unsubscribe = onDataChanged((e) => seen.push(e.source));
  try {
    await db.transaction(async (tx) => {
      await enqueueFinalize(db, payload(), T0, tx);
      await enqueueTraceUpload(db, { clientTripId: ID, tracePath: `${ID}.bin.gz` }, T0, tx);
      // Nothing has run yet: a listener firing here would be inside the open transaction.
      expect(seen).toHaveLength(0);
    });
    expect(seen).toHaveLength(0);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toEqual(['enqueue']);
  } finally {
    unsubscribe();
  }
});

test('a listener that has unsubscribed is not called again', async () => {
  let calls = 0;
  const unsubscribe = onDataChanged(() => {
    calls += 1;
  });
  unsubscribe();

  await enqueueFinalize(db, payload(), T0);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(calls).toBe(0);
});

test('a trace-upload payload must name a trip id the server would accept', async () => {
  for (const bad of ['../../etc/passwd', 'a b', '', 'x'.repeat(65)]) {
    await expect(
      enqueueTraceUpload(db, { clientTripId: bad, tracePath: `${bad}.bin.gz` }, T0)
    ).rejects.toThrow();
  }
  // And the path must be that trip's own trace, not another's.
  await expect(
    enqueueTraceUpload(db, { clientTripId: ID, tracePath: 'someone-else.bin.gz' }, T0)
  ).rejects.toThrow();
  await expect(createQueueRepo(db).countByStatus('pending')).resolves.toBe(0);
});

test('deviceOwnerIs answers for the recorded owner only, on the handle it is given', async () => {
  await expect(deviceOwnerIs(db, 'user-1')).resolves.toBe(false);
  await createSettingsRepo(db).set(DEVICE_OWNER_KEY, 'user-1');
  await expect(deviceOwnerIs(db, 'user-1')).resolves.toBe(true);
  await expect(deviceOwnerIs(db, 'user-2')).resolves.toBe(false);
  await db.transaction(async (tx) => {
    await tx.execute('DELETE FROM settings');
    // Mid-wipe: nobody owns the device, so nobody's write may land.
    await expect(deviceOwnerIs(tx, 'user-1')).resolves.toBe(false);
  });
});
