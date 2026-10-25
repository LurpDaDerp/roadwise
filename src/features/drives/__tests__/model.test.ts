import { haversineMeters } from '@/lib/geo';

import { DAY, drive, event, EXPOSURE, NOW, ROUTE, sums } from '../__fixtures__/drives';
import {
  EVENT_ICON,
  eventKind,
  eventName,
  formatDuration,
  formatEventDuration,
  formatSpeed,
  formatTimeSpan,
  groupByWeek,
  spokenEventDuration,
  spokenSpeed,
  weekLabel,
  weekStart,
} from '../format';
import { eventTally } from '../DriveRow';
import { awayFrom, eventMarks, fittedSpan, markShape, metersPerPixel, MIN_MARK_PX, regionFor, sameZoom, sketchPath, tipAnchor } from '../route';
import { homeStats, trendFor } from '../stats';
import {
  availableReasons,
  canMarkNotDriving,
  driveKind,
  driveScoreOf,
  eventRows,
  EVENT_LIST_MAX,
  isShownEvent,
  meritOf,
  notDrivingLabel,
  REPORT_LABEL,
  reportReasons,
  scoreState,
  stateWord,
  toScoringEvent,
} from '../summary';

describe('DashPal', () => {
  test('a DashPal event is reported as "DashPal got it wrong" or "wasn\'t driving"', () => {
    expect(reportReasons('drowsy')).toEqual(['camera_wrong', 'not_driving']);
    expect(reportReasons('eyes_off')).toEqual(['camera_wrong', 'not_driving']);
    expect(reportReasons('hard_brake')).toEqual(['hazard', 'not_driving']);
  });

  test('DashPal events get a pin on the route like any other event', () => {
    const drowsy = event({ id: 'd1', type: 'drowsy', tier: 'severe', durationS: 60 });
    expect(eventMarks([ROUTE], [drowsy]).map((m) => [m.id, m.type, m.tier])).toEqual([['d1', 'drowsy', 'severe']]);
  });

  test("a history row shows DashPal events with the phone's own", () => {
    const counts = { speeding: 1, hardBrake: 0, hardAccel: 0, hardCorner: 0, pickups: 2, eyesOff: 2, drowsy: 1 };
    expect(eventTally(counts)).toEqual([
      { type: 'speeding', n: 1 },
      { type: 'phone_pickup', n: 2 },
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

  test('drives group by week, newest first, with the miles per week and no points', () => {
    const groups = groupByWeek(
      [
        drive({ clientTripId: 'a', startedAt: NOW - 1000 }),
        drive({ clientTripId: 'b', startedAt: NOW - 2 * DAY, miles: 3 }),
        drive({ clientTripId: 'c', startedAt: NOW - 3 * DAY, status: 'not_driving', miles: 4 }),
        drive({ clientTripId: 'd', startedAt: NOW - 12 * DAY }),
      ],
      NOW
    );
    expect(groups.map((g) => g.title)).toEqual(['This week', 'Last week', 'Sep 21 – 27']);
    expect(groups[1]!.data.map((d) => d.clientTripId)).toEqual(['b', 'c']);
    expect(groups[1]!.miles).toBe(7);
    expect(groups[1]).not.toHaveProperty('points');
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
      event({ id: 'p', type: 'drowsy', tier: 'severe', lat: null, lng: null }),
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

  test('a square map frames a tall route by its height', () => {
    // At 60° a degree of latitude spans two of longitude.
    expect(fittedSpan({ latitude: 60, longitude: 0, latitudeDelta: 0.1, longitudeDelta: 0.05 })).toBeCloseTo(0.2, 9);
    expect(fittedSpan({ latitude: 0, longitude: 0, latitudeDelta: 0.01, longitudeDelta: 0.04 })).toBeCloseTo(0.04, 9);
  });

  test('the map is away from its opening view once moved or zoomed more than a tenth of it, in or out', () => {
    const fitted = { latitude: 40, longitude: -74, latitudeDelta: 0.05, longitudeDelta: 0.06 };
    const span = fittedSpan(fitted);
    const k = Math.cos((40 * Math.PI) / 180);
    expect(awayFrom(fitted, fitted)).toBe(false);
    // The engine's own settling (a slightly different square, a hair off centre) is not "away".
    expect(awayFrom({ ...fitted, latitude: 40.0005, latitudeDelta: 0.052, longitudeDelta: 0.062 }, fitted)).toBe(false);
    // Dragged: a fifth of the view east, or north.
    expect(awayFrom({ ...fitted, longitude: -74 + span * 0.2 }, fitted)).toBe(true);
    expect(awayFrom({ ...fitted, latitude: 40 + span * k * 0.2 }, fitted)).toBe(true);
    expect(awayFrom({ ...fitted, longitude: -74 + span * 0.05 }, fitted)).toBe(false);
    // Zoomed in or out, with no move.
    expect(awayFrom({ ...fitted, latitudeDelta: 0.025, longitudeDelta: 0.03 }, fitted)).toBe(true);
    expect(awayFrom({ ...fitted, latitudeDelta: 0.1, longitudeDelta: 0.12 }, fitted)).toBe(true);
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
    expect(eventKind('drowsy', 'severe')).toBe('DashPal');
    // A phone pickup's time in hand says how bad it was: no tier word.
    expect(eventKind('phone_pickup', 'severe')).toBeNull();
    expect(eventName('phone_pickup', 'severe')).toBe('Phone pickup');
    expect(EVENT_ICON.phone_pickup).toBe('phone-portrait-outline');
    expect(formatSpeed(38.4, 'mi')).toBe('38 mph');
    expect(formatSpeed(38.4, 'km')).toBe('62 km/h');
    expect(spokenSpeed(38.4, 'km')).toBe('62 kilometers per hour');
  });
});

describe('stats', () => {
  test('Home shows the last 7 days as counts coloured by the spec bands, with arrows vs an average 30-day week', () => {
    const { stats, window } = homeStats(
      sums({ miles: 50, drives: 4, cleanDrives: 2, speeding: 3, hardBrake: 1, hardAccel: 0 }),
      sums({ miles: 200, drives: 20, cleanDrives: 18, speeding: 2, hardBrake: 4, hardAccel: 2 })
    );
    expect(window).toBe('7d');
    const by = Object.fromEntries(stats.map((s) => [s.id, s]));
    // counts over the 7 days, never per 100 mi; the colour still follows the rate (6.0 per 100 mi is red)
    expect(by.speeding).toMatchObject({ value: '3', unit: '', health: 'red', trend: 'up' });
    // distance gives the counts their context: no colour, no arrow
    expect(by.miles).toMatchObject({ label: 'Distance', value: '50.0', unit: 'mi', health: null, trend: undefined });
    expect(stats.map((x) => x.id)).toEqual(['speeding', 'harsh', 'clean', 'miles']);
    // 1 against 6 × 7/30 = 1.4 a week
    expect(by.harsh).toMatchObject({ value: '1', unit: '', health: 'green', trend: 'down' });
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
  test('a drive has a score to show when it is scored, uploading or not synced yet, and long enough', () => {
    expect(driveKind(drive())).toEqual({ kind: 'scorable', notSynced: false });
    expect(driveKind(drive({ status: 'pending', result: null }))).toEqual({ kind: 'scorable', notSynced: false });
    expect(driveKind(drive({ status: 'failed', result: null }))).toEqual({ kind: 'scorable', notSynced: true });
    expect(driveKind(drive({ status: 'pending', reason: 'too_short', result: null }))).toEqual({ kind: 'too_short' });
    expect(driveKind(drive({ status: 'failed', reason: 'too_short', result: null }))).toEqual({ kind: 'too_short' });
    expect(driveKind(drive({ status: 'unscored', reason: 'too_short' }))).toEqual({ kind: 'too_short' });
    expect(driveKind(drive({ status: 'unscored', reason: 'spoofed' }))).toEqual({ kind: 'not_scored' });
    expect(driveKind(drive({ status: 'not_driving' }))).toEqual({ kind: 'not_driving' });
    expect(driveKind(drive({ status: 'recording', result: null }))).toEqual({ kind: 'recording' });
  });

  test('the score state and the word a row shows instead', () => {
    expect(scoreState(drive(), [event()])).toEqual({ kind: 'score', value: 93, notSynced: false });
    expect(scoreState(drive({ status: 'failed', result: null }), [event()])).toEqual({ kind: 'score', value: 93, notSynced: true });
    expect(scoreState(drive({ miles: 0 }), [])).toEqual({ kind: 'not_scored' });
    expect(stateWord({ kind: 'score' })).toBeNull();
    expect(stateWord({ kind: 'recording' })).toBe('Recording');
    expect(stateWord({ kind: 'too_short' })).toBe('Too short');
    expect(stateWord({ kind: 'not_scored' })).toBe('Not scored');
    expect(stateWord({ kind: 'not_driving' })).toBe('Not driving');
  });

  test('the event list: shown events, oldest first, a phone pickup with its time in hand and speed; never an old phone handling', () => {
    const later = event({ id: 'b', startedAt: NOW });
    const pickup = event({ id: 'p', type: 'phone_pickup', tier: 'severe', startedAt: NOW - 3 * DAY, durationS: 24, measured: { speedMph: 38.4, maxSpeedMph: 45 } });
    const handling = event({ id: 'h', type: 'phone_handling' as never, startedAt: NOW - 4 * DAY });
    const rows = eventRows([later, event(), pickup, handling]);
    expect(rows.map((r) => r.event.id)).toEqual(['p', 'e1', 'b']);
    expect(rows[0]).toMatchObject({
      key: 'event-p',
      label: 'Phone pickup',
      detail: { text: 'In hand 24 s · 38 mph', spoken: 'in hand 24 seconds, at 38 miles per hour' },
    });
    expect(rows[1]).toMatchObject({ key: 'event-e1', label: 'Hard brake · Minor', detail: null });
    // In kilometres, and without a measured speed.
    expect(eventRows([pickup], 'km')[0]!.detail).toEqual({ text: 'In hand 24 s · 62 km/h', spoken: 'in hand 24 seconds, at 62 kilometers per hour' });
    expect(eventRows([{ ...pickup, measured: {} }])[0]!.detail).toEqual({ text: 'In hand 24 s', spoken: 'in hand 24 seconds' });
    expect(eventRows([{ ...pickup, durationS: 75, measured: { maxSpeedMph: 51 } }])[0]!.detail!.text).toBe('In hand 1 min 15 s · 51 mph');
    expect(isShownEvent({ type: 'phone_handling' as never })).toBe(false);
    expect(isShownEvent({ type: 'phone_pickup' })).toBe(true);
    expect(isShownEvent({ type: 'speeding' })).toBe(true);
    expect(EVENT_LIST_MAX).toBe(3);
  });

  test(`report reasons fit the event type, with "wasn't driving" always offered; a phone pickup offers "my phone was mounted"`, () => {
    expect(reportReasons('hard_brake')).toEqual(['hazard', 'not_driving']);
    expect(reportReasons('speeding')).toEqual(['wrong_limit', 'not_driving']);
    expect(reportReasons('phone_pickup')).toEqual(['mounted', 'not_driving']);
    expect(reportReasons('hard_corner')).toEqual(['not_driving']);
    expect(reportReasons('hard_accel')).toEqual(['not_driving']);
    expect(REPORT_LABEL.mounted).toBe('My phone was mounted');
    expect(availableReasons('phone_pickup', false)).toEqual(['mounted']);
  });

  test(`the reasons on offer drop "wasn't driving" where the whole-drive action is not allowed`, () => {
    expect(availableReasons('hard_brake', false)).toEqual(['hazard']);
    expect(availableReasons('hard_corner', false)).toEqual([]);
    expect(availableReasons('hard_corner', true)).toEqual(['not_driving']);
  });

  test(`the "wasn't driving" label carries the uses left`, () => {
    expect(notDrivingLabel(2)).toBe("Wasn't driving (2 left this month)");
    expect(notDrivingLabel(null)).toBe("Wasn't driving");
  });

  test(`"Wasn't driving" is offered on any kept drive the server holds or will hold, within a day of its end, while its "Not driving?" never ran out`, () => {
    const d = drive();
    const ended = d.endedAt!;
    expect(canMarkNotDriving(d, ended + DAY)).toBe(true);
    expect(canMarkNotDriving(d, ended + DAY + 1)).toBe(false);
    expect(canMarkNotDriving(drive({ notDrivingExpired: true }), ended)).toBe(false);
    for (const status of ['scored', 'pending', 'unscored'] as const) expect(canMarkNotDriving(drive({ status }), ended)).toBe(true);
    // A drive whose upload the server refused was never stored there: nothing to mark (it would come back not_found).
    for (const status of ['recording', 'not_driving', 'failed'] as const) expect(canMarkNotDriving(drive({ status }), ended)).toBe(false);
    expect(canMarkNotDriving(drive({ syncError: 'too_old' }), ended)).toBe(false);
    expect(canMarkNotDriving(drive({ syncError: 'invalid_payload' }), ended)).toBe(true);
    expect(canMarkNotDriving(drive({ status: 'failed', syncError: 'invalid_payload' }), ended)).toBe(false);
  });
});

describe('drive score', () => {
  test('each category judged per chance over this drive alone: a hard brake against its slowdowns, a whole number', () => {
    // 12 mi, one minor hard brake in 30 slowdowns: Braking 63, the rest 100, Speed double → 93.
    expect(driveScoreOf(drive(), [event()])).toBe(93);
    expect(driveScoreOf(drive(), [])).toBe(100);
    // A severe one weighs twice: Braking 46 → 89.
    expect(driveScoreOf(drive(), [event({ tier: 'severe' })])).toBe(89);
    // Few slowdowns floor at 10, so one hard brake never sinks a short drive to 0: Braking 36 → 87.
    expect(driveScoreOf(drive({ exposure: { slowdowns: 2, speedups: 2, turns: 1, limitS: 60, movingS: 200, phoneS: 0 } }), [event()])).toBe(87);
  });

  test('a phone pickup counts against Phone use, judged against the drive’s time at driving speed; not watched, Phone use is left out', () => {
    const watched = drive({ exposure: { ...EXPOSURE, phoneS: 1200 } });
    const pickup = (durationS: number) => event({ id: 'p', type: 'phone_pickup', tier: durationS > 15 ? 'severe' : 'moderate', durationS, measured: { speedMph: 30 } });
    expect(driveScoreOf(watched, [])).toBe(100);
    const short = driveScoreOf(watched, [pickup(5)])!;
    const long = driveScoreOf(watched, [pickup(60)])!;
    expect(short).toBeLessThan(100);
    expect(long).toBeLessThan(short);
    // A report that took it off: it no longer counts.
    expect(driveScoreOf(watched, [{ ...pickup(60), disputeStatus: 'accepted' }])).toBe(100);
  });

  test('an event a report took off, or one removed, no longer counts', () => {
    expect(driveScoreOf(drive(), [event({ disputeStatus: 'accepted' })])).toBe(100);
    expect(driveScoreOf(drive(), [event({ removed: true })])).toBe(100);
    expect(driveScoreOf(drive(), [event({ disputeStatus: 'pending' })])).toBe(93);
    expect(toScoringEvent(event({ removed: true }))).toMatchObject({ status: 'removed' });
  });

  test('speeding reads how far over it was', () => {
    const speeding = (overMphS: number) => event({ id: 's', type: 'speeding', tier: 'minor', durationS: 30, measured: { overMphS } });
    const mild = driveScoreOf(drive(), [speeding(10)])!;
    const far = driveScoreOf(drive(), [speeding(400)])!;
    expect(far).toBeLessThan(mild);
    expect(toScoringEvent(speeding(10))).toMatchObject({ measured: { overMphS: 10 } });
  });

  test("DashPal's events score Attention over the miles it watched, and only when it watched", () => {
    const eyes = event({ id: 'd', type: 'eyes_off', tier: 'severe', measured: { source: 'dashcam' } });
    // Attention 100 / (1 + 40/6/16) = 70.6, weight 1 of 6 → 95.
    expect(driveScoreOf(drive({ watchedMiles: 6 }), [eyes])).toBe(95);
    expect(driveScoreOf(drive({ watchedMiles: 0 }), [eyes])).toBe(100);
  });

  test('only for a drive with a score to show', () => {
    const e = [event()];
    expect(driveScoreOf(drive({ status: 'pending', result: null }), e)).toBe(93);
    expect(driveScoreOf(drive({ status: 'failed', result: null }), e)).toBe(93);
    expect(driveScoreOf(drive({ status: 'pending', reason: 'too_short', result: null }), e)).toBeNull();
    expect(driveScoreOf(drive({ status: 'unscored', reason: 'too_short', result: null }), e)).toBeNull();
    expect(driveScoreOf(drive({ status: 'unscored', reason: 'spoofed', result: null }), e)).toBeNull();
    expect(driveScoreOf(drive({ status: 'not_driving' }), e)).toBeNull();
    expect(driveScoreOf(drive({ status: 'recording', result: null }), e)).toBeNull();
    expect(driveScoreOf(drive({ miles: 0 }), e)).toBeNull();
  });

  test('the merit tier needs both the score and the distance', () => {
    expect(meritOf(drive({ miles: 0.5 }), [])).toBe(1);
    expect(meritOf(drive({ miles: 20 }), [])).toBe(4);
    expect(meritOf(drive({ miles: 26 }), [])).toBe(5);
    expect(meritOf(drive(), [event()])).toBe(4);
    expect(meritOf(drive({ status: 'not_driving' }), [])).toBeNull();
  });
});
