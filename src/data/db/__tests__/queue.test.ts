/** @jest-environment node */
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import type { Db } from '@/data/db/driver';
import { migrate } from '@/data/db/migrate';
import { createEventsRepo } from '@/data/db/events';
import {
  backoffSeconds,
  createQueueRepo,
  MAX_ATTEMPTS,
  RECLAIM_AFTER_S,
  SERVER_REOPEN_AFTER_MS,
} from '@/data/db/queue';
import { createTripsRepo } from '@/data/db/trips';
import { eventRow, tripRow } from '@/data/queries/__fixtures__/rows';
import { RETRIES_EXHAUSTED } from '@/data/sync/actions';

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

test('release hands a claim back without counting an attempt', async () => {
  const item = await queue.enqueue('trace-upload', { n: 1 }, 'trace:a', T0);
  await queue.nextDue(T0);

  const released = await queue.release(item.id, T0 + 900 * SECOND);
  expect(released).toMatchObject({
    status: 'pending',
    attempts: 0,
    claimed_at: null,
    next_attempt_at: T0 + 900 * SECOND,
  });
  // Only the pass holding the claim may release it.
  await expect(queue.release(item.id, T0)).resolves.toBeNull();
});

test('deferUntil pushes the next try out, never in', async () => {
  const item = await queue.enqueue('finalize-trip', { n: 1 }, 'trip:a', T0);
  await queue.nextDue(T0);
  await queue.markAttempt(item.id, false, 'http_503', T0);
  const backedOff = T0 + backoffSeconds(0) * SECOND;

  await expect(queue.deferUntil(item.id, T0 + 120 * SECOND)).resolves.toMatchObject({
    next_attempt_at: T0 + 120 * SECOND,
  });
  // A Retry-After shorter than the ladder is ignored.
  await expect(queue.deferUntil(item.id, backedOff)).resolves.toBeNull();
  expect((await queue.get(item.id))?.next_attempt_at).toBe(T0 + 120 * SECOND);
});

test('markFailed gives up on an item, but never stomps a fresh claim', async () => {
  const item = await queue.enqueue('finalize-trip', { n: 1 }, 'trip:a', T0);
  await queue.nextDue(T0);

  // Guarded: the item is still inflight, so there is nothing to give up on yet.
  await expect(queue.markFailed(item.id, 'implausible_speed')).resolves.toBeNull();

  await queue.markAttempt(item.id, false, 'implausible_speed', T0);
  await expect(queue.markFailed(item.id, 'implausible_speed')).resolves.toMatchObject({
    status: 'failed',
    attempts: 1,
    last_error: 'implausible_speed',
    claimed_at: null,
  });
});

test('markTraceUploaded records the object once and keeps the first time', async () => {
  const item = await queue.enqueue('finalize-trip', { n: 1 }, 'trip:a', T0);
  expect(item.trace_uploaded_at).toBeNull();

  await expect(queue.markTraceUploaded(item.id, T0)).resolves.toMatchObject({
    trace_uploaded_at: T0,
  });
  // A later attempt does not move the mark: the object went up when it went up.
  await expect(queue.markTraceUploaded(item.id, T0 + 60 * SECOND)).resolves.toMatchObject({
    trace_uploaded_at: T0,
  });
  // It survives a failed attempt, which is the whole point of storing it on the row.
  await queue.nextDue(T0);
  await queue.markAttempt(item.id, false, 'network', T0);
  expect((await queue.get(item.id))?.trace_uploaded_at).toBe(T0);
});

// ---------------------------------------------------------------------------------------------
// reopenRetryable (plan D2): what an offline -> online transition puts back in the queue
// ---------------------------------------------------------------------------------------------

/** Walk an item down the whole ladder, as a device offline for days does. */
async function exhaust(id: number, code = 'network'): Promise<void> {
  const kind = (await queue.get(id))?.kind ?? '';
  for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
    await queue.nextDueOfKind(kind, T0 + i);
    await queue.markAttempt(id, false, code, T0 + i);
  }
}

/** A terminal refusal as the runner records one: the attempt closed, then given up. */
async function refuse(id: number, code: string, at = T0): Promise<void> {
  const kind = (await queue.get(id))?.kind ?? '';
  await queue.nextDueOfKind(kind, at);
  await queue.markAttempt(id, false, code, at);
  await queue.markFailed(id, code);
}

