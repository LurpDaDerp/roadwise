/** @jest-environment node */
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import type { Db } from '@/data/db/driver';
import { createEventsRepo } from '@/data/db/events';
import { migrate } from '@/data/db/migrate';
import { createQueueRepo } from '@/data/db/queue';
import { createScoreDailyCacheRepo } from '@/data/db/scoreDailyCache';
import { createTripsRepo } from '@/data/db/trips';
import type { DisputeRecord, EventRow, TripRow } from '@/data/db/types';
import {
  ACTION_HANDLERS,
  isActionKind,
  runDeleteTrip,
  runDispute,
  runSetRole,
  TRIP_ACTIONS_FUNCTION,
  type ActionContext,
} from '@/data/sync/actions';
import {
  createFakeAppState,
  createFakeFs,
  createFakeSupabase,
  functionsFetchError,
  functionsHttpError,
  type FakeSupabase,
  type SupabaseReply,
} from '@/data/sync/__fixtures__/fakes';
import { SYNC_KINDS } from '@/data/sync/kinds';
import { createSyncRunner } from '@/data/sync/runner';

const T0 = Date.UTC(2026, 0, 5, 12, 0, 0);
const NOW = T0 + 3_600_000;
const TRIP = 'trip-1';
const EVENT = 'event-1';
const SERVER_TRIP = '11111111-2222-4333-8444-555555555555';

const day = (over: Partial<Record<string, unknown>> = {}) => ({
  day: '2026-01-05',
  longTermScore: 84,
  band: 'good',
  provisional: false,
  safeDay: true,
  goodDay: false,
  phoneFreeDay: false,
  cameraDay: false,
  exposure: 1,
  drivingS: 1800,
  tripsScored: 1,
  severeEvents: 0,
  ...over,
});

let db: Db;
let supabase: FakeSupabase;

const tripRow = (over: Partial<TripRow> = {}): TripRow =>
  ({
    client_trip_id: TRIP,
    started_at: T0,
    ended_at: T0 + 1_800_000,
    tz: 'UTC',
    distance_m: 16_093,
    duration_s: 1800,
    role: 'driver',
    role_confidence: null,
    role_source: null,
    mode: null,
    camera_session: 0,
    score: 77,
    scoring_version: '1',
    category_deductions_json: JSON.stringify({ speeding: 6 }),
    exposure: 1,
    data_quality: 'A',
    conditions_json: JSON.stringify({ night: false, precipitation: false, hadSevereEvent: true }),
    limit_coverage_pct: 80,
    start_label: null,
    end_label: null,
    start_geohash5: null,
    end_geohash5: null,
    polyline: null,
    status: 'provisional',
    sync_state: 'queued',
    checkpoint_ts: null,
    incomplete: 0,
    server_id: null,
    sync_error: null,
    deleted_at: null,
    created_at: T0,
    updated_at: T0,
    ...over,
  }) as TripRow;

const eventRow = (over: Partial<EventRow> = {}): EventRow =>
  ({
    id: EVENT,
    client_trip_id: TRIP,
    category: 'speeding',
    started_at: T0 + 60_000,
    duration_s: 38,
    lat: 45.5,
    lng: -122.6,
    measured_json: JSON.stringify({ speedMps: 21, limitMps: 15.6, overMps: 5.4 }),
    severity: '3.5',
    confidence: 0.9,
    context_json: JSON.stringify({ night: false, precipitation: false }),
    deduction: 6,
    alert_shown: 1,
    corrected: 0,
    status: 'scored',
    source: 'gnss',
    dispute_json: null,
    ...over,
  }) as EventRow;

async function seed(trip: Partial<TripRow> = {}, event: Partial<EventRow> | null = {}) {
  await createTripsRepo(db).insert(tripRow(trip), T0);
  if (event !== null) await createEventsRepo(db).insert(eventRow(event));
}

const ctx = (over: Partial<ActionContext> = {}): ActionContext => ({
  db,
  supabase,
  now: NOW,
  ...over,
});

