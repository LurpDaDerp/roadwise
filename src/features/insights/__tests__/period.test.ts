import { parsePeriod, PERIOD_OPTIONS, periodPhrase } from '@/features/insights/period';

describe('parsePeriod', () => {
  test('accepts each of the four spec periods as it travels in the query string', () => {
    expect(parsePeriod('4w')).toBe('4w');
    expect(parsePeriod('3mo')).toBe('3mo');
    expect(parsePeriod('12mo')).toBe('12mo');
    expect(parsePeriod('all')).toBe('all');
  });

  test('falls back to four weeks for a missing, repeated or hand-typed value', () => {
    expect(parsePeriod(undefined)).toBe('4w');
    expect(parsePeriod('')).toBe('4w');
    expect(parsePeriod('7d')).toBe('4w');
    expect(parsePeriod(['3mo', '4w'])).toBe('3mo');
    expect(parsePeriod([])).toBe('4w');
  });

  test('a screen can name its own fallback, so totals can open on all time', () => {
    expect(parsePeriod(undefined, 'all')).toBe('all');
    expect(parsePeriod('nonsense', 'all')).toBe('all');
  });
});

test('the selector prints the spec labels and speaks them in full', () => {
  expect(PERIOD_OPTIONS.map((o) => o.short)).toEqual(['4 wk', '3 mo', '12 mo', 'All']);
  expect(PERIOD_OPTIONS.map((o) => o.spoken)).toEqual(['4 weeks', '3 months', '12 months', 'All time']);
});

test('every summary sentence ends in the period it covers', () => {
  expect(periodPhrase('4w')).toBe('over 4 weeks');
  expect(periodPhrase('all')).toBe('since your first drive');
});
