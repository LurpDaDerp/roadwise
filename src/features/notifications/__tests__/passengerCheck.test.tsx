// "Are you driving?": its tap hands the drive to the app's handler at once (never held for the
// drive), then opens Home (not over the driving screen, nor a second Home); the parse and the route.
import { act, render } from '@testing-library/react-native';

import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import type { Db } from '@/data/db/driver';
import { migrate } from '@/data/db/migrate';
import { DataProvider } from '@/data/queries/context';

import { NotificationsHost } from '../NotificationsHost';
import { PASSENGER_CHECK_KIND, passengerCheckId, passengerCheckOf } from '../passengerCheck';
import { routeForResponse } from '../responses';

const mockNotifications = { listener: null as null | ((r: unknown) => void), last: null as unknown };

jest.mock('expo-notifications', () => ({
  DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
  addNotificationResponseReceivedListener: (fn: (r: unknown) => void) => {
    mockNotifications.listener = fn;
    return {
      remove: () => {
        if (mockNotifications.listener === fn) mockNotifications.listener = null;
      },
    };
  },
  getLastNotificationResponse: () => mockNotifications.last,
  clearLastNotificationResponse: () => {},
  setNotificationHandler: () => {},
}));

let mockPathname = '/drives';
jest.mock('expo-router', () => ({
  usePathname: () => mockPathname,
  router: { push: jest.fn(), navigate: jest.fn() },
}));

const TRIP = '0f8fad5b-d9cb-469f-a165-70867728950e';
const tap = (date = 1, data: Record<string, unknown> = { kind: PASSENGER_CHECK_KIND, clientTripId: TRIP }, action = 'expo.modules.notifications.actions.DEFAULT') => ({
  actionIdentifier: action,
  notification: { date, request: { identifier: passengerCheckId(TRIP), content: { data } } },
});

let db: Db;
beforeAll(async () => {
  db = await createSqlJsDb();
  await migrate(db);
});
beforeEach(() => {
  mockNotifications.listener = null;
  mockNotifications.last = null;
  mockPathname = '/drives';
});

async function mount(o: { busy?: boolean; ready?: boolean; handler?: (id: string) => Promise<void> } = {}) {
  const navigate = jest.fn();
  const order: string[] = [];
  const onPassengerCheck = jest.fn(
    o.handler ??
      (async (id: string) => {
        order.push(`check ${id}`);
      })
  );
  let ready = o.ready ?? true;
  const props = () => ({
    isRecording: () => o.busy ?? true,
    isDriveRecording: () => o.busy ?? true,
    isBusy: () => o.busy ?? true,
    subscribeBusy: () => () => {},
    navigate: (href: string) => {
      order.push(`open ${href}`);
      navigate(href);
    },
    ready,
    onPassengerCheck,
  });
  const ui = () => (
    <DataProvider db={db} now={() => 1}>
      <NotificationsHost {...props()} />
    </DataProvider>
  );
  const view = await render(ui());
  const settle = async () => {
    for (let i = 0; i < 6; i += 1) await act(async () => Promise.resolve());
  };
  await settle();
  return {
    navigate,
    order,
    onPassengerCheck,
    settle,
    setReady: async (r: boolean) => {
      ready = r;
      await view.rerender(ui());
      await settle();
    },
  };
}

test('during a drive: the drive goes to the handler at once, then Home', async () => {
  const h = await mount({ busy: true });
  await act(async () => mockNotifications.listener!(tap()));
  await h.settle();
  expect(h.onPassengerCheck.mock.calls).toEqual([[TRIP]]);
  expect(h.order).toEqual([`check ${TRIP}`, 'open /home']);
});

test('a cold launch from the tap: the handler runs, Home waits for the navigator', async () => {
  mockNotifications.last = tap(5);
  const h = await mount({ ready: false });
  expect(h.onPassengerCheck.mock.calls).toEqual([[TRIP]]);
  expect(h.navigate).not.toHaveBeenCalled();
  await h.setReady(true);
  expect(h.navigate.mock.calls).toEqual([['/home']]);
});

test('over the driving screen nothing more opens (it leaves for Home itself); on Home, no second Home', async () => {
  mockPathname = '/drive';
  const h = await mount();
  await act(async () => mockNotifications.listener!(tap(2)));
  await h.settle();
  expect(h.onPassengerCheck).toHaveBeenCalledTimes(1);
  expect(h.navigate).not.toHaveBeenCalled();
  mockPathname = '/home';
  await act(async () => mockNotifications.listener!(tap(3)));
  await h.settle();
  expect(h.onPassengerCheck).toHaveBeenCalledTimes(2);
  expect(h.navigate).not.toHaveBeenCalled();
});

test('a handler that fails still opens Home; the same tap twice acts once', async () => {
  const h = await mount({
    handler: async () => {
      throw new Error('no');
    },
  });
  await act(async () => mockNotifications.listener!(tap(4)));
  await act(async () => mockNotifications.listener!(tap(4)));
  await h.settle();
  expect(h.onPassengerCheck).toHaveBeenCalledTimes(1);
  expect(h.navigate.mock.calls).toEqual([['/home']]);
});

test('a dismissal or another action is nothing', async () => {
  const h = await mount();
  await act(async () => mockNotifications.listener!(tap(6, undefined, 'com.apple.UNNotificationDismissActionIdentifier')));
  await h.settle();
  expect(h.onPassengerCheck).not.toHaveBeenCalled();
  expect(h.navigate).not.toHaveBeenCalled();
});

test('the parse: only its kind with a well-formed trip id; its route falls back to Home', () => {
  expect(passengerCheckOf({ kind: PASSENGER_CHECK_KIND, clientTripId: TRIP })).toBe(TRIP);
  expect(passengerCheckOf({ kind: 'driveSummary', clientTripId: TRIP })).toBeNull();
  expect(passengerCheckOf({ kind: PASSENGER_CHECK_KIND, clientTripId: '../x' })).toBeNull();
  expect(passengerCheckOf({ kind: PASSENGER_CHECK_KIND })).toBeNull();
  expect(passengerCheckOf(null)).toBeNull();
  expect(passengerCheckId(TRIP)).toBe(`drive-passenger:${TRIP}`);
  expect(routeForResponse(tap() as never)).toEqual({ href: '/home' });
});
