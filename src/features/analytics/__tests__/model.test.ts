/** @jest-environment node */
import { AXES as SCORING_AXES, ratingAt, speedingChargedS, type DriveEvent, type Exposure } from '@scoring';

import { EMPTY_COUNTS, type LocalDrive } from '@/data/queries/rows';
import { encodePolyline, encodeRuns } from '@/lib/polyline';

import {
  allTimeTotals,
  AXES,
  AXIS_TIP,
  AXIS_TITLE,
  axisCoaching,
  BAND_LABELS,
  bandIndex,
  coach,
  coachWindow,
  COACH_DAYS,
  DASHPAL_AXIS,
  driveGrid,
  eventsByDrive,
  fitLines,
  fitRegion,
  GOOD_TIP,
  LEVEL_ICON,
  LEVEL_LABEL,
  LEVEL_TONE,
  levelFor,
  PENALTY_AXES,
  personalBests,
  PHONE_AXIS,
  radarScores,
  rangeStart,
  routeLines,
  scoredSince,
  showsTip,
  storedMiles,
  toRatingDrives,
  trend,
  trendDirection,
  trendRange,
  TREND_EVENT_DAYS,
  TREND_KINDS,
  weekdayIndex,
  windowRating,
  windowStart,
  timeComment,
  windowSums,
  type AxisScores,
  type DriveGrid,
} from '../model';

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** A 10 mi city drive's chances to slip, not watched for phone pickups. */
const EXPOSURE: Exposure = { slowdowns: 25, speedups: 25, turns: 20, limitS: 900, movingS: 1100, phoneS: 0 };

let seq = 0;
function drive(over: Partial<LocalDrive> = {}): LocalDrive {
  seq += 1;
  return {
    clientTripId: `d${String(seq).padStart(4, '0')}`,
    startedAt: 0,
    endedAt: null,
    miles: 10,
    durationS: 1200,
    nightMiles: 0,
    fromLabel: null,
    toLabel: null,
    polyline: null,
    status: 'scored',
    clean: true,
    counts: { ...EMPTY_COUNTS },
    result: null,
    reason: null,
    mergedInto: null,
    syncError: null,
    endCause: null,
    watchedMiles: 0,
    origin: 'manual',
    notDrivingExpired: false,
    continuations: 0,
    startSource: null,
    exposure: { ...EXPOSURE },
    exposureEstimated: false,
    ...over,
  } as LocalDrive;
}

function ev(over: Partial<DriveEvent> & Pick<DriveEvent, 'type'>): DriveEvent {
  seq += 1;
  return { id: `e${seq}`, tier: 'minor', startedAt: 0, durationS: 0, status: 'active', ...over };
}

const scores = (over: Partial<AxisScores> = {}): AxisScores => ({
  speed: 100,
  braking: 100,
  acceleration: 100,
  turning: 100,
  attention: 100,
  phone: 100,
  ...over,
});

/** `ratingAt` over these drives and events, whole numbers per category (what the radar shows). */
const wholeAt = (drives: readonly LocalDrive[], events: readonly DriveEvent[], at: number) => {
  const s = ratingAt(toRatingDrives(drives, events), at).scores;
  const r = (v: number | null) => (v === null ? null : Math.round(v));
  return { acceleration: r(s.acceleration), braking: r(s.braking), turning: r(s.turning), attention: r(s.attention), phone: r(s.phone), speed: r(s.speed) };
};

