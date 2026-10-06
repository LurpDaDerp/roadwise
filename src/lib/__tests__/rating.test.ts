import { formatRating } from '@/lib/rating';

test('a ranked rating is a whole number', () => {
  expect(formatRating(91.7, true)).toBe('92');
  expect(formatRating(91.4, true)).toBe('91');
  expect(formatRating(100, true)).toBe('100');
});

test('unranked or missing never shows a number', () => {
  expect(formatRating(91.7, false)).toBe('Unranked');
  expect(formatRating(null, true)).toBe('Unranked');
  expect(formatRating(undefined, true)).toBe('Unranked');
});