const disputeBody = JSON.stringify({
  action: 'dispute',
  clientEventId: EVENT,
  reason: 'hazard',
});
const setRoleBody = JSON.stringify({ action: 'set-role', clientTripId: TRIP, role: 'passenger' });
const deleteBody = JSON.stringify({ action: 'delete', clientTripId: TRIP });

const disputeReply = (over: Record<string, unknown> = {}): SupabaseReply => ({
  data: {
    tripId: SERVER_TRIP,
    score: 85,
    status: 'final',
    autoAccepted: true,
    remainingAllowance: 2,
    reason: null,
    hadSevereEvent: false,
    days: [day()],
    replayed: false,
    ...over,
  },
  error: null,
});

const readEvent = async (): Promise<EventRow> => {
  const row = await createEventsRepo(db).get(EVENT);
  if (!row) throw new Error('no event');
  return row;
};
const readTrip = async (): Promise<TripRow> => {
  const row = await createTripsRepo(db).get(TRIP);
  if (!row) throw new Error('no trip');
  return row;
};
const readDispute = async (): Promise<DisputeRecord> =>
  JSON.parse((await readEvent()).dispute_json ?? 'null') as DisputeRecord;

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
  supabase = createFakeSupabase();
});

test('every queue kind that is not a trip or a trace is an action, and each has a handler', () => {
  const actions = SYNC_KINDS.filter(isActionKind);
  expect(actions).toEqual(['dispute', 'set-role', 'delete-trip']);
  for (const kind of actions) expect(typeof ACTION_HANDLERS[kind]).toBe('function');
});