describe('axes', () => {
  test('radar order and labels: the scoring package’s six categories, Phone use between Attention and Speed', () => {
    expect(AXES.map((a) => a.key)).toEqual(['acceleration', 'braking', 'turning', 'attention', 'phone', 'speed']);
    expect(AXES.map((a) => a.key)).toEqual([...SCORING_AXES]);
    expect(AXES.map((a) => a.label)).toEqual(['Acceleration', 'Braking', 'Turning', 'Attention', 'Phone use', 'Speed']);
    expect(PENALTY_AXES).toEqual(['acceleration', 'braking', 'turning', 'attention', 'phone', 'speed']);
    expect(DASHPAL_AXIS).toBe('attention');
    expect(PHONE_AXIS).toBe('phone');
    expect(COACH_DAYS).toBe(90);
  });

  test('an event belongs to the latest drive started at or before it; one before every drive to none', () => {
    const a = drive({ startedAt: 1000 });
    const b = drive({ startedAt: 5000 });
    const e1 = ev({ type: 'hard_brake', startedAt: 1500 });
    const e2 = ev({ type: 'speeding', startedAt: 5000 });
    const e3 = ev({ type: 'speeding', startedAt: 500 });
    const own = eventsByDrive([b, a], [e2, e3, e1]);
    expect(own.get(a.clientTripId)).toEqual([e1]);
    expect(own.get(b.clientTripId)).toEqual([e2]);
    const rated = toRatingDrives([a, b], [e1, e2]);
    expect(rated.map((d) => [d.id, d.miles, d.events.length, d.exposure.slowdowns])).toEqual([
      [a.clientTripId, 10, 1, 25],
      [b.clientTripId, 10, 1, 25],
    ]);
  });

  test('the radar is ratingAt over the 90 days, as whole numbers: a hard brake counts against the slowdowns, not the miles', () => {
    const now = 200 * DAY;
    const list = [drive({ startedAt: now - DAY }), drive({ startedAt: now - 2 * DAY })];
    const brake = ev({ type: 'hard_brake', tier: 'severe', startedAt: now - DAY + 60_000 });
    const s = radarScores(list, [brake], now);
    expect(s).toEqual(wholeAt(list, [brake], now));
    expect(s.braking).toBeLessThan(s.acceleration!);
    // twice the slowdowns, the same brake: a better Braking score, the miles unchanged
    const busy = list.map((d) => ({ ...d, exposure: { ...d.exposure, slowdowns: 100 } }));
    expect(radarScores(busy, [brake], now).braking!).toBeGreaterThan(s.braking!);
    // nothing watched: no Attention score and no Phone use score; nothing driven: no scores
    expect(s.attention).toBeNull();
    expect(s.phone).toBeNull();
    expect(radarScores([], [], now)).toEqual({ speed: null, braking: null, acceleration: null, turning: null, attention: null, phone: null });
  });

  test('Phone use: no score until a drive was watched for pickups; then pickups and their time in hand count against the time at driving speed', () => {
    const now = 200 * DAY;
    const watched = (over: Partial<LocalDrive> = {}) => drive({ startedAt: now - DAY, ...over, exposure: { ...EXPOSURE, phoneS: 1000 } });
    const clean = radarScores([watched()], [], now);
    expect(clean.phone).not.toBeNull();
    const pickup = ev({ type: 'phone_pickup', tier: 'moderate', durationS: 12, startedAt: now - DAY + 60_000, measured: { speedMph: 30 } });
    const held = radarScores([watched()], [pickup], now);
    expect(held).toEqual(wholeAt([watched()], [pickup], now));
    expect(held.phone!).toBeLessThan(clean.phone!);
    // A longer time in hand weighs more.
    const longer = radarScores([watched()], [{ ...pickup, durationS: 40, tier: 'severe' }], now);
    expect(longer.phone!).toBeLessThan(held.phone!);
    // The other categories don't move.
    expect({ ...held, phone: null }).toEqual({ ...clean, phone: null });
  });

  test('the rating reads each drive’s miles as the server stores them (2 decimals), so the 10 mi ranked line falls where the server’s does', () => {
    expect([0, 1.004, 1.005, 4.995, 3.334, 12.3456, -1, Number.NaN].map(storedMiles)).toEqual([0, 1, 1.01, 5, 3.33, 12.35, 0, 0]);
    const now = 200 * DAY;
    // 3 × 3.334 mi: 10.002 on the phone's own decimals, but 9.99 as stored: the server says unranked.
    const short = [1, 2, 3].map((i) => drive({ clientTripId: `s${i}`, startedAt: now - i * DAY, miles: 3.334 }));
    expect(windowRating(short, [], now).ranked).toBe(false);
    // 2 × 4.995 mi: 9.99 on the phone's decimals, but 10.00 as stored: the server says ranked.
    const enough = [1, 2].map((i) => drive({ clientTripId: `e${i}`, startedAt: now - i * DAY, miles: 4.995 }));
    expect(windowRating(enough, [], now).ranked).toBe(true);
    // Watched miles follow the stored miles in proportion (the server's miles × the covered share).
    const watched = toRatingDrives([drive({ miles: 4.995, watchedMiles: 4.995 / 2 })], []);
    expect(watched[0]).toMatchObject({ miles: 5 });
    expect(watched[0]!.watchedMiles).toBeCloseTo(2.5, 10);
  });

  test('the Safety Rating is ratingAt’s: 1 decimal, ranked from 10 mi in the 90 days', () => {
    const now = 200 * DAY;
    const list = [drive({ startedAt: now - DAY, miles: 6 }), drive({ startedAt: now - 3 * DAY, miles: 6 })];
    const events = [ev({ type: 'speeding', tier: 'severe', durationS: 60, startedAt: now - DAY + 60_000, measured: { overMphS: 300 } })];
    const r = ratingAt(toRatingDrives(list, events), now);
    expect(windowRating(list, events, now)).toEqual({ rating: r.rating, ranked: true });
    expect(windowRating(list.slice(0, 1), [], now)).toMatchObject({ ranked: false });
    expect(windowRating([], [], now)).toEqual({ rating: null, ranked: false });
  });
});

