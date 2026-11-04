import type { CommutePlace } from '@/core/places/commute';
import type { ProblemSpot } from '@/data/queries/spots';
import { drive } from '@/features/drives/__fixtures__/drives';
import type { LocalDrive } from '@/features/drives/model';
import type { LatLng } from '@/lib/geo';
import { encodePolyline, encodeRuns } from '@/lib/polyline';

import {
  changeKind,
  changeText,
  clockOfMinute,
  COMMUTE_CARD_DAYS,
  COMMUTE_CHANGE_MIN,
  COMMUTE_CHANGE_MIN_DRIVES,
  COMMUTE_MIN_LEG_DRIVES,
  COMMUTE_SCORE_DRIVES,
  COMMUTE_SCORE_READ_DRIVES,
  COMMUTE_SPOT_HEADING_DEG,
  COMMUTE_SPOT_RADIUS_M,
  COMMUTE_SPOT_SHARE,
  commuteLegs,
  commuteRows,
  commuteText,
  legScore,
  median,
  scoreReadDrives,
  scoreSpan,
  spotsOnTheWay,
  type CommuteRow,
} from '../commuteModel';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Fri Nov 20 2026, 18:00 UTC. */
const NOW = Date.UTC(2026, 10, 20, 18, 0);

const HOME: CommutePlace = { id: 'home', kind: 'home', name: 'Home', lat: 47.6, lng: -122.3 };
const WORK: CommutePlace = { id: 'work', kind: 'work', name: 'Work', lat: 47.65, lng: -122.35 };
const SCHOOL: CommutePlace = { id: 'school', kind: 'school', name: 'School', lat: 47.62, lng: -122.4 };
const GYM: CommutePlace = { id: 'place-1', kind: 'custom', name: 'Gym', lat: 47.7, lng: -122.2 };
const PLACES = [HOME, WORK, SCHOOL, GYM];

let seq = 0;
/** A scored drive from one place to another, `daysAgo` days back at 07:40 UTC (a weekday unless said). */
function trip(from: string | null, to: string | null, startedAt: number, over: Partial<LocalDrive> = {}): LocalDrive {
  seq += 1;
  return drive({ clientTripId: `t${seq}`, startedAt, endedAt: startedAt + 24 * 60_000, fromPlace: from, toPlace: to, tz: 'UTC', ...over });
}
/** 07:40 UTC on the day `n` days before NOW's day. */
const morning = (n: number, min = 7 * 60 + 40): number => Date.UTC(2026, 10, 20 - n, 0, min);

beforeEach(() => {
  seq = 0;
});

