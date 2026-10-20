/** @jest-environment node */
import { ratingPenalty, safetyRating, type DriveEvent } from '@scoring';

import { EMPTY_COUNTS, type LocalDrive } from '@/data/queries/rows';
import { encodePolyline, encodeRuns } from '@/lib/polyline';

import {
  AXES,
  AXIS_TIP,
  axisCoaching,
  axisOf,
  axisPenalties,
  axisScores,
  BAND_LABELS,
  bandIndex,
  coach,
  coachWindow,
  driveGrid,
  fitLines,
  fitRegion,
  GOOD_TIP,
  LEVEL_ICON,
  LEVEL_LABEL,
  LEVEL_TONE,
  levelFor,
  personalBests,
  rangeStart,
  routeLines,
  scoredSince,
  showsTip,
  trend,
  trendDirection,
  trendRange,
  weekdayIndex,
  windowStart,
  windowSums,
  type AxisScores,
} from '../model';

const HOUR = 3_600_000;
const DAY = 86_400_000;

let seq = 0;
function drive(over: Partial<LocalDrive> = {}): LocalDrive {
  seq += 1;
  return {
    clientTripId: `d${seq}`,
    startedAt: 0,
    endedAt: null,
    miles: 10,
    durationS: 1200,
    nightMiles: 0,
    fromLabel: null,
    toLabel: null,
    polyline: null,
    status: 'scored',
    pointsNet: 100,
    estimate: false,
    clean: true,
    counts: { ...EMPTY_COUNTS },
    result: null,
    reason: null,
    mergedInto: null,
    syncError: null,
    endCause: null,
    ...over,
  };
}

function ev(over: Partial<DriveEvent> & Pick<DriveEvent, 'type'>): DriveEvent {
  seq += 1;
  return { id: `e${seq}`, tier: 'minor', startedAt: 0, durationS: 0, status: 'active', ...over };
}

const scores = (over: Partial<AxisScores> = {}): AxisScores => ({
  speeding: 100,
  braking: 100,
  accel: 100,
  cornering: 100,
  phone: 100,
  clean: 100,
  ...over,
});

