/** @jest-environment node */
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import type { Db } from '@/data/db/driver';
import { migrate } from '@/data/db/migrate';
import { createQueueRepo, MAX_ATTEMPTS } from '@/data/db/queue';
import { createSettingsRepo, type SettingsRepo } from '@/data/db/settings';
import { createTripsRepo } from '@/data/db/trips';
import type { TripStatus } from '@/data/db/types';
import { LAST_UPSERT_KEY } from '@/data/devices/register';
import {
  computeWatermark,
  createWatermarkWriter,
  crossesSettleBoundary,
  WATERMARK_MIN_STEP_MS,
  WATERMARK_WRITTEN_KEY,
  watermarkClientFor,
  type WatermarkClient,
} from '@/data/devices/syncWatermark';

const OWNER = 'user-1';
const DEVICE = 'install-0001';
const TZ = 'America/Los_Angeles';
/** 2026-09-22 10:00 PDT. */
const T0 = Date.parse('2026-09-22T17:00:00Z');
const HOUR = 3_600_000;

let db: Db;
let settings: SettingsRepo;

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
  settings = createSettingsRepo(db);
});

async function enqueue(kind: string, key: string, status: 'pending' | 'inflight' | 'failed' | 'done' = 'pending', nextAttemptAt = T0) {
  await createQueueRepo(db).enqueue(kind, {}, key, T0, undefined, OWNER);
  await db.execute('UPDATE sync_queue SET status = ?, next_attempt_at = ? WHERE idempotency_key = ?', [
    status,
    nextAttemptAt,
    key,
  ]);
}

async function trip(status: TripStatus, id = 'trip-1') {
  await createTripsRepo(db).insert({ client_trip_id: id, started_at: T0 - HOUR, tz: TZ, status }, T0);
}

/** A double of the one `devices` update the writer sends. */
function fakeClient(opts: { fail?: 'error' | 'throw' | 'no-row' | 'hang' } = {}) {
  const writes: { patch: Record<string, unknown>; filters: [string, unknown][]; aborted?: boolean }[] = [];
  const state = { fail: opts.fail };
  const client: WatermarkClient = {
    updateDevice({ userId, deviceId, patch, signal }) {
      const write = {
        patch: patch as Record<string, unknown>,
        filters: [
          ['user_id', userId],
          ['id', deviceId],
        ] as [string, unknown][],
        aborted: false,
      };
      writes.push(write);
      if (state.fail === 'throw') return Promise.reject(new Error('fetch failed'));
      if (state.fail === 'hang') {
        return new Promise((resolve) => {
          signal?.addEventListener('abort', () => {
            write.aborted = true;
            resolve({ data: null, error: { message: 'aborted' } });
          });
        });
      }
      if (state.fail === 'error') return Promise.resolve({ data: null, error: { code: '42501' } });
      if (state.fail === 'no-row') return Promise.resolve({ data: [], error: null });
      return Promise.resolve({ data: [{ id: DEVICE }], error: null });
    },
  };
  return { client, writes, state };
}

function writer(
  client: WatermarkClient,
  over: { now?: () => number; owner?: string | null; deviceId?: string | null; budgetMs?: number; drainBudgetMs?: number } = {}
) {
  const errors: string[] = [];
  const w = createWatermarkWriter({
    db,
    supabase: client,
    settings,
    readOwner: async () => (over.owner === undefined ? OWNER : over.owner),
    deviceId: async () => (over.deviceId === undefined ? DEVICE : over.deviceId),
    now: over.now ?? (() => T0),
    tz: () => TZ,
    signOutBudgetMs: over.budgetMs,
    drainBudgetMs: over.drainBudgetMs,
    onError: (_e, context) => errors.push(context),
  });
  return { w, errors };
}

describe('computeWatermark: the drain was clean', () => {
  test('an empty queue and no open trip: the drain start', async () => {
    await expect(computeWatermark(db, T0)).resolves.toBe(T0);
  });

  test.each(['finalize-trip', 'set-role', 'dispute'])('a pending %s item holds it', async (kind) => {
    await enqueue(kind, `k-${kind}`);
    await expect(computeWatermark(db, T0)).resolves.toBeNull();
  });

  test.each(['finalize-trip', 'set-role', 'dispute'])('an in-flight %s item holds it', async (kind) => {
    await enqueue(kind, `k-${kind}`, 'inflight');
    await expect(computeWatermark(db, T0)).resolves.toBeNull();
  });

  test('an item whose retries ran out holds it (the next reconnect reopens it)', async () => {
    await enqueue('finalize-trip', 'k1', 'failed', T0 + 60_000);
    await expect(computeWatermark(db, T0)).resolves.toBeNull();
  });

  test('an item the server refused for good does not (the 72 h cap covers it)', async () => {
    await enqueue('finalize-trip', 'k1', 'failed', Number.MAX_SAFE_INTEGER);
    await expect(computeWatermark(db, T0)).resolves.toBe(T0);
  });

  test('a pending trace-upload or delete-trip alone does not hold it', async () => {
    await enqueue('trace-upload', 'k1');
    await enqueue('delete-trip', 'k2');
    await expect(computeWatermark(db, T0)).resolves.toBe(T0);
  });

  test('done items do not hold it', async () => {
    await enqueue('finalize-trip', 'k1', 'done');
    await expect(computeWatermark(db, T0)).resolves.toBe(T0);
  });

  test('an open local trip holds it; a finalized one does not', async () => {
    await trip('recording');
    await expect(computeWatermark(db, T0)).resolves.toBeNull();
    await createTripsRepo(db).update('trip-1', { status: 'provisional' }, T0);
    await expect(computeWatermark(db, T0)).resolves.toBe(T0);
  });

  test('MAX_ATTEMPTS is a real ceiling, so an exhausted item is a failed one (sanity)', () => {
    expect(MAX_ATTEMPTS).toBeGreaterThan(0);
  });
});

