import { formatRating, UNRANKED } from '@/lib/rating';

test('a ranked rating is a whole number', () => {
  expect(formatRating(91.7, true)).toBe('92');
  expect(formatRating(91.4, true)).toBe('91');
  expect(formatRating(100, true)).toBe('100');
});

test('no rating yet never shows a number', () => {
  expect(UNRANKED).toBe('No rating yet');
  expect(formatRating(91.7, false)).toBe('No rating yet');
  expect(formatRating(null, true)).toBe('No rating yet');
  expect(formatRating(undefined, true)).toBe('No rating yet');
});
