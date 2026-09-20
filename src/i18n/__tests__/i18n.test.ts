import { t } from '@/i18n';
import { en } from '@/i18n/en';

test('interpolates variables', () => {
  expect(t('summary.pointsEarned', { points: 50 })).toBe('+50 points');
});
test('every string is non-empty', () => {
  const empty = Object.entries(en)
    .filter(([, value]) => value.length === 0)
    .map(([key]) => key);
  expect(empty).toEqual([]);
});