describe('reporting an event', () => {
  test('sends the queued body verbatim to trip-actions and nothing else', async () => {
    await seed();
    supabase = createFakeSupabase({ invoke: () => disputeReply() });

    await expect(runDispute(disputeBody, ctx())).resolves.toEqual({ kind: 'done' });

    expect(supabase.invokes).toEqual([
      {
        name: TRIP_ACTIONS_FUNCTION,
        body: { action: 'dispute', clientEventId: EVENT, reason: 'hazard' },
      },
    ]);
  });

  test('an accepted report removes the event from the score and re-scores the drive', async () => {
    await seed();
    supabase = createFakeSupabase({ invoke: () => disputeReply() });

    await expect(runDispute(disputeBody, ctx())).resolves.toEqual({ kind: 'done' });

    expect(await readEvent()).toMatchObject({ status: 'removed', deduction: 0, corrected: 1 });
    expect(await readTrip()).toMatchObject({
      server_id: SERVER_TRIP,
      score: 85,
      status: 'final',
      sync_state: 'synced',
    });
    expect(await readDispute()).toMatchObject({
      reason: 'hazard',
      outcome: 'accepted',
      remainingAllowance: 2,
      deniedReason: null,
      decidedAt: NOW,
    });
  });

  test("the server's severe-speeding verdict replaces the device's, and the rest of the conditions stay", async () => {
    await seed();
    supabase = createFakeSupabase({ invoke: () => disputeReply() });

    await runDispute(disputeBody, ctx());

    expect(JSON.parse((await readTrip()).conditions_json ?? '{}')).toEqual({
      night: false,
      precipitation: false,
      hadSevereEvent: false,
    });
  });

  test('every day the server recomputed lands in the cache, whatever the outcome', async () => {
    await seed();
    supabase = createFakeSupabase({
      invoke: () => disputeReply({ days: [day(), day({ day: '2026-01-06', safeDay: false })] }),
    });

    await runDispute(disputeBody, ctx());

    const cached = await createScoreDailyCacheRepo(db).range<{ safeDay: boolean }>(
      '2026-01-01',
      '2026-01-31'
    );
    expect(cached.map((entry) => entry.day)).toEqual(['2026-01-05', '2026-01-06']);
    expect(cached[0]?.payload.safeDay).toBe(true);
    expect(cached[1]?.payload.safeDay).toBe(false);
  });

  test('a report beyond the allowance is recorded, not applied, and says which rail it hit', async () => {
    await seed({}, { status: 'disputed' });
    supabase = createFakeSupabase({
      invoke: () =>
        disputeReply({
          score: 77,
          status: 'provisional',
          autoAccepted: false,
          remainingAllowance: 0,
          reason: 'allowance_7d',
          hadSevereEvent: true,
        }),
    });

    await expect(runDispute(disputeBody, ctx())).resolves.toEqual({ kind: 'done' });

    // The event goes back to costing what it cost: nothing was applied.
    expect(await readEvent()).toMatchObject({ status: 'scored', deduction: 6 });
    expect(await readDispute()).toMatchObject({
      outcome: 'denied',
      deniedReason: 'allowance_7d',
      remainingAllowance: 0,
    });
    expect(await readTrip()).toMatchObject({ score: 77, status: 'provisional' });
  });

  test('a report past the 14-day window is refused for good, and the event says so', async () => {
    await seed({}, { status: 'disputed' });
    supabase = createFakeSupabase({
      invoke: () => functionsHttpError(422, { code: 'dispute_window_closed' }),
    });

    await expect(runDispute(disputeBody, ctx())).resolves.toEqual({
      kind: 'failed',
      code: 'dispute_window_closed',
    });

    expect(await readEvent()).toMatchObject({ status: 'scored' });
    expect(await readDispute()).toMatchObject({
      outcome: 'window_closed',
      code: 'dispute_window_closed',
      decidedAt: NOW,
    });
  });

  test('a server that asks for later is retried, with the wait it asked for', async () => {
    await seed();
    supabase = createFakeSupabase({
      invoke: () => functionsHttpError(503, { code: 'retry' }, { 'Retry-After': '2' }),
    });

    await expect(runDispute(disputeBody, ctx())).resolves.toEqual({
      kind: 'retry',
      code: 'retry',
      retryAfterS: 2,
    });
    // Nothing decided, so nothing is written on the event.
    expect((await readEvent()).dispute_json).toBeNull();
  });

  test('a rate limit is retried later, not failed', async () => {
    await seed();
    supabase = createFakeSupabase({
      invoke: () => functionsHttpError(429, { code: 'too_many_disputes' }, { 'Retry-After': '3600' }),
    });

    await expect(runDispute(disputeBody, ctx())).resolves.toEqual({
      kind: 'retry',
      code: 'too_many_disputes',
      retryAfterS: 3600,
    });
  });

  test('a request that never left is retried without a verdict', async () => {
    await seed();
    supabase = createFakeSupabase({ invoke: () => functionsFetchError() });

    await expect(runDispute(disputeBody, ctx())).resolves.toEqual({
      kind: 'retry',
      code: 'network',
      retryAfterS: null,
    });
  });

  test('an expired token buys one refresh from the runner, not a failure here', async () => {
    await seed();
    supabase = createFakeSupabase({ invoke: () => functionsHttpError(401, { code: 'unauthorized' }) });

    await expect(runDispute(disputeBody, ctx())).resolves.toMatchObject({ kind: 'unauthorized' });
  });

  test('two stored events with one client id is the server deciding against us, not a retry', async () => {
    await seed();
    supabase = createFakeSupabase({ invoke: () => functionsHttpError(409, { code: 'ambiguous_event' }) });

    await expect(runDispute(disputeBody, ctx())).resolves.toEqual({
      kind: 'failed',
      code: 'ambiguous_event',
    });
  });

  test('a replay is applied exactly as a first answer is', async () => {
    await seed({}, { status: 'removed', deduction: 0, corrected: 1 });
    supabase = createFakeSupabase({ invoke: () => disputeReply({ replayed: true }) });

    await expect(runDispute(disputeBody, ctx())).resolves.toEqual({ kind: 'done' });

    expect(await readEvent()).toMatchObject({ status: 'removed', deduction: 0 });
    expect(await readTrip()).toMatchObject({ score: 85, status: 'final' });
    expect(await readDispute()).toMatchObject({ outcome: 'accepted' });
  });

  test('a reply this build cannot read in full is retried and nothing is written', async () => {
    await seed();
    const report = jest.fn();
    supabase = createFakeSupabase({
      invoke: () => ({ data: { tripId: SERVER_TRIP, score: 85 }, error: null }),
    });

    await expect(runDispute(disputeBody, ctx({ report }))).resolves.toEqual({
      kind: 'retry',
      code: 'invalid_response',
    });
    expect(report).toHaveBeenCalledTimes(1);
    expect(await readEvent()).toMatchObject({ status: 'scored', deduction: 6 });
  });

  test('a payload this build cannot send is failed before any call', async () => {
    await seed();
    await expect(runDispute('{"action":"dispute"}', ctx())).resolves.toEqual({
      kind: 'failed',
      code: 'invalid_payload',
    });
    await expect(runDispute('not json', ctx())).resolves.toEqual({
      kind: 'failed',
      code: 'invalid_payload',
    });
    expect(supabase.invokes).toHaveLength(0);
  });

  test('a report whose drive was deleted under it still caches the days it came back with', async () => {
    supabase = createFakeSupabase({ invoke: () => disputeReply({ replayed: true }) });

    await expect(runDispute(disputeBody, ctx())).resolves.toEqual({ kind: 'done' });

    const cached = await createScoreDailyCacheRepo(db).range('2026-01-01', '2026-01-31');
    expect(cached).toHaveLength(1);
  });
});

