/** @jest-environment node */
import type { CommuteDrive, CommutePlace } from '@/core/places/commute';
import { DEFAULT_QUIET_HOURS, type QuietHours } from '@/features/settings/notifications/quietHours';

import {
  atLocalMinute,
  departureWeather,
  endedAt,
  fireTimeFor,
  HEADS_UP_AT_START_M,
  HEADS_UP_MILD,
  headsUpId,
  inQuietHours,
  localClock,
  nextHeadsUp,
  planDepartures,
  quietEndAfter,
  spaced,
} from '../commutePlan';
import { clockOfMinute, commuteHeadsUpCopy, WEATHER_TITLES } from '../copy';
import type { HourlyForecast, HourlyPoint } from '../forecast';
import type { WeatherSample } from '../openMeteo';

const NY = 'America/New_York';
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const OFF: QuietHours = { enabled: false, start: '22:00', end: '07:00' };

/** Monday 9 Nov 2026, 7:40 AM in New York (EST, UTC−5). */
const MON_740 = Date.UTC(2026, 10, 9, 12, 40);
/** Sunday 8 Nov 2026, 6 PM in New York. */
const SUN_6PM = Date.UTC(2026, 10, 8, 23, 0);

describe('the phone clock', () => {
  it('reads the local day, weekday and minute in the zone', () => {
    expect(localClock(MON_740, NY)).toMatchObject({ weekday: 1, minute: 7 * 60 + 40 });
    expect(localClock(MON_740, 'UTC')).toMatchObject({ weekday: 1, minute: 12 * 60 + 40 });
    // 11:30 PM Sunday in New York is already Monday in UTC.
    expect(localClock(Date.UTC(2026, 10, 9, 4, 30), NY)).toMatchObject({ weekday: 0, minute: 23 * 60 + 30 });
  });

  it('finds the moment a local day shows a minute, across both clock changes', () => {
    const day = localClock(MON_740, NY).day;
    expect(atLocalMinute(day, 7 * 60 + 40, NY)).toBe(MON_740);
    // Monday 9 Mar 2026, the day after clocks went forward: 7:40 EDT is 11:40 UTC.
    const spring = localClock(Date.UTC(2026, 2, 9, 15, 0), NY).day;
    expect(atLocalMinute(spring, 7 * 60 + 40, NY)).toBe(Date.UTC(2026, 2, 9, 11, 40));
    // Sunday 8 Mar 2026 itself: 1:30 AM is still EST, 3:30 AM already EDT.
    const springDay = localClock(Date.UTC(2026, 2, 8, 15, 0), NY).day;
    expect(atLocalMinute(springDay, 90, NY)).toBe(Date.UTC(2026, 2, 8, 6, 30));
    expect(atLocalMinute(springDay, 210, NY)).toBe(Date.UTC(2026, 2, 8, 7, 30));
    // Monday 2 Nov 2026, the day after clocks went back: 7:40 EST is 12:40 UTC.
    const fall = localClock(Date.UTC(2026, 10, 2, 15, 0), NY).day;
    expect(atLocalMinute(fall, 7 * 60 + 40, NY)).toBe(Date.UTC(2026, 10, 2, 12, 40));
  });
});

