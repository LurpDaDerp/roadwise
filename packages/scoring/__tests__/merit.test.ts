import * as barrel from '../src';
import { MERIT_RULES, driveMerit } from '../src/merit';

describe('driveMerit: five tiers from the drive score and the distance', () => {
  test('the rule table', () =>
    expect(MERIT_RULES).toEqual([
      { tier: 5, minScore: 95, minMiles: 25 },
      { tier: 4, minScore: 90, minMiles: 10 },
      { tier: 3, minScore: 85, minMiles: 4 },
      { tier: 2, minScore: 75, minMiles: 1 },
    ]));

  test.each([
    [100, 0.5, 1], // a short perfect drive is the lowest tier
    [97, 20, 4], // a long excellent drive is high
    [97, 25, 5],
    [95, 24.9, 4],
    [90, 10, 4],
    [89, 10, 3],
    [85, 4, 3],
    [84, 4, 2],
    [75, 1, 2],
    [74, 1, 1],
    [100, 0.99, 1],
    [0, 100, 1],
    [100, 0, 1],
  ] as const)('score %f over %f mi → tier %i', (score, miles, tier) => expect(driveMerit(score, miles)).toBe(tier));

  test('no score, or unreadable miles, has no tier', () => {
    expect(driveMerit(null, 30)).toBeNull();
    expect(driveMerit(Number.NaN, 30)).toBeNull();
    expect(driveMerit(Number.POSITIVE_INFINITY, 30)).toBeNull();
    expect(driveMerit(90, -0.1)).toBeNull();
    expect(driveMerit(90, Number.NaN)).toBeNull();
  });

  test('the barrel exports it, and no tier names', () => {
    expect(barrel.driveMerit).toBe(driveMerit);
    expect(barrel.MERIT_RULES).toBe(MERIT_RULES);
    for (const rule of MERIT_RULES) expect(Object.keys(rule).sort()).toEqual(['minMiles', 'minScore', 'tier']);
  });
});
