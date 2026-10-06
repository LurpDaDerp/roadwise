/** @jest-environment node */
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import type { Db } from '@/data/db/driver';
import { migrate } from '@/data/db/migrate';
import { backoffSeconds, createQueueRepo, MAX_ATTEMPTS, REFUSED_NEVER, SERVER_REOPEN_AFTER_MS, TRANSPORT_FAILURE } from '@/data/db/queue';

const T0 = 1_700_000_000_000;

let db: Db;
let queue: ReturnType<typeof createQueueRepo>;

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
  queue = createQueueRepo(db);
});

test('backoff doubles from 30 s to a one-hour ceiling', () => {
  expect([0, 1, 2, 6, 7, 20].map(backoffSeconds)).toEqual([30, 60, 120, 1920, 3600, 3600]);
});

test('enqueue is idempotent on the key and stamps the owner', async () => {
  const a = await queue.enqueue('finalize-trip', { clientTripId: 'a' }, 'trip:a', T0, undefined, 'u1');
  const b = await queue.enqueue('finalize-trip', { clientTripId: 'a', changed: true }, 'trip:a', T0 + 1);
  expect(b.id).toBe(a.id);
  expect(b.payload_json).toBe(JSON.stringify({ clientTripId: 'a' }));
  expect(b.owner_uid).toBe('u1');
  expect(await queue.countByStatus('pending')).toBe(1);
});

test('nextDue claims due items as inflight and reclaims stale claims', async () => {
  await queue.enqueue('finalize-trip', {}, 'trip:a', T0);
  await queue.enqueue('finalize-trip', {}, 'trip:b', T0 + 10_000);
  const first = await queue.nextDue(T0);
  expect(first.map((i) => i.idempotency_key)).toEqual(['trip:a']);
  expect(first[0]?.status).toBe('inflight');
  expect(await queue.nextDue(T0)).toEqual([]);
  // The claim went stale (a crashed pass): handed back.
  const later = await queue.nextDue(T0 + 400_000, 10, 300);
  expect(later.map((i) => i.idempotency_key).sort()).toEqual(['trip:a', 'trip:b']);
});

test('markAttempt: success → done; failure → pending with backoff, then failed at MAX_ATTEMPTS; a second close is a no-op', async () => {
  await queue.enqueue('finalize-trip', {}, 'trip:a', T0);
  let [item] = await queue.nextDue(T0);
  const failed = await queue.markAttempt(item!.id, false, 'network', T0);
  expect(failed).toMatchObject({ status: 'pending', attempts: 1, next_attempt_at: T0 + 30_000, last_error: 'network' });
  expect(await queue.markAttempt(item!.id, false, 'network', T0)).toBeNull();
  for (let n = 1; n < MAX_ATTEMPTS; n += 1) {
    [item] = await queue.nextDue(T0 + 10_000_000);
    await queue.markAttempt(item!.id, false, 'network', T0);
  }
  expect((await queue.get(item!.id))?.status).toBe('failed');
});

test('release and deferUntil move an item without counting an attempt', async () => {
  await queue.enqueue('finalize-trip', {}, 'trip:a', T0);
  const [item] = await queue.nextDue(T0);
  expect(await queue.release(item!.id, T0 + 5000)).toMatchObject({ status: 'pending', attempts: 0, next_attempt_at: T0 + 5000 });
  expect(await queue.deferUntil(item!.id, T0 + 9000)).toMatchObject({ next_attempt_at: T0 + 9000 });
  expect(await queue.deferUntil(item!.id, T0 + 1000)).toBeNull();
});

test('markFailed is final; reopenRetryable reopens only exhausted ladders (transport at once, server-side after a day)', async () => {
  await queue.enqueue('finalize-trip', {}, 'trip:refused', T0);
  await queue.enqueue('finalize-trip', {}, 'trip:network', T0);
  await queue.enqueue('finalize-trip', {}, 'trip:server', T0);
  const exhaust = async (key: string, error: string) => {
    for (let n = 0; n < MAX_ATTEMPTS; n += 1) {
      const items = await queue.nextDue(T0 + 10_000_000);
      const item = items.find((i) => i.idempotency_key === key)!;
      await queue.markAttempt(item.id, false, error, T0);
      for (const other of items.filter((i) => i !== item)) await queue.release(other.id, T0);
    }
  };
  const [refused] = await queue.nextDue(T0, 1);
  await queue.markAttempt(refused!.id, false, 'invalid_payload', T0);
  await queue.markFailed(refused!.id, 'invalid_payload');
  expect(await queue.get(refused!.id)).toMatchObject({ status: 'failed', next_attempt_at: REFUSED_NEVER });
  await exhaust('trip:network', TRANSPORT_FAILURE);
  await exhaust('trip:server', 'http_503');
  expect(await queue.reopenRetryable(T0)).toBe(1);
  expect((await queue.byKey('trip:network'))?.status).toBe('pending');
  expect((await queue.byKey('trip:server'))?.status).toBe('failed');
  expect((await queue.byKey('trip:refused'))?.status).toBe('failed');
  // The give-up left `next_attempt_at` at the last scheduled try (an hour on); a day after THAT it reopens.
  expect(await queue.reopenRetryable(T0 + 3_600_000 + SERVER_REOPEN_AFTER_MS + 1)).toBe(1);
  expect((await queue.byKey('trip:server'))?.status).toBe('pending');
});

test('purgeDone removes old finished items only', async () => {
  await queue.enqueue('finalize-trip', {}, 'trip:a', T0);
  const [item] = await queue.nextDue(T0);
  await queue.markAttempt(item!.id, true, null, T0);
  expect(await queue.purgeDone(T0)).toBe(0);
  expect(await queue.purgeDone(T0 + 1)).toBe(1);
});
