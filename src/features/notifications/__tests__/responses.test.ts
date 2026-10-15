/** @jest-environment node */
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createSettingsRepo, migrate, type Db } from '@/data/db';
import { isAllowedHref } from '@/features/notifications/hrefs';
import { handleResponse, PENDING_HREF_KEY, PENDING_HREF_MAX_AGE_MS, replayPendingHref, routeForResponse } from '@/features/notifications/responses';

jest.mock('expo-notifications', () => ({ DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT' }));

const response = (data: unknown, action = 'expo.modules.notifications.actions.DEFAULT') =>
  ({ actionIdentifier: action, notification: { date: 1, request: { identifier: 'n1', content: { data } } } }) as never;

test('the allowlist: the drive summary (with ?fresh=1), history, home, leagues, friends — nothing else, never a drive start', () => {
  expect(isAllowedHref('/drives/00000000-0000-4000-8000-000000000001?fresh=1')).toBe(true);
  expect(isAllowedHref('/drives/abc')).toBe(true);
  expect(isAllowedHref('/drives')).toBe(true);
  expect(isAllowedHref('/home')).toBe(true);
  expect(isAllowedHref('/leagues')).toBe(true);
  expect(isAllowedHref('/friends')).toBe(true);
  expect(isAllowedHref('/drive')).toBe(false);
  expect(isAllowedHref('/drives/abc?fresh=2')).toBe(false);
  expect(isAllowedHref('https://evil.example/')).toBe(false);
  expect(isAllowedHref(null)).toBe(false);
});

test('routeForResponse: the url when allowed, Home otherwise; a dismissal opens nothing', () => {
  expect(routeForResponse(response({ url: '/drives/abc?fresh=1' }))).toEqual({ href: '/drives/abc?fresh=1', clientTripId: 'abc' });
  expect(routeForResponse(response({ url: '/leagues' }))).toEqual({ href: '/leagues' });
  expect(routeForResponse(response({ url: '/settings/x' }))).toEqual({ href: '/home' });
  expect(routeForResponse(response({}))).toEqual({ href: '/home' });
  expect(routeForResponse(response({ url: '/home' }, 'dismiss'))).toBeNull();
  expect(routeForResponse(null)).toBeNull();
});

test('the forgot-to-start reminder: its tap opens Home; its "Not driving" action opens nothing (native handles it)', () => {
  expect(routeForResponse(response({ url: '/home' }))).toEqual({ href: '/home' });
  expect(routeForResponse(response({ url: '/home' }, 'roadwise.tripReminder.notDriving'))).toBeNull();
});

test('handleResponse navigates, or holds the tap while a drive is under way and replays it later (not when stale)', async () => {
  const db: Db = await createSqlJsDb();
  await migrate(db);
  const navigated: string[] = [];
  let busy = true;
  const deps = { db, navigate: (h: string) => void navigated.push(h), isBusy: () => busy, now: () => 1_000_000 };
  expect(await handleResponse(response({ url: '/drives/abc' }), deps)).toEqual({ kind: 'deferred', href: '/drives/abc' });
  expect(navigated).toEqual([]);
  expect(await replayPendingHref(deps)).toEqual({ kind: 'busy' });
  busy = false;
  expect(await replayPendingHref(deps)).toEqual({ kind: 'navigated', href: '/drives/abc' });
  expect(navigated).toEqual(['/drives/abc']);
  expect(await replayPendingHref(deps)).toEqual({ kind: 'none' });
  await createSettingsRepo(db).set(PENDING_HREF_KEY, { href: '/leagues', at: 1_000_000 - PENDING_HREF_MAX_AGE_MS - 1 });
  expect(await replayPendingHref(deps)).toEqual({ kind: 'expired' });
  expect(await handleResponse(response({ url: '/friends' }), deps)).toEqual({ kind: 'navigated', href: '/friends' });
});
