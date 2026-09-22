import { assertEquals, assertRejects } from '@std/assert';
import { createDb, DAY_TRIPS_LIMIT, EVENT_ID_CHUNK } from './db.ts';
import { PgError } from './pg.ts';
import { fakeSupabase } from './testing/fake_supabase.ts';
import { CLIENT_TRIP_ID, dayRowRecord, NOW, OTHER_UID, T0, TRIP_DAY, tripRow, UID } from './testing/fixtures.ts';

const HOUR = 3_600_000;
const DAY_MS = 24 * HOUR;

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
    fields: {
      categoryDeductions: { phone: 0, speeding: 4, braking: 0, accel: 0, cornering: 0, focus: 0 },
      exposure: 1,
      dataQuality: 'A',
      hadSevereEvent: false,
      limitCoveragePct: null,
    },
  });
  assertEquals(await db.findTrip(UID, 'nope'), null);
  assertEquals(fake.queries[0].table, 'trips');
  assertEquals(fake.queries[0].filters, [
    ['eq', 'user_id', UID],
    ['eq', 'client_trip_id', CLIENT_TRIP_ID],
  ]);
  assertEquals(fake.storageTouched(), false);
});

Deno.test('countTripsSince counts the user\'s rows created in the window, deleted ones included', async () => {
  const since = NOW - DAY_MS;
  const fake = fakeSupabase({
    tables: {
      trips: [
        tripRow({ created_at: new Date(NOW - HOUR).toISOString() }),
        tripRow({ created_at: new Date(since).toISOString() }), // exactly at the edge counts
        tripRow({ created_at: new Date(NOW - HOUR).toISOString(), deleted_at: new Date(NOW).toISOString() }),
        tripRow({ created_at: new Date(NOW - HOUR).toISOString(), local_day: '2023-10-01' }), // backdated trip still counts
        tripRow({ created_at: new Date(since - 1000).toISOString() }),
        tripRow({ created_at: new Date(NOW - HOUR).toISOString(), user_id: OTHER_UID }),
      ],
    },
  });
  assertEquals(await createDb(fake.client).countTripsSince(UID, since), 4);
  assertEquals(fake.queries[0].filters, [
    ['eq', 'user_id', UID],
    ['gte', 'created_at', new Date(since).toISOString()],
  ]);
});

Deno.test('getDayRow reads trips_all when the row has it', async () => {
  const fake = fakeSupabase({ tables: { score_daily: [dayRowRecord({ trips_scored: 0, trips_all: 1, safe_day: false })] } });
  const row = await createDb(fake.client).getDayRow(UID, TRIP_DAY);
  assertEquals(row?.tripsScored, 0);
  assertEquals(row?.tripsAll, 1);
  assertEquals((fake.queries[0].select ?? '').split(', ').includes('trips_all'), true);
});

Deno.test('getDayRow maps the stored day row, or null when the day has none', async () => {
  const fake = fakeSupabase({ tables: { score_daily: [dayRowRecord(), dayRowRecord({ user_id: OTHER_UID, day: TRIP_DAY, long_term_score: 5 })] } });
  const db = createDb(fake.client);
  assertEquals(await db.getDayRow(UID, TRIP_DAY), {
    day: TRIP_DAY,
    longTermScore: 81,
    band: 'good',
    provisional: false,
    safeDay: true,
    goodDay: false,
    phoneFreeDay: true,
    cameraDay: false,
    exposure: 2.5,
    drivingS: 2400,
    tripsScored: 2,
    // a row stored before trips_all existed reads as M2 did: every final trip was a kept one
    tripsAll: 2,
    severeEvents: 0,
  });
  assertEquals(await db.getDayRow(UID, '2023-11-15'), null);
  assertEquals(fake.queries[0].table, 'score_daily');
  assertEquals(fake.queries[0].filters, [
    ['eq', 'user_id', UID],
    ['eq', 'day', TRIP_DAY],
  ]);
});

Deno.test('listScoredTrips returns live scored trips since the cutoff, newest first', async () => {
  const old = new Date(T0 - 200 * DAY_MS).toISOString();
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
  const rows = await createDb(fake.client).listScoredTrips(UID, T0 - 180 * DAY_MS);
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

Deno.test('listDayTrips returns the trips of those days, deleted ones marked, with their scored phone events', async () => {
  const fake = fakeSupabase({
    tables: {
      trips: [
        tripRow({ id: 'a', camera_session: true }),
        tripRow({ id: 'b', local_day: '2023-11-15', status: 'unscored', score: null, had_severe_event: true }),
        tripRow({ id: 'gone', score: 50, deleted_at: new Date(T0).toISOString() }),
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
      deleted: false,
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
      deleted: false,
    },
    // D2: a deleted drive keeps counting against its day, with what it stored
    {
      id: 'gone',
      localDay: TRIP_DAY,
      score: 50,
      status: 'final',
      durationS: 1200,
      exposure: 1,
      hadSevereEvent: false,
      phoneEvents: 1,
      cameraGood: false,
      deleted: true,
    },
  ]);
  const trips = fake.queries.find((q) => q.table === 'trips');
  assertEquals(
    trips?.filters.some((f) => f[1] === 'deleted_at'),
    false
  );
  const events = fake.queries.find((q) => q.table === 'trip_events');
  assertEquals(events?.filters, [
    ['in', 'trip_id', ['a', 'b', 'gone']],
    ['eq', 'category', 'phone'],
    ['eq', 'status', 'scored'],
  ]);
});

Deno.test('listDayTrips is bounded and asks for phone events in chunks of trip ids', async () => {
  const trips = Array.from({ length: DAY_TRIPS_LIMIT + 20 }, (_, i) =>
    tripRow({ id: `t${i}`, started_at: new Date(T0 + i * 1000).toISOString() })
  );
  const fake = fakeSupabase({
    tables: { trips, trip_events: [{ trip_id: `t${DAY_TRIPS_LIMIT - 1}`, category: 'phone', status: 'scored' }] },
  });
  const rows = await createDb(fake.client).listDayTrips(UID, [TRIP_DAY]);
  assertEquals(rows.length, DAY_TRIPS_LIMIT);
  const eventQueries = fake.queries.filter((q) => q.table === 'trip_events');
  assertEquals(eventQueries.length, Math.ceil(DAY_TRIPS_LIMIT / EVENT_ID_CHUNK));
  for (const q of eventQueries) {
    const ids = q.filters[0][2] as string[];
    assertEquals(ids.length <= EVENT_ID_CHUNK, true);
  }
  assertEquals(rows.find((r) => r.id === `t${DAY_TRIPS_LIMIT - 1}`)?.phoneEvents, 1);
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

Deno.test('applyTrip surfaces the writer\'s SQLSTATE and message as a PgError', async () => {
  const fake = fakeSupabase({
    rpc: () => ({ error: { code: '22023', message: 'apply_trip day does not match the trip' } }),
  });
  const envelope = {} as unknown as Parameters<ReturnType<typeof createDb>['applyTrip']>[0];
  const err = await assertRejects(() => createDb(fake.client).applyTrip(envelope), PgError);
  assertEquals(err.code, '22023');
  assertEquals(err.message, 'apply_trip day does not match the trip');
});