describe('reopenRetryable', () => {
  test('an exhausted ladder goes back to pending with a clean ladder, due now', async () => {
    await createTripsRepo(db).insert(tripRow({ client_trip_id: 'a' }), T0);
    const item = await queue.enqueue('finalize-trip', { clientTripId: 'a' }, 'trip:a', T0, undefined, 'u1');
    await exhaust(item.id);
    expect(await queue.get(item.id)).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS });

    const later = T0 + 7 * 24 * 3600 * SECOND;
    await expect(queue.reopenRetryable(later)).resolves.toBe(1);

    expect(await queue.get(item.id)).toMatchObject({
      status: 'pending',
      attempts: 0,
      next_attempt_at: later,
      last_error: null,
      claimed_at: null,
      owner_uid: 'u1',
    });
    expect((await queue.nextDue(later)).map((i) => i.id)).toEqual([item.id]);
  });

  test('a 4xx refusal stays failed: retrying sends the same bytes to the same answer', async () => {
    const item = await queue.enqueue('finalize-trip', { clientTripId: 'a' }, 'trip:a', T0);
    await refuse(item.id, 'implausible_speed');

    await expect(queue.reopenRetryable(T0 + 1)).resolves.toBe(0);
    expect(await queue.get(item.id)).toMatchObject({
      status: 'failed',
      last_error: 'implausible_speed',
    });
  });

  test('a refusal that arrives on the last rung is still a refusal, not an exhausted ladder', async () => {
    const item = await queue.enqueue('dispute', { clientEventId: 'e1' }, 'dispute:e1', T0);
    // Nineteen retryable failures, then the server decides against it on the twentieth.
    for (let i = 0; i < MAX_ATTEMPTS - 1; i += 1) {
      await queue.nextDueOfKind('dispute', T0 + i);
      await queue.markAttempt(item.id, false, 'http_503', T0 + i);
    }
    await refuse(item.id, 'dispute_window_closed', T0 + 100);
    expect(await queue.get(item.id)).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS });

    await expect(queue.reopenRetryable(T0 + 200)).resolves.toBe(0);
    expect((await queue.get(item.id))?.status).toBe('failed');
  });

  test('pending, in-flight, backed-off and done items are left exactly as they are', async () => {
    const done = await queue.enqueue('a', {}, 'k-done', T0 - 2);
    const inflight = await queue.enqueue('a', {}, 'k-inflight', T0 - 1);
    await queue.nextDue(T0, 2);
    await queue.markAttempt(done.id, true, null, T0);
    const pending = await queue.enqueue('a', {}, 'k-pending', T0);
    const backedOff = await queue.enqueue('b', {}, 'k-backoff', T0);
    await queue.nextDueOfKind('b', T0);
    await queue.markAttempt(backedOff.id, false, 'network', T0);
    const ids = [pending, inflight, done, backedOff].map((i) => i.id);
    const before = await Promise.all(ids.map((id) => queue.get(id)));
    expect(before.map((i) => i?.status)).toEqual(['pending', 'inflight', 'done', 'pending']);

    await expect(queue.reopenRetryable(T0 + 1)).resolves.toBe(0);

    expect(await Promise.all(ids.map((id) => queue.get(id)))).toEqual(before);
  });

  test('the trip of a reopened upload, role answer or delete stops saying it failed', async () => {
    const trips = createTripsRepo(db);
    const failed = { sync_state: 'failed' as const, sync_error: RETRIES_EXHAUSTED };
    await trips.insert(tripRow({ client_trip_id: 'up', ...failed }), T0);
    await trips.insert(tripRow({ client_trip_id: 'role', ...failed }), T0);
    await trips.insert(tripRow({ client_trip_id: 'del', ...failed }), T0);
    // Refused for good: its trip keeps the reason the server gave.
    await trips.insert(
      tripRow({ client_trip_id: 'bad', sync_state: 'failed', sync_error: 'implausible_speed' }),
      T0
    );

    const up = await queue.enqueue('finalize-trip', { clientTripId: 'up' }, 'trip:up', T0);
    const role = await queue.enqueue('set-role', { clientTripId: 'role' }, 'role:role', T0);
    const del = await queue.enqueue('delete-trip', { clientTripId: 'del' }, 'delete:del', T0);
    const bad = await queue.enqueue('finalize-trip', { clientTripId: 'bad' }, 'trip:bad', T0);
    for (const item of [up, role, del]) await exhaust(item.id);
    await refuse(bad.id, 'implausible_speed');

    await expect(queue.reopenRetryable(T0 + 1000)).resolves.toBe(3);

    for (const id of ['up', 'role', 'del']) {
      expect(await trips.get(id)).toMatchObject({ sync_state: 'queued', sync_error: null });
    }
    expect(await trips.get('bad')).toMatchObject({
      sync_state: 'failed',
      sync_error: 'implausible_speed',
    });
  });

  test('a trip whose failure came from somewhere else is not touched by a reopened item', async () => {
    const trips = createTripsRepo(db);
    // The upload was refused for good; a later role answer on the same trip ran out of retries.
    await trips.insert(
      tripRow({ client_trip_id: 't', sync_state: 'failed', sync_error: 'implausible_speed' }),
      T0
    );
    const role = await queue.enqueue('set-role', { clientTripId: 't' }, 'role:t', T0);
    await exhaust(role.id);

    await queue.reopenRetryable(T0 + 1000);
    expect(await trips.get('t')).toMatchObject({
      sync_state: 'failed',
      sync_error: 'implausible_speed',
    });
  });

  test('a reopened report goes back to "sending" on its event', async () => {
    await createTripsRepo(db).insert(tripRow({ client_trip_id: 'trip-1', sync_state: 'synced' }), T0);
    const refused = {
      reason: 'wrong_limit',
      note: null,
      statedLimitMph: 35,
      submittedAt: T0,
      outcome: 'refused',
      deniedReason: null,
      remainingAllowance: null,
      code: RETRIES_EXHAUSTED,
      decidedAt: T0 + 5000,
    };
    await createEventsRepo(db).insertMany([
      eventRow({ id: 'e1', status: 'scored', dispute_json: JSON.stringify(refused) }),
      // Refused by the server for good: stays as it is.
      eventRow({
        id: 'e2',
        status: 'scored',
        dispute_json: JSON.stringify({
          ...refused,
          code: 'dispute_window_closed',
          outcome: 'window_closed',
        }),
      }),
    ]);
    const e1 = await queue.enqueue('dispute', { clientEventId: 'e1' }, 'dispute:e1', T0);
    const e2 = await queue.enqueue('dispute', { clientEventId: 'e2' }, 'dispute:e2', T0);
    await exhaust(e1.id);
    await refuse(e2.id, 'dispute_window_closed');

    await expect(queue.reopenRetryable(T0 + 1000)).resolves.toBe(1);

    const events = createEventsRepo(db);
    const one = await events.get('e1');
    expect(one?.status).toBe('disputed');
    expect(JSON.parse(one?.dispute_json ?? 'null')).toEqual({
      ...refused,
      outcome: 'queued',
      code: null,
      decidedAt: null,
    });
    const two = await events.get('e2');
    expect(two?.status).toBe('scored');
    expect(JSON.parse(two?.dispute_json ?? 'null').outcome).toBe('window_closed');
  });

  test('an item whose trip or event is gone stays failed (security review D2 I-1)', async () => {
    await createTripsRepo(db).insert(tripRow({ client_trip_id: 'kept' }), T0);
    await createEventsRepo(db).insertMany([eventRow({ id: 'e-kept', client_trip_id: 'kept' })]);
    const items = [
      await queue.enqueue('dispute', { clientEventId: 'e-gone', note: 'private words' }, 'dispute:e-gone', T0),
      await queue.enqueue('set-role', { clientTripId: 'gone' }, 'role:gone:1', T0),
      await queue.enqueue('finalize-trip', { clientTripId: 'gone' }, 'trip:gone', T0),
      await queue.enqueue('dispute', { clientEventId: 'e-kept' }, 'dispute:e-kept', T0),
      await queue.enqueue('set-role', { clientTripId: 'kept' }, 'role:kept:1', T0),
    ];
    for (const item of items) await exhaust(item.id);

    await expect(queue.reopenRetryable(T0 + 1000)).resolves.toBe(2);

    const status = async (key: string) => (await queue.byKey(key))?.status;
    expect(await status('dispute:e-gone')).toBe('failed');
    expect(await status('role:gone:1')).toBe('failed');
    expect(await status('trip:gone')).toBe('failed');
    expect(await status('dispute:e-kept')).toBe('pending');
    expect(await status('role:kept:1')).toBe('pending');
  });

  test('a delete-trip item is reopened even though its trip row is a husk or gone: the server still has to hear it', async () => {
    const item = await queue.enqueue('delete-trip', { clientTripId: 'husk' }, 'delete:husk', T0);
    await exhaust(item.id);
    await expect(queue.reopenRetryable(T0 + 1000)).resolves.toBe(1);
  });

  test('review D2 m1: an item that ran out on server answers waits a day after giving up; a transport failure does not', async () => {
    await createTripsRepo(db).insert(tripRow({ client_trip_id: 'net' }), T0);
    await createTripsRepo(db).insert(tripRow({ client_trip_id: 'srv' }), T0);
    const net = await queue.enqueue('finalize-trip', { clientTripId: 'net' }, 'trip:net', T0);
    const srv = await queue.enqueue('finalize-trip', { clientTripId: 'srv' }, 'trip:srv', T0);
    await exhaust(net.id, 'network');
    await exhaust(srv.id, 'http_503');
    const gaveUpAt = (await queue.get(srv.id))!.next_attempt_at;

    await expect(queue.reopenRetryable(gaveUpAt + 60_000)).resolves.toBe(1);
    expect((await queue.get(net.id))?.status).toBe('pending');
    expect((await queue.get(srv.id))?.status).toBe('failed');

    await expect(queue.reopenRetryable(gaveUpAt + SERVER_REOPEN_AFTER_MS)).resolves.toBe(1);
    expect((await queue.get(srv.id))?.status).toBe('pending');
  });

  test('review D2 m2: a reopened role answer does not say "queued" over an upload the server refused', async () => {
    const trips = createTripsRepo(db);
    await trips.insert(tripRow({ client_trip_id: 't', sync_state: 'failed', sync_error: RETRIES_EXHAUSTED }), T0);
    const up = await queue.enqueue('finalize-trip', { clientTripId: 't' }, 'trip:t', T0);
    await refuse(up.id, 'implausible_speed');
    const role = await queue.enqueue('set-role', { clientTripId: 't' }, 'role:t:1', T0);
    await exhaust(role.id);

    await expect(queue.reopenRetryable(T0 + 1000)).resolves.toBe(1);
    expect(await trips.get('t')).toMatchObject({ sync_state: 'failed' });
  });

  test('sweepOrphanedReports drops reports and role answers whose event or trip is gone, and nothing else', async () => {
    await createTripsRepo(db).insert(tripRow({ client_trip_id: 'kept' }), T0);
    await createEventsRepo(db).insertMany([eventRow({ id: 'e-kept', client_trip_id: 'kept' })]);
    await queue.enqueue('dispute', { clientEventId: 'e-gone', note: 'private words' }, 'dispute:e-gone', T0);
    await queue.enqueue('set-role', { clientTripId: 'gone' }, 'role:gone:1', T0);
    await queue.enqueue('dispute', { clientEventId: 'e-kept' }, 'dispute:e-kept', T0);
    await queue.enqueue('set-role', { clientTripId: 'kept' }, 'role:kept:1', T0);
    // Not a report: the delete of a gone drive must still reach the server.
    await queue.enqueue('delete-trip', { clientTripId: 'gone' }, 'delete:gone', T0);

    await expect(queue.sweepOrphanedReports()).resolves.toBe(2);

    const { rows } = await db.execute('SELECT idempotency_key FROM sync_queue ORDER BY idempotency_key');
    expect(rows.map((r) => r.idempotency_key)).toEqual(['delete:gone', 'dispute:e-kept', 'role:kept:1']);
  });

  test('an item whose body this build cannot read is still reopened, and touches no row', async () => {
    const item = await queue.enqueue('finalize-trip', 'not an object', 'trip:odd', T0);
    await exhaust(item.id);
    await expect(queue.reopenRetryable(T0 + 1000)).resolves.toBe(1);
  });
});
