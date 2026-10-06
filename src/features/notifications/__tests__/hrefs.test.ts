/**
 * Final review m1: one deep-link allowlist for the notification router and onboarding's held link,
 * so a route added to one can never diverge from the other.
 */
import { PENDING_HREF_ALLOWLIST, pendingHrefFor } from '@/features/auth/authGuard';
import { ALLOWED_HREFS, isAllowedHref } from '@/features/notifications/hrefs';
import { allowHref } from '@/features/notifications/responses';

jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
jest.mock('expo-notifications', () => ({ DEFAULT_ACTION_IDENTIFIER: 'default' }));

test('the router and the onboarding hold read the very same list', () => {
  expect(PENDING_HREF_ALLOWLIST).toBe(ALLOWED_HREFS);
});

test.each([
  ['/drives/abc_123', true],
  ['/drives', true],
  ['/settings/permissions', true],
  ['/home', true],
  ['/leagues', true],
  ['/friends', true],
  // v2 routes are gone.
  ['/rewards', false],
  ['/inbox', false],
  ['/trips', false],
  ['/join/ABCD2345', false],
  ['/leagues/', false],
  ['/friends?x=1', false],
  ['/settings', false],
  ['/drives/abc?x=1', false],
  ['https://evil.example/home', false],
])('%s → %s, in both', (url, allowed) => {
  expect(isAllowedHref(url)).toBe(allowed);
  expect(pendingHrefFor(url)).toBe(allowed ? url : null);
  expect(allowHref(url)).toBe(allowed ? url : '/home');
});
