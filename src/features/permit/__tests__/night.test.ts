/**
 * Day and night minutes of a practice drive: night under each rule against known sunsets (Seattle
 * at midsummer, Miami at midwinter, Anchorage), a drive across midnight, the midnight sun and the
 * polar night, the last partial minute, the route's ends when the drive keeps no stored ends, and
 * the night minutes kept for an archived drive (exact under every rule), and the night-miles share
 * when it keeps no position and nothing was kept.
 */
import { encodeRuns } from '@/lib/polyline';
import { sunTimes } from '@/ui/sky/solar';

import { driveEnds, isNightAt, nightByRule, practiceMinutes, type PracticeDriveFacts } from '../night';

const MIN = 60_000;
const SEATTLE = { lat: 47.6062, lng: -122.3321 };
const MIAMI = { lat: 25.7617, lng: -80.1918 };
const ANCHORAGE = { lat: 61.2181, lng: -149.9003 };
const UTQIAGVIK = { lat: 71.29, lng: -156.79 };

const sun = (iso: string, p: { lat: number; lng: number }) => {
  const s = sunTimes(new Date(iso), p.lat, p.lng);
  return { sunrise: s.sunrise?.getTime() ?? NaN, sunset: s.sunset?.getTime() ?? NaN };
};
const near = (ms: number, iso: string) => expect(Math.abs(ms - Date.parse(iso))).toBeLessThan(3 * MIN);

const drive = (startedAt: number, minutes: number, over: Partial<PracticeDriveFacts> = {}): PracticeDriveFacts => ({
  startedAt,
  endedAt: startedAt + minutes * MIN,
  durationS: minutes * 60,
  miles: 10,
  nightMiles: 0,
  polyline: null,
  start: SEATTLE,
  end: SEATTLE,
  ...over,
});

describe('night under each rule', () => {
  // Seattle, June 21 2026: sunrise 5:11 AM, sunset 9:11 PM (PDT).
  const sea = sun('2026-06-21T20:00:00Z', SEATTLE);

  test('the sun is where the almanac puts it', () => {
    near(sea.sunrise, '2026-06-21T12:11:00Z');
    near(sea.sunset, '2026-06-22T04:11:00Z');
    // Miami, December 21 2026: 7:03 AM and 5:35 PM (EST). Anchorage, June 21 2026: 4:20 AM and 11:42 PM (AKDT).
    const mia = sun('2026-12-21T17:00:00Z', MIAMI);
    near(mia.sunrise, '2026-12-21T12:03:00Z');
    near(mia.sunset, '2026-12-21T22:35:00Z');
    const anc = sun('2026-06-21T22:00:00Z', ANCHORAGE);
    near(anc.sunrise, '2026-06-21T12:20:00Z');
    near(anc.sunset, '2026-06-22T07:42:00Z');
  });

  test('sunset: from sunset to sunrise', () => {
    const night = (ms: number) => isNightAt(ms, SEATTLE.lat, SEATTLE.lng, 'sunset');
    expect(night(sea.sunset - MIN)).toBe(false);
    expect(night(sea.sunset + MIN)).toBe(true);
    expect(night(sea.sunrise - MIN)).toBe(true);
    expect(night(sea.sunrise + MIN)).toBe(false);
  });

  test('dark30: from 30 minutes after sunset to 30 minutes before sunrise', () => {
    const night = (ms: number) => isNightAt(ms, SEATTLE.lat, SEATTLE.lng, 'dark30');
    expect(night(sea.sunset + 29 * MIN)).toBe(false);
    expect(night(sea.sunset + 31 * MIN)).toBe(true);
    expect(night(sea.sunrise - 31 * MIN)).toBe(true);
    expect(night(sea.sunrise - 29 * MIN)).toBe(false);
  });

  test('md30: from 30 minutes before sunset to 30 minutes after sunrise', () => {
    const night = (ms: number) => isNightAt(ms, SEATTLE.lat, SEATTLE.lng, 'md30');
    expect(night(sea.sunset - 31 * MIN)).toBe(false);
    expect(night(sea.sunset - 29 * MIN)).toBe(true);
    expect(night(sea.sunrise + 29 * MIN)).toBe(true);
    expect(night(sea.sunrise + 31 * MIN)).toBe(false);
  });

  test('Anchorage at midsummer: still day at 11:30 PM, night just before midnight', () => {
    const anc = sun('2026-06-21T22:00:00Z', ANCHORAGE);
    expect(isNightAt(anc.sunset - 10 * MIN, ANCHORAGE.lat, ANCHORAGE.lng, 'sunset')).toBe(false);
    expect(isNightAt(anc.sunset + 10 * MIN, ANCHORAGE.lat, ANCHORAGE.lng, 'sunset')).toBe(true);
  });

  test('the midnight sun is never night, the polar night always is', () => {
    for (const rule of ['sunset', 'dark30', 'md30'] as const) {
      expect(isNightAt(Date.parse('2026-06-22T08:00:00Z'), UTQIAGVIK.lat, UTQIAGVIK.lng, rule)).toBe(false);
      expect(isNightAt(Date.parse('2026-12-21T22:00:00Z'), UTQIAGVIK.lat, UTQIAGVIK.lng, rule)).toBe(true);
    }
  });
});

