import { assertEquals } from '@std/assert';
import { baselines, dayRows, isNightAt, localDay, median, type DayTripInput } from './aggregate.ts';
import type { LongTermScore } from './scoring/index';
import { T0, TRIP_DAY, TZ } from './testing/fixtures.ts';

const withheld: LongTermScore = { score: null, band: null, provisional: true, tripsUsed: 0 };
const good: LongTermScore = { score: 86, band: 'good', provisional: false, tripsUsed: 4 };

const trip = (overrides: Partial<DayTripInput> = {}): DayTripInput => ({
  localDay: TRIP_DAY,
  score: 90,
  status: 'final',
  durationS: 400,
  exposure: 1.2,
  hadSevereEvent: false,
  phoneEvents: 0,
  cameraGood: false,
  ...overrides,
});

Deno.test('localDay is the calendar date in the zone, as Postgres derives it', () => {
  assertEquals(localDay(T0, TZ), '2023-11-14');
  assertEquals(localDay(T0, 'Asia/Tokyo'), '2023-11-15');
  assertEquals(localDay(Date.UTC(2024, 0, 1, 7, 59), TZ), '2023-12-31');
  assertEquals(localDay(Date.UTC(2024, 0, 1, 8, 0), TZ), '2024-01-01');
});

Deno.test('night is 23:00 through 04:59 on the local clock', () => {
  assertEquals(isNightAt(T0, TZ), false); // 14:13
  assertEquals(isNightAt(Date.UTC(2023, 10, 15, 7, 30), TZ), true); // 23:30 PST
  assertEquals(isNightAt(Date.UTC(2023, 10, 15, 12, 59), TZ), true); // 04:59
  assertEquals(isNightAt(Date.UTC(2023, 10, 15, 13, 0), TZ), false); // 05:00
});

Deno.test('a day row aggregates only that day\'s final trips and carries the long-term score', () => {
  const rows = dayRows(
    [TRIP_DAY],
    [
      trip({ score: 90, durationS: 400, exposure: 1.2 }),
      trip({ score: 88, durationS: 300, exposure: 0.8, cameraGood: true }),
      trip({ score: null, status: 'unscored', durationS: 5000, exposure: 3 }),
      trip({ localDay: '2023-11-13', score: 10, hadSevereEvent: true }),
    ],
    good
  );
  assertEquals(rows, [
    {
      day: TRIP_DAY,
      longTermScore: 86,
      band: 'good',
      provisional: false,
      safeDay: true,
      goodDay: false,
      phoneFreeDay: true,
      cameraDay: true,
      exposure: 2,
      drivingS: 700,
      tripsScored: 2,
      severeEvents: 0,
    },
  ]);
});

Deno.test('a severe event on a scored trip is counted and forfeits the safe day', () => {
  const [row] = dayRows(
    [TRIP_DAY],
    [trip({ hadSevereEvent: true, durationS: 700 }), trip({ score: 80, phoneEvents: 2 })],
    good
  );
  assertEquals(row.safeDay, false);
  assertEquals(row.goodDay, true);
  assertEquals(row.phoneFreeDay, false);
  assertEquals(row.severeEvents, 1);
});

Deno.test('a day with no trips is all zeros but still carries the long-term score', () => {
  const rows = dayRows([TRIP_DAY, '2023-11-15'], [], withheld);
  assertEquals(rows.length, 2);
  assertEquals(rows[1], {
    day: '2023-11-15',
    longTermScore: null,
    band: null,
    provisional: true,
    safeDay: false,
    goodDay: false,
    phoneFreeDay: false,
    cameraDay: false,
    exposure: 0,
    drivingS: 0,
    tripsScored: 0,
    severeEvents: 0,
  });
});

Deno.test('median of an even count is the mean of the middle pair', () => {
  assertEquals(median([4, 1, 3]), 3);
  assertEquals(median([4, 1, 3, 2]), 2.5);
});

Deno.test('baselines are the 8-week medians per category and of the score', () => {
  const day = 86_400_000;
  const cat = (phone: number, speeding: number) => ({
    phone,
    speeding,
    braking: 0,
    accel: 0,
    cornering: 0,
    focus: 0,
  });
  const b = baselines(
    [
      { endedAt: T0 - 1 * day, score: 90, exposure: 1, durationS: 600, categoryDeductions: cat(0, 2) },
      { endedAt: T0 - 10 * day, score: 70, exposure: 1, durationS: 600, categoryDeductions: cat(4, 6) },
      { endedAt: T0 - 55 * day, score: 80, exposure: 1, durationS: 600, categoryDeductions: cat(10, 4) },
      // aged out of the window: must not move the medians
      { endedAt: T0 - 57 * day, score: 0, exposure: 1, durationS: 600, categoryDeductions: cat(30, 25) },
    ],
    T0
  );
  assertEquals(b, {
    medians: { phone: 4, speeding: 4, braking: 0, accel: 0, cornering: 0, focus: 0, score: 80 },
    computedAt: new Date(T0).toISOString(),
  });
});

Deno.test('no scored trips in the window means no baselines row', () => {
  assertEquals(baselines([], T0), null);
});
