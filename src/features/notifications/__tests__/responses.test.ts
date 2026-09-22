/**
 * Where a tapped notification goes, the "I drove" / "Passenger" actions, the opened-trips record
 * and the href held while a drive is under way. A real SQLite (sql.js) stands behind the db.
 */
import { createSettingsRepo, createTripsRepo, type Db } from '@/data/db';
import { createTestDb, seedTrips } from '@/data/queries/__fixtures__/harness';
import { T0, tripRow } from '@/data/queries/__fixtures__/rows';
import {
  FALLBACK_HREF,
  handleResponse,
  OPENED_TRIPS_MAX,
  PENDING_HREF_KEY,
  PENDING_HREF_MAX_AGE_MS,
  recordOpenedTrip,
  replayPendingHref,
  routeForResponse,
  type ResponseDeps,
} from '@/features/notifications/responses';
import { OPENED_TRIPS_KEY } from '@/notifications/keys';

jest.mock('expo-notifications', () => ({
  DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
}));

const DEFAULT = 'expo.modules.notifications.actions.DEFAULT';
const NOW = T0 + 3_600_000;

const response = (data: unknown, actionIdentifier = DEFAULT, identifier = 'n1') =>
  ({
    actionIdentifier,
    notification: {
      date: 1,
      request: { identifier, content: { title: 't', body: 'b', data }, trigger: null },
    },
  }) as never;

describe('routeForResponse — the allowlist', () => {
  test.each([
    ['/trips/abc_DEF-123/summary', '/trips/abc_DEF-123/summary'],
    [`/trips/${'a'.repeat(64)}/summary`, `/trips/${'a'.repeat(64)}/summary`],
    ['/trips', '/trips'],
    ['/permissions', '/permissions'],
    ['/inbox', '/inbox'],
    // Anything else lands in the inbox, where every notice is listed.
    [`/trips/${'a'.repeat(65)}/summary`, '/inbox'],
    ['/trips/abc/summary?x=1', '/inbox'],
    ['/trips/abc/summary/', '/inbox'],
    ['/trips/a.b/summary', '/inbox'],
    ['/trips/abc', '/inbox'],
    ['/trips/', '/inbox'],
    ['/settings', '/inbox'],
    ['https://evil.example/trips', '/inbox'],
    ['roadwise://trips', '/inbox'],
    ['//trips', '/inbox'],
    ['/trips\n', '/inbox'],
    ['', '/inbox'],
  ])('%j → %s', (url, href) => {
    expect(routeForResponse(response({ url }))?.href).toBe(href);
  });

  test('a notification with no url, or a url that is not a string, goes to the inbox', () => {
    expect(routeForResponse(response({}))).toEqual({ href: '/inbox' });
    expect(routeForResponse(response(null))).toEqual({ href: '/inbox' });
    expect(routeForResponse(response({ url: 42 }))).toEqual({ href: '/inbox' });
    expect(FALLBACK_HREF).toBe('/inbox');
  });

  test('a malformed response is null', () => {
    expect(routeForResponse(null)).toBeNull();
    expect(routeForResponse(undefined)).toBeNull();
    expect(routeForResponse({} as never)).toBeNull();
    expect(routeForResponse({ actionIdentifier: DEFAULT } as never)).toBeNull();
    expect(
      routeForResponse({ actionIdentifier: DEFAULT, notification: { request: {} } } as never)
    ).toBeNull();
    expect(
      routeForResponse({
        actionIdentifier: 7,
        notification: { request: { content: { data: {} } } },
      } as never)
    ).toBeNull();
  });

  test('a summary url names its trip', () => {
    expect(routeForResponse(response({ url: '/trips/t1/summary' }))).toEqual({
      href: '/trips/t1/summary',
      clientTripId: 't1',
    });
  });

  test('an action other than a tap or a role answer (a dismissal) is not routed', () => {
    expect(
      routeForResponse(response({ url: '/trips' }, 'com.apple.UNNotificationDismissActionIdentifier'))
    ).toBeNull();
  });

  test('"I drove" and "Passenger" carry the role for the trip in the url', () => {
    expect(routeForResponse(response({ url: '/trips/t1/summary' }, 'drove'))).toEqual({
      href: '/trips/t1/summary',
      clientTripId: 't1',
      role: 'driver',
    });
    expect(routeForResponse(response({ url: '/trips/t1/summary' }, 'passenger'))).toEqual({
      href: '/trips/t1/summary',
      clientTripId: 't1',
      role: 'passenger',
    });
  });

  test('a role answer with no single trip to apply it to only opens the url', () => {
    expect(routeForResponse(response({ url: '/trips' }, 'drove'))).toEqual({ href: '/trips' });
  });

  test("M3's interim drive-summary data still routes (the hand-over before Task 19)", () => {
    expect(routeForResponse(response({ kind: 'driveSummary', clientTripIds: ['t1'] }))).toEqual({
      href: '/trips/t1/summary',
      clientTripId: 't1',
    });
    expect(
      routeForResponse(response({ kind: 'driveSummary', clientTripIds: ['t1', 't2'] }))
    ).toEqual({ href: '/trips' });
    expect(routeForResponse(response({ kind: 'driveSummary', clientTripIds: ['../x'] }))).toEqual({
      href: '/inbox',
    });
  });
});

