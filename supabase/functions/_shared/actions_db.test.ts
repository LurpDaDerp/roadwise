import { assertEquals, assertRejects } from '@std/assert';
import { createActionsDb, StorageFailure } from './actions_db.ts';
import { PgError } from './pg.ts';
import { fakeActionsClient } from './testing/fake_actions_client.ts';
import {
  CLIENT_EVENT_ID,
  EVENT_ID,
  ROWS_DIGEST,
  storedEventRow,
  storedTripRow,
  TRACE_KEY,
  TRIP_ID,
} from './testing/action_fixtures.ts';
import { CLIENT_TRIP_ID, OTHER_UID, T0, TRIP_DAY, TZ, UID } from './testing/fixtures.ts';

Deno.test('findTripRow looks the trip up by the JWT user and the client id, deleted or not, and maps every column the actions read', async () => {
  const fake = fakeActionsClient({
    tables: {
      trips: [storedTripRow({ deleted_at: '2023-11-15T00:00:00.000Z' }), storedTripRow({ id: 'foreign', user_id: OTHER_UID })],
    },
  });
  const db = createActionsDb(fake.client);
  assertEquals(await db.findTripRow(UID, CLIENT_TRIP_ID), {
    id: TRIP_ID,
    clientTripId: CLIENT_TRIP_ID,
    status: 'final',
    score: 90,
    role: 'driver',
    localDay: TRIP_DAY,
    tz: TZ,
    startedAt: T0,
    endedAt: T0 + 1_320_000,
    distanceM: 13_200,
    durationS: 1320,
    exposure: 1.1,
    dataQuality: 'A',
    rowsDigest: ROWS_DIGEST,
    tracePath: TRACE_KEY,
    incomplete: false,
    hadSevereEvent: false,
    cameraSession: false,
    deletedAt: '2023-11-15T00:00:00.000Z',
  });
  assertEquals(await db.findTripRow(UID, 'nope'), null);
  assertEquals((await db.findTripRow(OTHER_UID, CLIENT_TRIP_ID))?.id, 'foreign');
  assertEquals(fake.queries[0].filters, [
    ['eq', 'user_id', UID],
    ['eq', 'client_trip_id', CLIENT_TRIP_ID],
  ]);
});

Deno.test('numeric columns PostgREST returns as strings are numbers on the way out', async () => {
  const fake = fakeActionsClient({
    tables: { trips: [storedTripRow({ distance_m: '13200', duration_s: '1320.5', exposure: '1.1' })] },
  });
  const row = await createActionsDb(fake.client).findTripRow(UID, CLIENT_TRIP_ID);
  assertEquals(row?.distanceM, 13_200);
  assertEquals(row?.durationS, 1320.5);
  assertEquals(row?.exposure, 1.1);
});

Deno.test('findTripById is scoped to the user too', async () => {
  const fake = fakeActionsClient({ tables: { trips: [storedTripRow()] } });
  const db = createActionsDb(fake.client);
  assertEquals((await db.findTripById(UID, TRIP_ID))?.id, TRIP_ID);
  assertEquals(await db.findTripById(OTHER_UID, TRIP_ID), null);
  assertEquals(fake.queries[0].filters, [
    ['eq', 'id', TRIP_ID],
    ['eq', 'user_id', UID],
  ]);
});

Deno.test("findEvent answers none, one or many for the user's client event id", async () => {
  const fake = fakeActionsClient({
    tables: {
      trip_events: [
        storedEventRow(),
        storedEventRow({ id: 'foreign', user_id: OTHER_UID }),
        storedEventRow({ id: 'twin', client_event_id: 'dup' }),
        storedEventRow({ id: 'twin-2', trip_id: 'trip-0002', client_event_id: 'dup' }),
      ],
    },
  });
  const db = createActionsDb(fake.client);
  assertEquals(await db.findEvent(UID, CLIENT_EVENT_ID), {
    kind: 'one',
    event: {
      id: EVENT_ID,
      tripId: TRIP_ID,
      clientEventId: CLIENT_EVENT_ID,
      category: 'phone',
      startedAt: T0 + 300_000,
      durationMs: 12_000,
      q: 0.9,
      corrected: false,
      status: 'scored',
      measured: { speedMps: 15.6464 },
      context: { night: false, precipitation: false },
    },
  });
  assertEquals(await db.findEvent(UID, 'missing'), { kind: 'none' });
  const theirs = await db.findEvent(OTHER_UID, CLIENT_EVENT_ID);
  assertEquals(theirs.kind === 'one' ? theirs.event.id : null, 'foreign');
  assertEquals(await db.findEvent(UID, 'dup'), { kind: 'many' });
});

