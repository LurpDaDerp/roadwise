/** @jest-environment node */
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import type { Db } from '@/data/db/driver';
import { migrate } from '@/data/db/migrate';
import { createQueueRepo } from '@/data/db/queue';
import type { FinalizeTripPayload } from '@/data/sync/payload';
import {
  enqueueFinalize,
  FINALIZE_KIND,
  finalizeIdempotencyKey,
  findFinalize,
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

test('findFinalize still finds the payload once the item is done', async () => {
  const item = await enqueueFinalize(db, payload(), T0);
  const queue = createQueueRepo(db);
  await queue.nextDue(T0);
  await queue.markAttempt(item.id, true, null, T0);
  await expect(findFinalize(db, ID)).resolves.toEqual(payload());
});