describe('crossesSettleBoundary: 02:00 local', () => {
  const at = (iso: string) => Date.parse(iso);
  test.each([
    ['01:59 → 02:00 PDT', '2026-09-22T08:59:00Z', '2026-09-22T09:00:00Z', true],
    ['02:00 → 23:00 the same day', '2026-09-22T09:00:00Z', '2026-09-23T06:00:00Z', false],
    ['23:00 → 01:00 the next day (no 02:00 between)', '2026-09-23T06:00:00Z', '2026-09-23T08:00:00Z', false],
    ['23:00 → 03:00 the next day', '2026-09-23T06:00:00Z', '2026-09-23T10:00:00Z', true],
    // 2027-03-14: 02:00 PST does not exist; 01:59 PST is followed by 03:00 PDT.
    ['spring forward: 01:30 PST → 03:05 PDT', '2027-03-14T09:30:00Z', '2027-03-14T10:05:00Z', true],
  ])('%s', (_label, from, to, expected) => {
    expect(crossesSettleBoundary(at(from), at(to), TZ)).toBe(expected);
  });
});

describe('onCleanDrain', () => {
  test('a clean drain PATCHes synced_through on the stored owner\'s own row', async () => {
    const { client, writes } = fakeClient();
    const { w } = writer(client);
    await w.onCleanDrain(T0);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.patch).toEqual({ synced_through: new Date(T0).toISOString() });
    expect(writes[0]?.filters).toEqual([
      ['user_id', OWNER],
      ['id', DEVICE],
    ]);
    expect(await settings.get(WATERMARK_WRITTEN_KEY)).toEqual({ uid: OWNER, deviceId: DEVICE, at: T0 });
  });

  test('a drain leaving a retryable finalize-trip item writes nothing', async () => {
    await enqueue('finalize-trip', 'k1');
    const { client, writes } = fakeClient();
    await writer(client).w.onCleanDrain(T0);
    expect(writes).toEqual([]);
  });

  test('an open trip writes nothing', async () => {
    await trip('recording');
    const { client, writes } = fakeClient();
    await writer(client).w.onCleanDrain(T0);
    expect(writes).toEqual([]);
  });

  test('a pending trace-upload alone still writes', async () => {
    await enqueue('trace-upload', 'k1');
    const { client, writes } = fakeClient();
    await writer(client).w.onCleanDrain(T0);
    expect(writes).toHaveLength(1);
  });

  test('throttled to about hourly: < 1 h later nothing, ≥ 1 h later a write', async () => {
    const { client, writes } = fakeClient();
    const { w } = writer(client);
    await w.onCleanDrain(T0);
    await w.onCleanDrain(T0 + WATERMARK_MIN_STEP_MS - 1);
    expect(writes).toHaveLength(1);
    await w.onCleanDrain(T0 + WATERMARK_MIN_STEP_MS);
    expect(writes).toHaveLength(2);
  });

  test('a 02:00 local boundary between them writes before the hour is up', async () => {
    const before = Date.parse('2026-09-23T08:50:00Z'); // 01:50 PDT
    const after = Date.parse('2026-09-23T09:05:00Z'); // 02:05 PDT
    const { client, writes } = fakeClient();
    const { w } = writer(client);
    await w.onCleanDrain(before);
    await w.onCleanDrain(after);
    expect(writes).toHaveLength(2);
  });

  test('the throttle is per account: another owner writes at once', async () => {
    const { client, writes } = fakeClient();
    await writer(client).w.onCleanDrain(T0);
    await writer(client, { owner: 'user-2' }).w.onCleanDrain(T0 + 60_000);
    expect(writes).toHaveLength(2);
    expect(writes[1]?.filters).toContainEqual(['user_id', 'user-2']);
  });

  test('a clock that moved back does not keep the throttle shut', async () => {
    const { client, writes } = fakeClient();
    const { w } = writer(client);
    await w.onCleanDrain(T0);
    await w.onCleanDrain(T0 - 10 * 60_000);
    expect(writes).toHaveLength(2);
  });

  test('the owner comes from storage, never the network session; none → nothing', async () => {
    const { client, writes } = fakeClient();
    await writer(client, { owner: null }).w.onCleanDrain(T0);
    expect(writes).toEqual([]);
    // The client double has no `auth` at all: a getSession() call would throw.
    expect((client as unknown as { auth?: unknown }).auth).toBeUndefined();
  });

  test('no install id: nothing', async () => {
    const { client, writes } = fakeClient();
    await writer(client, { deviceId: null }).w.onCleanDrain(T0);
    expect(writes).toEqual([]);
  });

  test.each(['error', 'throw', 'no-row'] as const)('a %s is swallowed and not stamped, so the next drain tries again', async (fail) => {
    const { client, writes, state } = fakeClient({ fail });
    const { w, errors } = writer(client);
    await expect(w.onCleanDrain(T0)).resolves.toBeUndefined();
    expect(errors).toEqual(['sync watermark']);
    expect(await settings.get(WATERMARK_WRITTEN_KEY)).toBeNull();
    state.fail = undefined;
    await w.onCleanDrain(T0 + 60_000);
    expect(writes).toHaveLength(2);
  });
});