Deno.test("listTripEvents returns the trip's events oldest first, whatever their status", async () => {
  const fake = fakeActionsClient({
    tables: {
      trip_events: [
        storedEventRow({
          id: 'later',
          client_event_id: 'p2',
          started_at: new Date(T0 + 600_000).toISOString(),
          status: 'possible',
        }),
        storedEventRow(),
        storedEventRow({ id: 'elsewhere', trip_id: 'trip-0002' }),
      ],
    },
  });
  const rows = await createActionsDb(fake.client).listTripEvents(TRIP_ID);
  assertEquals(
    rows.map((r) => r.id),
    [EVENT_ID, 'later']
  );
  assertEquals(rows[1].status, 'possible');
});

Deno.test("countDeniedDisputes counts the user's denied rows since the cutoff", async () => {
  const cutoff = T0;
  const fake = fakeActionsClient({
    tables: {
      event_disputes: [
        { id: 'a', user_id: UID, auto_accepted: false, created_at: new Date(T0 + 1000).toISOString() },
        { id: 'b', user_id: UID, auto_accepted: false, created_at: new Date(T0 + 2000).toISOString() },
        { id: 'old', user_id: UID, auto_accepted: false, created_at: new Date(T0 - 1000).toISOString() },
        { id: 'ok', user_id: UID, auto_accepted: true, created_at: new Date(T0 + 3000).toISOString() },
        { id: 'theirs', user_id: OTHER_UID, auto_accepted: false, created_at: new Date(T0 + 4000).toISOString() },
      ],
    },
  });
  assertEquals(await createActionsDb(fake.client).countDeniedDisputes(UID, cutoff), 2);
  assertEquals(fake.queries[0].filters, [
    ['eq', 'user_id', UID],
    ['eq', 'auto_accepted', false],
    ['gte', 'created_at', new Date(cutoff).toISOString()],
  ]);
});

Deno.test("the writer wrappers pass their arguments by name and return the writer's object", async () => {
  const fake = fakeActionsClient({ rpc: (fn, args) => ({ data: { fn, ...args } }) });
  const db = createActionsDb(fake.client);
  // the fake echoes the call, so the results are compared as plain values, not as the result types
  const echo = async (p: Promise<unknown>): Promise<unknown> => await p;
  assertEquals(await echo(db.countDisputeAllowance(UID)), { fn: 'count_dispute_allowance', p_user: UID });
  assertEquals(await echo(db.recordDispute(UID, EVENT_ID, 'wrong_limit', null, 35)), {
    fn: 'record_dispute',
    p_user: UID,
    p_event_id: EVENT_ID,
    p_reason: 'wrong_limit',
    p_note: null,
    p_stated_limit_mph: 35,
  });
  assertEquals(await echo(db.setTripRole(UID, TRIP_ID, 'other')), {
    fn: 'set_trip_role_row',
    p_user: UID,
    p_trip_id: TRIP_ID,
    p_role: 'other',
  });
  assertEquals(await echo(db.softDeleteTrip(UID, TRIP_ID)), { fn: 'soft_delete_trip', p_user: UID, p_trip_id: TRIP_ID });
  const result = await echo(db.applyRecompute({ userId: UID, tripId: TRIP_ID, scored: null, events: null, day: [], baselines: null }));
  assertEquals(result, {
    fn: 'apply_recompute',
    p_user: UID,
    p_trip_id: TRIP_ID,
    p_scored: null,
    p_events: null,
    p_day: [],
    p_baselines: null,
  });
});

Deno.test('a writer error surfaces as a PgError with its SQLSTATE', async () => {
  const fake = fakeActionsClient({ rpc: () => ({ error: { code: '42501', message: 'trip not owned by user' } }) });
  const err = await assertRejects(() => createActionsDb(fake.client).softDeleteTrip(UID, TRIP_ID), PgError);
  assertEquals(err.code, '42501');
  assertEquals(err.message, 'trip not owned by user');
});

Deno.test('removeTrace removes the key from the traces bucket and surfaces a storage error as a StorageFailure', async () => {
  const ok = fakeActionsClient();
  await createActionsDb(ok.client).removeTrace(TRACE_KEY);
  assertEquals(ok.storageCalls, [{ bucket: 'traces', keys: [TRACE_KEY] }]);
  const down = fakeActionsClient({ storageError: { message: 'storage is down' } });
  const err = await assertRejects(() => createActionsDb(down.client).removeTrace(TRACE_KEY), StorageFailure);
  assertEquals(err.message, 'storage is down');
});
