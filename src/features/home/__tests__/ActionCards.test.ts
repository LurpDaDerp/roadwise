import { drive, result } from '@/features/drives/__fixtures__/drives';

import { freezesLeft, latestStreakNews } from '../ActionCards';
import { pointsToNext, levelProgress } from '../HomeHeader';

const streak = (outcome: 'none' | 'grew' | 'freeze_used' | 'at_risk' | 'restored' | 'reset') =>
  result({ streak: { before: 5, after: outcome === 'reset' ? 0 : 5, outcome, nextMult: 1, atRisk: false, freezes: 1, freezeEarned: false } });

describe('latestStreakNews', () => {
  test.each(['reset', 'freeze_used'] as const)('the newest kept drive with %s is news', (outcome) => {
    expect(latestStreakNews([drive({ clientTripId: 'n', result: streak(outcome) }), drive({ clientTripId: 'o' })])).toEqual({ clientTripId: 'n', outcome });
  });

  test.each(['none', 'grew', 'at_risk', 'restored'] as const)('%s is not', (outcome) => {
    expect(latestStreakNews([drive({ result: streak(outcome) })])).toBeNull();
  });

  test('only the newest answered drive counts: an older loss is no news once a later drive grew the streak', () => {
    expect(latestStreakNews([drive({ clientTripId: 'n' }), drive({ clientTripId: 'o', result: streak('reset') })])).toBeNull();
  });

  test('drives the server has not answered, "wasn\'t driving" and merged drives are skipped', () => {
    const older = drive({ clientTripId: 'o', result: streak('freeze_used') });
    expect(latestStreakNews([drive({ status: 'pending', result: null }), older])).toEqual({ clientTripId: 'o', outcome: 'freeze_used' });
    expect(latestStreakNews([drive({ status: 'not_driving', result: streak('grew') }), older])).toEqual({ clientTripId: 'o', outcome: 'freeze_used' });
    expect(latestStreakNews([drive({ status: 'merged', result: streak('grew') }), older])).toEqual({ clientTripId: 'o', outcome: 'freeze_used' });
    expect(latestStreakNews([])).toBeNull();
  });
});

test('freezesLeft', () => {
  expect(freezesLeft(0)).toBe('No freezes left');
  expect(freezesLeft(1)).toBe('1 freeze left');
  expect(freezesLeft(2)).toBe('2 freezes left');
  expect(freezesLeft(3)).toBe('3 freezes left');
});

test('level math: share of the way to the next level, and points still to earn', () => {
  expect(levelProgress({ points: 1750, level_floor: 1500, level_next: 2500 })).toBe(0.25);
  expect(levelProgress({ points: 400_000, level_floor: 306_250, level_next: null })).toBe(1);
  expect(pointsToNext({ points: 1750, level_next: 2500 })).toBe(750);
  expect(pointsToNext({ points: 2600, level_next: 2500 })).toBe(0);
  expect(pointsToNext({ points: 400_000, level_next: null })).toBeNull();
  // the level follows the points: a level just dropped to reads from its own floor
  expect(levelProgress({ points: 700, level_floor: 250, level_next: 750 })).toBe(0.9);
  expect(pointsToNext({ points: 700, level_next: 750 })).toBe(50);
});