test('onCleanDrain: a hung request is abandoned within its budget, unstamped (the runner awaits it)', async () => {
  const { client, writes } = fakeClient({ fail: 'hang' });
  const started = Date.now();
  await writer(client, { drainBudgetMs: 50 }).w.onCleanDrain(T0);
  expect(Date.now() - started).toBeLessThan(1000);
  expect(writes[0]?.aborted).toBe(true);
  expect(await settings.get(WATERMARK_WRITTEN_KEY)).toBeNull();
});

describe('onSignOut (rev2: m1a)', () => {
  test('nothing pending: writes signed_out_at = now on the owner\'s row, clears the stamps', async () => {
    await settings.set(WATERMARK_WRITTEN_KEY, { uid: OWNER, deviceId: DEVICE, at: T0 - HOUR });
    await settings.set(LAST_UPSERT_KEY, { userId: OWNER, deviceId: DEVICE, at: T0 - HOUR });
    const { client, writes } = fakeClient();
    await writer(client).w.onSignOut();
    expect(writes).toHaveLength(1);
    expect(writes[0]?.patch).toEqual({ signed_out_at: new Date(T0).toISOString() });
    expect(writes[0]?.filters).toEqual([
      ['user_id', OWNER],
      ['id', DEVICE],
    ]);
    // Signing back in re-enrols at once: the next upsert and the next drain are not throttled.
    expect(await settings.get(WATERMARK_WRITTEN_KEY)).toBeNull();
    expect(await settings.get(LAST_UPSERT_KEY)).toBeNull();
  });

  test('a pending finalize-trip item: nothing is written (the 72 h cap bounds the hold)', async () => {
    await enqueue('finalize-trip', 'k1');
    const { client, writes } = fakeClient();
    await writer(client).w.onSignOut();
    expect(writes).toEqual([]);
  });

  test('an open trip: nothing is written', async () => {
    await trip('recording');
    const { client, writes } = fakeClient();
    await writer(client).w.onSignOut();
    expect(writes).toEqual([]);
  });

  test('a failure is swallowed', async () => {
    const { client } = fakeClient({ fail: 'throw' });
    const { w, errors } = writer(client);
    await expect(w.onSignOut()).resolves.toBeUndefined();
    expect(errors).toEqual(['sync watermark sign-out']);
  });

  test('a hung request is abandoned within its budget', async () => {
    const { client, writes } = fakeClient({ fail: 'hang' });
    const started = Date.now();
    await writer(client, { budgetMs: 50 }).w.onSignOut();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(writes[0]?.aborted).toBe(true);
  });

  test('the default budget is the sign-out\'s 2 s', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { SIGN_OUT_BUDGET_MS } = require('@/data/devices/syncWatermark') as typeof import('@/data/devices/syncWatermark');
    expect(SIGN_OUT_BUDGET_MS).toBe(2000);
  });
});

test('watermarkClientFor adapts the app client: update, both filters, select, and the abort signal', async () => {
  const calls: unknown[][] = [];
  const query = {
    eq: (...args: unknown[]) => (calls.push(['eq', ...args]), query),
    select: (...args: unknown[]) => (calls.push(['select', ...args]), query),
    abortSignal: (...args: unknown[]) => (calls.push(['abortSignal']), Promise.resolve({ data: args.length, error: null })),
    then: (resolve: (v: unknown) => unknown) => resolve({ data: [{ id: DEVICE }], error: null }),
  };
  const app = {
    from: (table: string) => (calls.push(['from', table]), { update: (p: unknown) => (calls.push(['update', p]), query) }),
  } as unknown as import('@/data/devices/register').DevicesClient;
  const seam = watermarkClientFor(app);
  await seam.updateDevice({ userId: OWNER, deviceId: DEVICE, patch: { synced_through: 'x' } });
  expect(calls).toEqual([
    ['from', 'devices'],
    ['update', { synced_through: 'x' }],
    ['eq', 'user_id', OWNER],
    ['eq', 'id', DEVICE],
    ['select', 'id'],
  ]);
  calls.length = 0;
  await seam.updateDevice({ userId: OWNER, deviceId: DEVICE, patch: { signed_out_at: 'y' }, signal: new AbortController().signal });
  expect(calls.at(-1)).toEqual(['abortSignal']);
});
