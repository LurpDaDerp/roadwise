import { assertEquals, assertRejects } from '@std/assert';
import { createDb, PgError } from './db.ts';
import { fakeSupabase } from './testing/fake_supabase.ts';
import { CLIENT_TRIP_ID, OTHER_UID, T0, TRIP_DAY, tripRow, UID } from './testing/fixtures.ts';

Deno.test('findTrip looks the trip up by the JWT user and the client id, and maps the row', async () => {
  const fake = fakeSupabase({
    tables: {
      trips: [
        tripRow({ id: 't1', client_trip_id: CLIENT_TRIP_ID, trace_path: `${UID}/${CLIENT_TRIP_ID}.bin.gz` }),
        tripRow({ id: 't2', user_id: OTHER_UID, client_trip_id: CLIENT_TRIP_ID }),
      ],
    },
  });
  const db = createDb(fake.client);
  assertEquals(await db.findTrip(UID, CLIENT_TRIP_ID), {
    id: 't1',
    score: 88,
    status: 'final',
    localDay: TRIP_DAY,
    tracePath: `${UID}/${CLIENT_TRIP_ID}.bin.gz`,
    deletedAt: null,
  });
  assertEquals(await db.findTrip(UID, 'nope'), null);
  assertEquals(fake.queries[0].table, 'trips');
  assertEquals(fake.queries[0].filters, [
    ['eq', 'user_id', UID],
    ['eq', 'client_trip_id', CLIENT_TRIP_ID],
  ]);
  assertEquals(fake.storageTouched(), false);
});

Deno.test('countTripsOnDay counts every row of the user on that local day, deleted ones included', async () => {
  const fake = fakeSupabase({
    tables: {
      trips: [
        tripRow(),
        tripRow({ deleted_at: new Date(T0).toISOString() }),
        tripRow({ local_day: '2023-11-13' }),
        tripRow({ user_id: OTHER_UID }),
      ],
    },
  });
  assertEquals(await createDb(fake.client).countTripsOnDay(UID, TRIP_DAY), 2);
});

Deno.test('listScoredTrips returns live scored trips since the cutoff, newest first', async () => {
  const old = new Date(T0 - 200 * 86_400_000).toISOString();
  const fake = fakeSupabase({
    tables: {
      trips: [
        tripRow({ id: 'a', ended_at: new Date(T0 - 1000).toISOString() }),
        tripRow({ id: 'b', ended_at: new Date(T0 - 5000).toISOString(), status: 'provisional' }),
        tripRow({ id: 'unscored', status: 'unscored', score: null }),
        tripRow({ id: 'deleted', deleted_at: new Date(T0).toISOString() }),
        tripRow({ id: 'other', user_id: OTHER_UID }),
        tripRow({ id: 'ancient', ended_at: old }),
      ],
    },
  });
  const rows = await createDb(fake.client).listScoredTrips(UID, T0 - 180 * 86_400_000);
  assertEquals(
    rows.map((r) => r.id),
    ['a', 'b']
  );
  assertEquals(rows[0], {
    id: 'a',
    endedAt: T0 - 1000,
    localDay: TRIP_DAY,
    score: 88,
    exposure: 1,
    durationS: 1200,
    categoryDeductions: { phone: 0, speeding: 4, braking: 0, accel: 0, cornering: 0, focus: 0 },
  });
});

Deno.test('listDayTrips returns the live trips of those days with their scored phone events', async () => {
  const fake = fakeSupabase({
    tables: {
      trips: [
        tripRow({ id: 'a', camera_session: true }),
        tripRow({ id: 'b', local_day: '2023-11-15', status: 'unscored', score: null, had_severe_event: true }),
        tripRow({ id: 'gone', deleted_at: new Date(T0).toISOString() }),
        tripRow({ id: 'other-day', local_day: '2023-11-16' }),
      ],
      trip_events: [
        { trip_id: 'a', category: 'phone', status: 'scored' },
        { trip_id: 'a', category: 'phone', status: 'scored' },
        { trip_id: 'a', category: 'phone', status: 'removed' },
        { trip_id: 'a', category: 'speeding', status: 'scored' },
        { trip_id: 'gone', category: 'phone', status: 'scored' },
      ],
    },
  });
  const rows = await createDb(fake.client).listDayTrips(UID, [TRIP_DAY, '2023-11-15']);
  assertEquals(rows, [
    {
      id: 'a',
      localDay: TRIP_DAY,
      score: 88,
      status: 'final',
      durationS: 1200,
      exposure: 1,
      hadSevereEvent: false,
      phoneEvents: 2,
      cameraGood: true,
    },
    {
      id: 'b',
      localDay: '2023-11-15',
      score: null,
      status: 'unscored',
      durationS: 1200,
      exposure: 1,
      hadSevereEvent: true,
      phoneEvents: 0,
      cameraGood: false,
    },
  ]);
  const events = fake.queries.find((q) => q.table === 'trip_events');
  assertEquals(events?.filters, [
    ['in', 'trip_id', ['a', 'b']],
    ['eq', 'category', 'phone'],
    ['eq', 'status', 'scored'],
  ]);
});

Deno.test('listDayTrips makes no event query when the days are empty', async () => {
  const fake = fakeSupabase({ tables: { trips: [] } });
  assertEquals(await createDb(fake.client).listDayTrips(UID, [TRIP_DAY]), []);
  assertEquals(fake.queries.map((q) => q.table), ['trips']);
});

Deno.test('applyTrip calls the writer with the envelope as `p` and returns its result', async () => {
  const fake = fakeSupabase({
    rpc: () => ({ data: { trip_id: 't1', score: 90, status: 'final', day: TRIP_DAY, replayed: false } }),
  });
  const envelope = { userId: UID } as unknown as Parameters<ReturnType<typeof createDb>['applyTrip']>[0];
  const result = await createDb(fake.client).applyTrip(envelope);
  assertEquals(result, { trip_id: 't1', score: 90, status: 'final', day: TRIP_DAY, replayed: false });
  assertEquals(fake.rpcCalls, [{ fn: 'apply_trip', args: { p: envelope } }]);
  assertEquals(fake.storageTouched(), false);
});

Deno.test('applyTrip surfaces the writer’s SQLSTATE and message as a PgError', async () => {
  const fake = fakeSupabase({
    rpc: () => ({ error: { code: '22023', message: 'apply_trip day does not match the trip' } }),
  });
  const envelope = {} as unknown as Parameters<ReturnType<typeof createDb>['applyTrip']>[0];
  const err = await assertRejects(() => createDb(fake.client).applyTrip(envelope), PgError);
  assertEquals(err.code, '22023');
  assertEquals(err.message, 'apply_trip day does not match the trip');
});