describe('quiet hours', () => {
  const night: QuietHours = { enabled: true, start: '22:00', end: '07:00' };
  const day: QuietHours = { enabled: true, start: '13:00', end: '15:00' };

  it('hold from the start up to the end, across midnight too', () => {
    const at = (h: number, m = 0) => Date.UTC(2026, 10, 9, h + 5, m);
    expect(inQuietHours(at(6, 59), NY, night)).toBe(true);
    expect(inQuietHours(at(7, 0), NY, night)).toBe(false);
    expect(inQuietHours(at(21, 59), NY, night)).toBe(false);
    expect(inQuietHours(at(22, 0), NY, night)).toBe(true);
    expect(inQuietHours(at(2), NY, night)).toBe(true);
    expect(inQuietHours(at(14), NY, day)).toBe(true);
    expect(inQuietHours(at(15), NY, day)).toBe(false);
  });

  it('do nothing when off, when start and end are the same, or when malformed', () => {
    const at = Date.UTC(2026, 10, 9, 8, 0); // 3 AM
    expect(inQuietHours(at, NY, OFF)).toBe(false);
    expect(inQuietHours(at, NY, null)).toBe(false);
    expect(inQuietHours(at, NY, { enabled: true, start: '07:00', end: '07:00' })).toBe(false);
    expect(inQuietHours(at, NY, { enabled: true, start: '7am', end: '07:00' })).toBe(false);
  });

  it('end at the next end of the clock after the moment', () => {
    expect(quietEndAfter(Date.UTC(2026, 10, 9, 11, 10), NY, night)).toBe(Date.UTC(2026, 10, 9, 12, 0)); // 6:10 → 7:00 AM
    expect(quietEndAfter(Date.UTC(2026, 10, 9, 4, 0), NY, night)).toBe(Date.UTC(2026, 10, 9, 12, 0)); // 11 PM → 7:00 AM next day
  });
});

describe('when a heads-up is due', () => {
  const night: QuietHours = { enabled: true, start: '22:00', end: '07:00' };

  it('is 30 minutes before the departure', () => {
    expect(fireTimeFor(MON_740, NY, OFF)).toBe(MON_740 - 30 * MIN);
    expect(fireTimeFor(MON_740, NY, null)).toBe(MON_740 - 30 * MIN);
  });

  it('moves to the end of quiet hours when that is still 10 minutes before leaving, else there is none', () => {
    const at = (h: number, m: number) => Date.UTC(2026, 10, 9, h + 5, m);
    // Leaving at 7:15: 6:45 is quiet, 7:00 is 15 min before.
    expect(fireTimeFor(at(7, 15), NY, night)).toBe(at(7, 0));
    // Leaving at 7:10: 7:00 is exactly 10 min before.
    expect(fireTimeFor(at(7, 10), NY, night)).toBe(at(7, 0));
    // Leaving at 7:09: too close.
    expect(fireTimeFor(at(7, 9), NY, night)).toBeNull();
    expect(fireTimeFor(at(6, 30), NY, night)).toBeNull();
    // The server's default quiet hours (10 PM to 7 AM) are the same.
    expect(fireTimeFor(at(7, 15), NY, DEFAULT_QUIET_HOURS)).toBe(at(7, 0));
    // Leaving at 7:31: 7:01 is outside them.
    expect(fireTimeFor(at(7, 31), NY, night)).toBe(at(7, 1));
  });
});

