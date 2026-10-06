import { DAY, drive, event, NOW, ROUTE, sums } from '../__fixtures__/drives';
import { formatDuration, formatTimeSpan, groupByWeek, weekLabel, weekStart } from '../format';
import { routeDots, routeRuns, sketchPath } from '../route';
import { homeStats, trendFor } from '../stats';
import {
  breakdownLines,
  celebrations,
  multiplierText,
  notDrivingLabel,
  pointsState,
  reportReasons,
  streakLine,
} from '../summary';

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
    const d = sketchPath(ROUTE, 56, 56, 4)!;
    const nums = d.match(/[\d.]+/g)!.map(Number);
    expect(Math.min(...nums)).toBeGreaterThanOrEqual(3.9);
    expect(Math.max(...nums)).toBeLessThanOrEqual(52.1);
    expect(sketchPath([ROUTE[0]!], 56, 56)).toBeNull();
  });

  test('a speeding stretch is coloured by its tier; the rest stays clean', () => {
    const runs = routeRuns(ROUTE, [event({ id: 's', type: 'speeding', tier: 'moderate', durationS: 20, lat: ROUTE[5]!.lat, lng: ROUTE[5]!.lng })]);
    expect(runs.map((r) => r.tier)).toEqual([null, 'moderate', null]);
  });

  test('overlapping stretches take the worse tier, and removed events are ignored', () => {
    const runs = routeRuns(ROUTE, [
      event({ id: 's', type: 'speeding', tier: 'minor', durationS: 60, lat: ROUTE[5]!.lat, lng: ROUTE[5]!.lng }),
      event({ id: 'h', type: 'phone_handling', tier: 'severe', durationS: 5, lat: ROUTE[6]!.lat, lng: ROUTE[6]!.lng }),
      event({ id: 'x', type: 'drowsy', tier: 'severe', durationS: 60, lat: ROUTE[20]!.lat, lng: ROUTE[20]!.lng, disputeStatus: 'accepted' }),
    ]);
    expect(runs.some((r) => r.tier === 'severe')).toBe(true);
    expect(runs.some((r) => r.tier === 'minor')).toBe(true);
    expect(runs[runs.length - 1]!.tier).toBeNull();
  });

  test('instant events become dots; ones without a location are left off', () => {
    const dots = routeDots([event(), event({ id: 'p', type: 'phone_pickup', tier: 'severe', lat: null, lng: null }), event({ id: 's', type: 'speeding' })]);
    expect(dots.map((d) => d.id)).toEqual(['e1']);
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
    expect(pointsState(drive())).toEqual({ kind: 'points', value: 167, estimate: false });
    expect(pointsState(drive({ status: 'pending', estimate: true, pointsNet: 40, result: null }))).toEqual({ kind: 'points', value: 40, estimate: true });
    expect(pointsState(drive({ status: 'unscored', reason: 'too_short' })).kind).toBe('too_short');
    expect(pointsState(drive({ status: 'unscored', reason: 'spoofed' })).kind).toBe('not_scored');
    expect(pointsState(drive({ status: 'merged', mergedInto: 'z' }))).toEqual({ kind: 'merged', into: 'z' });
  });

  test('the multiplier line names each part and the cap', () => {
    expect(multiplierText(1.2, 1.25, 1.5)).toBe('streak ×1.20 · DMS ×1.25 → ×1.50 (cap)');
    expect(multiplierText(1.08, 1, 1.08)).toBe('streak ×1.08 → ×1.08');
  });

  test('the breakdown itemizes miles, multiplier, each event and the net', () => {
    const { lines, note } = breakdownLines(drive(), [event()]);
    expect(lines.map((l) => [l.label, l.value])).toEqual([
      ['Safe miles: 11.8 mi × 10', '+118'],
      ['Multiplier: streak ×1.20 · DMS ×1.25 → ×1.50 (cap)', '= +177'],
      ['Hard brake · Minor', '−10'],
      ['Net total', '+167'],
    ]);
    expect(note).toBeNull();
  });

  test('an accepted report reads as removed; an offline estimate explains the missing lines', () => {
    const { lines, note } = breakdownLines(drive({ result: null, status: 'pending', estimate: true, pointsNet: 30 }), [event({ disputeStatus: 'accepted' })]);
    expect(lines.map((l) => l.value)).toEqual(['Removed', '+30']);
    expect(note).toMatch(/once this drive is scored/);
  });

  test('the streak line covers growth, freezes and risk', () => {
    expect(streakLine(drive())!.text).toBe('Streak 11 · next drive ×1.22');
    const r = drive().result!;
    expect(streakLine(drive({ result: { ...r, streak: { ...r.streak, outcome: 'freeze_used', after: 11 } } }))!.text).toBe('Freeze used · streak stays at 11');
    expect(streakLine(drive({ result: { ...r, streak: { ...r.streak, outcome: 'at_risk' } } }))!.text).toBe('Streak at risk: drive clean next time');
  });

  test('celebrations list level-ups, achievements and challenges', () => {
    const r = drive().result!;
    const c = celebrations(drive({ result: { ...r, achievements: ['streak_10'], challenges: [{ id: 'c1', title: 'Phone down' }], progress: { ...r.progress, levelUp: true, level: 5 } } }));
    expect(c.map((x) => x.label)).toEqual(['Level 5!', 'Streak 10', 'Phone down · +100']);
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
