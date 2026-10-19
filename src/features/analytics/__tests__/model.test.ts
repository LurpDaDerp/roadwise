/** @jest-environment node */
import { ratingPenalty, safetyRating, type DriveEvent } from '@scoring';

import { EMPTY_COUNTS, type LocalDrive } from '@/data/queries/rows';
import { encodePolyline, encodeRuns } from '@/lib/polyline';

import {
  AXES,
  AXIS_TIP,
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