describe('handleResponse', () => {
  let db: Db;
  let navigate: jest.Mock;
  let busy: boolean;
  let onTripChanged: jest.Mock;
  let dismiss: jest.Mock;
  let onError: jest.Mock;

  const deps = (over: Partial<ResponseDeps> = {}): ResponseDeps => ({
    db,
    navigate,
    isBusy: () => busy,
    onTripChanged,
    dismiss,
    onError,
    now: () => NOW,
    ...over,
  });

  beforeEach(async () => {
    db = await createTestDb();
    await seedTrips(db, [
      tripRow({ client_trip_id: 't1', role: 'unknown', score: null, status: 'unscored' }),
    ]);
    navigate = jest.fn();
    busy = false;
    onTripChanged = jest.fn();
    dismiss = jest.fn(async () => {});
    onError = jest.fn();
  });

  test('a tap opens its route and records the trip as opened', async () => {
    const out = await handleResponse(response({ url: '/trips/t1/summary' }), deps());
    expect(out).toEqual({ kind: 'navigated', href: '/trips/t1/summary' });
    expect(navigate).toHaveBeenCalledWith('/trips/t1/summary');
    expect(await createSettingsRepo(db).get(OPENED_TRIPS_KEY)).toEqual(['t1']);
  });

  test('"Passenger" writes the role through setTripRole, refreshes the trip and opens its summary', async () => {
    const out = await handleResponse(response({ url: '/trips/t1/summary' }, 'passenger'), deps());
    expect(out).toEqual({ kind: 'navigated', href: '/trips/t1/summary', role: 'applied' });
    const row = await createTripsRepo(db).get('t1');
    expect(row).toMatchObject({ role: 'passenger', role_source: 'manual', status: 'unscored' });
    expect(onTripChanged).toHaveBeenCalledWith('t1');
    expect(dismiss).toHaveBeenCalledWith('n1');
    expect(navigate).toHaveBeenCalledWith('/trips/t1/summary');
  });

  test('"I drove" stores driver', async () => {
    await handleResponse(response({ url: '/trips/t1/summary' }, 'drove'), deps());
    expect(await createTripsRepo(db).get('t1')).toMatchObject({ role: 'driver' });
  });

  test('a role answer for a trip this phone no longer holds opens the summary, which says what it knows', async () => {
    const out = await handleResponse(response({ url: '/trips/gone/summary' }, 'drove'), deps());
    expect(out).toEqual({ kind: 'navigated', href: '/trips/gone/summary', role: 'missing-trip' });
    expect(navigate).toHaveBeenCalledWith('/trips/gone/summary');
    expect(onTripChanged).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  test('a role write that fails is reported, the notification kept, and the summary opened to answer there', async () => {
    const setTripRole = jest.fn(async () => {
      throw new Error('disk');
    });
    const out = await handleResponse(
      response({ url: '/trips/t1/summary' }, 'passenger'),
      deps({ setTripRole })
    );
    expect(out).toEqual({ kind: 'navigated', href: '/trips/t1/summary', role: 'failed' });
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'notifications.role');
    expect(dismiss).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/trips/t1/summary');
  });

  test('a malformed response does nothing', async () => {
    expect(await handleResponse(null, deps())).toEqual({ kind: 'ignored' });
    expect(navigate).not.toHaveBeenCalled();
  });

  test('while busy the href is held, not navigated; the role is still written', async () => {
    busy = true;
    const out = await handleResponse(response({ url: '/trips/t1/summary' }, 'passenger'), deps());
    expect(out).toEqual({ kind: 'deferred', href: '/trips/t1/summary', role: 'applied' });
    expect(navigate).not.toHaveBeenCalled();
    expect(await createSettingsRepo(db).get(PENDING_HREF_KEY)).toEqual({
      href: '/trips/t1/summary',
      at: NOW,
    });
    expect(await createTripsRepo(db).get('t1')).toMatchObject({ role: 'passenger' });
  });

  test('replay navigates once the drive is over, and only once', async () => {
    busy = true;
    await handleResponse(response({ url: '/permissions' }), deps());
    expect(await replayPendingHref(deps())).toEqual({ kind: 'busy' });
    expect(navigate).not.toHaveBeenCalled();

    busy = false;
    expect(await replayPendingHref(deps())).toEqual({ kind: 'navigated', href: '/permissions' });
    expect(navigate).toHaveBeenCalledWith('/permissions');
    expect(await replayPendingHref(deps())).toEqual({ kind: 'none' });
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  test('a held href older than its age limit is dropped, not replayed on some later launch', async () => {
    await createSettingsRepo(db).set(PENDING_HREF_KEY, {
      href: '/inbox',
      at: NOW - PENDING_HREF_MAX_AGE_MS - 1,
    });
    expect(await replayPendingHref(deps())).toEqual({ kind: 'expired' });
    expect(navigate).not.toHaveBeenCalled();
    expect(await createSettingsRepo(db).get(PENDING_HREF_KEY)).toBeNull();
  });

  test('a held href is re-checked against the allowlist on replay', async () => {
    await createSettingsRepo(db).set(PENDING_HREF_KEY, { href: '/settings/danger', at: NOW });
    expect(await replayPendingHref(deps())).toEqual({ kind: 'navigated', href: '/inbox' });
    await createSettingsRepo(db).set(PENDING_HREF_KEY, 'garbage');
    expect(await replayPendingHref(deps())).toEqual({ kind: 'expired' });
  });
});

describe('recordOpenedTrip', () => {
  test(`keeps at most ${OPENED_TRIPS_MAX} ids, newest last, each once`, async () => {
    const db = await createTestDb();
    for (let i = 0; i < 60; i += 1) await recordOpenedTrip(db, `t${i}`);
    await recordOpenedTrip(db, 't30');
    const ids = await createSettingsRepo(db).get<string[]>(OPENED_TRIPS_KEY);
    expect(ids).toHaveLength(50);
    expect(ids?.[0]).toBe('t10');
    expect(ids?.[49]).toBe('t30');
    expect(new Set(ids).size).toBe(50);
  });

  test('survives a corrupt stored value', async () => {
    const db = await createTestDb();
    await createSettingsRepo(db).set(OPENED_TRIPS_KEY, { not: 'a list' });
    await recordOpenedTrip(db, 'a');
    expect(await createSettingsRepo(db).get(OPENED_TRIPS_KEY)).toEqual(['a']);
  });
});
