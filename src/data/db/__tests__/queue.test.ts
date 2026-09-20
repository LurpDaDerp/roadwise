/** @jest-environment node */
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import type { Db } from '@/data/db/driver';
import { migrate } from '@/data/db/migrate';
import { backoffSeconds, createQueueRepo, MAX_ATTEMPTS, RECLAIM_AFTER_S } from '@/data/db/queue';

const T0 = 1_700_000_000_000;
const SECOND = 1000;

let db: Db;
let queue: ReturnType<typeof createQueueRepo>;

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
  queue = createQueueRepo(db);
});

test('enqueue stores a pending item due immediately', async () => {
  const item = await queue.enqueue('finalize-trip', { clientTripId: 'a' }, 'trip:a', T0);

  expect(item).toMatchObject({
    kind: 'finalize-trip',
    idempotency_key: 'trip:a',
    status: 'pending',
    attempts: 0,
    next_attempt_at: T0,
    last_error: null,
    created_at: T0,
  });
  expect(JSON.parse(item.payload_json)).toEqual({ clientTripId: 'a' });
  expect(item.id).toBeGreaterThan(0);
});

test('enqueueing the same idempotency key twice keeps the first item', async () => {
  const first = await queue.enqueue('finalize-trip', { n: 1 }, 'trip:a', T0);
  const second = await queue.enqueue('finalize-trip', { n: 2 }, 'trip:a', T0 + 5000);

  expect(second.id).toBe(first.id);
  expect(JSON.parse(second.payload_json)).toEqual({ n: 1 });
  await expect(queue.countByStatus('pending')).resolves.toBe(1);
});

test('nextDue hands back due items oldest first and marks them inflight', async () => {
  await queue.enqueue('a', {}, 'k-a', T0);
  await queue.enqueue('b', {}, 'k-b', T0 + 1);

  const due = await queue.nextDue(T0 + 10, 10);

  expect(due.map((i) => i.idempotency_key)).toEqual(['k-a', 'k-b']);
  expect(due.every((i) => i.status === 'inflight')).toBe(true);
  expect(due.every((i) => i.claimed_at === T0 + 10)).toBe(true);
  await expect(queue.countByStatus('pending')).resolves.toBe(0);
  await expect(queue.countByStatus('inflight')).resolves.toBe(2);

  // The claim is recorded on the stored row, not only on what nextDue handed back.
  expect((await queue.get(due[0]?.id ?? 0))?.claimed_at).toBe(T0 + 10);
});

test('nextDue honours the limit and leaves the rest pending', async () => {
  await queue.enqueue('a', {}, 'k-a', T0);
  await queue.enqueue('b', {}, 'k-b', T0 + 1);
  await queue.enqueue('c', {}, 'k-c', T0 + 2);

  const due = await queue.nextDue(T0 + 10, 2);

  expect(due.map((i) => i.idempotency_key)).toEqual(['k-a', 'k-b']);
  await expect(queue.countByStatus('pending')).resolves.toBe(1);
});

test('nextDue skips items whose retry is still in the future', async () => {
  const item = await queue.enqueue('a', {}, 'k-a', T0);
  const [taken] = await queue.nextDue(T0, 10);
  expect(taken?.id).toBe(item.id);

  await queue.markAttempt(item.id, false, 'offline', T0);

  await expect(queue.nextDue(T0 + 29 * SECOND, 10)).resolves.toEqual([]);
  const due = await queue.nextDue(T0 + 30 * SECOND, 10);
  expect(due.map((i) => i.id)).toEqual([item.id]);
});

test('nextDue never returns items that are done or failed', async () => {
  const ok = await queue.enqueue('a', {}, 'k-a', T0);
  await queue.nextDue(T0, 10);
  await queue.markAttempt(ok.id, true, null, T0);

  await expect(queue.nextDue(T0 + 10 * 60 * SECOND, 10)).resolves.toEqual([]);
});

test('a successful attempt marks the item done and clears the last error', async () => {
  const item = await queue.enqueue('a', {}, 'k-a', T0);
  await queue.nextDue(T0, 10);
  await queue.markAttempt(item.id, false, 'boom', T0);
  await queue.nextDue(T0 + 30 * SECOND, 10);

  const done = await queue.markAttempt(item.id, true, null, T0 + 31 * SECOND);

  expect(done).toMatchObject({ status: 'done', attempts: 1, last_error: null });
});