describe('the next departure', () => {
  const m740 = 7 * 60 + 40;

  it('is tomorrow morning from the evening before', () => {
    expect(nextHeadsUp(m740, SUN_6PM, NY, OFF)).toEqual({ departAt: MON_740, fireAt: MON_740 - 30 * MIN });
  });

  it('is today while its heads-up is more than a minute off', () => {
    expect(nextHeadsUp(m740, MON_740 - 31 * MIN - 1, NY, OFF)).toEqual({ departAt: MON_740, fireAt: MON_740 - 30 * MIN });
    // One minute before the heads-up: too late for today, and tomorrow is more than 20 h away.
    expect(nextHeadsUp(m740, MON_740 - 31 * MIN, NY, OFF)).toBeNull();
    expect(nextHeadsUp(m740, MON_740 - 10 * MIN, NY, OFF)).toBeNull();
    expect(nextHeadsUp(m740, MON_740 + HOUR, NY, OFF)).toBeNull();
  });

  it('is never more than 20 hours away', () => {
    expect(nextHeadsUp(m740, MON_740 - 20 * HOUR, NY, OFF)?.departAt).toBe(MON_740);
    expect(nextHeadsUp(m740, MON_740 - 20 * HOUR - 1, NY, OFF)).toBeNull();
  });

  it('skips the weekend: none from Friday evening, Saturday or Sunday morning', () => {
    const fri6pm = SUN_6PM - 2 * DAY;
    expect(nextHeadsUp(m740, fri6pm, NY, OFF)).toBeNull();
    expect(nextHeadsUp(m740, SUN_6PM - DAY, NY, OFF)).toBeNull(); // Saturday 6 PM
    expect(nextHeadsUp(m740, SUN_6PM - 12 * HOUR, NY, OFF)).toBeNull(); // Sunday 6 AM
    // An evening leg on Friday afternoon is still Friday.
    const fri1730 = Date.UTC(2026, 10, 6, 22, 30);
    expect(nextHeadsUp(17 * 60 + 30, fri1730 - 2 * HOUR, NY, OFF)?.departAt).toBe(fri1730);
  });

  it('keeps the wall clock across a clock change', () => {
    // Sunday 8 Mar 2026, 6 PM EDT; Monday 7:40 EDT is 11:40 UTC.
    expect(nextHeadsUp(m740, Date.UTC(2026, 2, 8, 22, 0), NY, OFF)?.departAt).toBe(Date.UTC(2026, 2, 9, 11, 40));
    // Sunday 1 Nov 2026, 6 PM EST; Monday 7:40 EST is 12:40 UTC.
    expect(nextHeadsUp(m740, Date.UTC(2026, 10, 1, 23, 0), NY, OFF)?.departAt).toBe(Date.UTC(2026, 10, 2, 12, 40));
  });

  it('a minute after midnight departs the same night', () => {
    // Sunday 11 PM: Monday 0:45 is 1 h 45 min away.
    const sun11pm = Date.UTC(2026, 10, 9, 4, 0);
    expect(nextHeadsUp(45, sun11pm, NY, OFF)?.departAt).toBe(Date.UTC(2026, 10, 9, 5, 45));
  });

  it('with quiet hours: their end, or none', () => {
    const night: QuietHours = { enabled: true, start: '22:00', end: '07:00' };
    const d = Date.UTC(2026, 10, 9, 12, 15); // Monday 7:15
    expect(nextHeadsUp(7 * 60 + 15, SUN_6PM, NY, night)).toEqual({ departAt: d, fireAt: Date.UTC(2026, 10, 9, 12, 0) });
    // Between the would-be 6:45 and the moved 7:00: the heads-up still stands.
    expect(nextHeadsUp(7 * 60 + 15, Date.UTC(2026, 10, 9, 11, 50), NY, night)?.fireAt).toBe(Date.UTC(2026, 10, 9, 12, 0));
    expect(nextHeadsUp(6 * 60 + 50, SUN_6PM, NY, night)).toBeNull();
  });

  it('rejects a minute that is not one', () => {
    expect(nextHeadsUp(-1, SUN_6PM, NY, OFF)).toBeNull();
    expect(nextHeadsUp(1440, SUN_6PM, NY, OFF)).toBeNull();
    expect(nextHeadsUp(7.5, SUN_6PM, NY, OFF)).toBeNull();
  });
});

// ——— the forecast ———

const calm: Omit<WeatherSample, 'time'> = {
  code: 3,
  tempC: 8,
  rainMmH: 0,
  precipMmH: 0,
  snowCmH: 0,
  windMph: 5,
  gustMph: 9,
  visibilityM: 16000,
  isDay: true,
};
const point = (t: number, over: Partial<WeatherSample> = {}, recent: Partial<Omit<HourlyPoint, 'sample'>> = {}): HourlyPoint => ({
  sample: { ...calm, time: t / 1000, ...over },
  recentRainMm: 0,
  recentSnowCm: 0,
  ...recent,
});
/** Hourly points from 3 h before 7:40 to 3 h after: 5:00 … 10:00. */
const around = (over: (t: number) => Partial<WeatherSample> = () => ({})): HourlyForecast => ({
  points: [-2, -1, 0, 1, 2, 3].map((k) => Date.UTC(2026, 10, 9, 12 + k, 0)).map((t) => point(t, over(t))),
});
const at = (h: number) => Date.UTC(2026, 10, 9, h + 5, 0);