describe('commuteLegs', () => {
  test(`a leg shows with ${COMMUTE_MIN_LEG_DRIVES} drives or more, in Home → Work, Work → Home, Home → School, School → Home order`, () => {
    const drives = [
      trip('school', 'home', morning(1)),
      trip('school', 'home', morning(2)),
      trip('school', 'home', morning(3)),
      trip('home', 'work', morning(1)),
      trip('home', 'work', morning(2)),
      trip('home', 'work', morning(3)),
      // Two Work → Home drives: not enough.
      trip('work', 'home', morning(1)),
      trip('work', 'home', morning(2)),
    ];
    const legs = commuteLegs(drives, PLACES, NOW);
    expect(legs.map((l) => l.id)).toEqual(['home-work', 'school-home']);
    expect(legs[0]!.from).toBe(HOME);
    expect(legs[0]!.to).toBe(WORK);
    expect(legs[1]!.drives).toHaveLength(3);
  });

  test('no saved places, or neither end of a leg saved: nothing', () => {
    const drives = [trip('home', 'work', morning(1)), trip('home', 'work', morning(2)), trip('home', 'work', morning(3))];
    expect(commuteLegs(drives, [], NOW)).toEqual([]);
    expect(commuteLegs(drives, [HOME, SCHOOL], NOW)).toEqual([]);
  });

  test('a drive to or from a place of the driver’s own, or with an end that matched no place, is no commute', () => {
    const drives = [
      trip('home', 'place-1', morning(1)),
      trip('home', 'place-1', morning(2)),
      trip('home', 'place-1', morning(3)),
      trip('home', null, morning(1)),
      trip(null, 'work', morning(2)),
      trip('home', 'home', morning(3)),
      trip('work', 'work', morning(4)),
    ];
    expect(commuteLegs(drives, PLACES, NOW)).toEqual([]);
  });

  test(`only scored drives not archived, started in the last ${COMMUTE_CARD_DAYS} days and not after now`, () => {
    const ok = [trip('home', 'work', morning(1)), trip('home', 'work', morning(2))];
    const third = (over: Partial<LocalDrive>, at = morning(3)) => commuteLegs([...ok, trip('home', 'work', at, over)], PLACES, NOW);
    expect(third({})).toHaveLength(1);
    expect(third({ archived: true })).toEqual([]);
    expect(third({ status: 'not_driving' })).toEqual([]);
    expect(third({ status: 'recording' })).toEqual([]);
    expect(third({ status: 'unscored', reason: 'too_short' })).toEqual([]);
    expect(third({ status: 'pending', reason: 'too_short' })).toEqual([]);
    // Pending and long enough to score: counted, as everywhere else on the tab.
    expect(third({ status: 'pending', reason: null })).toHaveLength(1);
    expect(third({}, NOW - COMMUTE_CARD_DAYS * DAY)).toHaveLength(1);
    expect(third({}, NOW - COMMUTE_CARD_DAYS * DAY - 1)).toEqual([]);
    expect(third({}, NOW + 1)).toEqual([]);
    expect(third({}, Number.NaN)).toEqual([]);
  });

  test('a drive to where a place used to be (the place has moved) is not on the leg', () => {
    const near: LatLng = { lat: WORK.lat + 0.0005, lng: WORK.lng };
    const old: LatLng = { lat: WORK.lat + 0.05, lng: WORK.lng };
    const drives = [trip('home', 'work', morning(1), { end: near }), trip('home', 'work', morning(2), { end: near }), trip('home', 'work', morning(3), { end: old })];
    expect(commuteLegs(drives, PLACES, NOW)).toEqual([]);
    expect(commuteLegs([...drives, trip('home', 'work', morning(4))], PLACES, NOW)[0]!.drives).toHaveLength(3);
  });

  test('the leg’s drives newest first, its median drive time, and its usual departure', () => {
    const drives = [
      trip('home', 'work', morning(10), { durationS: 30 * 60 }),
      trip('home', 'work', morning(0), { durationS: 20 * 60 }),
      trip('home', 'work', morning(3), { durationS: 26 * 60 }),
      trip('home', 'work', morning(7), { durationS: 22 * 60 }),
    ];
    const [leg] = commuteLegs(drives, PLACES, NOW);
    expect(leg!.drives.map((d) => d.startedAt)).toEqual([morning(0), morning(3), morning(7), morning(10)]);
    expect(leg!.usualS).toBe(24 * 60);
    // Fri 20, Tue 17, Fri 13, Tue 10: four weekdays over two weeks, all at 07:40.
    expect(leg!.departure).toEqual({ minuteOfDay: 7 * 60 + 40, drives: 4 });
  });

  test('no usual departure when the drives don’t keep to a time', () => {
    const drives = [
      trip('home', 'work', morning(0, 6 * 60)),
      trip('home', 'work', morning(3, 9 * 60)),
      trip('home', 'work', morning(7, 12 * 60)),
      trip('home', 'work', morning(10, 15 * 60)),
    ];
    expect(commuteLegs(drives, PLACES, NOW)[0]!.departure).toBeNull();
  });

  test('no usual departure from weekend drives alone', () => {
    // Sun 15, Sat 14, Sun 8, Sat 7.
    const drives = [5, 6, 12, 13].map((n) => trip('home', 'work', morning(n)));
    const [leg] = commuteLegs(drives, PLACES, NOW);
    expect(leg!.drives).toHaveLength(4);
    expect(leg!.departure).toBeNull();
  });
});

