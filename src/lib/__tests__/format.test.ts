import { formatDistanceMi, formatDuration, formatPoints, formatSpeed } from '@/lib/format';

test('speed is an integer or a dash', () => {
  expect(formatSpeed(44.6)).toBe('45');
  expect(formatSpeed(NaN)).toBe('—');
});
test('distance under 10 mi keeps one decimal', () => {
  expect(formatDistanceMi(804.672)).toBe('0.5 mi');
  expect(formatDistanceMi(19312)).toBe('12 mi');
});
test('duration', () => {
  expect(formatDuration(1320)).toBe('22 min');
  expect(formatDuration(3900)).toBe('1 h 05 min');
});
test('points use thousands separators', () => expect(formatPoints(1250)).toBe('1,250'));