describe('the weather at a departure', () => {
  it('is nothing when the forecast is calm', () => {
    expect(departureWeather(around(), MON_740)).toEqual({ known: true, kind: null });
  });

  it('names a danger forecast within the hour either side', () => {
    // 7:00 and 8:00 are in, 6:00 and 9:00 are out.
    expect(departureWeather(around((t) => (t === at(8) ? { code: 66 } : {})), MON_740)).toEqual({ known: true, kind: 'freezing_rain' });
    expect(departureWeather(around((t) => (t === at(7) ? { visibilityM: 200 } : {})), MON_740)).toEqual({ known: true, kind: 'dense_fog' });
    expect(departureWeather(around((t) => (t === at(6) ? { code: 66 } : {})), MON_740)).toEqual({ known: true, kind: null });
    expect(departureWeather(around((t) => (t === at(9) ? { code: 66 } : {})), MON_740)).toEqual({ known: true, kind: null });
  });

  it('names the most severe one', () => {
    const f = around((t) => (t === at(7) ? { rainMmH: 9 } : t === at(8) ? { code: 75, snowCmH: 3 } : {}));
    expect(departureWeather(f, MON_740)).toEqual({ known: true, kind: 'heavy_snow' });
  });

  it('never names the mild ones', () => {
    expect([...HEADS_UP_MILD].sort()).toEqual(['rain_at_night', 'strong_wind']);
    expect(departureWeather(around(() => ({ gustMph: 50 })), MON_740)).toEqual({ known: true, kind: null });
    expect(departureWeather(around(() => ({ isDay: false, rainMmH: 3 })), MON_740)).toEqual({ known: true, kind: null });
    // A mild one beside a real one: the real one.
    expect(departureWeather(around((t) => (t === at(7) ? { gustMph: 50 } : { gustMph: 60 })), MON_740)).toEqual({ known: true, kind: 'high_wind' });
  });

  it('reads each hour with the rain and snow before it', () => {
    const f: HourlyForecast = {
      points: [point(at(7), { tempC: -2 }, { recentRainMm: 1 }), point(at(8), { tempC: 0.5 }, { recentSnowCm: 3 })],
    };
    expect(departureWeather(f, MON_740)).toEqual({ known: true, kind: 'black_ice' });
    const g: HourlyForecast = { points: [point(at(7)), point(at(8), { tempC: 0.5 }, { recentSnowCm: 3 })] };
    expect(departureWeather(g, MON_740)).toEqual({ known: true, kind: 'snow_on_road' });
  });

  it('is unknown with no forecast, or one that does not reach both sides of the departure', () => {
    expect(departureWeather(null, MON_740)).toEqual({ known: false });
    expect(departureWeather({ points: [] }, MON_740)).toEqual({ known: false });
    expect(departureWeather({ points: [point(at(7))] }, MON_740)).toEqual({ known: false });
    expect(departureWeather({ points: [point(at(8))] }, MON_740)).toEqual({ known: false });
    // A departure on the hour is covered by that hour alone.
    expect(departureWeather({ points: [point(at(8), { code: 66 })] }, at(8))).toEqual({ known: true, kind: 'freezing_rain' });
  });
});

// ——— the legs ———

const HOME: CommutePlace = { id: 'home', kind: 'home', name: 'Home', lat: 40.7, lng: -74.0 };
const WORK: CommutePlace = { id: 'work', kind: 'work', name: 'Work', lat: 40.75, lng: -73.98 };
const SCHOOL: CommutePlace = { id: 'school', kind: 'school', name: 'School', lat: 40.71, lng: -74.01 };

/** Weekday drives at `minute` New York time: Monday 2 to Friday 6 Nov 2026 (EST), and Monday 26 to Wednesday 28 Oct (EDT). */
function legDrives(from: CommutePlace, to: CommutePlace, minute: number): CommuteDrive[] {
  const lastWeek = [2, 3, 4, 5, 6].map((d) => Date.UTC(2026, 10, d, 5, 0) + minute * MIN);
  const weekBefore = [26, 27, 28].map((d) => Date.UTC(2026, 9, d, 4, 0) + minute * MIN);
  return [...lastWeek, ...weekBefore].map((startedAt) => ({ startedAt, tz: NY, fromPlace: from.id, toPlace: to.id, start: from, end: to }));
}