describe('legScore', () => {
  const list = (n: number) => Array.from({ length: n }, (_, i) => trip('home', 'work', morning(i)));
  const scored = (drives: LocalDrive[], values: number[]) => new Map(drives.map((d, i) => [d.clientTripId, values[i]!] as const).filter(([, v]) => v !== undefined));

  test(`the rounded mean of the newest ${COMMUTE_SCORE_DRIVES} scores`, () => {
    const drives = list(7);
    // Newest first: 90, 80, 85, 81, 70 → 81.2.
    expect(legScore(drives, scored(drives, [90, 80, 85, 81, 70, 10, 10]))).toEqual({ score: 81, change: null, scored: 7 });
    // 3 drives: 80, 81, 82 → 81.
    expect(legScore(drives.slice(0, 3), scored(drives, [80, 81, 82]))).toEqual({ score: 81, change: null, scored: 3 });
    // 80.5 rounds up.
    expect(legScore(drives.slice(0, 2), scored(drives, [80, 81]))).toEqual({ score: 81, change: null, scored: 2 });
  });

  test('a drive with no score yet (its events still loading) is skipped; none scored: no score', () => {
    const drives = list(6);
    const scores = new Map([
      [drives[1]!.clientTripId, 70],
      [drives[3]!.clientTripId, 90],
    ]);
    expect(legScore(drives, scores)).toEqual({ score: 80, change: null, scored: 2 });
    expect(legScore(drives, new Map())).toEqual({ score: null, change: null, scored: 0 });
  });

  test(`the change against the ${COMMUTE_SCORE_DRIVES} before shows from ${COMMUTE_CHANGE_MIN_DRIVES} scored drives on`, () => {
    const drives = list(12);
    const values = [90, 90, 90, 90, 90, 80, 80, 80, 80, 80, 0, 0];
    expect(legScore(drives.slice(0, COMMUTE_CHANGE_MIN_DRIVES - 1), scored(drives, values))).toEqual({ score: 90, change: null, scored: 7 });
    // 8 drives: the 3 before are 80s.
    expect(legScore(drives.slice(0, COMMUTE_CHANGE_MIN_DRIVES), scored(drives, values))).toEqual({ score: 90, change: 10, scored: 8 });
    // 12 drives: only the 5 right before count (the two 0s are older).
    expect(legScore(drives, scored(drives, values))).toEqual({ score: 90, change: 10, scored: 12 });
    // Falling.
    expect(legScore(drives.slice(0, 10), scored(drives, [70, 70, 70, 70, 70, 80, 80, 80, 80, 80]))).toEqual({ score: 70, change: -10, scored: 10 });
  });

  test('the change is rounded from the unrounded means, the same both ways, and a still leg is 0', () => {
    const drives = list(10);
    // 82.5 vs 80: +2.5 → 3; the reverse → -3 (not -2).
    expect(legScore(drives, scored(drives, [85, 80, 85, 80, 82.5, 80, 80, 80, 80, 80])).change).toBe(3);
    expect(legScore(drives, scored(drives, [80, 80, 80, 80, 80, 85, 80, 85, 80, 82.5])).change).toBe(-3);
    const still = legScore(drives, scored(drives, Array.from({ length: 10 }, () => 80))).change;
    expect(still).toBe(0);
    expect(Object.is(still, -0)).toBe(false);
  });
});

describe('scoreReadDrives', () => {
  test(`each leg's newest ${COMMUTE_SCORE_READ_DRIVES} drives: enough for the score and its change, with spares`, () => {
    expect(COMMUTE_SCORE_READ_DRIVES).toBeGreaterThan(2 * COMMUTE_SCORE_DRIVES);
    const leg = (n: number, from: string) => ({ drives: Array.from({ length: n }, (_, i) => trip(from, 'work', morning(i))) });
    const long = leg(40, 'home');
    const short = leg(4, 'school');
    const read = scoreReadDrives([long, short]);
    expect(read).toEqual([...long.drives.slice(0, COMMUTE_SCORE_READ_DRIVES), ...short.drives]);
    expect(scoreReadDrives([])).toEqual([]);
  });
});

describe('the change words', () => {
  test(`"Up" and "Down" from ${COMMUTE_CHANGE_MIN} points, else "Steady"; nothing with no change`, () => {
    expect(changeKind(null)).toBeNull();
    expect(changeText(null)).toBeNull();
    expect(changeKind(0)).toBe('steady');
    expect(changeText(1)).toBe('Steady');
    expect(changeText(-1)).toBe('Steady');
    expect(changeText(COMMUTE_CHANGE_MIN)).toBe('Up 2');
    expect(changeText(-COMMUTE_CHANGE_MIN)).toBe('Down 2');
    expect(changeText(12)).toBe('Up 12');
    expect(changeKind(-7)).toBe('down');
  });

  test('what the score is the mean of, and what it is compared with', () => {
    expect(scoreSpan(0)).toEqual({ recent: 0, before: 0 });
    expect(scoreSpan(3)).toEqual({ recent: 3, before: 0 });
    expect(scoreSpan(8)).toEqual({ recent: 5, before: 3 });
    expect(scoreSpan(30)).toEqual({ recent: 5, before: 5 });
  });
});

test('clockOfMinute: a 12-hour clock', () => {
  expect(clockOfMinute(460)).toBe('7:40 AM');
  expect(clockOfMinute(0)).toBe('12:00 AM');
  expect(clockOfMinute(5)).toBe('12:05 AM');
  expect(clockOfMinute(12 * 60)).toBe('12:00 PM');
  expect(clockOfMinute(12 * 60 + 30)).toBe('12:30 PM');
  expect(clockOfMinute(17 * 60 + 5)).toBe('5:05 PM');
  expect(clockOfMinute(23 * 60 + 59)).toBe('11:59 PM');
  expect(clockOfMinute(24 * 60)).toBe('12:00 AM');
});

