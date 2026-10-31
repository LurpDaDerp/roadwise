// The recap notification's "I wasn't driving": the category it is registered under, which drives
// carry it, when its confirm is offered (an automatic drive, kept, its "Not driving?" never run
// out, ended 30 minutes ago at most, its recap never opened), and the host's handling: the confirm
// then a mark that uses no monthly mark, the recap otherwise, a cold launch from the action once
// the navigator is up, and a recap tap held like any other while a drive is under way.
import { act, render } from '@testing-library/react-native';

import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createQueueRepo, createTripsRepo, migrate, type Db } from '@/data/db';
import { DataProvider } from '@/data/queries/context';
import { markRecapSeen, RECAP_SEEN_KEY, RECAP_SEEN_MAX, wasRecapSeen } from '@/features/drives/recapSeen';
import { createSettingsRepo } from '@/data/db';

import { ensurePassengerCategory } from '../categories';
import { NotificationsHost } from '../NotificationsHost';
import { PASSENGER_ACTION_ID, PASSENGER_CATEGORY_ID, PASSENGER_WINDOW_MS, passengerOffered, passengerTapOf, recapCategory } from '../passenger';
import { routeForResponse } from '../responses';

const mockNotifications = { listener: null as null | ((r: unknown) => void), last: null as unknown };

jest.mock('expo-notifications', () => ({
  DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
  addNotificationResponseReceivedListener: (fn: (r: unknown) => void) => {
    mockNotifications.listener = fn;
    return { remove: () => {} };
  },
  getLastNotificationResponse: () => mockNotifications.last,
  clearLastNotificationResponse: () => {},
  setNotificationHandler: () => {},
}));
jest.mock('expo-router', () => ({ usePathname: () => '/home', router: { push: jest.fn(), navigate: jest.fn() } }));

const T = 1_760_000_000_000;
const ID = '0b0b0b0b-0000-4000-8000-000000000001';

const tap = (action: string, clientTripId = ID, date = 1) => ({
  actionIdentifier: action,
  notification: { date, request: { identifier: `drive-summary:${clientTripId}`, content: { data: { kind: 'driveSummary', url: `/drives/${clientTripId}?fresh=1`, clientTripId } } } },
});

let db: Db;
beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
  mockNotifications.listener = null;
  mockNotifications.last = null;
});

/** A kept drive that ended `agoMs` before T. */
async function drive(over: { origin?: 'auto' | 'manual'; expired?: boolean; agoMs?: number; status?: 'scored' | 'pending' | 'not_driving' } = {}) {
  const trips = createTripsRepo(db);
  const endedAt = T - (over.agoMs ?? 5 * 60_000);
  await trips.insert({ client_trip_id: ID, started_at: endedAt - 20 * 60_000, tz: 'UTC', status: 'recording', origin: over.origin ?? 'auto' }, endedAt);
  await trips.update(ID, { status: over.status ?? 'scored', ended_at: endedAt, not_driving_expired: over.expired ? 1 : 0, local_day: '2026-10-31' }, endedAt);
}

describe('the recap-seen store', () => {
  test('marks a recap seen, keeps the newest first, at most RECAP_SEEN_MAX ids', async () => {
    expect(await wasRecapSeen(db, 'a')).toBe(false);
    await markRecapSeen(db, 'a');
    await markRecapSeen(db, 'b');
    await markRecapSeen(db, 'a');
    expect(await createSettingsRepo(db).get(RECAP_SEEN_KEY)).toEqual(['a', 'b']);
    for (let i = 0; i < RECAP_SEEN_MAX + 5; i += 1) await markRecapSeen(db, `t${i}`);
    const seen = (await createSettingsRepo(db).get<string[]>(RECAP_SEEN_KEY))!;
    expect(seen).toHaveLength(RECAP_SEEN_MAX);
    expect(seen[0]).toBe(`t${RECAP_SEEN_MAX + 4}`);
    expect(await wasRecapSeen(db, 'a')).toBe(false);
  });

  test('anything stored that is not a list of ids reads as none seen', async () => {
    await createSettingsRepo(db).set(RECAP_SEEN_KEY, { a: 1 });
    expect(await wasRecapSeen(db, 'a')).toBe(false);
    await markRecapSeen(db, 'a');
    expect(await wasRecapSeen(db, 'a')).toBe(true);
  });
});

