import type { CommutePlace } from '@/core/places/commute';

import { DAY, drive, NOW } from '../__fixtures__/drives';
import { commuteCompare, commuteEvents, COMPARE_MIN_DRIVES } from '../commuteCompare';
import type { DriveCounts, LocalDrive } from '../model';

const HOME: CommutePlace = { id: 'home', kind: 'home', name: 'Home', lat: 40.7, lng: -74 };
const SCHOOL: CommutePlace = { id: 'school', kind: 'school', name: 'School', lat: 40.758, lng: -74.001 };
const GYM: CommutePlace = { id: 'place-1', kind: 'custom', name: 'Gym', lat: 40.71, lng: -74.01 };
const PLACES = [HOME, SCHOOL, GYM];

const ZERO: DriveCounts = { speeding: 0, hardBrake: 0, hardAccel: 0, hardCorner: 0, pickups: 0, eyesOff: 0, drowsy: 0 };
/** `n` hard brakes. */
const counts = (n: number, over: Partial<DriveCounts> = {}): DriveCounts => ({ ...ZERO, hardBrake: n, ...over });

/** This drive: Home → School, started at the fixture's time, `n` events. */
const mine = (n: number, over: Partial<LocalDrive> = {}): LocalDrive => drive({ clientTripId: 'this', counts: counts(n), ...over });

/** An earlier drive on the same leg, `days` before this one, `n` events. */
let id = 0;
const before = (days: number, n: number, over: Partial<LocalDrive> = {}): LocalDrive =>
  drive({ clientTripId: `b${(id += 1)}`, startedAt: mine(0).startedAt - days * DAY, counts: counts(n), ...over });

const usual = (...events: number[]): LocalDrive[] => events.map((n, i) => before(i + 1, n));

test('the minimum baseline is the commute card\'s own: 3 drives on the leg', () => {
  expect(COMPARE_MIN_DRIVES).toBe(3);
});

test('fewer events than the usual drive on the leg says so, with the leg in arrows and in words', () => {
  expect(commuteCompare(mine(1), usual(2, 3, 4), PLACES)).toEqual({
    kind: 'fewer',
    text: 'Fewer events than your usual Home → School',
    spoken: 'Fewer events than your usual Home to School',
  });
});

test('a clean drive on a leg that is usually clean: "Clean, like your usual…"', () => {
  expect(commuteCompare(mine(0), usual(0, 0, 1), PLACES)).toMatchObject({ kind: 'clean', text: 'Clean, like your usual Home → School' });
});

test('the same as the usual with some events: "Same as your usual…"', () => {
  expect(commuteCompare(mine(2), usual(1, 2, 3), PLACES)).toMatchObject({ kind: 'same', text: 'Same as your usual Home → School', spoken: 'Same as your usual Home to School' });
});

test('a worse drive gets no line', () => {
  expect(commuteCompare(mine(3), usual(1, 2, 3), PLACES)).toBeNull();
  expect(commuteCompare(mine(1), usual(0, 0, 0), PLACES)).toBeNull();
});

test('the usual of an even count is the mean of the middle two', () => {
  // 1, 2, 3, 4: 2.5. Two is fewer; three is more.
  expect(commuteCompare(mine(2), usual(1, 2, 3, 4), PLACES)?.kind).toBe('fewer');
  expect(commuteCompare(mine(3), usual(1, 2, 3, 4), PLACES)).toBeNull();
});

test('fewer than 3 earlier drives on the leg: no line', () => {
  expect(commuteCompare(mine(0), usual(4, 4), PLACES)).toBeNull();
  expect(commuteCompare(mine(0), [], PLACES)).toBeNull();
});

test('events count speeding, hard brakes, starts and turns and pickups; DashPal never', () => {
  expect(commuteEvents({ counts: { speeding: 1, hardBrake: 1, hardAccel: 1, hardCorner: 1, pickups: 1, eyesOff: 5, drowsy: 5 } })).toBe(5);
  // DashPal's events alone: a clean drive.
  expect(commuteCompare(mine(0, { counts: counts(0, { eyesOff: 3, drowsy: 1 }) }), usual(0, 0, 0), PLACES)?.kind).toBe('clean');
});

test('plain counts, not per distance: drive lengths (and so the units) play no part', () => {
  const base = [before(1, 2, { miles: 2 }), before(2, 2, { miles: 40 }), before(3, 2, { miles: 9 })];
  expect(commuteCompare(mine(1, { miles: 80 }), base, PLACES)?.kind).toBe('fewer');
  expect(commuteCompare(mine(1, { miles: 0.8 }), base, PLACES)?.kind).toBe('fewer');
});

