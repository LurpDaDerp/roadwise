import { t } from '@/i18n';
import { en } from '@/i18n/en';

test('interpolates variables', () => {
  expect(t('format.distanceMi', { value: 12 })).toBe('12 mi');
});
test('every string is non-empty', () => {
  const empty = Object.entries(en)
    .filter(([, value]) => value.length === 0)
    .map(([key]) => key);
  expect(empty).toEqual([]);
});
test('carries the tab and drive keys: the Friends tab, no points and no phone alert', () => {
  expect(t('tabs.analytics')).toBe('Analytics');
  expect(t('tabs.friends')).toBe('Friends');
  expect(Object.keys(en)).not.toContain('tabs.leaderboards');
  expect(Object.keys(en)).not.toContain('summary.pointsEarned');
  expect(Object.keys(en)).not.toContain('alert.phoneDown');
  expect(t('alert.recording')).toBe('Recording');
});