test('backoffSeconds doubles from 30 s and holds at one hour', () => {
  expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 19].map(backoffSeconds)).toEqual([
    30, 60, 120, 240, 480, 960, 1920, 3600, 3600, 3600,
  ]);
});

test('each failed attempt schedules the next retry on the backoff ladder', async () => {
  const item = await queue.enqueue('a', {}, 'k-a', T0);
  const ladder = [30, 60, 120, 240, 480, 960, 1920, 3600, 3600, 3600];

  let now = T0;
  for (const [index, delay] of ladder.entries()) {
    const due = await queue.nextDue(now, 10);
    expect(due.map((i) => i.id)).toEqual([item.id]);

    const after = await queue.markAttempt(item.id, false, `fail ${index}`, now);

    expect(after).toMatchObject({
      status: 'pending',
      attempts: index + 1,
      last_error: `fail ${index}`,
      next_attempt_at: now + delay * SECOND,
    });
    now += delay * SECOND;
  }
});

test('the twentieth failure gives up and marks the item failed', async () => {
  const item = await queue.enqueue('a', {}, 'k-a', T0);

  let now = T0;
  let last = item;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    await queue.nextDue(now, 10);
    const after = await queue.markAttempt(item.id, false, 'boom', now);
    expect(after).not.toBeNull();
    if (after) last = after;
    now = Math.max(now + 1, last.next_attempt_at);
  }

  expect(MAX_ATTEMPTS).toBe(20);
  expect(last).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS });
  await expect(queue.nextDue(now + 24 * 3600 * SECOND, 10)).resolves.toEqual([]);
});

test('markAttempt returns null for an item that is not there', async () => {
  await expect(queue.markAttempt(999, true, null, T0)).resolves.toBeNull();
});

test('markAttempt does nothing to an item nobody has claimed', async () => {
  const item = await queue.enqueue('a', {}, 'k-a', T0);

  await expect(queue.markAttempt(item.id, false, 'boom', T0)).resolves.toBeNull();

  expect(await queue.get(item.id)).toMatchObject({
    status: 'pending',
    attempts: 0,
    last_error: null,
    next_attempt_at: T0,
  });
});

test('closing the same claim twice does not double-count the attempt', async () => {
  const item = await queue.enqueue('a', {}, 'k-a', T0);
  await queue.nextDue(T0, 10);

  const first = await queue.markAttempt(item.id, false, 'boom', T0);
  const second = await queue.markAttempt(item.id, false, 'boom again', T0);

  expect(first).toMatchObject({ attempts: 1, status: 'pending', last_error: 'boom' });
  expect(second).toBeNull();
  expect(await queue.get(item.id)).toMatchObject({
    attempts: 1,
    status: 'pending',
    last_error: 'boom',
    next_attempt_at: T0 + 30 * SECOND,
  });
});

test('a success reported twice for one claim marks the item done once', async () => {
  const item = await queue.enqueue('a', {}, 'k-a', T0);
  await queue.nextDue(T0, 10);

  await expect(queue.markAttempt(item.id, true, null, T0)).resolves.toMatchObject({
    status: 'done',
    attempts: 0,
  });
  await expect(queue.markAttempt(item.id, true, null, T0)).resolves.toBeNull();
  await expect(queue.markAttempt(item.id, false, 'late failure', T0)).resolves.toBeNull();

  expect(await queue.get(item.id)).toMatchObject({ status: 'done', attempts: 0 });
});

test('closing a claim clears it', async () => {
  const item = await queue.enqueue('a', {}, 'k-a', T0);
  await queue.nextDue(T0, 10);
  expect((await queue.get(item.id))?.claimed_at).toBe(T0);

  await queue.markAttempt(item.id, false, 'boom', T0);

  expect((await queue.get(item.id))?.claimed_at).toBeNull();
});

