import {
  COMMUTE_CONSISTENT_SHARE,
  COMMUTE_LEGS,
  COMMUTE_MIN_DAYS,
  COMMUTE_MIN_DRIVES,
  COMMUTE_MIN_WEEKS,
  COMMUTE_MOVED_M,
  COMMUTE_SPREAD_MIN,
  COMMUTE_WINDOW_DAYS,
  commuteDrives,
  medianMinute,
  minutesApart,
  usualDeparture,
  type CommuteDrive,
  type CommutePlace,
} from '@/core/places/commute';

const LA = 'America/Los_Angeles';
const NY = 'America/New_York';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The instant of a wall-clock time in a zone with a whole-hour offset from UTC (`offset`: -8 for PST). */
const wall = (y: number, mo: number, d: number, h: number, min: number, offset: number): number => Date.UTC(y, mo - 1, d, h, min) - offset * HOUR;
/** Los Angeles in November 2026 (PST, UTC−8): Mon Nov 2 … Fri Nov 6, Mon Nov 9 … */
const la = (d: number, h: number, min: number): CommuteDrive => ({ startedAt: wall(2026, 11, d, h, min, -8), tz: LA });
const NOW = wall(2026, 11, 20, 18, 0, -8);

describe('usualDeparture', () => {
  test('the median local start of weekday drives over two weeks', () => {
    const drives = [la(2, 7, 35), la(3, 7, 40), la(4, 7, 50), la(9, 7, 45), la(10, 7, 38)];
    expect(usualDeparture(drives, NOW)).toEqual({ minuteOfDay: 7 * 60 + 40, drives: 5 });
  });

  test(`at least ${COMMUTE_MIN_DRIVES} drives, on ${COMMUTE_MIN_DAYS} different days, over ${COMMUTE_MIN_WEEKS} weeks`, () => {
    expect(usualDeparture([la(2, 7, 40), la(3, 7, 40), la(9, 7, 40)], NOW)).toBeNull();
    // Four drives in one week.
    expect(usualDeparture([la(2, 7, 40), la(3, 7, 40), la(4, 7, 40), la(5, 7, 40)], NOW)).toBeNull();
    // Four drives over two weeks but on three days (two on Monday the 2nd).
    expect(usualDeparture([la(2, 7, 40), la(2, 7, 50), la(3, 7, 40), la(9, 7, 40)], NOW)).toBeNull();
    expect(usualDeparture([la(2, 7, 40), la(3, 7, 40), la(4, 7, 40), la(9, 7, 40)], NOW)).toEqual({ minuteOfDay: 460, drives: 4 });
  });

  test('weekend drives are ignored', () => {
    // Sat Nov 7 and Sun Nov 8 do not count: three weekday drives are not enough.
    expect(usualDeparture([la(2, 7, 40), la(3, 7, 40), la(7, 7, 40), la(8, 7, 40), la(9, 7, 40)], NOW)).toBeNull();
    // A weekend drive at another hour does not move the time.
    expect(usualDeparture([la(2, 7, 40), la(3, 7, 40), la(4, 7, 40), la(9, 7, 40), la(7, 11, 0), la(8, 11, 0)], NOW)).toEqual({ minuteOfDay: 460, drives: 4 });
  });

  test('the weekday is the drive’s own: 11 pm Sunday in Los Angeles is Monday in UTC, and still Sunday', () => {
    const sundayNight = la(8, 23, 0);
    expect(new Date(sundayNight.startedAt).getUTCDay()).toBe(1);
    expect(usualDeparture([la(1, 23, 0), sundayNight, la(15, 23, 0), la(2, 23, 0)], NOW)).toBeNull();
  });

  test(`only the last ${COMMUTE_WINDOW_DAYS} days, up to now`, () => {
    const now = wall(2026, 12, 18, 18, 0, -8);
    const old = [la(2, 6, 0), la(3, 6, 0), la(4, 6, 0)];
    const recent = [la(9, 7, 40), la(10, 7, 40), la(16, 7, 40), la(17, 7, 40)];
    // Nov 2–4 are more than 42 days before Dec 18.
    expect(now - old[2]!.startedAt).toBeGreaterThan(COMMUTE_WINDOW_DAYS * DAY);
    expect(usualDeparture([...old, ...recent], now)).toEqual({ minuteOfDay: 460, drives: 4 });
    expect(usualDeparture([...old, recent[0]!], now)).toBeNull();
    // A drive after now (a clock that moved) is not read.
    expect(usualDeparture([la(2, 7, 40), la(3, 7, 40), la(4, 7, 40), la(9, 7, 40)], wall(2026, 11, 9, 7, 0, -8))).toBeNull();
  });

  test(`inconsistent times: under ${COMMUTE_CONSISTENT_SHARE * 100} % within ${COMMUTE_SPREAD_MIN} min of the median is no usual time`, () => {
    expect(usualDeparture([la(2, 7, 0), la(3, 9, 0), la(4, 11, 0), la(9, 13, 0), la(10, 15, 0)], NOW)).toBeNull();
    // 3 of 5 within 45 min (60 %): a usual time.
    expect(usualDeparture([la(2, 7, 30), la(3, 7, 40), la(4, 7, 50), la(9, 10, 0), la(10, 11, 0)], NOW)).toEqual({ minuteOfDay: 470, drives: 5 });
    // 2 of 4 (50 %): none.
    expect(usualDeparture([la(2, 7, 30), la(3, 7, 40), la(9, 10, 0), la(10, 11, 0)], NOW)).toBeNull();
    // 45 min off still counts; 46 does not.
    expect(usualDeparture([la(2, 8, 0), la(3, 8, 0), la(4, 8, 45), la(9, 7, 15), la(10, 8, 0)], NOW)).toEqual({ minuteOfDay: 480, drives: 5 });
    expect(usualDeparture([la(2, 8, 0), la(3, 8, 0), la(4, 8, 46), la(9, 7, 14), la(10, 8, 46)], NOW)).toBeNull();
  });

  test('a daylight-saving change keeps the local time (Los Angeles springs forward on Sunday, March 8)', () => {
    const before = (d: number) => ({ startedAt: wall(2026, 3, d, 7, 40, -8), tz: LA });
    const after = (d: number) => ({ startedAt: wall(2026, 3, d, 7, 40, -7), tz: LA });
    const now = wall(2026, 3, 20, 18, 0, -7);
    expect(usualDeparture([before(4), before(5), before(6), after(9), after(10)], now)).toEqual({ minuteOfDay: 460, drives: 5 });
    // The same UTC instant after the change is an hour later on the clock.
    const sameUtc = (d: number) => ({ startedAt: wall(2026, 3, d, 7, 40, -8), tz: LA });
    expect(usualDeparture([sameUtc(9), sameUtc(10), sameUtc(11), sameUtc(16)], now)).toEqual({ minuteOfDay: 520, drives: 4 });
  });

  test('each drive in its own time zone', () => {
    const ny = (d: number, h: number, min: number): CommuteDrive => ({ startedAt: wall(2026, 11, d, h, min, -5), tz: NY });
    expect(usualDeparture([ny(2, 7, 40), ny(3, 7, 40), la(4, 7, 40), la(9, 7, 40)], NOW)).toEqual({ minuteOfDay: 460, drives: 4 });
  });

  test('around midnight: 23:50 to 00:10 is a usual time near midnight, not noon', () => {
    const drives = [la(2, 23, 50), la(3, 23, 55), la(5, 0, 5), la(10, 0, 10), la(11, 23, 58)];
    expect(usualDeparture(drives, NOW)).toEqual({ minuteOfDay: 23 * 60 + 58, drives: 5 });
    expect(usualDeparture([la(2, 23, 50), la(3, 23, 55), la(5, 0, 5), la(10, 0, 10)], NOW)).toEqual({ minuteOfDay: 0, drives: 4 });
  });

  test('broken starts are skipped; an unknown zone reads the phone’s own', () => {
    expect(usualDeparture([{ startedAt: NaN, tz: LA }, la(2, 7, 40), la(3, 7, 40), la(9, 7, 40)], NOW)).toBeNull();
    const phone = usualDeparture([la(2, 7, 40), la(3, 7, 40), la(4, 7, 40), la(9, 7, 40)].map((d) => ({ startedAt: d.startedAt, tz: 'Not/AZone' })), NOW);
    expect(phone?.drives).toBe(4);
  });
});

