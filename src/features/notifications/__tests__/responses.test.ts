/** @jest-environment node */
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createSettingsRepo, migrate, type Db } from '@/data/db';
import { isAllowedHref } from '@/features/notifications/hrefs';
import { handleResponse, PENDING_HREF_KEY, PENDING_HREF_MAX_AGE_MS, replayPendingHref, routeForResponse } from '@/features/notifications/responses';

jest.mock('expo-notifications', () => ({ DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT' }));

const response = (data: unknown, action = 'expo.modules.notifications.actions.DEFAULT') =>
  ({ actionIdentifier: action, notification: { date: 1, request: { identifier: 'n1', content: { data } } } }) as never;

test('the allowlist: the drive summary (with ?fresh=1), history, home, leagues, friends, the Wrapped — nothing else, never a drive start', () => {
  expect(isAllowedHref('/drives/00000000-0000-4000-8000-000000000001?fresh=1')).toBe(true);
  expect(isAllowedHref('/drives/abc')).toBe(true);
  expect(isAllowedHref('/drives')).toBe(true);
  expect(isAllowedHref('/home')).toBe(true);
  expect(isAllowedHref('/leagues')).toBe(true);
  expect(isAllowedHref('/friends')).toBe(true);
  // The monthly Wrapped: the archive, a month (the push on the 1st opens it) and a shared copy.
  expect(isAllowedHref('/wrapped')).toBe(true);
  expect(isAllowedHref('/wrapped/2026-10')).toBe(true);
  expect(isAllowedHref('/w/Ab3dEf7hJk9m')).toBe(true);
  expect(isAllowedHref('/wrapped/2026-13')).toBe(false);
  expect(isAllowedHref('/wrapped/2026-10?x=1')).toBe(false);
  expect(isAllowedHref('/w/short')).toBe(false);
  expect(isAllowedHref('/w/Ab3dEf7hJk9m/x')).toBe(false);
  expect(isAllowedHref('/drive')).toBe(false);
  expect(isAllowedHref('/drives/abc?fresh=2')).toBe(false);
  expect(isAllowedHref('https://evil.example/')).toBe(false);
  expect(isAllowedHref(null)).toBe(false);
});

test('routeForResponse: the url when allowed, Home otherwise; a dismissal opens nothing', () => {
  expect(routeForResponse(response({ url: '/drives/abc?fresh=1' }))).toEqual({ href: '/drives/abc?fresh=1', clientTripId: 'abc' });
  expect(routeForResponse(response({ url: '/leagues' }))).toEqual({ href: '/leagues' });
  // The monthly Wrapped push.
  expect(routeForResponse(response({ url: '/wrapped/2026-10' }))).toEqual({ href: '/wrapped/2026-10' });
  expect(routeForResponse(response({ url: '/settings/x' }))).toEqual({ href: '/home' });
  expect(routeForResponse(response({}))).toEqual({ href: '/home' });
  expect(routeForResponse(response({ url: '/home' }, 'dismiss'))).toBeNull();
  expect(routeForResponse(null)).toBeNull();
});

test('no notification can open a drive start: a pushed or local url naming the drive screen opens Home', () => {
  expect(routeForResponse(response({ url: '/drive' }))).toEqual({ href: '/home' });
  expect(routeForResponse(response({ url: '/drive?start=1' }))).toEqual({ href: '/home' });
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
