import { haversineMeters } from '@/lib/geo';

import { DAY, drive, event, NOW, ROUTE, sums } from '../__fixtures__/drives';
import { eventKind, formatDuration, formatEventDuration, formatTimeSpan, groupByWeek, spokenEventDuration, weekLabel, weekStart } from '../format';
import { eventTally } from '../DriveRow';
import { eventMarks, fittedSpan, markShape, metersPerPixel, MIN_MARK_PX, minZoomFor, regionFor, sameZoom, sketchPath, tipAnchor, ZOOM_SLACK, zoomBack } from '../route';
import { homeStats, trendFor } from '../stats';
import {
  breakdownLines,
  multiplierText,
  notDrivingLabel,
  pointsState,
  receipt,
  reportReasons,
  spokenPoints,
} from '../summary';

describe('DashPal', () => {
  test('the multiplier line names the DashPal ×1.25 and the ×1.50 cap of the two together', () => {
    expect(multiplierText(1.2, 1.25, 1.5)).toBe('streak ×1.20 · DashPal ×1.25 → ×1.50 (cap)');
    expect(multiplierText(1.08, 1.25, 1.35)).toBe('streak ×1.08 · DashPal ×1.25 → ×1.35');
    expect(multiplierText(1.3, 1, 1.3)).toBe('streak ×1.30 (cap)');
    expect(multiplierText(1.2, 1, 1.2)).toBe('streak ×1.20');
  });

  test('a DashPal event is reported as "DashPal got it wrong" or "wasn\'t driving"', () => {
    expect(reportReasons('drowsy')).toEqual(['camera_wrong', 'not_driving']);
    expect(reportReasons('eyes_off')).toEqual(['camera_wrong', 'not_driving']);
    expect(reportReasons('hard_brake')).toEqual(['hazard', 'not_driving']);
  });

  test('DashPal events get a pin on the route like any other event', () => {
    const drowsy = event({ id: 'd1', type: 'drowsy', tier: 'severe', durationS: 60 });
    expect(eventMarks([ROUTE], [drowsy]).map((m) => [m.id, m.type, m.tier])).toEqual([['d1', 'drowsy', 'severe']]);
  });

  test('a history row shows DashPal events with the phone events', () => {
    const counts = { speeding: 1, pickups: 0, handlingS: 0, hardBrake: 0, hardAccel: 0, hardCorner: 0, eyesOff: 2, drowsy: 1 };
    expect(eventTally(counts)).toEqual([
      { type: 'speeding', n: 1 },
      { type: 'eyes_off', n: 2 },
      { type: 'drowsy', n: 1 },
    ]);
  });
});

describe('format', () => {
  test('durations read like a person would say them', () => {
    expect(formatDuration(20)).toBe('<1 min');
    expect(formatDuration(24 * 60)).toBe('24 min');
    expect(formatDuration(65 * 60)).toBe('1 h 05 min');
  });

  test('a time span drops the repeated AM/PM', () => {
    const a = new Date(2026, 9, 5, 7, 42).getTime();
    expect(formatTimeSpan(a, a + 30 * 60_000)).toBe('7:42 – 8:12 AM');
    expect(formatTimeSpan(new Date(2026, 9, 5, 11, 50).getTime(), new Date(2026, 9, 5, 12, 20).getTime())).toBe('11:50 AM – 12:20 PM');
  });

  test('weeks start on Monday and are labelled relative to now', () => {
    const monday = weekStart(NOW); // NOW is a Monday
    expect(new Date(monday).getDay()).toBe(1);
    expect(weekLabel(monday, NOW)).toBe('This week');
    expect(weekLabel(weekStart(NOW - 3 * DAY), NOW)).toBe('Last week');
    expect(weekLabel(weekStart(NOW - 10 * DAY), NOW)).toBe('Sep 21 – 27');
    expect(weekLabel(weekStart(NOW - 7 * DAY * 1 - 8 * DAY), NOW)).toBe('Sep 14 – 20');
  });

  test('drives group by week, newest first, with a points and miles total per week', () => {
    const groups = groupByWeek(
      [
        drive({ clientTripId: 'a', startedAt: NOW - 1000, pointsNet: 100 }),
        drive({ clientTripId: 'b', startedAt: NOW - 2 * DAY, pointsNet: -20 }),
        drive({ clientTripId: 'c', startedAt: NOW - 3 * DAY, status: 'not_driving', pointsNet: 0 }),
        drive({ clientTripId: 'd', startedAt: NOW - 12 * DAY, pointsNet: 50 }),
      ],
      NOW
    );
    expect(groups.map((g) => g.title)).toEqual(['This week', 'Last week', 'Sep 21 – 27']);
    expect(groups[1]!.data.map((d) => d.clientTripId)).toEqual(['b', 'c']);
    expect(groups[1]!.points).toBe(-20);
  });
});