describe('axes', () => {
  test('radar order and labels', () => {
    expect(AXES.map((a) => a.key)).toEqual(['speeding', 'braking', 'accel', 'cornering', 'phone', 'clean']);
    expect(AXES.map((a) => a.label)).toEqual(['Speeding', 'Braking', 'Acceleration', 'Cornering', 'Phone use', 'Clean drives']);
  });

  test('each event type maps to its axis; DashPal events to none', () => {
    expect(axisOf('speeding')).toBe('speeding');
    expect(axisOf('hard_brake')).toBe('braking');
    expect(axisOf('hard_accel')).toBe('accel');
    expect(axisOf('hard_corner')).toBe('cornering');
    expect(axisOf('phone_pickup')).toBe('phone');
    expect(axisOf('phone_handling')).toBe('phone');
    expect(axisOf('eyes_off')).toBeNull();
    expect(axisOf('drowsy')).toBeNull();
  });

  test('penalties are the rating penalties per axis; removed and DashPal events count nothing', () => {
    const p = axisPenalties([
      ev({ type: 'speeding', tier: 'moderate' }),
      ev({ type: 'speeding', tier: 'severe', status: 'removed' }),
      ev({ type: 'hard_brake', tier: 'severe' }),
      ev({ type: 'phone_pickup', tier: 'severe', stoppedInTraffic: true }),
      ev({ type: 'phone_handling', tier: 'severe', units: 3 }),
      ev({ type: 'eyes_off', tier: 'severe' }),
      ev({ type: 'drowsy', tier: 'severe' }),
    ]);
    expect(p).toEqual({ speeding: 40, braking: 25, accel: 0, cornering: 0, phone: 20 + 30 });
  });

  test('S = clamp(100 − 10·P/miles); clean = clean / drives; whole numbers', () => {
    const s = axisScores(
      [ev({ type: 'speeding', tier: 'minor' }), ev({ type: 'hard_accel', tier: 'severe' }), ev({ type: 'phone_pickup', tier: 'severe' })],
      { drives: 3, cleanDrives: 2, miles: 20 }
    );
    // 100 − 10·15/20 = 92.5 → 93; 100 − 10·30/20 = 85; 100 − 10·40/20 = 80; clean 66.7 → 67
    expect(s).toEqual({ speeding: 93, braking: 100, accel: 85, cornering: 100, phone: 80, clean: 67 });
  });

  test('scores clamp at 0 and are null with no miles or drives', () => {
    expect(axisScores([ev({ type: 'speeding', tier: 'severe' })], { drives: 1, cleanDrives: 0, miles: 1 }).speeding).toBe(0);
    expect(axisScores([], { drives: 0, cleanDrives: 0, miles: 0 })).toEqual({
      speeding: null,
      braking: null,
      accel: null,
      cornering: null,
      phone: null,
      clean: null,
    });
    expect(axisScores([], { drives: 1, cleanDrives: 1, miles: 0 }).clean).toBe(100);
  });

  test('the penalty axes add up to the Safety Rating over the same window', () => {
    const events = [
      ev({ type: 'speeding', tier: 'minor' }),
      ev({ type: 'hard_brake', tier: 'minor' }),
      ev({ type: 'hard_corner', tier: 'severe' }),
      ev({ type: 'phone_handling', tier: 'moderate', units: 2 }),
    ];
    const miles = 200;
    const pen = events.reduce((sum, e) => sum + ratingPenalty(e), 0);
    const rating = safetyRating(pen, miles).rating!;
    const p = axisPenalties(events);
    const deficits = Object.values(p).reduce((sum, v) => sum + (10 * v) / miles, 0);
    expect(100 - deficits).toBeCloseTo(rating, 1);
  });
});