describe('levels and coaching', () => {
  test('good ≥ 80, fair 60–79, poor < 60; icons, tones and words', () => {
    expect([100, 80, 79, 60, 59, 0].map(levelFor)).toEqual(['good', 'good', 'fair', 'fair', 'poor', 'poor']);
    expect(LEVEL_ICON).toEqual({ good: 'checkmark-circle', fair: 'warning', poor: 'alert-circle' });
    expect(LEVEL_TONE).toEqual({ good: 'success', fair: 'warning', poor: 'danger' });
    expect(LEVEL_LABEL).toEqual({ good: 'Good', fair: 'Fair', poor: 'Poor' });
  });

  test('every tip is one short line with no em dash; Phone use has its own', () => {
    for (const tip of [...Object.values(AXIS_TIP), GOOD_TIP]) {
      expect(tip.length).toBeLessThanOrEqual(60);
      expect(tip).not.toMatch(/[—!]/);
    }
    expect(Object.keys(AXIS_TIP).sort()).toEqual(['acceleration', 'attention', 'braking', 'phone', 'speed', 'turning']);
    expect(AXIS_TIP.phone).toBe('Put your phone away before you pull out.');
    expect(AXIS_TITLE.phone).toBe('Phone down while driving');
  });

  test('Phone use coaches like any axis once scored, and stays out while it has no score', () => {
    expect(coach(scores({ phone: 58 }), { drives: 5, miles: 50 })).toMatchObject({ level: 'poor', axis: 'phone', tip: AXIS_TIP.phone });
    expect(coach(scores({ phone: null }), { drives: 5, miles: 50 })).toMatchObject({ level: 'good' });
  });

  test('the weakest axis decides; ties go to radar order', () => {
    const c = coach(scores({ braking: 70, speed: 55, turning: 55 }), { drives: 5, miles: 50 });
    expect(c).toEqual({ level: 'poor', axis: 'turning', title: expect.any(String), tip: AXIS_TIP.turning, also: expect.any(Array) });
    expect(coach(scores({ speed: 75 }), { drives: 3, miles: 10 })).toMatchObject({ level: 'fair', axis: 'speed', tip: AXIS_TIP.speed });
  });

  test('Attention coaches like any axis when DashPal scored it, and stays out when it has no score', () => {
    expect(coach(scores({ attention: 55 }), { drives: 5, miles: 50 })).toMatchObject({ level: 'poor', axis: 'attention', tip: AXIS_TIP.attention });
    expect(coach(scores({ attention: 55, acceleration: 50 }), { drives: 5, miles: 50 })).toMatchObject({ axis: 'acceleration', also: [{ axis: 'attention', level: 'poor' }] });
    expect(coach(scores({ attention: null }), { drives: 5, miles: 50 })).toMatchObject({ level: 'good' });
  });

  test('all good is a compliment', () => {
    expect(coach(scores({ speed: 80 }), { drives: 5, miles: 50 })).toEqual({ level: 'good', axis: null, title: expect.any(String), tip: GOOD_TIP, also: [] });
  });

  test('also: the other fair or poor axes, weakest first, at most two, never the main axis', () => {
    const c = coach(scores({ speed: 75, braking: 65, acceleration: 40, turning: 85 }), { drives: 5, miles: 50 });
    expect(c.axis).toBe('acceleration');
    expect(c.also).toEqual([
      { axis: 'braking', level: 'fair' },
      { axis: 'speed', level: 'fair' },
    ]);
    const many = coach(scores({ speed: 50, braking: 55, acceleration: 30, turning: 59, attention: 58 }), { drives: 5, miles: 50 });
    expect(many.axis).toBe('acceleration');
    expect(many.also).toEqual([
      { axis: 'speed', level: 'poor' },
      { axis: 'braking', level: 'poor' },
    ]);
    expect(coach(scores({ braking: 70 }), { drives: 5, miles: 50 }).also).toEqual([]);
  });

  test('also: empty when good or without enough driving', () => {
    expect(coach(scores(), { drives: 5, miles: 50 }).also).toEqual([]);
    expect(coach(scores({ speed: 10, braking: 10 }), { drives: 2, miles: 50 }).also).toEqual([]);
    expect(coach(scores({ speed: null, braking: null, acceleration: null, turning: null, attention: null }), { drives: 5, miles: 50 }).also).toEqual([]);
  });

  test('fewer than 3 drives or 10 miles: no advice', () => {
    expect(coach(scores({ speed: 10 }), { drives: 2, miles: 50 }).level).toBeNull();
    expect(coach(scores({ speed: 10 }), { drives: 5, miles: 9.9 }).level).toBeNull();
    expect(coach(scores({ speed: 10 }), { drives: 5, miles: 9.9 }).axis).toBeNull();
  });

  test('Home shows the tip only for fair or poor', () => {
    expect(showsTip(coach(scores({ speed: 10 }), { drives: 5, miles: 50 }))).toBe(true);
    expect(showsTip(coach(scores({ speed: 65 }), { drives: 5, miles: 50 }))).toBe(true);
    expect(showsTip(coach(scores(), { drives: 5, miles: 50 }))).toBe(false);
    expect(showsTip(coach(scores({ speed: 10 }), { drives: 1, miles: 50 }))).toBe(false);
  });

  test('coachWindow sums the 90 days’ scored drives and rates them with one ratingAt call', () => {
    const now = 200 * DAY;
    const since = windowStart(now, 90);
    const list = [
      drive({ startedAt: now - DAY, miles: 6, clean: true, watchedMiles: 3 }),
      drive({ startedAt: now - 2 * DAY, miles: 4, clean: false }),
      drive({ startedAt: now - 3 * DAY, miles: 5, clean: true, status: 'pending' }),
      drive({ startedAt: now - 3 * DAY, miles: 50, status: 'not_driving' }),
      drive({ startedAt: now - 100 * DAY, miles: 100 }),
    ];
    const brakes = [1, 2, 3].map((i) => ev({ type: 'hard_brake', tier: 'severe', startedAt: now - 2 * DAY + i * 1000 }));
    const out = coachWindow(list, brakes, since, now);
    expect(out.totals).toEqual({ drives: 3, cleanDrives: 2, miles: 15, watchedMiles: 3 });
    const kept = scoredSince(list, since);
    expect(out.scores).toEqual(wholeAt(kept, brakes, now));
    const r = ratingAt(toRatingDrives(kept, brakes), now);
    expect(out.rating).toEqual({ rating: r.rating, ranked: true });
    expect(out.scores.braking!).toBeLessThan(85);
    expect(out.coaching.axis).toBe('braking');
    // Under 10 mi the rating is there but unranked (the radar shows a dash).
    expect(coachWindow(list.slice(0, 1), [], since, now).rating).toMatchObject({ ranked: false });
  });

  test("a category's own verdict: its tip when fair or poor, a compliment when good, the wait line without enough driving", () => {
    const enough = { drives: 3, miles: 10 };
    expect(axisCoaching('braking', 72, enough)).toEqual({ level: 'fair', title: 'Brake more gently', tip: AXIS_TIP.braking });
    expect(axisCoaching('attention', 55, enough)).toEqual({ level: 'poor', title: 'Stay focused', tip: AXIS_TIP.attention });
    expect(axisCoaching('turning', 80, enough)).toEqual({ level: 'good', title: 'Driving well', tip: 'Keep it up.' });
    const wait = { level: null, title: 'Tips are on the way', tip: 'Drive a few more times to get tips here.' };
    expect(axisCoaching('speed', 40, { drives: 2, miles: 50 })).toEqual(wait);
    expect(axisCoaching('speed', 40, { drives: 5, miles: 9 })).toEqual(wait);
    expect(axisCoaching('speed', null, enough)).toEqual(wait);
  });
});

