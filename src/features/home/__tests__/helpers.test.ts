import { summary } from '@/features/drives/__fixtures__/drives';

import { ratingTrend, toRating } from '../HomeHeader';
import { goalsDone, weekDistance } from '../WeekPills';

describe('ratingTrend: the week in whole numbers, like the rating', () => {
  test.each([
    [2.4, 'up', 'Up 2 this week'],
    [0.6, 'up', 'Up 1 this week'],
    [0.4, 'flat', 'Steady this week'],
    [0, 'flat', 'Steady this week'],
    [-0.4, 'flat', 'Steady this week'],
    [-0.6, 'down', 'Down 1 this week'],
    [-3.2, 'down', 'Down 3 this week'],
  ] as const)('%s → %s', (trend, direction, line) => {
    expect(ratingTrend(trend)).toEqual(expect.objectContaining({ direction, line }));
  });

  test('unknown is hidden', () => {
    expect(ratingTrend(null)).toBeNull();
    expect(ratingTrend(undefined)).toBeNull();
    expect(ratingTrend(Number.NaN)).toBeNull();
  });
});

test('toRating: the distance still to drive, in the driver units, and nothing before the first drive', () => {
  expect(toRating(4.7, 'mi')).toEqual({ fill: 0.4, text: '4 of 10 mi to your rating', spoken: '4 of 10 miles to your rating' });
  expect(toRating(4.7, 'km')).toEqual({ fill: 7 / 16, text: '7 of 16 km to your rating', spoken: '7 of 16 kilometers to your rating' });
  expect(toRating(0, 'mi')).toBeNull();
});

test('weekDistance: whole from 10 up, one decimal under', () => {
  expect(weekDistance(38.4, 'mi')).toBe('38 mi');
  expect(weekDistance(4.24, 'mi')).toBe('4.2 mi');
  expect(weekDistance(4.24, 'km')).toBe('6.8 km');
  expect(weekDistance(9.99, 'mi')).toBe('10.0 mi');
  expect(weekDistance(38.4, 'mi', true)).toBe('38 miles');
});

test('goalsDone counts the completed goals, and nothing without goals', () => {
  expect(goalsDone(summary().challenges)).toEqual({ done: 1, total: 3 });
  expect(goalsDone([])).toBeNull();
  expect(goalsDone(undefined)).toBeNull();
});
