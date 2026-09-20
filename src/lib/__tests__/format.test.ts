import { t } from '@/i18n';
import { formatDistanceMi, formatDuration, formatPoints, formatSpeed } from '@/lib/format';

const NON_FINITE = [NaN, Infinity, -Infinity];

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

test('non-finite speed renders the unknown glyph', () => {
  for (const value of NON_FINITE) expect(formatSpeed(value)).toBe('—');
});
test('non-finite distance renders the unknown glyph', () => {
  for (const value of NON_FINITE) expect(formatDistanceMi(value)).toBe('—');
});
test('non-finite duration renders the unknown glyph', () => {
  for (const value of NON_FINITE) expect(formatDuration(value)).toBe('—');
});
test('non-finite points render the unknown glyph', () => {
  for (const value of NON_FINITE) expect(formatPoints(value)).toBe('—');
});
test('the unknown fallback comes from the string table', () => {
  expect(formatSpeed(NaN)).toBe(t('common.unknown'));
});