test('median', () => {
  expect(median([])).toBe(0);
  expect(median([5])).toBe(5);
  expect(median([3, 1, 2])).toBe(2);
  expect(median([4, 1, 3, 2])).toBe(2.5);
  expect(median([1, Number.NaN, 3])).toBe(2);
});

describe('commuteText', () => {
  const row = (over: Partial<CommuteRow> = {}): CommuteRow => ({
    id: 'home-work',
    from: HOME,
    to: WORK,
    drives: [],
    usualS: 24 * 60,
    departure: { minuteOfDay: 460, drives: 6 },
    score: 84,
    change: 3,
    scored: 9,
    ...over,
  });

  test('the title, the line, the score and the spoken row', () => {
    expect(commuteText(row())).toEqual({
      title: 'Home → Work',
      line: 'Usually 24 min · Leave around 7:40 AM',
      score: 'Score 84 · Up 3',
      spoken: 'Home to Work, Usually 24 minutes, Leave around 7:40 AM, Score 84, Up 3',
    });
  });

  test('no departure, no change, no score yet', () => {
    expect(commuteText(row({ departure: null, change: null }))).toMatchObject({ line: 'Usually 24 min', score: 'Score 84' });
    expect(commuteText(row({ change: 1 })).score).toBe('Score 84 · Steady');
    expect(commuteText(row({ change: -4 })).score).toBe('Score 84 · Down 4');
    const none = commuteText(row({ score: null, change: null, departure: null, usualS: 65 * 60 }));
    expect(none.score).toBeNull();
    expect(none.line).toBe('Usually 1 h 05 min');
    expect(none.spoken).toBe('Home to Work, Usually 1 hour 5 minutes');
  });

  test('the place names as saved', () => {
    expect(commuteText(row({ from: { ...SCHOOL, name: 'Lincoln High' }, to: HOME })).title).toBe('Lincoln High → Home');
  });
});