describe('medianMinute and minutesApart', () => {
  test('an even count is the mean of the middle two, rounded', () => {
    expect(medianMinute([450, 460, 470, 481])).toBe(465);
    expect(medianMinute([450, 461])).toBe(456);
    expect(medianMinute([])).toBe(0);
  });

  test('read around the clock, cut at the widest gap', () => {
    expect(medianMinute([1430, 1435, 5, 10])).toBe(0);
    expect(medianMinute([1430, 5, 10])).toBe(5);
    expect(medianMinute([600, 900, 1200])).toBe(900);
  });

  test('minutes apart, around midnight too', () => {
    expect(minutesApart(1430, 10)).toBe(20);
    expect(minutesApart(460, 505)).toBe(45);
    expect(minutesApart(0, 720)).toBe(720);
  });
});

describe('commuteDrives', () => {
  const place = (id: string, kind: CommutePlace['kind'], lat: number): CommutePlace => ({ id, kind, name: id, lat, lng: -122.3 });
  const home = place('home', 'home', 47.6);
  const work = place('work', 'work', 47.7);
  const school = place('school', 'school', 47.8);
  const gym = place('place-1', 'custom', 47.9);
  const d = (n: number, fromPlace: string | null, toPlace: string | null, over: Partial<CommuteDrive> = {}) => ({ n, startedAt: n, fromPlace, toPlace, ...over });

  test('the four legs in order, each with its drives; legs without a drive are left out', () => {
    const drives = [d(1, 'work', 'home'), d(2, 'home', 'work'), d(3, 'home', 'school'), d(4, 'home', 'work'), d(5, 'school', 'home')];
    const legs = commuteDrives(drives, [school, work, home]);
    expect(COMMUTE_LEGS.map((l) => l.id)).toEqual(['home-work', 'work-home', 'home-school', 'school-home']);
    expect(legs.map((l) => [l.id, l.from.id, l.to.id, l.drives.map((x) => x.n)])).toEqual([
      ['home-work', 'home', 'work', [2, 4]],
      ['work-home', 'work', 'home', [1]],
      ['home-school', 'home', 'school', [3]],
      ['school-home', 'school', 'home', [5]],
    ]);
    // The drives themselves, as given.
    expect(legs[0]?.drives[0]).toBe(drives[1]);
  });

  test('not a commute: a place not saved, a driver’s own place, the same place, an end with no place', () => {
    expect(commuteDrives([d(1, 'home', 'work')], [home])).toEqual([]);
    expect(commuteDrives([d(1, 'home', 'place-1'), d(2, 'place-1', 'work'), d(3, 'home', 'home'), d(4, 'home', null), d(5, null, 'work'), d(6, 'work', 'school')], [home, work, school, gym])).toEqual([]);
    expect(commuteDrives([], [home, work])).toEqual([]);
  });

  test(`a drive to where a place used to be (its end more than ${COMMUTE_MOVED_M} m from it now) is not on the leg`, () => {
    const at = (lat: number) => ({ lat, lng: -122.3 });
    const near = d(1, 'home', 'work', { start: at(47.6 + 100 / 111_195), end: at(47.7 - 150 / 111_195) });
    const moved = d(2, 'home', 'work', { start: at(47.6 - 2_000 / 111_195), end: at(47.7) });
    const movedWork = d(3, 'home', 'work', { start: at(47.6), end: at(47.7 + 250 / 111_195) });
    const unknown = d(4, 'home', 'work', { start: null });
    expect(commuteDrives([near, moved, movedWork, unknown], [home, work])[0]?.drives.map((x) => x.n)).toEqual([1, 4]);
  });
});