describe('route', () => {
  test('the sketch fits inside its box', () => {
    const d = sketchPath([ROUTE], 56, 56, 4)!;
    const nums = d.match(/[\d.]+/g)!.map(Number);
    expect(Math.min(...nums)).toBeGreaterThanOrEqual(3.9);
    expect(Math.max(...nums)).toBeLessThanOrEqual(52.1);
    expect(d.match(/M/g)).toHaveLength(1);
    expect(sketchPath([[ROUTE[0]!]], 56, 56)).toBeNull();
    expect(sketchPath([], 56, 56)).toBeNull();
  });

  test('a route in two visible runs is two subpaths: the pen lifts between them, nothing is drawn across the gap', () => {
    const first = ROUTE.slice(0, 10);
    const second = ROUTE.slice(20);
    const d = sketchPath([first, second], 56, 56, 4)!;
    expect(d.match(/M/g)).toHaveLength(2);
    // The second subpath starts with M right after the first's last L: no L joins them.
    expect(d).toMatch(/L[\d.]+ [\d.]+ M[\d.]+ [\d.]+/);
    // A run too short to draw is skipped, not joined to the next.
    expect(sketchPath([first, [ROUTE[15]!], second], 56, 56, 4)!.match(/M/g)).toHaveLength(2);
  });

  test('each event marks the stretch it covered: from where it began, for its duration along the road', () => {
    const [m] = eventMarks([ROUTE], [event({ id: 's', type: 'speeding', tier: 'moderate', durationS: 20, lat: ROUTE[5]!.lat, lng: ROUTE[5]!.lng })]);
    expect(m!.at).toEqual(ROUTE[5]);
    expect(m!.stretch[0]).toEqual(ROUTE[5]);
    // 20 s at ≈ 30 mph: about 268 m of road, measured along the stretch itself.
    expect(m!.lengthM).toBeCloseTo(268, 0);
    const along = m!.stretch.slice(1).reduce((n, p, i) => n + haversineMeters(m!.stretch[i]!, p), 0);
    expect(along).toBeCloseTo(m!.lengthM, 0);
  });

  test('a measured speed sets how far the stretch runs', () => {
    const at = { lat: ROUTE[5]!.lat, lng: ROUTE[5]!.lng };
    const [slow] = eventMarks([ROUTE], [event({ type: 'speeding', durationS: 10, measured: { speedMph: 20 }, ...at })]);
    const [fast] = eventMarks([ROUTE], [event({ type: 'speeding', durationS: 10, measured: { speedMph: 60 }, ...at })]);
    expect(fast!.lengthM / slow!.lengthM).toBeCloseTo(3, 1);
  });

  test('a stretch never leaves its visible run; one that would run off the end starts earlier instead', () => {
    const first = ROUTE.slice(0, 10);
    const second = ROUTE.slice(20);
    const onFirst = (p: { lat: number; lng: number }) => p.lat <= first[9]!.lat;
    const [m] = eventMarks([first, second], [event({ id: 's', type: 'speeding', tier: 'severe', durationS: 30, lat: first[8]!.lat, lng: first[8]!.lng })]);
    expect(m!.stretch.every(onFirst)).toBe(true);
    expect(m!.stretch[m!.stretch.length - 1]).toEqual(first[9]);
    expect(m!.lengthM).toBeCloseTo(30 * 13.4, 0);
  });

  test('every counted event with a location is marked, minor first so severe draws on top', () => {
    const marks = eventMarks([ROUTE], [
      event({ id: 'b', type: 'hard_brake', tier: 'severe' }),
      event({ id: 'a', type: 'hard_accel', tier: 'minor' }),
      event({ id: 'c', type: 'hard_corner', tier: 'moderate' }),
      event({ id: 'p', type: 'phone_pickup', tier: 'severe', lat: null, lng: null }),
      event({ id: 'x', type: 'speeding', tier: 'severe', disputeStatus: 'accepted' }),
      event({ id: 'r', type: 'speeding', tier: 'severe', removed: true }),
    ]);
    expect(marks.map((m) => [m.id, m.tier])).toEqual([
      ['a', 'minor'],
      ['c', 'moderate'],
      ['b', 'severe'],
    ]);
    expect(eventMarks([], [event()])).toEqual([expect.objectContaining({ id: 'e1', stretch: [], lengthM: 0 })]);
  });

  test('a stretch too short to see at the zoom becomes a dot', () => {
    expect(markShape(1000, 10)).toBe('line'); // 100 pt on screen
    expect(markShape(MIN_MARK_PX * 10, 10)).toBe('line');
    expect(markShape(MIN_MARK_PX * 10 - 1, 10)).toBe('dot');
    expect(markShape(13, 80)).toBe('dot'); // a one-second brake on a long drive
    expect(markShape(500, 0)).toBe('dot'); // not laid out yet
    // A one-second brake on the fixture's ~6.4 km route, on a 340 pt square map.
    const [brake] = eventMarks([ROUTE], [event()]);
    expect(markShape(brake!.lengthM, metersPerPixel(regionFor(ROUTE)!, 340))).toBe('dot');
  });

  test('the map scale follows the longer side of the region', () => {
    const region = { latitude: 0, longitude: 0, latitudeDelta: 0.01, longitudeDelta: 0.02 };
    expect(metersPerPixel(region, 200)).toBeCloseTo((0.02 * 111_320) / 200, 3);
    expect(metersPerPixel(region, 0)).toBe(0);
  });

  test('a marker view lands its tip on the spot: anchor for Google Maps, centre offset for Apple Maps', () => {
    expect(tipAnchor(44, 42)).toEqual({ anchor: { x: 0.5, y: 42 / 44 }, centerOffset: { x: 0, y: -20 } });
    // A tip at the very bottom lifts the view by half its height; a centred spot does not move it.
    expect(tipAnchor(40, 40).centerOffset).toEqual({ x: 0, y: -20 });
    expect(tipAnchor(12, 6)).toEqual({ anchor: { x: 0.5, y: 0.5 }, centerOffset: { x: 0, y: 0 } });
  });

  test('the outer zoom limit is the level that frames the route, in each engine’s zoom levels', () => {
    // At the equator a 360° wide view on a 256-point square is Google zoom 0 and Apple zoom −1.
    const world = { latitude: 0, longitude: 0, latitudeDelta: 10, longitudeDelta: 360 };
    expect(minZoomFor(world, 256, 'google')).toBeCloseTo(0 - ZOOM_SLACK, 9);
    expect(minZoomFor(world, 256, 'apple')).toBeCloseTo(-1 - ZOOM_SLACK, 9);
    // Each halving of the span or doubling of the square is one level further in.
    const city = { latitude: 0, longitude: 0, latitudeDelta: 0.01, longitudeDelta: 360 / 1024 };
    expect(minZoomFor(city, 512, 'google')).toBeCloseTo(11 - ZOOM_SLACK, 9);
    expect(minZoomFor(city, 0, 'google')).toBeUndefined();
    // A tall route is fitted by its height: at 60° a degree of latitude spans two of longitude.
    const tall = { latitude: 60, longitude: 0, latitudeDelta: 0.1, longitudeDelta: 0.05 };
    expect(fittedSpan(tall)).toBeCloseTo(0.2, 9);
    expect(minZoomFor(tall, 300, 'google')).toBeCloseTo(Math.log2((360 * 300) / (256 * 0.2)) - ZOOM_SLACK, 9);
  });

  test('the zoom backstop pulls a map that went too far out back to the fitted size where it stands', () => {
    const fitted = { latitude: 40, longitude: -74, latitudeDelta: 0.05, longitudeDelta: 0.04 };
    expect(zoomBack(fitted, fitted)).toBeNull();
    expect(zoomBack({ ...fitted, latitudeDelta: 0.01, longitudeDelta: 0.008 }, fitted)).toBeNull(); // zoomed in
    expect(zoomBack({ ...fitted, latitudeDelta: 0.0515, longitudeDelta: 0.0412 }, fitted)).toBeNull(); // within 5 %
    expect(zoomBack({ latitude: 40.01, longitude: -74.02, latitudeDelta: 0.1, longitudeDelta: 0.08 }, fitted)).toEqual({
      latitude: 40.01,
      longitude: -74.02,
      latitudeDelta: 0.05,
      longitudeDelta: 0.04,
    });
  });

  test('a pan keeps the zoom; a pinch changes it', () => {
    const a = { latitude: 40, longitude: -74, latitudeDelta: 0.05, longitudeDelta: 0.04 };
    expect(sameZoom(a, { ...a, latitude: 40.02, longitude: -74.01 })).toBe(true);
    expect(sameZoom(a, { ...a, latitudeDelta: 0.025, longitudeDelta: 0.02 })).toBe(false);
  });

  test('an event says how long it lasted, in words too, and its tier or source', () => {
    expect(formatEventDuration(0.4)).toBe('under 1 s');
    expect(formatEventDuration(2)).toBe('2 s');
    expect(formatEventDuration(65)).toBe('1 min 5 s');
    expect(formatEventDuration(180)).toBe('3 min');
    expect(formatEventDuration(3900)).toBe('1 h 05 min');
    expect(spokenEventDuration(0)).toBe('under a second');
    expect(spokenEventDuration(1)).toBe('1 second');
    expect(spokenEventDuration(65)).toBe('1 minute 5 seconds');
    expect(spokenEventDuration(120)).toBe('2 minutes');
    expect(eventKind('hard_brake', 'moderate')).toBe('Moderate');
    expect(eventKind('phone_pickup', 'severe')).toBeNull();
    expect(eventKind('drowsy', 'severe')).toBe('DashPal');
  });
});