describe('spotsOnTheWay', () => {
  /** A straight road north from (47.60, -122.30) to (47.62, -122.30), a point every ~55 m. */
  const NORTH: LatLng[] = Array.from({ length: 41 }, (_, i) => ({ lat: 47.6 + i * 0.0005, lng: -122.3 }));
  const SOUTH = [...NORTH].reverse();
  const MID = { lat: 47.61, lng: -122.3 };
  /** Metres east as degrees of longitude at the road's latitude. */
  const east = (m: number) => m / ((Math.PI / 180) * 6371008.8 * Math.cos((MID.lat * Math.PI) / 180));
  const spot = (id: string, over: Partial<ProblemSpot> = {}): ProblemSpot =>
    ({ id, kind: 'hard_brake', state: 'active', pin: MID, headingDeg: 0, segment: [], label: null, ...over }) as ProblemSpot;
  const on = (points: LatLng[] | null) => ({ polyline: points === null ? null : encodePolyline(points) });

  test(`a spot the route passes within ${COMMUTE_SPOT_RADIUS_M} m, heading its way within ${COMMUTE_SPOT_HEADING_DEG}°`, () => {
    const drives = [on(NORTH)];
    expect(spotsOnTheWay([spot('a')], drives).map((s) => s.id)).toEqual(['a']);
    expect(spotsOnTheWay([spot('b', { pin: { ...MID, lng: MID.lng + east(30) } })], drives)).toHaveLength(1);
    expect(spotsOnTheWay([spot('c', { pin: { ...MID, lng: MID.lng + east(40) } })], drives)).toEqual([]);
    expect(spotsOnTheWay([spot('d', { headingDeg: 40 })], drives)).toHaveLength(1);
    expect(spotsOnTheWay([spot('e', { headingDeg: 320 })], drives)).toHaveLength(1);
    expect(spotsOnTheWay([spot('f', { headingDeg: 50 })], drives)).toEqual([]);
    // The other way along the same road: not on this way.
    expect(spotsOnTheWay([spot('g', { headingDeg: 180 })], drives)).toEqual([]);
    expect(spotsOnTheWay([spot('h', { headingDeg: 180 })], [on(SOUTH)])).toHaveLength(1);
    // Past the end of the road.
    expect(spotsOnTheWay([spot('i', { pin: { lat: 47.63, lng: -122.3 } })], drives)).toEqual([]);
  });

  test(`at least ${COMMUTE_SPOT_SHARE * 100}% of the leg’s drives with a route pass it; drives with no route don’t count`, () => {
    const s = [spot('a')];
    expect(spotsOnTheWay(s, [on(NORTH), on(SOUTH)])).toHaveLength(1);
    expect(spotsOnTheWay(s, [on(NORTH), on(SOUTH), on(SOUTH)])).toEqual([]);
    expect(spotsOnTheWay(s, [on(NORTH), on(NORTH), on(SOUTH), on(SOUTH)])).toHaveLength(1);
    expect(spotsOnTheWay(s, [on(NORTH), on(SOUTH), on(null), on(null), on(null)])).toHaveLength(1);
    expect(spotsOnTheWay(s, [{ polyline: '' }, on(NORTH)])).toHaveLength(1);
    expect(spotsOnTheWay(s, [on(null), { polyline: '' }])).toEqual([]);
    expect(spotsOnTheWay(s, [])).toEqual([]);
  });

  test('a route in runs (a privacy gap): any run may pass; a one-point run is no route', () => {
    const route = { polyline: encodeRuns([NORTH.slice(0, 5), NORTH.slice(15)]) };
    expect(spotsOnTheWay([spot('a')], [route])).toHaveLength(1);
    // The spot sits in the gap: no run passes it.
    const gap = { polyline: encodeRuns([NORTH.slice(0, 10), NORTH.slice(30)]) };
    expect(spotsOnTheWay([spot('a')], [gap])).toEqual([]);
    expect(spotsOnTheWay([spot('a')], [{ polyline: encodePolyline([MID]) }])).toEqual([]);
  });

  test('only active spots, in the order given; a spot with no place is skipped', () => {
    const spots = [spot('x', { state: 'cleared' }), spot('b'), spot('a'), spot('n', { pin: { lat: Number.NaN, lng: -122.3 } }), spot('h', { headingDeg: Number.NaN })];
    expect(spotsOnTheWay(spots, [on(NORTH)]).map((s) => s.id)).toEqual(['b', 'a']);
  });

  test('a sharp-turn spot is on the way only for a route that makes its turn', () => {
    const at = (mEast: number) => ({ lat: MID.lat, lng: MID.lng + east(mEast) });
    // Its coloured road comes up from the south and turns east (right) at the pin, 40 m each side.
    const corner = (over: Partial<ProblemSpot> = {}) => spot('k', { kind: 'hard_corner', segment: [{ lat: MID.lat - 0.00036, lng: MID.lng }, MID, at(40)], ...over });
    const right = on([...NORTH.slice(0, 21), ...Array.from({ length: 10 }, (_, i) => at(55 * (i + 1)))]);
    const left = on([...NORTH.slice(0, 21), ...Array.from({ length: 10 }, (_, i) => at(-55 * (i + 1)))]);
    expect(spotsOnTheWay([corner()], [right])).toHaveLength(1);
    // Straight on through the junction, or the other turn there: not this spot's way.
    expect(spotsOnTheWay([corner()], [on(NORTH)])).toEqual([]);
    expect(spotsOnTheWay([corner()], [left])).toEqual([]);
    expect(spotsOnTheWay([corner()], [right, on(NORTH), on(NORTH)])).toEqual([]);
    // A route that ends at the corner has no way out to compare: it does not pass.
    expect(spotsOnTheWay([corner()], [on(NORTH.slice(0, 21))])).toEqual([]);
    // With no way out to read (too little road after the pin), the heading alone decides, as for the other kinds.
    expect(spotsOnTheWay([corner({ segment: [] })], [on(NORTH)])).toHaveLength(1);
    expect(spotsOnTheWay([corner({ segment: [MID, at(5)] })], [on(NORTH)])).toHaveLength(1);
    // Only a sharp turn reads a way out.
    expect(spotsOnTheWay([corner({ kind: 'hard_brake' })], [on(NORTH)])).toHaveLength(1);
  });

  test('a garbled route passes nothing', () => {
    expect(spotsOnTheWay([spot('a')], [{ polyline: '\u0000\u0001' }, on(NORTH)])).toHaveLength(1);
  });
});

test('commuteRows: each leg with its score, the drives kept as they were', () => {
  const drives = [trip('home', 'work', morning(1)), trip('home', 'work', morning(2)), trip('home', 'work', morning(3))];
  const legs = commuteLegs(drives, PLACES, NOW);
  const scores = new Map(drives.map((d) => [d.clientTripId, 90] as const));
  const [row] = commuteRows(legs, scores);
  expect(row).toMatchObject({ id: 'home-work', score: 90, change: null, scored: 3 });
  expect(row!.drives).toBe(legs[0]!.drives);
});