describe('windows', () => {
  test('the cutoff floors now to the hour, then steps back 1, 7, 30 or 365 days', () => {
    const now = 1_000 * DAY + 5 * HOUR + 1234;
    expect(windowStart(now, 7)).toBe(1_000 * DAY + 5 * HOUR - 7 * DAY);
    expect(windowStart(now + 30 * 60_000, 7)).toBe(windowStart(now, 7));
    expect(rangeStart(now, 'day')).toBe(windowStart(now, 1));
    expect(rangeStart(now, 'week')).toBe(windowStart(now, 7));
    expect(rangeStart(now, 'month')).toBe(windowStart(now, 30));
    expect(rangeStart(now, 'year')).toBe(windowStart(now, 365));
  });

  test('sums scored drives in the window with their chances to slip, the time over the limit and the time in hand; DashPal counts apart', () => {
    const since = 10_000;
    const list = [
      drive({ startedAt: 20_000, miles: 10, durationS: 1800, nightMiles: 3, clean: true, counts: { ...EMPTY_COUNTS, eyesOff: 3, drowsy: 1 } }),
      drive({
        startedAt: 10_000,
        miles: 5,
        durationS: 1800,
        clean: false,
        counts: { ...EMPTY_COUNTS, speeding: 2, hardBrake: 1, hardAccel: 1, hardCorner: 3, pickups: 2 },
        exposure: { slowdowns: 12, speedups: 10, turns: 8, limitS: 600, movingS: 1500, phoneS: 1200 },
        exposureEstimated: true,
      }),
      drive({ startedAt: 9_000, miles: 100 }),
      drive({ startedAt: 30_000, status: 'unscored', reason: 'too_short', miles: 0.2 }),
    ];
    const events = [
      ev({ type: 'speeding', startedAt: 10_500, durationS: 40 }),
      ev({ type: 'speeding', startedAt: 11_000, durationS: 20, status: 'removed' }),
      ev({ type: 'speeding', startedAt: 12_000, durationS: 3 }),
      ev({ type: 'phone_pickup', tier: 'moderate', startedAt: 12_500, durationS: 9 }),
      ev({ type: 'phone_pickup', tier: 'severe', startedAt: 13_000, durationS: 24 }),
      ev({ type: 'phone_pickup', tier: 'moderate', startedAt: 13_500, durationS: 5, status: 'removed' }),
      // the drive before the window's: not counted
      ev({ type: 'speeding', startedAt: 9_500, durationS: 100 }),
      ev({ type: 'phone_pickup', tier: 'severe', startedAt: 9_600, durationS: 60 }),
    ];
    expect(windowSums(list, since, events)).toEqual({
      drives: 2,
      miles: 15,
      durationS: 3600,
      nightMiles: 3,
      nightPct: 20,
      avgMph: 15,
      speeding: 2,
      hardBrake: 1,
      hardAccel: 1,
      hardCorner: 3,
      slowdowns: 37,
      speedups: 35,
      turns: 28,
      limitS: 1500,
      speedingS: speedingChargedS(40) + speedingChargedS(3),
      pickups: 2,
      inHandS: 33,
      phoneS: 1200,
      exposureEstimated: true,
      eyesOff: 3,
      drowsy: 1,
      watchedMiles: 0,
      cleanDrives: 1,
      cleanPct: 50,
      avgMiles: 7.5,
    });
    expect(windowSums(list, null).drives).toBe(3);
    // without the events the time over the limit and in hand is unknown: 0
    expect(windowSums(list, since)).toMatchObject({ speedingS: 0, inHandS: 0, pickups: 2 });
  });

  test('an empty window has no averages and no clean rate', () => {
    expect(windowSums([], 0)).toMatchObject({ drives: 0, avgMph: null, cleanPct: null, nightPct: null, avgMiles: null, exposureEstimated: false });
    expect(windowSums([], 0)).not.toHaveProperty('points');
  });

  test('scoredSince keeps scored and uploading drives in the window, in order, never a short one', () => {
    const a = drive({ startedAt: 5 });
    const b = drive({ startedAt: 4, status: 'pending' });
    const c = drive({ startedAt: 3, status: 'merged' });
    const short = drive({ startedAt: 3, status: 'pending', reason: 'too_short' });
    const d = drive({ startedAt: 1 });
    expect(scoredSince([a, b, c, short, d], 2)).toEqual([a, b]);
  });
});