describe('which legs are planned', () => {
  const places = [HOME, WORK, SCHOOL];
  const morning = legDrives(HOME, WORK, 7 * 60 + 40);
  const evening = legDrives(WORK, HOME, 17 * 60 + 30);
  const base = { places, now: SUN_6PM, tz: NY, quiet: OFF };

  it('a learned leg from where the last drive ended', () => {
    const planned = planDepartures({ ...base, drives: [...morning, ...evening], last: { toPlace: 'home', end: HOME } });
    expect(planned).toEqual([
      { legId: 'home-work', identifier: 'weather-commute:home-work', from: HOME, to: WORK, departAt: MON_740, fireAt: MON_740 - 30 * MIN },
    ]);
  });

  it('none for a leg that does not start where the driver is', () => {
    // Away from home (the last drive ended 5 km away): none.
    expect(planDepartures({ ...base, drives: morning, last: { toPlace: null, end: { lat: 40.745, lng: -74.0 } } })).toEqual([]);
    // No drive at all: none.
    expect(planDepartures({ ...base, drives: morning, last: null })).toEqual([]);
    // Ended at Work: the evening leg (Monday 5:30 PM is 23.5 h away from Sunday 6 PM: not yet).
    expect(planDepartures({ ...base, drives: [...morning, ...evening], last: { toPlace: 'work', end: WORK } })).toEqual([]);
    const mon9am = Date.UTC(2026, 10, 9, 14, 0);
    expect(planDepartures({ ...base, now: mon9am, drives: [...morning, ...evening], last: { toPlace: 'work', end: WORK } }).map((p) => p.legId)).toEqual(['work-home']);
  });

  it('none for a leg with no usual time', () => {
    // Too few drives.
    expect(planDepartures({ ...base, drives: morning.slice(0, 3), last: { toPlace: 'home', end: HOME } })).toEqual([]);
    // All over the clock.
    const scattered = morning.map((d, i) => ({ ...d, startedAt: d.startedAt + (i % 2 === 0 ? 0 : 3 * HOUR) + i * 40 * MIN }));
    expect(planDepartures({ ...base, drives: scattered, last: { toPlace: 'home', end: HOME } })).toEqual([]);
    // Work no longer saved.
    expect(planDepartures({ ...base, places: [HOME], drives: morning, last: { toPlace: 'home', end: HOME } })).toEqual([]);
  });

  it('two legs from the same place, soonest first', () => {
    const school = legDrives(HOME, SCHOOL, 7 * 60 + 30);
    const planned = planDepartures({ ...base, drives: [...morning, ...school], last: { toPlace: 'home', end: HOME } });
    expect(planned.map((p) => p.legId)).toEqual(['home-school', 'home-work']);
  });
});