describe('changing who was driving', () => {
  test("the server's re-score replaces whatever the device guessed", async () => {
    await seed();
    supabase = createFakeSupabase({
      invoke: () => ({
        data: {
          tripId: SERVER_TRIP,
          role: 'passenger',
          score: null,
          status: 'unscored',
          days: [day({ safeDay: false, tripsScored: 0 })],
          replayed: false,
        },
        error: null,
      }),
    });

    await expect(runSetRole(setRoleBody, ctx())).resolves.toEqual({ kind: 'done' });

    expect(supabase.invokes[0]).toEqual({
      name: TRIP_ACTIONS_FUNCTION,
      body: { action: 'set-role', clientTripId: TRIP, role: 'passenger' },
    });
    expect(await readTrip()).toMatchObject({
      role: 'passenger',
      score: null,
      status: 'unscored',
      server_id: SERVER_TRIP,
      sync_state: 'synced',
      sync_error: null,
    });
    const cached = await createScoreDailyCacheRepo(db).range<{ tripsScored: number }>(
      '2026-01-01',
      '2026-01-31'
    );
    expect(cached[0]?.payload.tripsScored).toBe(0);
  });

  test('a drive the server does not have is a refusal a retry cannot fix', async () => {
    await seed();
    supabase = createFakeSupabase({ invoke: () => functionsHttpError(404, { code: 'not_found' }) });

    await expect(runSetRole(setRoleBody, ctx())).resolves.toEqual({
      kind: 'failed',
      code: 'not_found',
    });
    expect(await readTrip()).toMatchObject({ role: 'driver', sync_state: 'queued' });
  });

  test('a locked writer is tried again later', async () => {
    await seed();
    supabase = createFakeSupabase({
      invoke: () => functionsHttpError(503, { code: 'retry' }, { 'Retry-After': '2' }),
    });

    await expect(runSetRole(setRoleBody, ctx())).resolves.toMatchObject({ kind: 'retry' });
  });

  test('a role this build cannot send is failed before any call', async () => {
    await expect(
      runSetRole(JSON.stringify({ action: 'set-role', clientTripId: TRIP, role: 'pilot' }), ctx())
    ).resolves.toEqual({ kind: 'failed', code: 'invalid_payload' });
    expect(supabase.invokes).toHaveLength(0);
  });
});