describe('personal bests', () => {
  test('the longest clean drive, over scored drives', () => {
    const a = drive({ miles: 8, clean: true });
    const b = drive({ miles: 30, clean: false, counts: { ...EMPTY_COUNTS, hardBrake: 1 } });
    const d = drive({ miles: 90, clean: true, status: 'not_driving' });
    const e = drive({ miles: 12, clean: true });
    expect(personalBests([a, b, d, e])).toEqual({ longestClean: { value: 12, clientTripId: e.clientTripId } });
  });

  test('none without a qualifying drive', () => {
    expect(personalBests([])).toEqual({ longestClean: null });
    expect(personalBests([drive({ clean: false })])).toEqual({ longestClean: null });
  });
});

describe('all-time totals', () => {
  test('every scored drive, whenever it was: the longest clean drive, the clean drives as the range counts them, the share after dark', () => {
    const old = drive({ clientTripId: 'old', startedAt: 0, endedAt: 1, miles: 20, nightMiles: 10, clean: true });
    const list = [
      drive({ clientTripId: 'a', miles: 10, nightMiles: 0, clean: true }),
      drive({ clientTripId: 'b', miles: 10, nightMiles: 0, clean: false }),
      drive({ clientTripId: 'gone', miles: 50, nightMiles: 50, clean: true, status: 'not_driving' }),
      old,
    ];
    expect(allTimeTotals(list)).toEqual({ longestClean: { value: 20, clientTripId: 'old' }, cleanDrives: 2, nightPct: 25 });
    expect(allTimeTotals(list).cleanDrives).toBe(windowSums(list, null).cleanDrives);
    expect(allTimeTotals([])).toEqual({ longestClean: null, cleanDrives: 0, nightPct: null });
  });
});

describe('when you drive', () => {
  test('local weekday Monday first and 3-hour bands', () => {
    // Local-time constructor: the same wall clock in any time zone. 2026-10-12 is a Monday.
    expect(weekdayIndex(new Date(2026, 9, 12, 8).getTime())).toBe(0);
    expect(weekdayIndex(new Date(2026, 9, 18, 23).getTime())).toBe(6);
    expect(bandIndex(new Date(2026, 9, 12, 0, 0).getTime())).toBe(0);
    expect(bandIndex(new Date(2026, 9, 12, 2, 59).getTime())).toBe(0);
    expect(bandIndex(new Date(2026, 9, 12, 17, 42).getTime())).toBe(5);
    expect(bandIndex(new Date(2026, 9, 12, 23, 59).getTime())).toBe(7);
    expect(BAND_LABELS).toHaveLength(8);
  });

  test('counts the window’s scored drives by weekday × band', () => {
    const since = new Date(2026, 9, 12).getTime();
    const g = driveGrid(
      [
        drive({ startedAt: new Date(2026, 9, 13, 7, 30).getTime() }), // Tue 6a
        drive({ startedAt: new Date(2026, 9, 13, 8, 10).getTime() }), // Tue 6a
        drive({ startedAt: new Date(2026, 9, 18, 21, 0).getTime() }), // Sun 9p
        drive({ startedAt: new Date(2026, 9, 14, 12, 0).getTime(), status: 'not_driving' }),
        drive({ startedAt: new Date(2026, 9, 11, 12, 0).getTime() }), // before the window
      ],
      since
    );
    expect(g.cells).toHaveLength(7);
    expect(g.cells.every((row) => row.length === 8)).toBe(true);
    expect(g.cells[1]![2]).toBe(2);
    expect(g.cells[6]![7]).toBe(1);
    expect(g.max).toBe(2);
    expect(g.total).toBe(3);
  });

  test('empty grid', () => {
    const g = driveGrid([], 0);
    expect(g).toMatchObject({ max: 0, total: 0 });
    expect(g.cells.flat().every((n) => n === 0)).toBe(true);
  });
});

