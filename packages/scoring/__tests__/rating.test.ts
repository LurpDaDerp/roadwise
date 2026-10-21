import { attentionPenalty } from '../src/drive';
import { attentionDeficit, levelForPoints, safetyRating, watchedMiles } from '../src/rating';

describe('safetyRating', () => {
  test('one phone pickup every 10 mi → R 400 → 60', () =>
    expect(safetyRating(40, 10)).toEqual({ rating: 60, ranked: true }));

  test('one hard brake every 20 mi → R 50 → 95', () => expect(safetyRating(10, 20).rating).toBe(95));

  test('the same rate over 100 mi rates the same and is ranked', () =>
    expect(safetyRating(400, 100)).toEqual({ rating: 60, ranked: true }));

  test('no miles → no rating', () => {
    expect(safetyRating(0, 0)).toEqual({ rating: null, ranked: false });
    expect(safetyRating(40, 0)).toEqual({ rating: null, ranked: false });
  });

  test('ranked from 10 mi', () => {
    expect(safetyRating(0, 9.9)).toEqual({ rating: 100, ranked: false });
    expect(safetyRating(0, 10)).toEqual({ rating: 100, ranked: true });
  });

  test('clamped to 0', () => expect(safetyRating(1000, 10).rating).toBe(0));

  test('rounded to 1 decimal', () => expect(safetyRating(7, 30).rating).toBe(97.7)); // 100 − 23.33/10
});

describe('Attention (DashPal)', () => {
  test('watched miles: the drive’s miles × the covered share of its moving seconds', () => {
    expect(watchedMiles(20, 1000, 500)).toBe(10);
    expect(watchedMiles(20, 1000, 1500)).toBe(20);
    expect(watchedMiles(20, 0, 0)).toBe(0);
    expect(watchedMiles(0, 1000, 1000)).toBe(0);
  });

  test('its penalty: DashPal events only', () => {
    const base = { id: 'e', startedAt: 0, durationS: 3 };
    expect(attentionPenalty({ ...base, type: 'eyes_off', tier: 'severe' })).toBe(40);
    expect(attentionPenalty({ ...base, type: 'drowsy', tier: 'severe' })).toBe(50);
    expect(attentionPenalty({ ...base, type: 'hard_brake', tier: 'severe' })).toBe(0);
  });

  test('10 × penalty per watched mile, never over fewer than 10 watched miles', () => {
    expect(attentionDeficit(40, 40)).toBe(10);
    expect(attentionDeficit(40, 2)).toBe(40);
    expect(attentionDeficit(40, 0)).toBe(0);
  });

  test('takes its share off the rating only for a driver DashPal watched', () => {
    expect(safetyRating(40, 20).rating).toBe(80);
    expect(safetyRating(40, 20, { penalty: 40, watchedMiles: 20 }).rating).toBe(60);
    expect(safetyRating(40, 20, { penalty: 0, watchedMiles: 20 }).rating).toBe(80);
    expect(safetyRating(40, 20, null).rating).toBe(80);
  });
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
