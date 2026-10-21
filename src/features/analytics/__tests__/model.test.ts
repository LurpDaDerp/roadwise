/** @jest-environment node */
import { AXES as SCORING_AXES, axisPenalties, axisScores as categoryScores, categoryScore, safetyRatingOf, weightedScore, zeroAxisPenalties, type DriveEvent } from '@scoring';

import { EMPTY_COUNTS, type LocalDrive } from '@/data/queries/rows';
import { encodePolyline, encodeRuns } from '@/lib/polyline';

import {
  AXES,
  AXIS_TIP,
  axisCoaching,
  BAND_LABELS,
  bandIndex,
  coach,
  coachWindow,
  DASHPAL_AXIS,
  driveGrid,
  fitLines,
  fitRegion,
  GOOD_TIP,
  LEVEL_ICON,
  LEVEL_LABEL,
  LEVEL_TONE,
  levelFor,
  PENALTY_AXES,
  personalBests,
  radarScores,
  rangeStart,
  routeLines,
  scoredSince,
  showsTip,
  trend,
  trendDirection,
  trendRange,
  TREND_EVENT_DAYS,
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
    watchedMiles: 0,
    ...over,
  };
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
  phone: 100,
  attention: 100,
  ...over,
});

describe('axes', () => {
  test('radar order and labels: the scoring package’s categories', () => {
    expect(AXES.map((a) => a.key)).toEqual(['acceleration', 'braking', 'turning', 'attention', 'phone', 'speed']);
    expect(AXES.map((a) => a.key)).toEqual([...SCORING_AXES]);
    expect(AXES.map((a) => a.label)).toEqual(['Acceleration', 'Braking', 'Turning', 'Attention', 'Phone use', 'Speed']);
    expect(PENALTY_AXES).toEqual(['acceleration', 'braking', 'turning', 'attention', 'phone', 'speed']);
    expect(DASHPAL_AXIS).toBe('attention');
  });

  test('each category scores 100 / (1 + penalty per mile / 16) over the miles floored at 10; Attention over the watched miles; whole numbers', () => {
    const s = radarScores(
      [ev({ type: 'speeding', tier: 'minor' }), ev({ type: 'hard_accel', tier: 'severe' }), ev({ type: 'phone_pickup', tier: 'severe' }), ev({ type: 'eyes_off', tier: 'severe' })],
      { miles: 20, watchedMiles: 16 }
    );
    // 100 / (1 + 15/20/16) = 95.5; 100 / (1 + 30/20/16) = 91.4; 100 / (1 + 40/20/16) = 88.9; 100 / (1 + 40/16/16) = 86.5
    expect(s).toEqual({ speed: 96, braking: 100, acceleration: 91, turning: 100, phone: 89, attention: 86 });
    expect(s.phone).toBe(Math.round(categoryScore(40, 20, 10)));
    // a short watched stretch counts as 10 miles: 100 / (1 + 40/10/16) = 80
    expect(radarScores([ev({ type: 'eyes_off', tier: 'severe' })], { miles: 20, watchedMiles: 2 }).attention).toBe(80);
    // nothing watched: no Attention score
    expect(radarScores([ev({ type: 'eyes_off', tier: 'severe' })], { miles: 20, watchedMiles: 0 }).attention).toBeNull();
  });

  test('rating penalties per category, DashPal’s on Attention; removed events count nothing; points multipliers never', () => {
    const s = radarScores(
      [
        ev({ type: 'speeding', tier: 'moderate' }),
        ev({ type: 'speeding', tier: 'severe', status: 'removed' }),
        ev({ type: 'hard_brake', tier: 'severe' }),
        // a pickup at 60 mph costs ×2 in points, never in the rating
        ev({ type: 'phone_pickup', tier: 'severe', measured: { maxSpeedMph: 60 } }),
        ev({ type: 'phone_handling', tier: 'severe', units: 3 }),
        ev({ type: 'drowsy', tier: 'severe' }),
      ],
      { miles: 10, watchedMiles: 10 }
    );
    expect(s).toEqual({
      speed: Math.round(categoryScore(40, 10, 10)),
      braking: Math.round(categoryScore(25, 10, 10)),
      acceleration: 100,
      turning: 100,
      phone: Math.round(categoryScore(40 + 30, 10, 10)),
      attention: Math.round(categoryScore(50, 10, 10)),
    });
  });

  test('a category never reaches 0 on real driving, and every score is null with no miles', () => {
    // one severe speeding over 1 mi: the miles floor at 10, so 100 / (1 + 100/10/16) = 61.5
    expect(radarScores([ev({ type: 'speeding', tier: 'severe' })], { miles: 1, watchedMiles: 0 }).speed).toBe(62);
    const many = Array.from({ length: 30 }, () => ev({ type: 'speeding', tier: 'severe' }));
    expect(radarScores(many, { miles: 10, watchedMiles: 0 }).speed).toBeGreaterThan(0);
    expect(radarScores([], { miles: 0, watchedMiles: 0 })).toEqual({ speed: null, braking: null, acceleration: null, turning: null, phone: null, attention: null });
  });

  test('the Safety Rating is the weighted average of the unrounded categories (Speed and Phone use double), 1 decimal, ranked from 10 mi', () => {
    const events = [ev({ type: 'speeding', tier: 'severe' }), ev({ type: 'phone_pickup', tier: 'severe' }), ev({ type: 'hard_brake', tier: 'minor' })];
    // The scoring package's pinned value: speed 100, phone 40, braking 10 over 20 mi, no DashPal.
    expect(windowRating(events, { miles: 20, watchedMiles: 0 })).toEqual({ rating: 89.6, ranked: true });
    // Attention joins with DashPal miles: 40 over 20 watched.
    expect(windowRating([...events, ev({ type: 'eyes_off', tier: 'severe' })], { miles: 20, watchedMiles: 20 })).toEqual({ rating: 89.5, ranked: true });
    // It is the mean of the categories, never their sum: one severe speeding in a 9 mi month.
    const short = windowRating([ev({ type: 'speeding', tier: 'severe' })], { miles: 9, watchedMiles: 0 });
    expect(short).toEqual({ rating: 89, ranked: false });
    const exact = categoryScores({ penalties: axisPenalties(events), miles: 20, watchedMiles: 0 }, 10);
    expect(windowRating(events, { miles: 20, watchedMiles: 0 }).rating).toBe(Math.round(weightedScore(exact)! * 10) / 10);
    expect(windowRating([], { miles: 0, watchedMiles: 0 })).toEqual({ rating: null, ranked: false });
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
    const c = coach(scores({ braking: 70, phone: 55, turning: 55 }), { drives: 5, miles: 50 });
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

  test('also: the other fair or poor penalty axes, weakest first, ties in radar order', () => {
    const c = coach(scores({ speed: 75, braking: 65, phone: 40, turning: 85 }), { drives: 5, miles: 50 });
    expect(c.axis).toBe('phone');
    expect(c.also).toEqual([
      { axis: 'braking', level: 'fair' },
      { axis: 'speed', level: 'fair' },
    ]);
    expect(coach(scores({ phone: 55, braking: 70, turning: 55 }), { drives: 5, miles: 50 }).also).toEqual([
      { axis: 'phone', level: 'poor' },
      { axis: 'braking', level: 'fair' },
    ]);
  });

  test('also: at most two, never the main axis, empty with nothing else to watch', () => {
    const c = coach(scores({ speed: 50, braking: 55, acceleration: 58, turning: 59, phone: 30 }), { drives: 5, miles: 50 });
    expect(c.axis).toBe('phone');
    expect(c.also).toEqual([
      { axis: 'speed', level: 'poor' },
      { axis: 'braking', level: 'poor' },
    ]);
    expect(coach(scores({ braking: 70 }), { drives: 5, miles: 50 }).also).toEqual([]);
    expect(coach(scores({ braking: 70, phone: null }), { drives: 5, miles: 50 }).also).toEqual([]);
  });


  test('also: empty when good or without enough driving', () => {
    expect(coach(scores(), { drives: 5, miles: 50 }).also).toEqual([]);
    expect(coach(scores({ phone: 10, braking: 10 }), { drives: 2, miles: 50 }).also).toEqual([]);
    expect(coach(scores({ speed: null, braking: null, acceleration: null, turning: null, phone: null, attention: null }), { drives: 5, miles: 50 }).also).toEqual([]);
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

  test('coachWindow sums the window’s scored drives and scores the given events, with the window’s Safety Rating', () => {
    const now = 100 * DAY;
    const since = windowStart(now, 30);
    const drives = [
      drive({ startedAt: now - DAY, miles: 6, clean: true, watchedMiles: 3 }),
      drive({ startedAt: now - 2 * DAY, miles: 4, clean: false }),
      drive({ startedAt: now - 3 * DAY, miles: 5, clean: true, status: 'pending', pointsNet: 10 }),
      drive({ startedAt: now - 3 * DAY, miles: 50, status: 'not_driving' }),
      drive({ startedAt: now - 40 * DAY, miles: 100 }),
    ];
    const brakes = [1, 2, 3].map(() => ev({ type: 'hard_brake', tier: 'severe' }));
    const out = coachWindow(drives, brakes, since);
    expect(out.totals).toEqual({ drives: 3, cleanDrives: 2, miles: 15, watchedMiles: 3 });
    // 3 × 25 over 15 mi: 100 / (1 + 5/16) = 76.2
    expect(out.scores.braking).toBe(76);
    expect(out.scores.attention).toBe(100);
    expect(out.coaching).toMatchObject({ level: 'fair', axis: 'braking' });
    // (7 × 100 + 76.2) / 8 over the six categories (Attention with DashPal's 3 mi), ranked at 15 mi.
    expect(out.rating).toEqual({ rating: 97, ranked: true });
    expect(out.rating.rating).toBe(Math.round(weightedScore(categoryScores({ penalties: axisPenalties(brakes), miles: 15, watchedMiles: 3 }, 10))! * 10) / 10);
    // Under 10 mi the rating is there but unranked (the radar shows a dash).
    expect(coachWindow(drives.slice(0, 1), [], since).rating).toEqual({ rating: 100, ranked: false });
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

  test('sums scored drives in the window; DashPal counts apart (Attention only); avg speed, clean rate and per-drive averages', () => {
    const since = 1_000;
    const drives = [
      drive({ startedAt: 2_000, miles: 10, durationS: 1800, nightMiles: 3, pointsNet: 120, clean: true, counts: { ...EMPTY_COUNTS, eyesOff: 3, drowsy: 1 } }),
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
      nightMiles: 3,
      nightPct: 20,
      avgMph: 15,
      speeding: 2,
      hardBrake: 1,
      hardAccel: 1,
      hardCorner: 3,
      pickups: 1,
      handlingS: 45,
      eyesOff: 3,
      drowsy: 1,
      watchedMiles: 0,
      cleanDrives: 1,
      cleanPct: 50,
      points: 90,
      avgMiles: 7.5,
      avgPoints: 45,
    });
    expect(windowSums(drives, null).drives).toBe(3);
  });

  test('an empty window has no averages and no clean rate', () => {
    expect(windowSums([], 0)).toMatchObject({ drives: 0, avgMph: null, cleanPct: null, nightPct: null, points: 0, avgMiles: null, avgPoints: null });
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
  /** The rating `safetyRatingOf` gives these penalties over these miles, whole. */
  const rated = (miles: number, penalties: Partial<ReturnType<typeof zeroAxisPenalties>>, watchedMiles = 0) =>
    Math.round(safetyRatingOf({ penalties: { ...zeroAxisPenalties(), ...penalties }, miles, watchedMiles }).rating!);

  test('a week: Score is the Safety Rating over each day’s trailing 30 days, Events per mile per day with drives, Points the running total', () => {
    const tue1 = drive({ startedAt: at(13, 8), miles: 10, pointsNet: 100, counts: brakes(1) });
    const tue2 = drive({ startedAt: at(13, 17), miles: 10, pointsNet: 50, counts: { ...EMPTY_COUNTS, speeding: 1, pickups: 1, handlingS: 30 } });
    const fri = drive({ startedAt: at(9, 9), miles: 20, pointsNet: 120 });
    // Before the range, inside every point's 30 days.
    const old = drive({ startedAt: at(6, 9), miles: 50, pointsNet: 999 });
    const events = [
      ev({ type: 'hard_brake', tier: 'severe', startedAt: at(13, 8, 10) }),
      ev({ type: 'speeding', tier: 'moderate', startedAt: at(13, 17, 5), durationS: 40 }),
      ev({ type: 'phone_pickup', startedAt: at(13, 17, 9) }),
      // DashPal counts only over the miles it watched (none here); a removed event counts nothing.
      ev({ type: 'drowsy', tier: 'severe', startedAt: at(13, 17, 12) }),
      ev({ type: 'hard_brake', tier: 'severe', startedAt: at(9, 9, 5), status: 'removed' }),
    ];
    const t = trend([tue2, tue1, fri, old], events, 'week', NOW);
    expect(t.step).toBe('day');
    // A rolling week touches 8 local days: last Wednesday afternoon through today.
    expect(t.ticks.map((k) => k.label)).toEqual(['W', 'T', 'F', 'S', 'S', 'M', 'T', 'W']);
    expect(t.ticks[0]!.x).toBe(0);
    expect(t.ticks[7]!.x).toBe(1);
    // Every day has a Score, drives of its own or not: the old drive's 50 mi rank each window.
    const tuesday = rated(90, { braking: 25, speed: 40, phone: 40 });
    expect(tuesday).toBeLessThan(100);
    expect(t.series.score.map((q) => q.value)).toEqual([100, 100, 100, 100, 100, 100, tuesday, tuesday]);
    expect(t.series.score.map((q) => q.when)).toEqual(['last Wednesday', 'on Thursday', 'on Friday', 'on Saturday', 'on Sunday', 'on Monday', 'on Tuesday', 'today']);
    // Tuesday: a brake, a speeding and a pickup over 20 mi; handling time is not a count. Friday: none.
    expect(t.series.events).toEqual([
      { x: 2 / 7, value: 0, when: 'on Friday' },
      { x: 6 / 7, value: 3 / 20, when: 'on Tuesday' },
    ]);
    // No answers stored: each drive adds its net points to the total before it.
    expect(t.series.points.map((q) => q.value)).toEqual([999, 999, 1119, 1119, 1119, 1119, 1269, 1269]);
  });

  test('the latest Score point is the radar’s centre: the same 30 days, the same arithmetic', () => {
    const list = [0.5, 3, 9, 20, 29, 33, 45].map((d, i) => drive({ startedAt: NOW - d * DAY, miles: 4 + i, watchedMiles: i % 2 === 0 ? 2 : 0 }));
    const events = [
      ev({ type: 'hard_brake', tier: 'severe', startedAt: NOW - 0.5 * DAY + 60_000 }),
      ev({ type: 'phone_pickup', startedAt: NOW - 9 * DAY + 60_000 }),
      ev({ type: 'eyes_off', tier: 'severe', startedAt: NOW - 20 * DAY + 60_000 }),
      ev({ type: 'speeding', tier: 'severe', startedAt: NOW - 29 * DAY + 60_000 }),
      ev({ type: 'speeding', tier: 'severe', startedAt: NOW - 33 * DAY + 60_000 }),
    ];
    const since = windowStart(NOW, 30);
    // The radar reads the window's own events (`readWindowEvents(since)`): those of drives started since.
    const own = events.filter((e) => e.startedAt >= since);
    const centre = coachWindow(list, own, since).rating;
    expect(centre.ranked).toBe(true);
    for (const range of ['day', 'week', 'month', 'year'] as const) {
      const score = trend(list, events, range, NOW + HOUR - 1).series.score;
      expect(score[score.length - 1]!.value).toBe(Math.round(centre.rating!));
    }
  });

  test('by drive, the Score line also ends now, at the radar’s centre: a drive that has left the 30 days since the last drive no longer counts', () => {
    const end = NOW + HOUR - 1;
    // The day's only drive started 20 h ago; 30 days before it, a drive with a severe speeding that
    // has left the radar's 30 days since.
    const last = drive({ startedAt: NOW - 20 * HOUR, miles: 12 });
    const old = drive({ startedAt: NOW - 30 * DAY - 10 * HOUR, miles: 12 });
    const events = [ev({ type: 'speeding', tier: 'severe', startedAt: old.startedAt + 60_000 })];
    const since = windowStart(end, 30);
    const centre = coachWindow([last, old], events.filter((e) => e.startedAt >= since), since).rating;
    expect(centre).toMatchObject({ rating: 100, ranked: true });
    const score = trend([last, old], events, 'day', end).series.score;
    // At the drive's start the old drive still counted; now it doesn't, as on the radar.
    expect(score[0]!.value).toBe(rated(24, { speed: 100 }));
    expect(score[0]!.value).toBeLessThan(100);
    expect(score.map((q) => [q.x, q.when])).toEqual([
      [(4 * HOUR) / (end - rangeStart(end, 'day')), 'at 4:00 PM'],
      [1, 'now'],
    ]);
    expect(score[1]!.value).toBe(Math.round(centre.rating!));
  });

  test('Score needs 10 mi in a point’s 30 days; an event belongs to the latest drive started at or before it', () => {
    // 12 mi on Sep 10 rank the windows that still hold it (to the end of Friday Oct 9), then leave.
    const sep = drive({ startedAt: new Date(2026, 8, 10, 9).getTime(), miles: 12 });
    // Monday 23:50: its brake at 00:10 is still its own.
    const late = drive({ startedAt: at(12, 23, 50), miles: 5 });
    const today = drive({ startedAt: at(14, 7), miles: 6 });
    const events = [
      // Before any drive the trend holds: nobody's, so nothing.
      ev({ type: 'speeding', tier: 'severe', startedAt: new Date(2026, 8, 8, 9).getTime() }),
      ev({ type: 'hard_brake', tier: 'severe', startedAt: at(13, 0, 10) }),
    ];
    const t = trend([today, late, sep], events, 'week', NOW);
    expect(t.series.score.map((q) => [q.when, q.value])).toEqual([
      ['last Wednesday', 100],
      ['on Thursday', 100],
      ['on Friday', 100],
      // Saturday to Tuesday hold under 10 mi; today holds 11 with Monday's brake.
      ['today', rated(11, { braking: 25 })],
    ]);
  });

  test('Score waits for the events; a slot with no miles has no Events point', () => {
    const t = trend([drive({ startedAt: at(13, 8), miles: 6 }), drive({ startedAt: at(11, 8), miles: 0, pointsNet: -20 })], null, 'week', NOW);
    expect(t.series.score).toEqual([]);
    expect(t.series.events.map((q) => q.when)).toEqual(['on Tuesday']);
    // The total never goes below 0: −20 from nothing is 0, then +100.
    expect(t.series.points.map((q) => [q.when, q.value])).toEqual([
      ['on Sunday', 0],
      ['on Monday', 0],
      ['on Tuesday', 100],
      ['today', 100],
    ]);
    expect(trend([], [], 'week', NOW).series).toEqual({ score: [], events: [], points: [] });
  });

  test('Points: the total each answered drive came back with, an estimate added to the one before, carried forward, the latest pinned to the total now', () => {
    const answered = (points: number) => ({
      tripId: 't',
      clientTripId: 'c',
      mergedInto: null,
      scored: true,
      reason: null,
      breakdown: {} as never,
      net: 0,
      streak: { before: 0, after: 0, outcome: 'grew' as const, nextMult: 1, atRisk: false, freezes: 0, freezeEarned: false },
      progress: { points, lifetime: points, level: 1, levelUp: false, safetyRating: null, ranked: false },
      achievements: [],
      challenges: [],
      league: { tier: 'bronze', placed: false },
    });
    const list = [
      drive({ startedAt: at(1, 9), pointsNet: 300, result: answered(500) }),
      drive({ startedAt: at(9, 9), pointsNet: 80, result: answered(600) }),
      // An estimate: no answer yet, the total before it plus its net.
      drive({ startedAt: at(13, 9), pointsNet: 40, estimate: true, status: 'pending' }),
      // Not scored: counts nowhere.
      drive({ startedAt: at(12, 9), pointsNet: 999, status: 'not_driving', result: answered(5000) }),
    ];
    const t = trend(list, [], 'week', NOW);
    expect(t.series.points.map((q) => q.value)).toEqual([500, 500, 600, 600, 600, 600, 640, 640]);
    // The server's total now (a challenge reward since) is the latest point, as Home's pill shows it.
    const pinned = trend(list, [], 'week', NOW, { pointsNow: 840 });
    expect(pinned.series.points.map((q) => q.value)).toEqual([500, 500, 600, 600, 600, 600, 640, 840]);
    expect(pinned.series.points[7]).toMatchObject({ x: 1, when: 'today' });
    // No drive yet: the total now alone, a single point.
    expect(trend([], [], 'week', NOW, { pointsNow: 0 }).series.points).toEqual([{ x: 1, value: 0, when: 'today' }]);
    expect(trend(list, [], 'week', NOW, { pointsNow: null }).series.points[7]!.value).toBe(640);
  });

  test('Points: the latest point is the server’s total alone, so a drive still waiting is never counted twice', () => {
    const answered = (points: number) =>
      ({ net: 0, progress: { points, lifetime: points, level: 1, levelUp: false, safetyRating: null, ranked: false } }) as unknown as LocalDrive['result'];
    const waiting = (over: Partial<LocalDrive>) => drive({ estimate: true, status: 'pending', ...over });
    // Answered yesterday at 1,000; this morning's drive is still an estimate (+80).
    const list = [drive({ startedAt: at(13, 18), pointsNet: 60, result: answered(1000) }), waiting({ startedAt: at(14, 8), pointsNet: 80 })];
    const values = (pointsNow: number, range: 'day' | 'week' = 'day') =>
      trend(list, [], range, NOW, { pointsNow }).series.points.map((q) => [q.when, q.value]);
    // The server already counted it (its answer was lost on the way, or the summary came first):
    // the line ends on that total, never the estimate on top of it.
    expect(values(1080)).toEqual([
      ['at 6:00 PM', 1000],
      ['at 8:00 AM', 1080],
      ['now', 1080],
    ]);
    // Not counted yet: the drive shows in its own point, and now is the server's total until it is.
    expect(values(1000)).toEqual([
      ['at 6:00 PM', 1000],
      ['at 8:00 AM', 1080],
      ['now', 1000],
    ]);
    // A week reads the same: today's point is the server's total, whatever is still waiting.
    expect(values(1080, 'week')).toEqual([
      ['on Tuesday', 1000],
      ['today', 1080],
    ]);
    expect(values(1000, 'week')).toEqual([
      ['on Tuesday', 1000],
      ['today', 1000],
    ]);
    // A credit since shows as it is.
    expect(values(1200).at(-1)).toEqual(['now', 1200]);
  });

  test('unscored drives stay out; a drive before the range carries its total in, with no Events point', () => {
    const t = trend(
      [
        drive({ startedAt: at(13, 8), status: 'unscored', pointsNet: null }),
        drive({ startedAt: at(13, 9), status: 'not_driving', pointsNet: null }),
        drive({ startedAt: new Date(2026, 8, 1, 9).getTime(), pointsNet: 100 }),
      ],
      [],
      'month',
      NOW
    );
    expect(t.series.events).toEqual([]);
    expect(t.series.points.map((q) => q.value)).toEqual([100, 100, 100, 100, 100]);
  });

  test('a day is a point per drive, placed by its start time, with 6-hour marks; Points also start the range and end now', () => {
    const t = trend([drive({ startedAt: at(14, 8, 15), pointsNet: 40 }), drive({ startedAt: at(13, 18) })], [], 'day', NOW);
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
    // Score: one per drive and one now, as Points.
    expect(t.series.score).toEqual([
      { x: 0.25, value: 100, when: 'at 6:00 PM' },
      { x: (20.25 * HOUR) / DAY, value: 100, when: 'at 8:15 AM' },
      { x: 1, value: 100, when: 'now' },
    ]);
    expect(t.series.points).toEqual([
      { x: 0.25, value: 100, when: 'at 6:00 PM' },
      { x: (20.25 * HOUR) / DAY, value: 140, when: 'at 8:15 AM' },
      { x: 1, value: 140, when: 'now' },
    ]);
    // A drive before the range starts the line at the range's start.
    const carried = trend([drive({ startedAt: at(14, 8, 15), pointsNet: 40 }), drive({ startedAt: at(12, 18) })], [], 'day', NOW, { pointsNow: 150 });
    expect(carried.series.points).toEqual([
      { x: 0, value: 100, when: 'at 12:00 PM' },
      { x: (20.25 * HOUR) / DAY, value: 140, when: 'at 8:15 AM' },
      { x: 1, value: 150, when: 'now' },
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
    expect(t.series.points.map((q) => q.value)).toEqual([100, 100, 100, 100, 300]);
    // Score from the first week (10 mi) to the last; the three drives' 30 mi fall in the last window.
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
    // A month has a Score when the 30 days to its end hold a drive's 10 mi: never the month after.
    expect(t.series.score.map((q) => q.when)).toEqual(['in October 2025', 'in March', 'in October 2026']);
    expect(t.series.points).toHaveLength(13);
  });

  test('the events reach back a year and the 30 days before it', () => {
    expect(TREND_EVENT_DAYS).toBe(395);
  });

  test('range: Score is 0–100; Events and Points pad their spread and never go below 0', () => {
    expect(trendRange('score', [40, 90])).toEqual({ lo: 0, hi: 100 });
    expect(trendRange('events', [1, 3])).toEqual({ lo: 0.7, hi: 3.3 });
    expect(trendRange('events', [0, 10])).toEqual({ lo: 0, hi: 11.5 });
    const flat = trendRange('events', [0.1, 0.1]);
    expect(flat.lo).toBeCloseTo(0.05);
    expect(flat.hi).toBeCloseTo(0.15);
    expect(trendRange('points', [100, 300])).toEqual({ lo: 70, hi: 330 });
    expect(trendRange('points', [50, 50])).toEqual({ lo: 45, hi: 55 });
    expect(trendRange('points', [0, 2])).toEqual({ lo: 0, hi: 7 });
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