describe('trip map', () => {
  test('route lines: one per run, malformed and single-point runs skipped', () => {
    const run1 = [
      { lat: 47.6, lng: -122.3 },
      { lat: 47.61, lng: -122.31 },
    ];
    const run2 = [
      { lat: 47.7, lng: -122.4 },
      { lat: 47.71, lng: -122.41 },
    ];
    const lines = routeLines([encodeRuns([run1, run2]), encodePolyline([{ lat: 1, lng: 1 }]), '']);
    expect(lines).toHaveLength(2);
    expect(lines[0]![0]).toEqual({ latitude: 47.6, longitude: -122.3 });
  });

  test('fitRegion centres on the median and spans the 10th–90th percentile × 1.6', () => {
    // 11 points at lat 40.0 … 41.0 and one far outlier: the median and the inner span ignore it.
    const pts = Array.from({ length: 11 }, (_, i) => ({ latitude: 40 + i / 10, longitude: -100 + i / 10 }));
    pts.push({ latitude: 60, longitude: -60 });
    const r = fitRegion(pts)!;
    // sorted 12 values: median index round(5.5) = 6 → 40.6; p10 index round(1.1) = 1 → 40.1; p90 index round(9.9) = 10 → 41.0
    expect(r.latitude).toBeCloseTo(40.6, 6);
    expect(r.longitude).toBeCloseTo(-99.4, 6);
    expect(r.latitudeDelta).toBeCloseTo(0.9 * 1.6, 6);
    expect(r.longitudeDelta).toBeCloseTo(0.9 * 1.6, 6);
  });

  test('fitRegion: at least 0.02° each way; null with no points', () => {
    expect(fitRegion([{ latitude: 47.6, longitude: -122.3 }])).toEqual({ latitude: 47.6, longitude: -122.3, latitudeDelta: 0.02, longitudeDelta: 0.02 });
    expect(fitRegion([])).toBeNull();
    expect(fitRegion([{ latitude: NaN, longitude: 1 }])).toBeNull();
    expect(fitLines([])).toBeNull();
    expect(fitLines([[{ latitude: 1, longitude: 2 }], [{ latitude: 3, longitude: 4 }]])).toMatchObject({ latitude: 3, longitude: 4 });
  });
});

