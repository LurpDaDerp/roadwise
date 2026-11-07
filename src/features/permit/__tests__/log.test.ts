/**
 * The practice log: which drives count (kept, not a passenger ride, from the start day on, Permit
 * mode on), their whole minutes and supervisors, the totals, the targets (the driver's or the
 * state's), and the hours as the screens write them.
 */
import { DAY, drive, HOUR, NOW } from '@/features/drives/__fixtures__/drives';
import { dayKey } from '@/lib/time';

import { permitSubtitle } from '../PermitSettingRow';
import {
  dayTargetOf,
  driveDay,
  hoursText,
  isKeptDrive,
  isPracticeDrive,
  nightRuleOf,
  permitState,
  practiceLog,
  progressOf,
  targetsOf,
  targetText,
  wholeMinutes,
} from '../log';
import { DEFAULT_PERMIT, type PermitPrefs } from '../prefs';
import { stateByCode } from '../states';

const today = dayKey(new Date(NOW));
const prefs = (over: Partial<PermitPrefs> = {}): PermitPrefs => ({ ...DEFAULT_PERMIT, enabled: true, startDay: today, state: { code: 'CA', auto: true }, ...over });
// A daytime drive today (13:00, 24 min).
const todays = drive();

describe('which drives count', () => {
  test('kept: scored, waiting, refused, or too short; never in progress, marked, or one the server could not score', () => {
    expect(isKeptDrive(drive({ status: 'scored' }))).toBe(true);
    expect(isKeptDrive(drive({ status: 'pending' }))).toBe(true);
    expect(isKeptDrive(drive({ status: 'pending', reason: 'too_short' }))).toBe(true);
    expect(isKeptDrive(drive({ status: 'failed' }))).toBe(true);
    expect(isKeptDrive(drive({ status: 'unscored', reason: 'too_short' }))).toBe(true);
    expect(isKeptDrive(drive({ status: 'unscored', reason: null, result: { ...drive().result!, reason: 'too_short' } }))).toBe(true);
    expect(isKeptDrive(drive({ status: 'unscored', reason: 'implausible_speed', result: null }))).toBe(false);
    expect(isKeptDrive(drive({ status: 'not_driving' }))).toBe(false);
    expect(isKeptDrive(drive({ status: 'recording' }))).toBe(false);
  });

  test("from the start day on (the drive's own day), only while Permit mode is on", () => {
    expect(isPracticeDrive(todays, prefs())).toBe(true);
    expect(isPracticeDrive(drive({ startedAt: NOW - 2 * DAY }), prefs())).toBe(false);
    expect(isPracticeDrive(todays, prefs({ enabled: false }))).toBe(false);
    expect(isPracticeDrive(todays, prefs({ startDay: null }))).toBe(false);
    expect(isPracticeDrive(drive({ status: 'not_driving' }), prefs())).toBe(false);
  });

  test("a drive's day is read in its own time zone", () => {
    const t = Date.UTC(2026, 9, 5, 3, 0); // 3 AM UTC is the evening before in Los Angeles
    expect(driveDay({ startedAt: t, tz: 'America/Los_Angeles' })).toBe('2026-10-04');
    expect(driveDay({ startedAt: t, tz: 'UTC' })).toBe('2026-10-05');
    expect(isPracticeDrive(drive({ startedAt: t, tz: 'America/Los_Angeles' }), prefs({ startDay: '2026-10-05' }))).toBe(false);
    expect(isPracticeDrive(drive({ startedAt: t, tz: 'UTC' }), prefs({ startDay: '2026-10-05' }))).toBe(true);
  });
});

describe('the log', () => {
  test("newest first, whole minutes, the drive's supervisor else the saved one, and totals that add up", () => {
    const older = drive({ clientTripId: 'b', startedAt: NOW - 4 * HOUR, endedAt: NOW - 4 * HOUR + 30.4 * 60_000, durationS: 30.4 * 60, miles: 8, practiceSupervisor: 'Mom' });
    const marked = drive({ clientTripId: 'c', status: 'not_driving' });
    const log = practiceLog([older, todays, marked], prefs({ supervisor: 'Dad' }));
    expect(log.rows.map((r) => r.drive.clientTripId)).toEqual(['a1', 'b']);
    expect(log.rows.map((r) => r.supervisor)).toEqual(['Dad', 'Mom']);
    expect(log.rows[1]).toMatchObject({ dayMin: 30, nightMin: 0 });
    expect(log.totals).toEqual({ drives: 2, dayMin: 54, nightMin: 0, totalMin: 54, miles: 20 });
    expect(practiceLog([todays], prefs({ supervisor: null })).rows[0]?.supervisor).toBeNull();
    expect(practiceLog([todays], prefs({ enabled: false })).totals.drives).toBe(0);
  });

  test('whole minutes: the night rounded, the day the rest of the rounded whole', () => {
    expect(wholeMinutes({ dayMin: 10.4, nightMin: 5.4 })).toEqual({ dayMin: 11, nightMin: 5 });
    expect(wholeMinutes({ dayMin: 0.2, nightMin: 0.6 })).toEqual({ dayMin: 0, nightMin: 1 });
    expect(wholeMinutes({ dayMin: 0, nightMin: 0 })).toEqual({ dayMin: 0, nightMin: 0 });
  });
});

describe('targets and words', () => {
  test("the driver's own targets, else the state's, else none", () => {
    expect(targetsOf(prefs())).toEqual({ totalH: 50, nightH: 10 });
    expect(targetsOf(prefs({ targets: { totalH: 40, nightH: null } }))).toEqual({ totalH: 40, nightH: null });
    expect(targetsOf(prefs({ state: { code: 'AR', auto: false } }))).toEqual({ totalH: null, nightH: null });
    expect(targetsOf(prefs({ state: { code: null, auto: true } }))).toEqual({ totalH: null, nightH: null });
  });

  test("the night rule is the state's; sunset to sunrise without one", () => {
    expect(nightRuleOf(permitState(prefs()))).toBe('dark30');
    expect(nightRuleOf(stateByCode('MD'))).toBe('md30');
    expect(nightRuleOf(null)).toBe('sunset');
  });

  test('hours to a tenth, never rounded up; targets as typed; progress and the day target', () => {
    expect(hoursText(750)).toBe('12.5');
    expect(hoursText(2999)).toBe('49.9');
    expect(hoursText(0)).toBe('0.0');
    expect(hoursText(60)).toBe('1.0');
    expect(targetText(50)).toBe('50');
    expect(targetText(12.5)).toBe('12.5');
    expect(progressOf(1500, 50)).toBe(0.5);
    expect(progressOf(6000, 50)).toBe(1);
    expect(progressOf(60, null)).toBe(0);
    expect(dayTargetOf({ totalH: 50, nightH: 10 })).toBe(40);
    expect(dayTargetOf({ totalH: 50, nightH: null })).toBeNull();
  });

  test('the Settings row: Off, On with the hours against the total, or On without a total', () => {
    const log = practiceLog([todays], prefs());
    expect(permitSubtitle(undefined, undefined)).toBe('Off');
    expect(permitSubtitle(prefs({ enabled: false }), undefined)).toBe('Off');
    expect(permitSubtitle(prefs(), { ...log, totals: { ...log.totals, totalMin: 750 } })).toBe('On · 12.5 of 50 h');
    expect(permitSubtitle(prefs({ state: { code: 'AR', auto: false } }), log)).toBe('On');
    expect(permitSubtitle(prefs(), undefined)).toBe('On');
  });
});