describe('practice minutes', () => {
  const sea = sun('2026-06-21T20:00:00Z', SEATTLE);

  test('an hour across sunset splits by the rule', () => {
    const d = drive(sea.sunset - 30 * MIN, 60);
    const by = (rule: 'sunset' | 'dark30' | 'md30') => practiceMinutes(d, rule);
    expect(by('sunset').nightMin).toBeCloseTo(30, 0);
    expect(by('sunset').dayMin).toBeCloseTo(30, 0);
    expect(by('dark30').nightMin).toBeLessThanOrEqual(1);
    expect(by('md30').nightMin).toBeGreaterThanOrEqual(59);
    expect(by('dark30').dayMin + by('dark30').nightMin).toBe(60);
  });

  test('a noon drive has no night; a drive across midnight in Miami is night throughout', () => {
    expect(practiceMinutes(drive(Date.parse('2026-06-21T19:00:00Z'), 45), 'sunset')).toEqual({ dayMin: 45, nightMin: 0 });
    // 11:30 PM to 12:30 AM EST, December 21 to 22.
    const late = drive(Date.parse('2026-12-22T04:30:00Z'), 60, { start: MIAMI, end: MIAMI });
    expect(practiceMinutes(late, 'sunset')).toEqual({ dayMin: 0, nightMin: 60 });
    expect(practiceMinutes(late, 'dark30')).toEqual({ dayMin: 0, nightMin: 60 });
  });

  test('a drive that ends in the dark and moves between its ends is judged at the place it has reached', () => {
    // Seattle to Miami is absurd for a drive, but it shows the interpolation: at 9:00 PM PDT the
    // sun has long set in Miami (12:00 AM EST), so the second half, nearer Miami, is night.
    const t = Date.parse('2026-06-22T03:30:00Z');
    const across = practiceMinutes(drive(t, 60, { start: SEATTLE, end: MIAMI }), 'sunset');
    const stay = practiceMinutes(drive(t, 60), 'sunset');
    expect(across.nightMin).toBeGreaterThan(stay.nightMin);
  });

  test('the last partial minute counts; no end time uses the duration', () => {
    const t = Date.parse('2026-06-21T19:00:00Z');
    const m = practiceMinutes(drive(t, 0, { endedAt: t + 90_500, durationS: 90.5 }), 'sunset');
    expect(m.dayMin + m.nightMin).toBeCloseTo(90.5 / 60, 6);
    expect(practiceMinutes(drive(t, 0, { endedAt: null, durationS: 600 }), 'sunset')).toEqual({ dayMin: 10, nightMin: 0 });
    expect(practiceMinutes(drive(t, 0, { endedAt: t, durationS: 0 }), 'sunset')).toEqual({ dayMin: 0, nightMin: 0 });
  });

  test('without stored ends the route gives them; one end alone stands for both', () => {
    const polyline = encodeRuns([
      [MIAMI, { lat: 26, lng: -80.2 }],
      [{ lat: 26.1, lng: -80.3 }, SEATTLE],
    ]);
    expect(driveEnds({ polyline, start: undefined, end: undefined })).toEqual({ from: expect.objectContaining({ lat: MIAMI.lat }), to: expect.objectContaining({ lat: SEATTLE.lat }) });
    expect(driveEnds({ polyline: null, start: undefined, end: MIAMI })).toEqual({ from: MIAMI, to: MIAMI });
    expect(driveEnds({ polyline: 'not a polyline', start: undefined, end: undefined })).toBeNull();
    const t = Date.parse('2026-12-22T04:30:00Z');
    expect(practiceMinutes(drive(t, 30, { start: undefined, end: undefined, polyline: encodeRuns([[MIAMI, { lat: 25.77, lng: -80.2 }]]) }), 'sunset')).toEqual({ dayMin: 0, nightMin: 30 });
  });

  test('with no position at all, the night share is its night miles over its miles', () => {
    const t = Date.parse('2026-06-21T19:00:00Z');
    const none = { start: undefined, end: undefined, polyline: null };
    expect(practiceMinutes(drive(t, 20, { ...none, miles: 10, nightMiles: 2.5 }), 'sunset')).toEqual({ dayMin: 15, nightMin: 5 });
    expect(practiceMinutes(drive(t, 20, { ...none, miles: 0, nightMiles: 0 }), 'sunset')).toEqual({ dayMin: 20, nightMin: 0 });
    expect(practiceMinutes(drive(t, 20, { ...none, miles: 1, nightMiles: 3 }), 'sunset')).toEqual({ dayMin: 0, nightMin: 20 });
  });

  test('an archived drive keeps its split: the night kept under the rule, the rest of its wall time day', () => {
    const d = drive(sea.sunset - 30 * MIN, 60);
    const kept = nightByRule(d);
    expect(kept).not.toBeNull();
    const archived = { ...d, start: undefined, end: undefined, polyline: null, nightMiles: 5 };
    for (const rule of ['sunset', 'dark30', 'md30'] as const) {
      const before = practiceMinutes(d, rule);
      const after = practiceMinutes(archived, rule, kept);
      expect(after.nightMin).toBeCloseTo(before.nightMin, 1);
      expect(after.dayMin + after.nightMin).toBe(60);
    }
    // Nothing kept: the night-miles share (sunset to sunrise whatever the rule).
    expect(practiceMinutes(archived, 'dark30')).toEqual({ dayMin: 30, nightMin: 30 });
    // A drive with a position ignores anything kept.
    expect(practiceMinutes(d, 'sunset', { sunset: 60, dark30: 60, md30: 60 })).toEqual(practiceMinutes(d, 'sunset'));
    // Kept night is held to the wall time.
    expect(practiceMinutes(archived, 'md30', { sunset: 0, dark30: 0, md30: 99 })).toEqual({ dayMin: 0, nightMin: 60 });
    expect(nightByRule({ ...archived })).toBeNull();
  });
});
