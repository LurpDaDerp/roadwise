import { dayKey, isNight, sunIsDown } from '@/lib/time';

test('night window 23:00–05:00', () => {
  expect(isNight(new Date(2026, 8, 20, 23, 30))).toBe(true);
  expect(isNight(new Date(2026, 8, 20, 4, 59))).toBe(true);
  expect(isNight(new Date(2026, 8, 20, 5, 0))).toBe(false);
  expect(isNight(new Date(2026, 8, 20, 12, 0))).toBe(false);
});
test('dayKey', () => expect(dayKey(new Date(2026, 8, 20, 13, 0))).toBe('2026-09-20'));
test('dayKey resolves the calendar day in an explicit time zone', () => {
  const instant = new Date('2026-09-21T05:30:00Z'); // still the 20th in Seattle, already the 21st in Tokyo
  expect(dayKey(instant, 'America/Los_Angeles')).toBe('2026-09-20');
  expect(dayKey(instant, 'Asia/Tokyo')).toBe('2026-09-21');
  expect(dayKey(instant, 'UTC')).toBe('2026-09-21');
});
test('sun is down in Seattle at 22:00 UTC-7 in September', () => {
  expect(sunIsDown(new Date('2026-09-20T05:00:00Z'), 47.6062, -122.3321)).toBe(true); // 22:00 PDT
  expect(sunIsDown(new Date('2026-09-20T20:00:00Z'), 47.6062, -122.3321)).toBe(false); // 13:00 PDT
});