test('a claim the uploader died holding is handed back after the window', async () => {
  const item = await queue.enqueue('a', {}, 'k-a', T0);
  await queue.nextDue(T0, 10);
  // The uploader is killed here: the item stays 'inflight' with nobody working on it.

  const stillFresh = await queue.nextDue(T0 + RECLAIM_AFTER_S * SECOND - 1, 10);
  expect(stillFresh).toEqual([]);
  expect((await queue.get(item.id))?.status).toBe('inflight');

  const reclaimed = await queue.nextDue(T0 + RECLAIM_AFTER_S * SECOND, 10);
  expect(reclaimed.map((i) => i.id)).toEqual([item.id]);
  expect(reclaimed[0]).toMatchObject({ status: 'inflight', attempts: 0 });
});

test('reclaimInflight leaves the attempt count alone and reports what it recovered', async () => {
  const stale = await queue.enqueue('a', {}, 'k-a', T0);
  await queue.nextDue(T0, 10);
  await queue.markAttempt(stale.id, false, 'boom', T0);
  await queue.nextDue(T0 + 30 * SECOND, 10);
  const fresh = await queue.enqueue('b', {}, 'k-b', T0 + 30 * SECOND);
  await queue.nextDue(T0 + 30 * SECOND, 10);

  // `stale` was claimed at T0 + 30 s along with `fresh`; move past the window for both but
  // ask only for claims older than the remaining gap.
  const now = T0 + 400 * SECOND;
  await expect(queue.reclaimInflight(300, now)).resolves.toBe(2);

  expect(await queue.get(stale.id)).toMatchObject({
    status: 'pending',
    attempts: 1,
    next_attempt_at: now,
    claimed_at: null,
    last_error: 'boom',
  });
  expect(await queue.get(fresh.id)).toMatchObject({ status: 'pending', attempts: 0 });
});

test('reclaimInflight spares a claim inside the window', async () => {
  const item = await queue.enqueue('a', {}, 'k-a', T0);
  await queue.nextDue(T0, 10);

  await expect(queue.reclaimInflight(300, T0 + 299 * SECOND)).resolves.toBe(0);
  expect((await queue.get(item.id))?.status).toBe('inflight');

  await expect(queue.reclaimInflight(300, T0 + 300 * SECOND)).resolves.toBe(1);
  expect((await queue.get(item.id))?.status).toBe('pending');
});

test('get returns the item, or null when it is gone', async () => {
  const item = await queue.enqueue('a', {}, 'k-a', T0);
  expect((await queue.get(item.id))?.idempotency_key).toBe('k-a');
  await expect(queue.get(item.id + 1)).resolves.toBeNull();
});

test('purgeDone drops finished items created before the cutoff', async () => {
  const old = await queue.enqueue('a', {}, 'k-a', T0);
  const fresh = await queue.enqueue('b', {}, 'k-b', T0 + 10_000);
  await queue.nextDue(T0 + 10_000, 10);
  await queue.markAttempt(old.id, true, null, T0 + 10_000);
  await queue.markAttempt(fresh.id, true, null, T0 + 10_000);

  await expect(queue.purgeDone(T0 + 5000)).resolves.toBe(1);
  await expect(queue.get(old.id)).resolves.toBeNull();
  expect((await queue.get(fresh.id))?.status).toBe('done');
});

test('byKey returns the item under an idempotency key, or null', async () => {
  await expect(queue.byKey('trip:a')).resolves.toBeNull();
  const item = await queue.enqueue('finalize-trip', { clientTripId: 'a' }, 'trip:a', T0);
  await expect(queue.byKey('trip:a')).resolves.toEqual(item);
  await expect(queue.byKey('trip:b')).resolves.toBeNull();
});

test('enqueue on a transaction handle joins that transaction instead of opening its own', async () => {
  await expect(
    db.transaction(async (tx) => {
      await queue.enqueue('finalize-trip', { clientTripId: 'a' }, 'trip:a', T0, tx);
      throw new Error('boom');
    })
  ).rejects.toThrow('boom');
  await expect(queue.byKey('trip:a')).resolves.toBeNull();

  const item = await db.transaction((tx) =>
    queue.enqueue('finalize-trip', { clientTripId: 'a' }, 'trip:a', T0, tx)
  );
  expect(item).toMatchObject({ idempotency_key: 'trip:a', status: 'pending' });
  await expect(queue.countByStatus('pending')).resolves.toBe(1);
});
