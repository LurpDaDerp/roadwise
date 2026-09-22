import { assertEquals } from '@std/assert';
import { createDb } from './db.ts';
import {
  aggregatesAfter,
  anySevereSpeeding,
  eventRows,
  isSevereSpeeding,
  settleDisputed,
  severeAfter,
  storedDowngrades,
  storedMetrics,
  toScorableEvent,
} from './rescore.ts';
import type { StoredEvent, StoredTrip } from './actions_db.ts';
import { scoreTrip } from './scoring/index';
import { fakeSupabase } from './testing/fake_supabase.ts';
import { ROWS_DIGEST, TRACE_KEY, TRIP_ID } from './testing/action_fixtures.ts';
import { baselineTripRow, CLIENT_TRIP_ID, T0, TRIP_DAY, tripRow, TZ, UID } from './testing/fixtures.ts';

const DAY_MS = 86_400_000;

const trip = (overrides: Partial<StoredTrip> = {}): StoredTrip => ({
  id: TRIP_ID,
  clientTripId: CLIENT_TRIP_ID,
  status: 'final',
  score: 90,
  role: 'driver',
  scoringVersion: 1,
  localDay: TRIP_DAY,
  tz: TZ,
  startedAt: T0,
  endedAt: T0 + 1_320_000,
  distanceM: 13_200,
  durationS: 1320,
  exposure: 1.1,
  dataQuality: 'A',
  categoryDeductions: { phone: 0, speeding: 4, braking: 0, accel: 0, cornering: 0, focus: 0 },
  limitCoveragePct: 80,
  rowsDigest: ROWS_DIGEST,
  tracePath: TRACE_KEY,
  incomplete: false,
  hadSevereEvent: false,
  cameraSession: false,
  deletedAt: null,
  ...overrides,
});

const event = (overrides: Partial<StoredEvent> = {}): StoredEvent => ({
  id: 'event-1',
  tripId: TRIP_ID,
  clientEventId: 'p1',
  category: 'phone',
  startedAt: T0 + 300_000,
  durationMs: 12_000,
  q: 0.9,
  corrected: false,
  status: 'scored',
  measured: { speedMps: 15.6464 },
  context: { night: false, precipitation: false },
  ...overrides,
});

Deno.test('a consistent stored trip re-derives no downgrade', () => {
  assertEquals(storedDowngrades(trip()), []);
});

Deno.test('the downgrades finalize-trip applied are re-derived from the stored columns, in rule order', () => {
  assertEquals(storedDowngrades(trip({ tracePath: null })), ['no_trace']);
  assertEquals(storedDowngrades(trip({ incomplete: true })), ['incomplete']);
  assertEquals(storedDowngrades(trip({ durationS: 1322 })), ['duration_exceeds_span']);
  assertEquals(storedDowngrades(trip({ durationS: 1321 })), []);
  // 13.2 km in 400 s is 33 m/s against a 20 m/s sustained maximum (allowed up to 25)
  assertEquals(storedDowngrades(trip({ durationS: 400 })), ['distance_exceeds_speed']);
  assertEquals(storedDowngrades(trip({ tracePath: null, incomplete: true, durationS: 400 })), [
    'no_trace',
    'incomplete',
    'distance_exceeds_speed',
  ]);
});

Deno.test("storedMetrics carries the stored digest and the caller's role, and withholds the IMU under a cap", () => {
  assertEquals(storedMetrics(trip(), 'driver'), {
    distanceM: 13_200,
    durationS: 1320,
    validGnssPct: ROWS_DIGEST.validGnssPct,
    imuPresent: true,
    role: 'driver',
    maxSustainedSpeedMps: ROWS_DIGEST.maxSustainedSpeedMps,
  });
  assertEquals(storedMetrics(trip({ tracePath: null }), 'passenger')?.imuPresent, false);
  assertEquals(storedMetrics(trip({ tracePath: null }), 'passenger')?.role, 'passenger');
});

Deno.test('a stored digest the contract does not recognise yields no metrics', () => {
  assertEquals(storedMetrics(trip({ rowsDigest: {} }), 'driver'), null);
  assertEquals(storedMetrics(trip({ rowsDigest: { ...ROWS_DIGEST, validGnssPct: 'high' } }), 'driver'), null);
  assertEquals(storedMetrics(trip({ rowsDigest: null }), 'driver'), null);
});

