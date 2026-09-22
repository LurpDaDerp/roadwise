/**
 * Final review m1: one deep-link allowlist for the notification router and onboarding's held link,
 * so a route added to one can never diverge from the other.
 */
import { PENDING_HREF_ALLOWLIST, pendingHrefFor } from '@/features/auth/authGuard';
import { ALLOWED_HREFS, isAllowedHref, JOIN_HREF } from '@/features/notifications/hrefs';
import { allowHref } from '@/features/notifications/responses';

jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
jest.mock('expo-notifications', () => ({ DEFAULT_ACTION_IDENTIFIER: 'default' }));

test('the router and the onboarding hold read the very same list', () => {
  expect(PENDING_HREF_ALLOWLIST).toBe(ALLOWED_HREFS);
});

test.each([
  ['/trips/abc_123/summary', true],
  ['/trips', true],
  ['/permissions', true],
  ['/inbox', true],
  ['/rewards', true],
  ['/rewards/goal', true],
  ['/rewards/challenges', true],
  ['/rewards/badges', true],
  ['/rewards/invite', true],
  ['/join/ABCD2345', true],
  ['/join/abcd2345', false],
  ['/join/ABCD234', false],
  ['/join/ABCD23456', false],
  ['/join/IIII1111', false],
  ['/join/ABCD2345/x', false],
  ['/rewards/share', false],
  ['/rewards/', false],
  ['/rewards/goal?x=1', false],
  ['/settings', false],
  ['/trips/abc/summary?x=1', false],
  ['https://evil.example/inbox', false],
])('%s → %s, in both', (url, allowed) => {
  expect(isAllowedHref(url)).toBe(allowed);
  expect(pendingHrefFor(url)).toBe(allowed ? url : null);
  expect(allowHref(url)).toBe(allowed ? url : '/inbox');
});

test('JOIN_HREF captures the code, and only a well-formed one', () => {
  expect(JOIN_HREF.exec('/join/ABCD2345')?.[1]).toBe('ABCD2345');
  expect(JOIN_HREF.exec('/join/ABCD2340')).toBeNull();
  expect(ALLOWED_HREFS).toContain(JOIN_HREF);
});