describe('where the last drive ended', () => {
  const north = (m: number) => ({ lat: HOME.lat + m / 111_320, lng: HOME.lng });

  it('by the saved place it matched, else by its end point', () => {
    expect(endedAt({ toPlace: null, end: north(HEADS_UP_AT_START_M - 50) }, HOME)).toBe(true);
    expect(endedAt({ toPlace: null, end: north(HEADS_UP_AT_START_M + 50) }, HOME)).toBe(false);
    // The place it matched decides, wherever its end point is.
    expect(endedAt({ toPlace: 'home', end: north(HEADS_UP_AT_START_M + 50) }, HOME)).toBe(true);
    expect(endedAt({ toPlace: 'home', end: null }, HOME)).toBe(true);
    expect(endedAt({ toPlace: 'work', end: HOME }, HOME, [HOME, WORK])).toBe(false);
    // A place since removed: the end point again.
    expect(endedAt({ toPlace: 'place-9', end: north(100) }, HOME, [HOME, WORK])).toBe(true);
    expect(endedAt({ toPlace: 'work', end: null }, HOME)).toBe(false);
    expect(endedAt({ toPlace: null, end: null }, HOME)).toBe(false);
    expect(endedAt(null, HOME)).toBe(false);
  });

  it('Home and School 600 m apart: a drive that ended at Home is not at School', () => {
    const school: CommutePlace = { id: 'school', kind: 'school', name: 'School', lat: HOME.lat + 600 / 111_320, lng: HOME.lng };
    const places = [HOME, school];
    expect(endedAt({ toPlace: 'home', end: north(10) }, school, places)).toBe(false);
    expect(endedAt({ toPlace: 'home', end: north(10) }, HOME, places)).toBe(true);
    // No place matched: the nearer of the two.
    expect(endedAt({ toPlace: null, end: north(100) }, school, places)).toBe(false);
    expect(endedAt({ toPlace: null, end: north(100) }, HOME, places)).toBe(true);
    expect(endedAt({ toPlace: null, end: north(500) }, school, places)).toBe(true);
    // A place of the driver's own nearer the end does not count against Home.
    const gym: CommutePlace = { id: 'place-1', kind: 'custom', name: 'Gym', lat: HOME.lat + 150 / 111_320, lng: HOME.lng };
    expect(endedAt({ toPlace: null, end: north(140) }, HOME, [HOME, gym])).toBe(true);
  });
});

describe('spacing', () => {
  it('keeps one heads-up per 2 hours, the earlier departure', () => {
    const a = { id: 'a', departAt: 10 * HOUR, fireAt: 9.5 * HOUR };
    const b = { id: 'b', departAt: 10.2 * HOUR, fireAt: 9.7 * HOUR };
    const c = { id: 'c', departAt: 12 * HOUR, fireAt: 11.5 * HOUR };
    expect(spaced([b, c, a]).map((x) => x.id)).toEqual(['a', 'c']);
    expect(spaced([]).length).toBe(0);
  });

  it('one already shown counts', () => {
    const b = { id: 'b', departAt: 10.2 * HOUR, fireAt: 9.7 * HOUR };
    const c = { id: 'c', departAt: 12 * HOUR, fireAt: 11.5 * HOUR };
    expect(spaced([b, c], [9.5 * HOUR]).map((x) => x.id)).toEqual(['c']);
    expect(spaced([b], [7.6 * HOUR]).map((x) => x.id)).toEqual(['b']);
  });
});

describe('the words', () => {
  it('one identifier per leg', () => {
    expect(headsUpId({ from: HOME, to: WORK })).toBe('weather-commute:home-work');
  });

  it('a 12-hour clock', () => {
    expect(clockOfMinute(7 * 60 + 40)).toBe('7:40 AM');
    expect(clockOfMinute(0)).toBe('12:00 AM');
    expect(clockOfMinute(12 * 60 + 5)).toBe('12:05 PM');
    expect(clockOfMinute(17 * 60 + 30)).toBe('5:30 PM');
  });

  it('the title is the danger, the body says when and where', () => {
    expect(commuteHeadsUpCopy.title('freezing_rain')).toBe(WEATHER_TITLES.freezing_rain);
    expect(commuteHeadsUpCopy.body('freezing_rain', WORK, '7:40 AM')).toBe('Expected around 7:40 AM, when you usually leave for work. Give yourself extra time.');
    expect(commuteHeadsUpCopy.body('dense_fog', HOME, '5:30 PM')).toBe('Expected around 5:30 PM, when you usually head home. Give yourself extra time.');
    expect(commuteHeadsUpCopy.body('heavy_snow', SCHOOL, '7:30 AM')).toBe('Expected around 7:30 AM, when you usually leave for school. Give yourself extra time.');
    expect(commuteHeadsUpCopy.body('blizzard', WORK, '7:40 AM')).toBe('Expected around 7:40 AM, when you usually leave for work. Stay off the road if you can.');
  });
});