describe('the category and the offer', () => {
  test('one category with one action that opens the app', async () => {
    const set = jest.fn(async () => null);
    await ensurePassengerCategory({ setNotificationCategoryAsync: set } as never, 'ios');
    expect(set).toHaveBeenCalledWith(PASSENGER_CATEGORY_ID, [
      { identifier: PASSENGER_ACTION_ID, buttonTitle: 'I wasn’t driving', options: { opensAppToForeground: true } },
    ]);
  });

  test('only an automatic drive whose "Not driving?" never ran out carries it', async () => {
    await drive();
    expect(await recapCategory(db)(ID)).toBe(PASSENGER_CATEGORY_ID);
    await createTripsRepo(db).update(ID, { not_driving_expired: 1 }, T);
    expect(await recapCategory(db)(ID)).toBeNull();
    await createTripsRepo(db).update(ID, { not_driving_expired: 0, origin: 'manual' }, T);
    expect(await recapCategory(db)(ID)).toBeNull();
    expect(await recapCategory(db)('missing')).toBeNull();
  });

  test('the action is read from the recap only; it opens the recap like a tap', () => {
    expect(passengerTapOf(tap(PASSENGER_ACTION_ID))).toBe(ID);
    expect(passengerTapOf(tap('expo.modules.notifications.actions.DEFAULT'))).toBeNull();
    expect(passengerTapOf({ actionIdentifier: PASSENGER_ACTION_ID, notification: { request: { content: { data: { kind: 'friendRequest', clientTripId: ID } } } } })).toBeNull();
    expect(routeForResponse(tap(PASSENGER_ACTION_ID) as never)).toEqual({ href: `/drives/${ID}?fresh=1`, clientTripId: ID });
  });

  test('offered within 30 minutes of the end, before the recap is opened, on a kept automatic drive', async () => {
    await drive({ agoMs: 5 * 60_000 });
    expect(await passengerOffered(db, ID, T)).toBe(true);
    expect(await passengerOffered(db, ID, T - 5 * 60_000 + PASSENGER_WINDOW_MS + 1)).toBe(false);
    await markRecapSeen(db, ID);
    expect(await passengerOffered(db, ID, T)).toBe(false);
  });

  test('not on a Start drive, an expired one, one already marked or refused', async () => {
    await drive({ origin: 'manual' });
    expect(await passengerOffered(db, ID, T)).toBe(false);
    await createTripsRepo(db).update(ID, { origin: 'auto', not_driving_expired: 1 }, T);
    expect(await passengerOffered(db, ID, T)).toBe(false);
    await createTripsRepo(db).update(ID, { not_driving_expired: 0, status: 'not_driving' }, T);
    expect(await passengerOffered(db, ID, T)).toBe(false);
    await createTripsRepo(db).update(ID, { status: 'scored', sync_error: 'passenger_too_late' }, T);
    expect(await passengerOffered(db, ID, T)).toBe(false);
    await createTripsRepo(db).update(ID, { sync_error: null }, T);
    expect(await passengerOffered(db, ID, T)).toBe(true);
  });
});

describe('the host', () => {
  async function mount(o: { ready?: boolean; busy?: boolean; answer?: boolean } = {}) {
    const navigate = jest.fn();
    const confirm = jest.fn(async () => o.answer ?? true);
    let ready = o.ready ?? true;
    const ui = () => (
      <DataProvider db={db} now={() => T}>
        <NotificationsHost
          isRecording={() => o.busy ?? false}
          isDriveRecording={() => false}
          isBusy={() => o.busy ?? false}
          subscribeBusy={() => () => {}}
          navigate={navigate}
          ready={ready}
          confirmPassenger={confirm}
        />
      </DataProvider>
    );
    const view = await render(ui());
    const settle = async () => {
      for (let i = 0; i < 10; i += 1) await act(async () => Promise.resolve());
    };
    await settle();
    return {
      navigate,
      confirm,
      settle,
      press: async (r: unknown) => {
        await act(async () => mockNotifications.listener?.(r));
        await settle();
      },
      setReady: async (r: boolean) => {
        ready = r;
        await view.rerender(ui());
        await settle();
      },
    };
  }

  test('offered: the confirm, then the drive is marked from the notification (no recap opened)', async () => {
    await drive();
    const h = await mount();
    await h.press(tap(PASSENGER_ACTION_ID));
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(h.navigate).not.toHaveBeenCalled();
    expect(await createTripsRepo(db).get(ID)).toMatchObject({ status: 'not_driving' });
    const item = (await createQueueRepo(db).byKey(`not_driving:${ID}`))!;
    expect(JSON.parse(item.payload_json)).toEqual({ action: 'not_driving', clientTripId: ID, previousStatus: 'scored', via: 'notification' });
  });

  test('Cancel leaves the drive as it was', async () => {
    await drive();
    const h = await mount({ answer: false });
    await h.press(tap(PASSENGER_ACTION_ID));
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(await createTripsRepo(db).get(ID)).toMatchObject({ status: 'scored' });
    expect(h.navigate).not.toHaveBeenCalled();
  });

  test('not offered (the recap was opened): the action opens the recap, no confirm', async () => {
    await drive();
    await markRecapSeen(db, ID);
    const h = await mount();
    await h.press(tap(PASSENGER_ACTION_ID));
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.navigate).toHaveBeenCalledWith(`/drives/${ID}?fresh=1`);
  });

  test('a cold launch from the action asks once the navigator is up', async () => {
    await drive();
    mockNotifications.last = tap(PASSENGER_ACTION_ID, ID, 7);
    const h = await mount({ ready: false });
    expect(h.confirm).not.toHaveBeenCalled();
    await h.setReady(true);
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(await createTripsRepo(db).get(ID)).toMatchObject({ status: 'not_driving' });
  });

  test('during a drive the action is a recap tap, held like any other', async () => {
    await drive();
    const h = await mount({ busy: true });
    await h.press(tap(PASSENGER_ACTION_ID));
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.navigate).not.toHaveBeenCalled();
    expect(await createSettingsRepo(db).get('notifications.pendingHref')).toMatchObject({ href: `/drives/${ID}?fresh=1` });
  });
});