Deno.test("a stored event maps back to the scorer's event", () => {
  assertEquals(toScorableEvent(event()), {
    id: 'p1',
    category: 'phone',
    startedAt: T0 + 300_000,
    durationS: 12,
    q: 0.9,
    corrected: false,
    status: 'scored',
    measured: { speedMps: 15.6464 },
    context: { night: false, precipitation: false },
  });
  // stored jsonb that lost its keys still scores as an event without them
  const bare = toScorableEvent(event({ measured: {}, context: {} }));
  assertEquals(bare.measured, {});
  assertEquals(bare.context, { night: false, precipitation: false });
});

Deno.test("settleDisputed turns the writer's transient disputed status into removed and leaves the rest alone", () => {
  const events = [event(), event({ id: 'event-2', clientEventId: 'p2', status: 'disputed' }), event({ id: 'event-3', clientEventId: 'p3', status: 'possible' })];
  assertEquals(
    settleDisputed(events).map((e) => e.status),
    ['scored', 'removed', 'possible']
  );
});

Deno.test('a severe speeding event is one at or beyond 20 mph over, whatever its status; the trip has one only while it is scored', () => {
  const over = (overMps: number, status: StoredEvent['status'] = 'scored') =>
    event({ category: 'speeding', status, measured: { speedMps: 24, limitMps: 15, overMps } });
  assertEquals(isSevereSpeeding(over(8.9408)), true);
  assertEquals(isSevereSpeeding(over(8.94)), false);
  assertEquals(isSevereSpeeding(over(9, 'removed')), true);
  assertEquals(isSevereSpeeding(event()), false);
  assertEquals(anySevereSpeeding([event(), over(9)]), true);
  assertEquals(anySevereSpeeding([event(), over(9, 'removed')]), false);
  assertEquals(anySevereSpeeding([event(), over(9, 'possible')]), false);
  assertEquals(anySevereSpeeding([]), false);
});

Deno.test('the severe flag after a recompute is what survives, and the stored half only while no disputed severe event is being settled', () => {
  const severe = (status: string, id = 'event-s1') =>
    event({ id, clientEventId: id, category: 'speeding', status, measured: { speedMps: 24.6, limitMps: 15.6464, overMps: 9 } });
  // a scored severe event proves the flag whatever was stored
  assertEquals(severeAfter([event(), severe('scored')], false), true);
  // the dispute's own recompute: the event settles here, so the flag goes
  assertEquals(severeAfter([event(), severe('disputed')], true), false);
  // a foreign recompute settles it just the same — the flag must not outlive the event
  assertEquals(severeAfter([event({ status: 'disputed' }), severe('disputed')], true), false);
  // the device's own half (an L3 alert) survives a dispute of an ordinary event
  assertEquals(severeAfter([event({ status: 'disputed' })], true), true);
  // one of two severe events settling leaves the other
  assertEquals(severeAfter([severe('scored', 'event-s2'), severe('disputed')], true), true);
  assertEquals(severeAfter([event()], false), false);
});

Deno.test('eventRows carries the server ids with the new statuses and deductions; null deductions on an unscored trip', () => {
  const events = [event(), event({ id: 'event-2', clientEventId: 'p2', status: 'removed' })];
  const scored = scoreTrip(storedMetrics(trip(), 'driver')!, events.map(toScorableEvent));
  assertEquals(eventRows(events, scored), [
    { id: 'event-1', status: 'scored', deduction: scored.eventDeductions.p1 },
    { id: 'event-2', status: 'removed', deduction: 0 },
  ]);
  const unscored = scoreTrip(storedMetrics(trip(), 'passenger')!, events.map(toScorableEvent));
  assertEquals(eventRows(events, unscored), [
    { id: 'event-1', status: 'scored', deduction: null },
    { id: 'event-2', status: 'removed', deduction: null },
  ]);
});