describe('stats', () => {
  test('Home shows the last 7 days coloured by the spec bands, with arrows vs 30 days', () => {
    const { stats, window } = homeStats(
      sums({ miles: 50, drives: 4, cleanDrives: 2, speeding: 3, pickups: 0, hardBrake: 1, hardAccel: 0 }),
      sums({ miles: 200, drives: 20, cleanDrives: 18, speeding: 2, pickups: 1, hardBrake: 4, hardAccel: 2 })
    );
    expect(window).toBe('7d');
    const by = Object.fromEntries(stats.map((s) => [s.id, s]));
    expect(by.speeding).toMatchObject({ value: '6.0', health: 'red', trend: 'up' });
    expect(by.pickups).toMatchObject({ value: '0.0', health: 'green', trend: 'down' });
    expect(by.harsh).toMatchObject({ value: '2.0', health: 'green', trend: 'down' });
    expect(by.clean).toMatchObject({ value: '50', health: 'yellow', trend: 'down', higherIsBetter: true });
  });

  test('with no drive in 7 days it shows the 30-day values without arrows', () => {
    const { stats, window } = homeStats(sums({ drives: 0, miles: 0 }), sums());
    expect(window).toBe('30d');
    expect(stats.every((s) => s.trend === undefined)).toBe(true);
  });

  test('trend compares at the shown precision', () => {
    expect(trendFor(0.81, 0.79)).toBe('flat');
    expect(trendFor(null, 1)).toBeUndefined();
  });
});