describe('the baseline', () => {
  test('only drives in the 120 days before this one count; later ones and this one itself never', () => {
    const base = usual(1, 1, 1);
    // Older than 120 days, later than this drive, and this drive again: none is part of the usual.
    const noise = [before(121, 9), before(-1, 9), before(-30, 9), mine(9)];
    expect(commuteCompare(mine(1), [...base, ...noise], PLACES)?.kind).toBe('same');
    expect(commuteCompare(mine(0), [...usual(1, 1), before(121, 1), before(-1, 1)], PLACES)).toBeNull();
    // 120 days to the millisecond still counts.
    expect(commuteCompare(mine(0), [...usual(1, 1), before(120, 1)], PLACES)?.kind).toBe('fewer');
  });

  test('only scored drives that are kept: not marked not driving, not unscored, not archived', () => {
    const skipped = [before(1, 0, { status: 'not_driving' }), before(2, 0, { status: 'unscored', reason: 'too_short' }), before(3, 0, { archived: true })];
    expect(commuteCompare(mine(1), [...usual(1, 1), ...skipped], PLACES)).toBeNull();
    // A pending drive long enough to score counts.
    expect(commuteCompare(mine(1), [...usual(1, 1), before(4, 1, { status: 'pending', reason: null })], PLACES)?.kind).toBe('same');
  });

  test('only drives on the same leg: the way back and other places are another leg', () => {
    const other = [
      before(1, 9, { fromPlace: 'school', toPlace: 'home' }),
      before(2, 9, { fromPlace: 'home', toPlace: 'place-1' }),
      before(3, 9, { fromPlace: 'home', toPlace: null }),
    ];
    expect(commuteCompare(mine(0), [...usual(1, 1), ...other], PLACES)).toBeNull();
  });

  test('a drive that ended more than 200 m from School went where it used to be: not on the leg', () => {
    const moved = before(3, 0, { end: { lat: SCHOOL.lat + 0.005, lng: SCHOOL.lng } });
    expect(commuteCompare(mine(1), [...usual(1, 1), moved], PLACES)).toBeNull();
    const near = before(3, 1, { end: { lat: SCHOOL.lat + 0.001, lng: SCHOOL.lng } });
    expect(commuteCompare(mine(1), [...usual(1, 1), near], PLACES)?.kind).toBe('same');
  });
});

describe('this drive', () => {
  test('must be on a commute leg by its stored places, not its labels', () => {
    const base = usual(3, 3, 3);
    expect(commuteCompare(mine(0, { toPlace: null }), base, PLACES)).toBeNull();
    expect(commuteCompare(mine(0, { fromPlace: null, fromLabel: 'Home' }), base, PLACES)).toBeNull();
    expect(commuteCompare(mine(0, { toPlace: 'place-1' }), base, PLACES)).toBeNull();
  });

  test('must be scored', () => {
    const base = usual(3, 3, 3);
    expect(commuteCompare(mine(0, { status: 'not_driving' }), base, PLACES)).toBeNull();
    expect(commuteCompare(mine(0, { status: 'unscored', reason: 'too_short' }), base, PLACES)).toBeNull();
    expect(commuteCompare(mine(0, { status: 'recording' }), base, PLACES)).toBeNull();
  });

  test('must still be at the place: one that ended more than 200 m from it is not on the leg', () => {
    expect(commuteCompare(mine(0, { end: { lat: SCHOOL.lat + 0.005, lng: SCHOOL.lng } }), usual(3, 3, 3), PLACES)).toBeNull();
  });

  test('needs both places saved', () => {
    expect(commuteCompare(mine(0), usual(3, 3, 3), [HOME])).toBeNull();
    expect(commuteCompare(mine(0), usual(3, 3, 3), [])).toBeNull();
  });

  test('a renamed place says its own name', () => {
    expect(commuteCompare(mine(0), usual(3, 3, 3), [HOME, { ...SCHOOL, name: 'Lincoln High' }])?.text).toBe('Fewer events than your usual Home → Lincoln High');
  });
});

test('the time of the comparison is the drive\'s own start, whatever the clock says now', () => {
  const d = mine(0, { startedAt: NOW - 200 * DAY });
  const base = [1, 2, 3].map((n) => before(n, 3, { startedAt: d.startedAt - n * DAY }));
  expect(commuteCompare(d, base, PLACES)?.kind).toBe('fewer');
});