describe('trend', () => {
  // A Wednesday noon, local time.
  const NOW = new Date(2026, 9, 14, 12, 0).getTime();
  const at = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m).getTime();
  const brakes = (n: number) => ({ ...EMPTY_COUNTS, hardBrake: n });
  /** The rating `ratingAt` gives these drives and events as of `when`, whole. */
  const rated = (list: readonly LocalDrive[], events: readonly DriveEvent[], when: number) => Math.round(ratingAt(toRatingDrives(list, events), when).rating!);

  test('two series, Score and Events; no Points', () => {
    expect(TREND_KINDS).toEqual(['score', 'events']);
    expect(trend([], [], 'week', NOW).series).toEqual({ score: [], events: [] });
  });

  test('a week: Score is the Safety Rating as of each day’s end, Events per mile per day with drives', () => {
    const tue1 = drive({ startedAt: at(13, 8), miles: 10, counts: brakes(1) });
    const tue2 = drive({ startedAt: at(13, 17), miles: 10, counts: { ...EMPTY_COUNTS, speeding: 1, pickups: 1 } });
    const fri = drive({ startedAt: at(9, 9), miles: 20 });
    // Before the range, inside every point's 90 days.
    const old = drive({ startedAt: at(6, 9), miles: 50 });
    const events = [
      ev({ type: 'hard_brake', tier: 'severe', startedAt: at(13, 8, 10) }),
      ev({ type: 'speeding', tier: 'moderate', startedAt: at(13, 17, 5), durationS: 40, measured: { overMphS: 120 } }),
      ev({ type: 'phone_pickup', tier: 'moderate', startedAt: at(13, 17, 8), durationS: 6 }),
      // DashPal counts only over the miles it watched (none here); a removed event counts nothing.
      ev({ type: 'drowsy', tier: 'severe', startedAt: at(13, 17, 12) }),
      ev({ type: 'hard_brake', tier: 'severe', startedAt: at(9, 9, 5), status: 'removed' }),
    ];
    const list = [tue2, tue1, fri, old];
    const t = trend(list, events, 'week', NOW);
    expect(t.step).toBe('day');
    // A rolling week touches 8 local days: last Wednesday afternoon through today.
    expect(t.ticks.map((k) => k.label)).toEqual(['W', 'T', 'F', 'S', 'S', 'M', 'T', 'W']);
    expect(t.ticks[0]!.x).toBe(0);
    expect(t.ticks[7]!.x).toBe(1);
    // Every day has a Score, drives of its own or not: the old drive's 50 mi rank each day.
    const values = t.series.score.map((q) => q.value);
    expect(values).toHaveLength(8);
    expect(values[5]).toBe(rated(list, events, at(13, 0) - 1));
    expect(values[6]).toBe(rated(list, events, at(14, 0) - 1));
    expect(values[6]!).toBeLessThan(values[5]!);
    expect(values[7]).toBe(rated(list, events, NOW));
    expect(t.series.score.map((q) => q.when)).toEqual(['last Wednesday', 'on Thursday', 'on Friday', 'on Saturday', 'on Sunday', 'on Monday', 'on Tuesday', 'today']);
    // Tuesday: a brake, a speeding and a phone pickup over 20 mi. Friday: none.
    expect(t.series.events).toEqual([
      { x: 2 / 7, value: 0, when: 'on Friday' },
      { x: 6 / 7, value: 3 / 20, when: 'on Tuesday' },
    ]);
  });

  test('the latest Score point is the radar’s centre: the same 90 days, the same arithmetic', () => {
    const list = [0.5, 3, 9, 20, 29, 60, 95].map((d, i) => drive({ startedAt: NOW - d * DAY, miles: 4 + i, watchedMiles: i % 2 === 0 ? 2 : 0 }));
    const events = [
      ev({ type: 'hard_brake', tier: 'severe', startedAt: NOW - 0.5 * DAY + 60_000 }),
      ev({ type: 'eyes_off', tier: 'severe', startedAt: NOW - 20 * DAY + 60_000 }),
      ev({ type: 'speeding', tier: 'severe', startedAt: NOW - 29 * DAY + 60_000 }),
      ev({ type: 'speeding', tier: 'severe', startedAt: NOW - 95 * DAY + 60_000 }),
    ];
    const end = NOW + HOUR - 1;
    const since = windowStart(end, 90);
    // The radar reads the window's own events (`readWindowEvents(since)`): those of drives started since.
    const own = events.filter((e) => e.startedAt >= since);
    const centre = coachWindow(list, own, since, end).rating;
    expect(centre.ranked).toBe(true);
    for (const range of ['day', 'week', 'month', 'year'] as const) {
      const score = trend(list, events, range, end).series.score;
      expect(score[score.length - 1]!.value).toBe(Math.round(centre.rating!));
    }
  });

  test('Score needs 10 mi in a point’s 90 days; an event belongs to the latest drive started at or before it', () => {
    // 12 mi on Jul 10 rank the days that still hold it (to Oct 7), then leave.
    const jul = drive({ startedAt: new Date(2026, 6, 10, 9).getTime(), miles: 12 });
    // Monday 23:50: its brake at 00:10 is still its own.
    const late = drive({ startedAt: at(12, 23, 50), miles: 5 });
    const today = drive({ startedAt: at(14, 7), miles: 6 });
    const events = [
      // Before any drive the trend holds: nobody's, so nothing.
      ev({ type: 'speeding', tier: 'severe', startedAt: new Date(2026, 6, 8, 9).getTime() }),
      ev({ type: 'hard_brake', tier: 'severe', startedAt: at(13, 0, 10) }),
    ];
    const list = [today, late, jul];
    const t = trend(list, events, 'week', NOW);
    expect(t.series.score.map((q) => q.when)).toEqual(['last Wednesday', 'today']);
    // today holds 11 mi with Monday's brake
    expect(t.series.score.at(-1)!.value).toBe(rated([today, late], events.slice(1), NOW));
    expect(t.series.score.at(-1)!.value).toBeLessThan(100);
  });

  test('Score waits for the events; a slot with no miles has no Events point', () => {
    const t = trend([drive({ startedAt: at(13, 8), miles: 6 }), drive({ startedAt: at(11, 8), miles: 0 })], null, 'week', NOW);
    expect(t.series.score).toEqual([]);
    expect(t.series.events.map((q) => q.when)).toEqual(['on Tuesday']);
  });

  test('unscored drives stay out', () => {
    const t = trend(
      [drive({ startedAt: at(13, 8), status: 'unscored', reason: 'too_short' }), drive({ startedAt: at(13, 9), status: 'not_driving' })],
      [],
      'month',
      NOW
    );
    expect(t.series.events).toEqual([]);
    expect(t.series.score).toEqual([]);
  });

  test('a day is a point per drive, placed by its start time, with 6-hour marks; Score also ends now', () => {
    const t = trend([drive({ startedAt: at(14, 8, 15) }), drive({ startedAt: at(13, 18) })], [], 'day', NOW);
    expect(t.step).toBe('drive');
    expect(t.ticks).toEqual([
      { x: 0, label: '12p' },
      { x: 0.25, label: '6p' },
      { x: 0.5, label: '12a' },
      { x: 0.75, label: '6a' },
      { x: 1, label: '12p' },
    ]);
    expect(t.series.events).toEqual([
      { x: 0.25, value: 0, when: 'at 6:00 PM' },
      { x: (20.25 * HOUR) / DAY, value: 0, when: 'at 8:15 AM' },
    ]);
    expect(t.series.score.map((q) => [q.x, q.when])).toEqual([
      [0.25, 'at 6:00 PM'],
      [(20.25 * HOUR) / DAY, 'at 8:15 AM'],
      [1, 'now'],
    ]);
  });

  test('a month is a point per Monday-first week', () => {
    const t = trend([drive({ startedAt: at(13, 8) }), drive({ startedAt: at(12, 8) }), drive({ startedAt: new Date(2026, 8, 20, 9).getTime() })], [], 'month', NOW);
    expect(t.step).toBe('week');
    expect(t.ticks.map((k) => k.label)).toEqual(['Sep 14', 'Sep 21', 'Sep 28', 'Oct 5', 'Oct 12']);
    expect(t.series.events.map((q) => [q.x, q.when])).toEqual([
      [0, 'in the week of Sep 14'],
      [1, 'in the week of Oct 12'],
    ]);
    expect(t.series.score.map((q) => q.when)).toEqual(['in the week of Sep 14', 'in the week of Sep 21', 'in the week of Sep 28', 'in the week of Oct 5', 'in the week of Oct 12']);
  });

  test('a year is a point per month; the two months that share a name say their year', () => {
    const t = trend([drive({ startedAt: at(13, 8) }), drive({ startedAt: new Date(2026, 2, 3).getTime() }), drive({ startedAt: new Date(2025, 9, 20).getTime() })], [], 'year', NOW);
    expect(t.step).toBe('month');
    expect(t.ticks.map((k) => k.label).join('')).toBe('ONDJFMAMJJASO');
    expect(t.series.events.map((q) => [q.x, q.when])).toEqual([
      [0, 'in October 2025'],
      [5 / 12, 'in March'],
      [1, 'in October 2026'],
    ]);
    // A month has a Score while the 90 days to its end hold a drive's 10 mi.
    expect(t.series.score.map((q) => q.when)).toEqual(['in October 2025', 'in November', 'in December', 'in March', 'in April', 'in May', 'in October 2026']);
  });

  test('the events reach back a year and the 90 days before it', () => {
    expect(TREND_EVENT_DAYS).toBe(455);
  });

  test('range: Score is 0–100; Events pads its spread and never goes below 0', () => {
    expect(trendRange('score', [40, 90])).toEqual({ lo: 0, hi: 100 });
    expect(trendRange('events', [1, 3])).toEqual({ lo: 0.7, hi: 3.3 });
    expect(trendRange('events', [0, 10])).toEqual({ lo: 0, hi: 11.5 });
    const flat = trendRange('events', [0.1, 0.1]);
    expect(flat.lo).toBeCloseTo(0.05);
    expect(flat.hi).toBeCloseTo(0.15);
    expect(trendRange('events', [])).toEqual({ lo: 0, hi: 1 });
  });

  test('direction: the least-squares change across the points, steady under 5 % of the range', () => {
    const pts = (...v: number[]) => v.map((value, i) => ({ x: i / Math.max(1, v.length - 1), value }));
    expect(trendDirection(pts(60, 70, 80), 100)).toBe('up');
    expect(trendDirection(pts(80, 70, 60), 100)).toBe('down');
    expect(trendDirection(pts(80, 82, 81), 100)).toBe('steady');
    // One low point in the middle does not make a trend.
    expect(trendDirection(pts(90, 40, 90), 100)).toBe('steady');
    expect(trendDirection(pts(90), 100)).toBe('steady');
  });
});