const store = () =>
  fakeSupabase({
    tables: {
      trips: [
        tripRow({
          id: TRIP_ID,
          client_trip_id: CLIENT_TRIP_ID,
          score: 90,
          duration_s: 1320,
          exposure: 1.1,
          ended_at: new Date(T0 + 1_320_000).toISOString(),
        }),
        tripRow({
          id: 'other',
          score: 80,
          duration_s: 1500,
          exposure: 1.5,
          ended_at: new Date(T0 - DAY_MS).toISOString(),
          category_deductions: { phone: 6, speeding: 0, braking: 0, accel: 0, cornering: 0, focus: 0 },
        }),
        tripRow({
          id: 'yesterday',
          score: 70,
          duration_s: 900,
          exposure: 1,
          local_day: '2023-11-13',
          ended_at: new Date(T0 - 2 * DAY_MS).toISOString(),
        }),
        // the baseline window is the eight weeks before the current four, so only these two are in
        // it: the trip under test and the three above are all inside the current four weeks
        baselineTripRow(40, {
          id: 'baseline-1',
          score: 60,
          duration_s: 900,
          exposure: 1,
          category_deductions: { phone: 2, speeding: 0, braking: 0, accel: 0, cornering: 0, focus: 0 },
        }),
        baselineTripRow(60, {
          id: 'baseline-2',
          score: 80,
          duration_s: 900,
          exposure: 1,
          category_deductions: { phone: 8, speeding: 0, braking: 0, accel: 0, cornering: 0, focus: 0 },
        }),
      ],
      trip_events: [{ trip_id: TRIP_ID, category: 'phone', status: 'scored' }],
    },
  });

Deno.test("aggregatesAfter replaces the trip's stored values with the outcome in the long-term list, the day and the baselines", async () => {
  const db = createDb(store().client);
  const now = T0 + 3_600_000;
  const out = await aggregatesAfter(db, UID, now, trip(), {
    score: 96,
    status: 'final',
    exposure: 1.1,
    categoryDeductions: { phone: 0, speeding: 0, braking: 0, accel: 0, cornering: 0, focus: 0 },
    phoneEvents: 0,
    hadSevereEvent: false,
  });
  assertEquals(out.day.length, 1);
  assertEquals(out.day[0].day, TRIP_DAY);
  assertEquals(out.day[0].tripsScored, 2);
  assertEquals(out.day[0].drivingS, 1320 + 1500);
  assertEquals(out.day[0].exposure, 2.6);
  // the stored row said one phone event; the outcome says none
  assertEquals(out.day[0].phoneFreeDay, true);
  assertEquals(out.day[0].severeEvents, 0);
  assertEquals(typeof out.day[0].longTermScore, 'number');
  // the outcome and the recent trips are in the current four weeks; the baseline is the two behind them
  assertEquals(out.baselines?.medians.score, 70); // median of 60 and 80
  assertEquals(out.baselines?.medians.phone, 5); // median of 2 and 8
});

Deno.test('an unscored outcome keeps the trip on its day but out of the scored aggregates', async () => {
  const db = createDb(store().client);
  const out = await aggregatesAfter(db, UID, T0 + 3_600_000, trip(), {
    score: null,
    status: 'unscored',
    exposure: 1.1,
    categoryDeductions: {},
    phoneEvents: 0,
    hadSevereEvent: false,
  });
  assertEquals(out.day[0].tripsScored, 1);
  assertEquals(out.day[0].drivingS, 1500);
  assertEquals(out.baselines?.medians.score, 70); // the window behind the current four is unmoved by the outcome
});

Deno.test('a deleted trip is left out of every aggregate, and a late action also refreshes today', async () => {
  const db = createDb(store().client);
  const out = await aggregatesAfter(db, UID, T0 + 3 * DAY_MS, trip(), null);
  assertEquals(
    out.day.map((d) => d.day),
    [TRIP_DAY, '2023-11-17']
  );
  assertEquals(out.day[0].tripsScored, 1);
  assertEquals(out.day[1].tripsScored, 0);
  assertEquals(out.day[1].longTermScore, out.day[0].longTermScore);
  assertEquals(out.baselines?.medians.score, 70);
});

Deno.test('the integer-bound day fields reach the envelope as integers even when the stored durations are not', async () => {
  const fake = fakeSupabase({
    tables: {
      trips: [tripRow({ id: 'frac', score: 80, duration_s: 1200.6, exposure: 1.5 })],
      trip_events: [],
    },
  });
  const out = await aggregatesAfter(createDb(fake.client), UID, T0 + 3_600_000, trip({ durationS: 1320.7 }), {
    score: 96,
    status: 'final',
    exposure: 1.1,
    categoryDeductions: {},
    phoneEvents: 0,
    hadSevereEvent: false,
  });
  assertEquals(out.day[0].drivingS, 2521);
  for (const row of out.day) {
    for (const field of ['drivingS', 'tripsScored', 'severeEvents'] as const) {
      assertEquals(Number.isInteger(row[field]), true, field);
    }
    assertEquals(row.longTermScore === null || Number.isInteger(row.longTermScore), true);
  }
});
