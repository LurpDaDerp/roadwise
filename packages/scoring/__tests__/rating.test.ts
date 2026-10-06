import { levelForPoints, safetyRating } from '../src/rating';

describe('safetyRating', () => {
  test('one phone pickup every 10 mi → R 400 → 60', () =>
    expect(safetyRating(40, 10)).toEqual({ rating: 60, ranked: false }));

  test('one hard brake every 20 mi → R 50 → 95', () => expect(safetyRating(10, 20).rating).toBe(95));

  test('the same rate over 100 mi rates the same and is ranked', () =>
    expect(safetyRating(400, 100)).toEqual({ rating: 60, ranked: true }));

  test('no miles → no rating', () => {
    expect(safetyRating(0, 0)).toEqual({ rating: null, ranked: false });
    expect(safetyRating(40, 0)).toEqual({ rating: null, ranked: false });
  });

  test('ranked from 25 mi', () => {
    expect(safetyRating(0, 24.9)).toEqual({ rating: 100, ranked: false });
    expect(safetyRating(0, 25)).toEqual({ rating: 100, ranked: true });
  });

  test('clamped to 0', () => expect(safetyRating(1000, 10).rating).toBe(0));

  test('rounded to 1 decimal', () => expect(safetyRating(7, 30).rating).toBe(97.7)); // 100 − 23.33/10
});

describe('levelForPoints — level n at 250 × n(n−1)/2', () => {
  test.each([
    [0, 1, 0, 250],
    [249, 1, 0, 250],
    [250, 2, 250, 750],
    [749, 2, 250, 750],
    [750, 3, 750, 1500],
    [1499, 3, 750, 1500],
    [1500, 4, 1500, 2500],
    [306_249, 49, 294_000, 306_250],
  ])('%i points → level %i [%i, %i)', (points, level, floor, next) =>
    expect(levelForPoints(points)).toEqual({ level, floor, next }));

  test('caps at level 50 with no next threshold', () => {
    expect(levelForPoints(306_250)).toEqual({ level: 50, floor: 306_250, next: null });
    expect(levelForPoints(1e9)).toEqual({ level: 50, floor: 306_250, next: null });
  });

  test('negative or non-finite points read as level 1', () => {
    expect(levelForPoints(-5)).toEqual({ level: 1, floor: 0, next: 250 });
    expect(levelForPoints(Number.NaN)).toEqual({ level: 1, floor: 0, next: 250 });
  });
});