describe('deleting a drive', () => {
  const deleteReply = (over: Record<string, unknown> = {}): SupabaseReply => ({
    data: {
      tripId: SERVER_TRIP,
      deleted: true,
      days: [day({ safeDay: false, tripsScored: 0 })],
      replayed: false,
      ...over,
    },
    error: null,
  });

  test("the wire action is 'delete', not the queue kind, and the day comes back without the drive", async () => {
    await seed({ deleted_at: NOW });
    supabase = createFakeSupabase({ invoke: () => deleteReply() });

    await expect(runDeleteTrip(deleteBody, ctx())).resolves.toEqual({ kind: 'done' });

    expect(supabase.invokes[0]).toEqual({
      name: TRIP_ACTIONS_FUNCTION,
      body: { action: 'delete', clientTripId: TRIP },
    });
    const cached = await createScoreDailyCacheRepo(db).range<{ tripsScored: number }>(
      '2026-01-01',
      '2026-01-31'
    );
    expect(cached[0]?.payload.tripsScored).toBe(0);
    // The row stays, still deleted: it is what stops a queued trace being uploaded.
    expect(await readTrip()).toMatchObject({ deleted_at: NOW, sync_state: 'synced' });
  });

  test('a delete the server had already applied is a replay, and still refreshes the day', async () => {
    await seed({ deleted_at: NOW });
    supabase = createFakeSupabase({ invoke: () => deleteReply({ replayed: true }) });

    await expect(runDeleteTrip(deleteBody, ctx())).resolves.toEqual({ kind: 'done' });
    const cached = await createScoreDailyCacheRepo(db).range('2026-01-01', '2026-01-31');
    expect(cached).toHaveLength(1);
  });

  test('a drive the server never had is failed, and stays deleted here', async () => {
    await seed({ deleted_at: NOW });
    supabase = createFakeSupabase({ invoke: () => functionsHttpError(404, { code: 'not_found' }) });

    await expect(runDeleteTrip(deleteBody, ctx())).resolves.toEqual({
      kind: 'failed',
      code: 'not_found',
    });
    expect(await readTrip()).toMatchObject({ deleted_at: NOW });
  });

  test('a storage failure on the server is tried again later', async () => {
    await seed({ deleted_at: NOW });
    supabase = createFakeSupabase({
      invoke: () => functionsHttpError(503, { code: 'retry' }, { 'Retry-After': '2' }),
    });

    await expect(runDeleteTrip(deleteBody, ctx())).resolves.toEqual({
      kind: 'retry',
      code: 'retry',
      retryAfterS: 2,
    });
  });
});

describe('through the runner', () => {
  test('a queued report is drained, applied and closed out', async () => {
    await seed();
    supabase = createFakeSupabase({ invoke: () => disputeReply() });
    await createQueueRepo(db).enqueue(
      'dispute',
      { action: 'dispute', clientEventId: EVENT, reason: 'hazard' },
      `dispute:${EVENT}`,
      T0
    );

    const runner = createSyncRunner({
      db,
      supabase,
      fs: createFakeFs(),
      net: { isWifi: () => true },
      isRecording: () => false,
      appState: createFakeAppState(),
      now: () => NOW,
    });

    await expect(runner.drainOnce(NOW)).resolves.toEqual({ done: 1, failed: 0, deferred: 0 });
    expect(await readEvent()).toMatchObject({ status: 'removed' });
    const [item] = await createQueueRepo(db).nextDue(NOW + 1, 10);
    expect(item).toBeUndefined();
  });

  test('a role change queued before this build had a handler now drains', async () => {
    await seed();
    supabase = createFakeSupabase({
      invoke: () => ({
        data: {
          tripId: SERVER_TRIP,
          role: 'passenger',
          score: null,
          status: 'unscored',
          days: [day()],
          replayed: false,
        },
        error: null,
      }),
    });
    await createQueueRepo(db).enqueue(
      'set-role',
      { action: 'set-role', clientTripId: TRIP, role: 'passenger' },
      `role:${TRIP}:${T0}`,
      T0
    );

    const runner = createSyncRunner({
      db,
      supabase,
      fs: createFakeFs(),
      net: { isWifi: () => true },
      isRecording: () => false,
      now: () => NOW,
    });

    await expect(runner.drainOnce(NOW)).resolves.toEqual({ done: 1, failed: 0, deferred: 0 });
    expect(await readTrip()).toMatchObject({ role: 'passenger', sync_state: 'synced' });
  });
});
