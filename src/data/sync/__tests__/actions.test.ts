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
  recordActionGiveUp,
  RETRIES_EXHAUSTED,
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
import { createSettingsRepo } from '@/data/db/settings';
import { currentOwnerUid, DEVICE_OWNER_KEY } from '@/data/sync/queue';
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

/** What the server's re-score stored on the trip; the device row follows it, not its own. */
const tripFields = (over: Record<string, unknown> = {}) => ({
  categoryDeductions: { phone: 0, speeding: 0, braking: 0, accel: 0, cornering: 0, focus: 0 },
  exposure: 1,
  dataQuality: 'A',
  hadSevereEvent: false,
  limitCoveragePct: 80,
  ...over,
});

const disputeReply = (over: Record<string, unknown> = {}): SupabaseReply => ({
  data: {
    tripId: SERVER_TRIP,
    score: 85,
    status: 'final',
    autoAccepted: true,
    remainingAllowance: 2,
    reason: null,
    hadSevereEvent: false,
    trip: tripFields(),
    days: [day()],
    replayed: false,
    ...over,
  },
  error: null,
});

const queuedRecord = (over: Partial<DisputeRecord> = {}): string =>
  JSON.stringify({
    reason: 'hazard',
    note: null,
    statedLimitMph: null,
    submittedAt: T0,
    outcome: 'queued',
    deniedReason: null,
    remainingAllowance: null,
    code: null,
    decidedAt: null,
    ...over,
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
  // The bootstrap's identity stage runs before anything is queued; without it every item is
  // unowned, and the runner refuses work it cannot attribute.
  await createSettingsRepo(db).set(DEVICE_OWNER_KEY, 'user-1');
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

  test("the drive's breakdown, exposure and grade follow the server, not the device's finalizer", async () => {
    // The stored row says speeding cost 6; the server has just removed that event.
    await seed();
    supabase = createFakeSupabase({
      invoke: () =>
        disputeReply({
          trip: tripFields({ dataQuality: 'B', exposure: 1.4, limitCoveragePct: 55 }),
        }),
    });

    await runDispute(disputeBody, ctx());

    const stored = await readTrip();
    expect(JSON.parse(stored.category_deductions_json ?? '{}')).toEqual({
      phone: 0,
      speeding: 0,
      braking: 0,
      accel: 0,
      cornering: 0,
      focus: 0,
    });
    expect(stored).toMatchObject({ exposure: 1.4, data_quality: 'B', limit_coverage_pct: 55 });
  });

  test('a reply naming a different server trip is not written to this row', async () => {
    await seed({ server_id: '99999999-2222-4333-8444-555555555555' });
    supabase = createFakeSupabase({ invoke: () => disputeReply() });

    await expect(runDispute(disputeBody, ctx())).resolves.toEqual({ kind: 'done' });

    // The event still settles — it is named by its own id — but the trip row is left alone.
    expect(await readTrip()).toMatchObject({
      server_id: '99999999-2222-4333-8444-555555555555',
      score: 77,
    });
  });

  test('a reply that lands after the device has changed hands writes nothing', async () => {
    await seed();
    supabase = createFakeSupabase({ invoke: () => disputeReply() });

    await expect(runDispute(disputeBody, ctx({ stale: () => true }))).resolves.toEqual({
      kind: 'defer',
    });

    expect(await readTrip()).toMatchObject({ score: 77 });
    expect(await createScoreDailyCacheRepo(db).range('2026-01-01', '2026-01-31')).toEqual([]);
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
    await seed({}, { status: 'disputed', dispute_json: queuedRecord() });
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

  test('a refusal that is not about the window keeps its own code, and never claims the window', async () => {
    await seed({}, { status: 'disputed', dispute_json: queuedRecord() });
    supabase = createFakeSupabase({
      invoke: () => functionsHttpError(422, { code: 'event_not_scored' }),
    });

    await expect(runDispute(disputeBody, ctx())).resolves.toEqual({
      kind: 'failed',
      code: 'event_not_scored',
    });

    expect(await readDispute()).toMatchObject({
      outcome: 'refused',
      code: 'event_not_scored',
      decidedAt: NOW,
    });
    expect(await readEvent()).toMatchObject({ status: 'scored' });
  });

  test('a report whose queue item ran out of attempts stops saying it is on its way', async () => {
    await seed({}, { status: 'disputed', dispute_json: queuedRecord() });

    await recordActionGiveUp(ctx(), 'dispute', disputeBody, RETRIES_EXHAUSTED);

    expect(await readDispute()).toMatchObject({
      outcome: 'refused',
      code: RETRIES_EXHAUSTED,
    });
    expect(await readEvent()).toMatchObject({ status: 'scored' });
  });

  test('a body this build cannot send still leaves a record, so D3 is not stuck on sending', async () => {
    await seed({}, { status: 'disputed', dispute_json: queuedRecord() });

    const bad = JSON.stringify({ action: 'dispute', clientEventId: EVENT, reason: 'nope' });
    await expect(runDispute(bad, ctx())).resolves.toEqual({
      kind: 'failed',
      code: 'invalid_payload',
    });

    expect(supabase.invokes).toHaveLength(0);
    expect(await readDispute()).toMatchObject({ outcome: 'refused', code: 'invalid_payload' });
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
          trip: tripFields({ dataQuality: 'B' }),
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

  test("the server's severe-speeding verdict travels on this path too, not only on a dispute", async () => {
    // The stored row says the drive had a severe episode; the server's re-score under the new
    // role says it does not. The flag is maintained on every path that re-scores, or it drifts.
    await seed();
    supabase = createFakeSupabase({
      invoke: () => ({
        data: {
          tripId: SERVER_TRIP,
          role: 'passenger',
          score: null,
          status: 'unscored',
          trip: tripFields({ hadSevereEvent: false }),
          days: [day()],
          replayed: false,
        },
        error: null,
      }),
    });

    await runSetRole(setRoleBody, ctx());

    expect(JSON.parse((await readTrip()).conditions_json ?? '{}')).toEqual({
      night: false,
      precipitation: false,
      hadSevereEvent: false,
    });
  });

  test('a replay echoing a role the column allows but nothing writes is still a reply we can read', async () => {
    // `trips.role`'s CHECK permits 'unknown', and the deleted-trip replay arm echoes the column
    // straight back. A narrower device enum would turn the first such row into a permanent
    // `invalid_response` retry loop rather than anything anyone could see.
    await seed();
    supabase = createFakeSupabase({
      invoke: () => ({
        data: {
          tripId: SERVER_TRIP,
          role: 'unknown',
          score: null,
          status: 'unscored',
          trip: tripFields(),
          days: [day()],
          replayed: true,
        },
        error: null,
      }),
    });

    await expect(runSetRole(setRoleBody, ctx())).resolves.toEqual({ kind: 'done' });
    expect(await readTrip()).toMatchObject({ role: 'unknown', sync_state: 'synced' });
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
  });

  test('a delete whose drive never reached the server never posts its route either', async () => {
    // The finalize body is the whole drive; `deleteTrip` drops it, so by the time the delete is
    // sent there is nothing queued that still carries the route.
    await seed({ deleted_at: NOW });
    supabase = createFakeSupabase({ invoke: () => functionsHttpError(404, { code: 'not_found' }) });

    await runDeleteTrip(deleteBody, ctx());

    expect(supabase.invokes.map((invoke) => invoke.name)).toEqual([TRIP_ACTIONS_FUNCTION]);
  });

  test('a confirmed delete leaves nothing behind', async () => {
    await seed({ deleted_at: NOW });
    supabase = createFakeSupabase({ invoke: () => deleteReply() });

    await expect(runDeleteTrip(deleteBody, ctx())).resolves.toEqual({ kind: 'done' });

    expect(await createTripsRepo(db).get(TRIP)).toBeNull();
    expect(await createEventsRepo(db).listByTrip(TRIP)).toEqual([]);
    const { rows } = await db.execute('SELECT count(*) AS n FROM samples WHERE client_trip_id = ?', [
      TRIP,
    ]);
    expect(rows[0]?.n).toBe(0);
  });

  test('a delete the server had already applied is a replay, and still refreshes the day', async () => {
    await seed({ deleted_at: NOW });
    supabase = createFakeSupabase({ invoke: () => deleteReply({ replayed: true }) });

    await expect(runDeleteTrip(deleteBody, ctx())).resolves.toEqual({ kind: 'done' });
    const cached = await createScoreDailyCacheRepo(db).range('2026-01-01', '2026-01-31');
    expect(cached).toHaveLength(1);
  });

  test('a drive the server never had is already deleted: the husk goes, and nothing is owed', async () => {
    // The ordinary outcome for a drive whose finalize never landed — offline, or a finalize the
    // delete correctly stopped. There is nothing on the server to delete and nothing to retry.
    await seed({ deleted_at: NOW });
    supabase = createFakeSupabase({ invoke: () => functionsHttpError(404, { code: 'not_found' }) });

    await expect(runDeleteTrip(deleteBody, ctx())).resolves.toEqual({ kind: 'done' });

    expect(await createTripsRepo(db).get(TRIP)).toBeNull();
    expect(await createEventsRepo(db).listByTrip(TRIP)).toEqual([]);
  });

  test('a delete that gives up leaves the drive visible as unfinished, not silently undone', async () => {
    await seed({ deleted_at: NOW });
    await recordActionGiveUp(ctx(), 'delete-trip', deleteBody, RETRIES_EXHAUSTED);

    expect(await readTrip()).toMatchObject({
      deleted_at: NOW,
      sync_state: 'failed',
      sync_error: RETRIES_EXHAUSTED,
    });
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
  const runnerFor = (over: Partial<Parameters<typeof createSyncRunner>[0]> = {}) =>
    createSyncRunner({
      db,
      supabase,
      fs: createFakeFs(),
      net: { isWifi: () => true },
      isRecording: () => false,
      now: () => NOW,
      ...over,
    });

  test('a queued report is drained, applied and closed out', async () => {
    await seed();
    supabase = createFakeSupabase({ invoke: () => disputeReply() });
    await createQueueRepo(db).enqueue(
      'dispute',
      { action: 'dispute', clientEventId: EVENT, reason: 'hazard' },
      `dispute:${EVENT}`,
      T0,
      undefined,
      'user-1'
    );

    const runner = runnerFor({ appState: createFakeAppState() });

    await expect(runner.drainOnce(NOW)).resolves.toEqual({ done: 1, failed: 0, deferred: 0 });
    expect(await readEvent()).toMatchObject({ status: 'removed' });
    const [item] = await createQueueRepo(db).nextDue(NOW + 1, 10);
    expect(item).toBeUndefined();
  });

  test('signed out, an action is held rather than posted — and costs no attempt', async () => {
    await seed({}, { status: 'disputed', dispute_json: queuedRecord() });
    supabase = createFakeSupabase({ uid: null, invoke: () => disputeReply() });
    await createQueueRepo(db).enqueue(
      'dispute',
      { action: 'dispute', clientEventId: EVENT, reason: 'other', note: 'my kid was in the car' },
      `dispute:${EVENT}`,
      T0,
      undefined,
      'user-1'
    );

    await expect(runnerFor().drainOnce(NOW)).resolves.toEqual({
      done: 0,
      failed: 0,
      deferred: 1,
    });

    // The note never left the device, and the ladder did not move.
    expect(supabase.invokes).toHaveLength(0);
    const [item] = await createQueueRepo(db).nextDue(NOW + 1, 10);
    expect(item).toMatchObject({ attempts: 0 });
  });

  test("work queued by one driver is never posted under another's session", async () => {
    await seed({}, { status: 'disputed', dispute_json: queuedRecord() });
    supabase = createFakeSupabase({ uid: 'user-b', invoke: () => disputeReply() });
    await createQueueRepo(db).enqueue(
      'dispute',
      { action: 'dispute', clientEventId: EVENT, reason: 'hazard' },
      `dispute:${EVENT}`,
      T0,
      undefined,
      'user-a'
    );

    await expect(runnerFor().drainOnce(NOW)).resolves.toEqual({
      done: 0,
      failed: 1,
      deferred: 0,
    });
    expect(supabase.invokes).toHaveLength(0);
  });

  test('the signed-in user is remembered, so work queued between drains carries its owner', async () => {
    await seed();
    supabase = createFakeSupabase({ uid: 'user-1' });
    await runnerFor().drainOnce(NOW);
    await expect(currentOwnerUid(db)).resolves.toBe('user-1');
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
          trip: tripFields(),
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
      T0,
      undefined,
      'user-1'
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

describe('owner re-checks before every local write (carry-over 4)', () => {
  const runnerFor = () =>
    createSyncRunner({
      db,
      supabase,
      fs: createFakeFs(),
      net: { isWifi: () => true },
      isRecording: () => false,
      now: () => NOW,
    });

  const queue = (kind: string, body: string, key: string) =>
    createQueueRepo(db).enqueue(kind, JSON.parse(body) as object, key, T0, undefined, 'user-1');

  test('a session that changes while a report is in flight: the answer writes nothing', async () => {
    await seed({}, { status: 'disputed', dispute_json: queuedRecord() });
    supabase = createFakeSupabase({
      invoke: () => {
        supabase.setUid('user-b');
        return disputeReply();
      },
    });
    await queue('dispute', disputeBody, `dispute:${EVENT}`);

    await expect(runnerFor().drainOnce(NOW)).resolves.toEqual({ done: 0, failed: 0, deferred: 1 });
    expect(await readEvent()).toMatchObject({ status: 'disputed' });
    expect(await readDispute()).toMatchObject({ outcome: 'queued' });
    expect(await createScoreDailyCacheRepo(db).range('2026-01-01', '2026-01-31')).toEqual([]);
  });

  test('a refusal that arrives after the session changed is not recorded either', async () => {
    await seed({}, { status: 'disputed', dispute_json: queuedRecord() });
    supabase = createFakeSupabase({
      invoke: () => {
        supabase.setUid('user-b');
        return functionsHttpError(422, { code: 'dispute_window_closed' });
      },
    });
    await queue('dispute', disputeBody, `dispute:${EVENT}`);

    await expect(runnerFor().drainOnce(NOW)).resolves.toEqual({ done: 0, failed: 0, deferred: 1 });
    expect(await readDispute()).toMatchObject({ outcome: 'queued' });
  });

  test('a wipe that lands while a role change is in flight: the transaction sees it and writes nothing', async () => {
    await seed();
    supabase = createFakeSupabase({
      invoke: async () => {
        await createSettingsRepo(db).set(DEVICE_OWNER_KEY, 'user-b');
        return {
          data: {
            tripId: SERVER_TRIP,
            role: 'passenger',
            score: null,
            status: 'unscored',
            trip: tripFields(),
            days: [day()],
            replayed: false,
          },
          error: null,
        };
      },
    });
    await queue('set-role', setRoleBody, 'role:trip-1:1');

    await expect(runnerFor().drainOnce(NOW)).resolves.toMatchObject({ done: 0, deferred: 1 });
    expect(await readTrip()).toMatchObject({ role: 'driver', score: 77, sync_state: 'queued' });
    expect(await createScoreDailyCacheRepo(db).range('2026-01-01', '2026-01-31')).toEqual([]);
  });

  test('a delete whose not-found answer lands after the session changed leaves the husk', async () => {
    await seed({ deleted_at: NOW });
    supabase = createFakeSupabase({
      invoke: () => {
        supabase.setUid('user-b');
        return functionsHttpError(404, { code: 'not_found' });
      },
    });
    await queue('delete-trip', deleteBody, 'delete:trip-1');

    await expect(runnerFor().drainOnce(NOW)).resolves.toMatchObject({ done: 0, deferred: 1 });
    expect(await createTripsRepo(db).get(TRIP)).not.toBeNull();
  });

  test('a handler told the owner no longer holds defers without writing, on every path', async () => {
    await seed();
    const refused = () => ctx({ ownerHolds: async () => false, owner: 'user-1' });
    supabase = createFakeSupabase({ invoke: () => disputeReply() });
    await expect(runDispute(disputeBody, refused())).resolves.toEqual({ kind: 'defer' });
    supabase = createFakeSupabase({ invoke: () => functionsHttpError(404, { code: 'not_found' }) });
    await expect(runDeleteTrip(deleteBody, refused())).resolves.toEqual({ kind: 'defer' });
    expect(await readTrip()).toMatchObject({ score: 77 });
    expect(await readEvent()).toMatchObject({ status: 'scored', dispute_json: null });
  });
});