describe('time of day comment', () => {
  /** A grid with `n` drives in each [weekday, band] given. */
  const grid = (cells: [number, number, number][]): DriveGrid => {
    const g = Array.from({ length: 7 }, () => new Array<number>(8).fill(0));
    let total = 0;
    for (const [d, b, n] of cells) {
      g[d]![b]! += n;
      total += n;
    }
    return { cells: g, max: Math.max(...g.flat()), total };
  };

  test('no drives: nothing; under 3: asks for a few more', () => {
    expect(timeComment(grid([]), null)).toBeNull();
    expect(timeComment(grid([[0, 4, 2]]), 0)?.kind).toBe('few');
  });

  test('the first rule that fits speaks', () => {
    // a quarter or more starting midnight–6am
    expect(timeComment(grid([[2, 0, 1], [2, 4, 3]]), 10)?.kind).toBe('late');
    // 40 % of the miles after dark, with the share
    expect(timeComment(grid([[2, 6, 4]]), 45)).toEqual({ kind: 'dark', text: 'About 45% of your miles are after dark. Give yourself a bit more room at night.' });
    // half or more on a weekday 6–9am or 3–6pm
    expect(timeComment(grid([[0, 2, 2], [3, 5, 2], [5, 4, 1]]), 5)?.kind).toBe('rush');
    // 60 % or more on the weekend
    expect(timeComment(grid([[5, 6, 2], [6, 6, 2], [2, 6, 1]]), 5)?.kind).toBe('weekend');
    // 70 % or more 9am–6pm
    expect(timeComment(grid([[1, 3, 3], [2, 4, 3], [4, 6, 1]]), 5)?.kind).toBe('daytime');
  });

  test('otherwise the busiest time, and the share after dark when it is 15 % or more', () => {
    expect(timeComment(grid([[4, 6, 3], [1, 7, 1], [2, 3, 1]]), 20)).toEqual({
      kind: 'busiest',
      text: 'Your busiest time is Fridays, 6–9pm. About 20% of your miles are after dark.',
    });
    expect(timeComment(grid([[4, 6, 3], [1, 7, 1], [2, 3, 1]]), 5)?.text).toBe('Your busiest time is Fridays, 6–9pm.');
  });

  test('every line is short, friendly and free of points, scores and em dashes', () => {
    const lines = [
      timeComment(grid([[0, 4, 2]]), 0),
      timeComment(grid([[2, 0, 1], [2, 4, 3]]), 10),
      timeComment(grid([[2, 6, 4]]), 45),
      timeComment(grid([[0, 2, 2], [3, 5, 2], [5, 4, 1]]), 5),
      timeComment(grid([[5, 6, 2], [6, 6, 2], [2, 6, 1]]), 5),
      timeComment(grid([[1, 3, 3], [2, 4, 3], [4, 6, 1]]), 5),
      timeComment(grid([[4, 6, 3], [1, 7, 1], [2, 3, 1]]), 20),
    ];
    for (const c of lines) {
      expect(c!.text.length).toBeLessThanOrEqual(110);
      expect(c!.text).not.toMatch(/—|!|points|score/i);
    }
  });
});