describe('levels and coaching', () => {
  test('good ≥ 80, fair 60–79, poor < 60; icons, tones and words', () => {
    expect([100, 80, 79, 60, 59, 0].map(levelFor)).toEqual(['good', 'good', 'fair', 'fair', 'poor', 'poor']);
    expect(LEVEL_ICON).toEqual({ good: 'checkmark-circle', fair: 'warning', poor: 'alert-circle' });
    expect(LEVEL_TONE).toEqual({ good: 'success', fair: 'warning', poor: 'danger' });
    expect(LEVEL_LABEL).toEqual({ good: 'Good', fair: 'Fair', poor: 'Poor' });
  });

  test('every tip is one short line with no em dash', () => {
    for (const tip of [...Object.values(AXIS_TIP), GOOD_TIP]) {
      expect(tip.length).toBeLessThanOrEqual(60);
      expect(tip).not.toMatch(/[—!]/);
    }
  });

  test('the weakest penalty axis decides; ties go to radar order', () => {
    const c = coach(scores({ braking: 70, phone: 55, cornering: 55 }), { drives: 5, miles: 50 });
    expect(c).toEqual({ level: 'poor', axis: 'cornering', title: expect.any(String), tip: AXIS_TIP.cornering, also: expect.any(Array) });
    expect(coach(scores({ speeding: 75 }), { drives: 3, miles: 10 })).toMatchObject({ level: 'fair', axis: 'speeding', tip: AXIS_TIP.speeding });
  });

  test('clean drives speak only when every penalty axis is good', () => {
    expect(coach(scores({ clean: 40 }), { drives: 5, miles: 50 })).toMatchObject({ level: 'poor', axis: 'clean', tip: AXIS_TIP.clean });
    expect(coach(scores({ clean: 40, accel: 70 }), { drives: 5, miles: 50 })).toMatchObject({ level: 'fair', axis: 'accel' });
  });

  test('all good is a compliment', () => {
    expect(coach(scores({ speeding: 80 }), { drives: 5, miles: 50 })).toEqual({ level: 'good', axis: null, title: expect.any(String), tip: GOOD_TIP, also: [] });
  });

  test('also: the other fair or poor penalty axes, weakest first, ties in radar order', () => {
    const c = coach(scores({ speeding: 75, braking: 65, phone: 40, cornering: 85 }), { drives: 5, miles: 50 });
    expect(c.axis).toBe('phone');
    expect(c.also).toEqual([
      { axis: 'braking', level: 'fair' },
      { axis: 'speeding', level: 'fair' },
    ]);
    expect(coach(scores({ phone: 55, braking: 70, cornering: 55 }), { drives: 5, miles: 50 }).also).toEqual([
      { axis: 'phone', level: 'poor' },
      { axis: 'braking', level: 'fair' },
    ]);
  });

  test('also: at most two, never the main axis, empty with nothing else to watch', () => {
    const c = coach(scores({ speeding: 50, braking: 55, accel: 58, cornering: 59, phone: 30 }), { drives: 5, miles: 50 });
    expect(c.axis).toBe('phone');
    expect(c.also).toEqual([
      { axis: 'speeding', level: 'poor' },
      { axis: 'braking', level: 'poor' },
    ]);
    expect(coach(scores({ braking: 70 }), { drives: 5, miles: 50 }).also).toEqual([]);
    expect(coach(scores({ braking: 70, phone: null }), { drives: 5, miles: 50 }).also).toEqual([]);
  });

  test('also: the clean-drive share never joins in', () => {
    expect(coach(scores({ braking: 70, clean: 20 }), { drives: 5, miles: 50 }).also).toEqual([]);
    expect(coach(scores({ clean: 40 }), { drives: 5, miles: 50 })).toMatchObject({ axis: 'clean', also: [] });
  });

  test('also: empty when good or without enough driving', () => {
    expect(coach(scores(), { drives: 5, miles: 50 }).also).toEqual([]);
    expect(coach(scores({ phone: 10, braking: 10 }), { drives: 2, miles: 50 }).also).toEqual([]);
    expect(coach(scores({ speeding: null, braking: null, accel: null, cornering: null, phone: null, clean: null }), { drives: 5, miles: 50 }).also).toEqual([]);
  });

  test('fewer than 3 drives or 10 miles: no advice', () => {
    expect(coach(scores({ phone: 10 }), { drives: 2, miles: 50 }).level).toBeNull();
    expect(coach(scores({ phone: 10 }), { drives: 5, miles: 9.9 }).level).toBeNull();
    expect(coach(scores({ phone: 10 }), { drives: 5, miles: 9.9 }).axis).toBeNull();
  });

  test('Home shows the tip only for fair or poor', () => {
    expect(showsTip(coach(scores({ phone: 10 }), { drives: 5, miles: 50 }))).toBe(true);
    expect(showsTip(coach(scores({ phone: 65 }), { drives: 5, miles: 50 }))).toBe(true);
    expect(showsTip(coach(scores(), { drives: 5, miles: 50 }))).toBe(false);
    expect(showsTip(coach(scores({ phone: 10 }), { drives: 1, miles: 50 }))).toBe(false);
  });

  test('coachWindow sums the window’s scored drives and scores the given events', () => {
    const now = 100 * DAY;
    const since = windowStart(now, 30);
    const drives = [
      drive({ startedAt: now - DAY, miles: 6, clean: true }),
      drive({ startedAt: now - 2 * DAY, miles: 4, clean: false }),
      drive({ startedAt: now - 3 * DAY, miles: 5, clean: true, status: 'pending', pointsNet: 10 }),
      drive({ startedAt: now - 3 * DAY, miles: 50, status: 'not_driving' }),
      drive({ startedAt: now - 40 * DAY, miles: 100 }),
    ];
    const brakes = [1, 2, 3].map(() => ev({ type: 'hard_brake', tier: 'severe' }));
    const out = coachWindow(drives, brakes, since);
    expect(out.totals).toEqual({ drives: 3, cleanDrives: 2, miles: 15 });
    expect(out.scores.braking).toBe(50);
    expect(out.scores.clean).toBe(67);
    expect(out.coaching).toMatchObject({ level: 'poor', axis: 'braking' });
  });

  test("a category's own verdict: its tip when fair or poor, a compliment when good, the wait line without enough driving", () => {
    const enough = { drives: 3, miles: 10 };
    expect(axisCoaching('braking', 72, enough)).toEqual({ level: 'fair', title: 'Brake more gently', tip: AXIS_TIP.braking });
    expect(axisCoaching('clean', 40, enough)).toEqual({ level: 'poor', title: 'More clean drives', tip: AXIS_TIP.clean });
    expect(axisCoaching('cornering', 80, enough)).toEqual({ level: 'good', title: 'Driving well', tip: 'Keep it up.' });
    const wait = { level: null, title: 'Tips are on the way', tip: 'Drive a few more times to get tips here.' };
    expect(axisCoaching('speeding', 40, { drives: 2, miles: 50 })).toEqual(wait);
    expect(axisCoaching('speeding', 40, { drives: 5, miles: 9 })).toEqual(wait);
    expect(axisCoaching('speeding', null, enough)).toEqual(wait);
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

  test('sums scored drives in the window; DashPal counts stay out; avg speed, clean share and per-drive averages', () => {
    const since = 1_000;
    const drives = [
      drive({ startedAt: 2_000, miles: 10, durationS: 1800, pointsNet: 120, clean: true, counts: { ...EMPTY_COUNTS, eyesOff: 3, drowsy: 1 } }),
      drive({
        startedAt: 1_000,
        miles: 5,
        durationS: 1800,
        pointsNet: -30,
        clean: false,
        counts: { ...EMPTY_COUNTS, speeding: 2, hardBrake: 1, hardAccel: 1, hardCorner: 3, pickups: 1, handlingS: 45 },
      }),
      drive({ startedAt: 999, miles: 100, pointsNet: 999 }),
      drive({ startedAt: 3_000, status: 'unscored', pointsNet: null, miles: 0.2 }),
      drive({ startedAt: 3_000, status: 'pending', pointsNet: null }),
    ];
    expect(windowSums(drives, since)).toEqual({
      drives: 2,
      miles: 15,
      durationS: 3600,
      avgMph: 15,
      speeding: 2,
      hardBrake: 1,
      hardAccel: 1,
      hardCorner: 3,
      pickups: 1,
      handlingS: 45,
      cleanDrives: 1,
      cleanPct: 50,
      points: 90,
      avgMiles: 7.5,
      avgPoints: 45,
    });
    expect(windowSums(drives, null).drives).toBe(3);
  });

  test('an empty window has no averages and no clean share', () => {
    expect(windowSums([], 0)).toMatchObject({ drives: 0, avgMph: null, cleanPct: null, points: 0, avgMiles: null, avgPoints: null });
  });

  test('scoredSince keeps scored and pending-with-points drives in the window, in order', () => {
    const a = drive({ startedAt: 5 });
    const b = drive({ startedAt: 4, status: 'pending', pointsNet: 3 });
    const c = drive({ startedAt: 3, status: 'merged' });
    const d = drive({ startedAt: 1 });
    expect(scoredSince([a, b, c, d], 2)).toEqual([a, b]);
  });
});

describe('personal bests', () => {
  test('most points, longest clean and longest phone-free drive, over scored drives', () => {
    const a = drive({ pointsNet: 150, miles: 8, clean: true });
    const b = drive({ pointsNet: 90, miles: 30, clean: false, counts: { ...EMPTY_COUNTS, hardBrake: 1 } });
    const c = drive({ pointsNet: 40, miles: 40, clean: false, counts: { ...EMPTY_COUNTS, pickups: 1 } });
    const d = drive({ pointsNet: 500, miles: 90, clean: true, status: 'not_driving' });
    const e = drive({ pointsNet: 150, miles: 12, clean: true, counts: { ...EMPTY_COUNTS, handlingS: 5 } });
    expect(personalBests([a, b, c, d, e])).toEqual({
      mostPoints: { value: 150, clientTripId: a.clientTripId },
      longestClean: { value: 12, clientTripId: e.clientTripId },
      longestPhoneFree: { value: 30, clientTripId: b.clientTripId },
    });
  });

  test('none without a qualifying drive', () => {
    expect(personalBests([])).toEqual({ mostPoints: null, longestClean: null, longestPhoneFree: null });
    const dirty = drive({ clean: false, counts: { ...EMPTY_COUNTS, pickups: 2 }, pointsNet: null, status: 'pending' });
    expect(personalBests([dirty])).toEqual({ mostPoints: null, longestClean: null, longestPhoneFree: null });
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

  test('a week is a point per local day with drives: Score on the rating’s scale, events per 100 mi, points per drive', () => {
    const tue1 = drive({ startedAt: at(13, 8), miles: 10, pointsNet: 100, counts: brakes(1) });
    const tue2 = drive({ startedAt: at(13, 17), miles: 10, pointsNet: 50, counts: { ...EMPTY_COUNTS, speeding: 1, pickups: 1, handlingS: 30 } });
    const fri = drive({ startedAt: at(9, 9), miles: 20, pointsNet: 120 });
    const old = drive({ startedAt: at(6, 9), miles: 50, pointsNet: 999 });
    const events = [
      ev({ type: 'hard_brake', tier: 'severe', startedAt: at(13, 8, 10) }),
      ev({ type: 'speeding', tier: 'moderate', startedAt: at(13, 17, 5), durationS: 40 }),
      ev({ type: 'phone_pickup', startedAt: at(13, 17, 9) }),
      // DashPal never counts toward the rating; a removed event counts nothing.
      ev({ type: 'drowsy', tier: 'severe', startedAt: at(13, 17, 12) }),
      ev({ type: 'hard_brake', tier: 'severe', startedAt: at(9, 9, 5), status: 'removed' }),
    ];
    const t = trend([tue2, tue1, fri, old], events, 'week', NOW);
    expect(t.step).toBe('day');
    // A rolling week touches 8 local days: last Wednesday afternoon through today.
    expect(t.ticks.map((k) => k.label)).toEqual(['W', 'T', 'F', 'S', 'S', 'M', 'T', 'W']);
    expect(t.ticks[0]!.x).toBe(0);
    expect(t.ticks[7]!.x).toBe(1);
    const p = events.slice(0, 3).reduce((sum, e) => sum + ratingPenalty(e), 0);
    expect(t.series.score).toEqual([
      { x: 2 / 7, value: 100, when: 'on Friday' },
      { x: 6 / 7, value: Math.round(safetyRating(p, 20).rating!), when: 'on Tuesday' },
    ]);
    expect(t.series.score[1]!.value).toBeLessThan(100);
    // Tuesday: a brake, a speeding and a pickup over 20 mi; handling time is not a count.
    expect(t.series.events.map((q) => q.value)).toEqual([0, 15]);
    expect(t.series.points.map((q) => q.value)).toEqual([120, 75]);
  });

  test('today, last week’s same weekday, and a drive at midnight keep its events', () => {
    const lastWed = drive({ startedAt: at(7, 15), miles: 4 });
    const today = drive({ startedAt: at(14, 7), miles: 4 });
    // Started Monday 23:50: its event at 00:10 still counts on Monday.
    const late = drive({ startedAt: at(12, 23, 50), miles: 5 });
    const events = [ev({ type: 'hard_brake', tier: 'severe', startedAt: at(13, 0, 10) }), ev({ type: 'hard_brake', startedAt: at(1, 0) })];
    const t = trend([today, late, lastWed], events, 'week', NOW);
    expect(t.series.points.map((q) => q.when)).toEqual(['last Wednesday', 'on Monday', 'today']);
    expect(t.series.score.map((q) => q.value)).toEqual([100, Math.round(safetyRating(ratingPenalty(events[0]!), 5).rating!), 100]);
  });

  test('Score waits for the events; a slot with no miles has Points only', () => {
    const t = trend([drive({ startedAt: at(13, 8), miles: 6 }), drive({ startedAt: at(11, 8), miles: 0, pointsNet: -20 })], null, 'week', NOW);
    expect(t.series.score).toEqual([]);
    expect(t.series.events).toHaveLength(1);
    expect(t.series.points.map((q) => q.value)).toEqual([-20, 100]);
    expect(trend([], [], 'week', NOW).series).toEqual({ score: [], events: [], points: [] });
  });

  test('unscored drives and drives before the range stay out', () => {
    const t = trend(
      [drive({ startedAt: at(13, 8), status: 'unscored', pointsNet: null }), drive({ startedAt: at(13, 9), status: 'not_driving', pointsNet: null }), drive({ startedAt: new Date(2026, 8, 1, 9).getTime() })],
      [],
      'month',
      NOW
    );
    expect(t.series.points).toEqual([]);
  });

  test('a day is a point per drive, placed by its start time, with 6-hour marks', () => {
    const t = trend([drive({ startedAt: at(14, 8, 15), pointsNet: 40 }), drive({ startedAt: at(13, 18) })], [], 'day', NOW);
    expect(t.step).toBe('drive');
    expect(t.ticks).toEqual([
      { x: 0, label: '12p' },
      { x: 0.25, label: '6p' },
      { x: 0.5, label: '12a' },
      { x: 0.75, label: '6a' },
      { x: 1, label: '12p' },
    ]);
    expect(t.series.points).toEqual([
      { x: 0.25, value: 100, when: 'at 6:00 PM' },
      { x: (20.25 * HOUR) / DAY, value: 40, when: 'at 8:15 AM' },
    ]);
  });

  test('a month is a point per Monday-first week', () => {
    const t = trend([drive({ startedAt: at(13, 8) }), drive({ startedAt: at(12, 8) }), drive({ startedAt: new Date(2026, 8, 20, 9).getTime() })], [], 'month', NOW);
    expect(t.step).toBe('week');
    expect(t.ticks.map((k) => k.label)).toEqual(['Sep 14', 'Sep 21', 'Sep 28', 'Oct 5', 'Oct 12']);
    expect(t.series.points.map((q) => [q.x, q.when])).toEqual([
      [0, 'in the week of Sep 14'],
      [1, 'in the week of Oct 12'],
    ]);
  });

  test('a year is a point per month; the two months that share a name say their year', () => {
    const t = trend([drive({ startedAt: at(13, 8) }), drive({ startedAt: new Date(2026, 2, 3).getTime() }), drive({ startedAt: new Date(2025, 9, 20).getTime() })], [], 'year', NOW);
    expect(t.step).toBe('month');
    expect(t.ticks.map((k) => k.label).join('')).toBe('ONDJFMAMJJASO');
    expect(t.series.points.map((q) => [q.x, q.when])).toEqual([
      [0, 'in October 2025'],
      [5 / 12, 'in March'],
      [1, 'in October 2026'],
    ]);
  });

  test('range: Score is 0–100; Events and Points pad their spread, Events never below 0', () => {
    expect(trendRange('score', [40, 90])).toEqual({ lo: 0, hi: 100 });
    expect(trendRange('events', [1, 3])).toEqual({ lo: 0.5, hi: 3.5 });
    expect(trendRange('events', [0, 10])).toEqual({ lo: 0, hi: 11.5 });
    expect(trendRange('points', [100, 300])).toEqual({ lo: 70, hi: 330 });
    expect(trendRange('points', [50, 50])).toEqual({ lo: 45, hi: 55 });
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