describe('summary', () => {
  test('points state follows the drive status', () => {
    expect(pointsState(drive())).toEqual({ kind: 'points', value: 132, estimate: false });
    expect(pointsState(drive({ status: 'pending', estimate: true, pointsNet: 40, result: null }))).toEqual({ kind: 'points', value: 40, estimate: true });
    expect(pointsState(drive({ status: 'unscored', reason: 'too_short' })).kind).toBe('too_short');
    expect(pointsState(drive({ status: 'unscored', reason: 'spoofed' })).kind).toBe('not_scored');
    expect(pointsState(drive({ status: 'merged', mergedInto: 'z' }))).toEqual({ kind: 'merged', into: 'z' });
  });

  test('the multiplier line names the streak multiplier and its cap', () => {
    expect(multiplierText(1.2)).toBe('streak ×1.20');
    expect(multiplierText(1.3)).toBe('streak ×1.30 (cap)');
  });

  test('the breakdown itemizes miles, multiplier, each event and the net', () => {
    const { lines, note } = breakdownLines(drive(), [event()]);
    expect(lines.map((l) => [l.label, l.value])).toEqual([
      ['Safe miles: 11.8 mi × 10', '+118'],
      ['Multiplier: streak ×1.20', '= +142'],
      ['Hard brake · Minor', '−10'],
      ['Net total', '+132'],
    ]);
    expect(note).toBeNull();
  });

  test('an accepted report reads as removed; an offline estimate explains the missing lines', () => {
    const { lines, note } = breakdownLines(drive({ result: null, status: 'pending', estimate: true, pointsNet: 30 }), [event({ disputeStatus: 'accepted' })]);
    expect(lines.map((l) => l.value)).toEqual(['Removed', '+30']);
    expect(note).toMatch(/once this drive is scored/);
  });

  test('the receipt: Earned is the gross gains, one deduction per event, the total is the net', () => {
    const r = receipt(drive(), [event()]);
    expect(r.earned).toBe(142);
    expect(r.detail).toEqual(['Safe miles 11.8 mi × 10', 'Streak ×1.20']);
    expect(r.deductions.map((l) => [l.label, l.value, l.cost, l.tone])).toEqual([['Hard brake · Minor', '−10', 10, 'loss']]);
    expect(r.total).toBe(132);
    expect(r.note).toBeNull();
  });

  test('the receipt detail keeps the daily cap, the clean bonus, km and the DashPal multiplier', () => {
    const b = drive().result!.breakdown;
    const d = drive({ result: { ...drive().result!, breakdown: { ...b, safeMiles: 14, cleanBonus: 25, dashcamMult: 1.25, mult: 1.5 } } });
    expect(receipt(d, [], 'km').detail).toEqual(['Safe miles 11.8 mi (19.0 km) × 10 (daily cap)', 'Clean bonus +25', 'Streak ×1.20 · DashPal ×1.25 → ×1.50 (cap)']);
  });

  test('without a server breakdown, Earned is the total plus the known costs, and unknown while any is missing', () => {
    const est = drive({ result: null, status: 'pending', estimate: true, pointsNet: 30 });
    expect(receipt(est, [event({ penalty: 15 }), event({ id: 'e2', disputeStatus: 'accepted' })])).toMatchObject({ earned: 45, detail: [], total: 30, note: expect.stringMatching(/once this drive is scored/) });
    expect(receipt(est, [event({ penalty: null })]).earned).toBeNull();
    expect(receipt(drive({ result: null, status: 'pending', pointsNet: null }), [event()])).toMatchObject({ earned: null, total: null });
  });

  test('the receipt lists deductions oldest first and marks a removed one', () => {
    const r = receipt(drive(), [event({ id: 'late', startedAt: NOW }), event({ id: 'gone', removed: true })]);
    expect(r.deductions.map((l) => [l.event.id, l.value, l.cost, l.tone])).toEqual([
      ['gone', 'Removed', 0, 'neutral'],
      ['late', '−10', 10, 'loss'],
    ]);
  });

  test('spoken points carry the sign in words', () => {
    expect(spokenPoints(142)).toBe('plus 142 points');
    expect(spokenPoints(-1)).toBe('minus 1 point');
    expect(spokenPoints(-1240)).toBe('minus 1,240 points');
    expect(spokenPoints(0)).toBe('0 points');
  });

  test('report reasons fit the event type, with "wasn\'t driving" always offered', () => {
    expect(reportReasons('hard_brake')).toEqual(['hazard', 'not_driving']);
    expect(reportReasons('speeding')).toEqual(['wrong_limit', 'not_driving']);
    expect(reportReasons('phone_pickup')).toEqual(['mounted', 'not_driving']);
    expect(reportReasons('phone_handling')).toEqual(['mounted', 'not_driving']);
    expect(reportReasons('hard_corner')).toEqual(['not_driving']);
  });

  test('the wasn\'t-driving label carries the uses left', () => {
    expect(notDrivingLabel(1)).toBe("Wasn't driving (1 left this month)");
    expect(notDrivingLabel(null)).toBe("Wasn't driving");
  });
});
