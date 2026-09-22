/**
 * The host: the app's one response listener and one received listener, set up at mount, gone at
 * unmount; a cold-start tap handled once; a tap during a drive delivered when the drive is over.
 */
import { act, render, waitFor } from '@testing-library/react-native';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';

import { createSettingsRepo, type Db } from '@/data/db';
import { createQueryClient } from '@/data/queries';
import { createTestDb, wrapperFor } from '@/data/queries/__fixtures__/harness';
import { T0 } from '@/data/queries/__fixtures__/rows';
import { NotificationsHost } from '@/features/notifications/NotificationsHost';
import { PENDING_HREF_KEY } from '@/features/notifications/responses';
import { INBOX_QUERY_KEY } from '@/notifications/keys';

type Listener<T> = (e: T) => void;

const mockResponseListeners = new Set<Listener<unknown>>();
const mockReceivedListeners = new Set<Listener<unknown>>();
let mockLastResponse: unknown = null;

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

jest.mock('expo-notifications', () => ({
  DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
  AndroidImportance: { DEFAULT: 3 },
  setNotificationChannelAsync: jest.fn(async () => null),
  setNotificationCategoryAsync: jest.fn(async () => null),
  setNotificationHandler: jest.fn(),
  dismissNotificationAsync: jest.fn(async () => {}),
  getLastNotificationResponse: jest.fn(() => mockLastResponse),
  clearLastNotificationResponse: jest.fn(() => {
    mockLastResponse = null;
  }),
  addNotificationResponseReceivedListener: jest.fn((l: Listener<unknown>) => {
    mockResponseListeners.add(l);
    return { remove: () => mockResponseListeners.delete(l) };
  }),
  addNotificationReceivedListener: jest.fn((l: Listener<unknown>) => {
    mockReceivedListeners.add(l);
    return { remove: () => mockReceivedListeners.delete(l) };
  }),
}));

const DEFAULT = 'expo.modules.notifications.actions.DEFAULT';

const response = (url: string, identifier = 'n1', actionIdentifier = DEFAULT) => ({
  actionIdentifier,
  notification: {
    date: 1,
    request: { identifier, content: { title: 't', body: 'b', data: { url } }, trigger: null },
  },
});

let db: Db;
let busy: boolean;
const busyListeners = new Set<() => void>();
const subscribeBusy = (l: () => void) => {
  busyListeners.add(l);
  return () => {
    busyListeners.delete(l);
  };
};
const setBusy = (b: boolean) => {
  busy = b;
  for (const l of [...busyListeners]) l();
};

const push = router.push as jest.Mock;

async function mount(props: { ready?: boolean; recording?: () => boolean } = {}) {
  const client = createQueryClient();
  const Wrapper = wrapperFor(db, client, () => T0);
  const view = await render(
    <Wrapper>
      <NotificationsHost
        isRecording={props.recording ?? (() => false)}
        isBusy={() => busy}
        subscribeBusy={subscribeBusy}
        ready={props.ready}
      />
    </Wrapper>
  );
  return { client, view, Wrapper };
}

beforeEach(async () => {
  jest.clearAllMocks();
  mockResponseListeners.clear();
  mockReceivedListeners.clear();
  busyListeners.clear();
  mockLastResponse = null;
  busy = false;
  db = await createTestDb();
});

// First in the file: `ensureNotificationSetup` is memoised per process, so only the first mount
// in this module registers.
test('at mount it sets up the category and installs the one foreground handler; unmount clears it', async () => {
  const { view } = await mount();
  await waitFor(() => expect(Notifications.setNotificationCategoryAsync).toHaveBeenCalled());
  expect(Notifications.setNotificationHandler).toHaveBeenCalledTimes(1);
  await act(async () => view.unmount());
  expect(Notifications.setNotificationHandler).toHaveBeenLastCalledWith(null);
});

test('exactly one response listener and one received listener per mount, none left after unmount', async () => {
  const { view } = await mount();
  await waitFor(() => expect(mockResponseListeners.size).toBe(1));
  expect(mockReceivedListeners.size).toBe(1);
  expect(Notifications.addNotificationResponseReceivedListener).toHaveBeenCalledTimes(1);

  await act(async () => view.unmount());
  expect(mockResponseListeners.size).toBe(0);
  expect(mockReceivedListeners.size).toBe(0);
  expect(busyListeners.size).toBe(0);
});

test('the handler reads the recording signal the host was given', async () => {
  let recording = true;
  await mount({ recording: () => recording });
  const handler = (Notifications.setNotificationHandler as jest.Mock).mock.calls[0][0] as {
    handleNotification: () => Promise<{ shouldShowBanner: boolean }>;
  };
  expect((await handler.handleNotification()).shouldShowBanner).toBe(false);
  recording = false;
  expect((await handler.handleNotification()).shouldShowBanner).toBe(true);
});

test('a tap navigates once', async () => {
  await mount();
  await act(async () => {
    for (const l of mockResponseListeners) l(response('/trips/t1/summary'));
  });
  await waitFor(() => expect(push).toHaveBeenCalledWith('/trips/t1/summary'));
  expect(push).toHaveBeenCalledTimes(1);
});

test('the tap that launched the app is handled once, even when the listener delivers it too', async () => {
  const r = response('/permissions');
  mockLastResponse = r;
  await mount();
  await act(async () => {
    for (const l of mockResponseListeners) l(r);
  });
  await waitFor(() => expect(push).toHaveBeenCalledWith('/permissions'));
  expect(push).toHaveBeenCalledTimes(1);
  expect(Notifications.clearLastNotificationResponse).toHaveBeenCalled();
});

test('a notification received in the foreground refreshes the inbox', async () => {
  const { client } = await mount();
  const spy = jest.spyOn(client, 'invalidateQueries');
  await act(async () => {
    for (const l of mockReceivedListeners) l({});
  });
  expect(spy).toHaveBeenCalledWith({ queryKey: INBOX_QUERY_KEY });
});

test('a tap during a drive waits, then opens when the drive is over', async () => {
  busy = true;
  await mount();
  await act(async () => {
    for (const l of mockResponseListeners) l(response('/inbox'));
  });
  await waitFor(async () =>
    expect(await createSettingsRepo(db).get(PENDING_HREF_KEY)).not.toBeNull()
  );
  expect(push).not.toHaveBeenCalled();

  // A tick of the drive that is still busy changes nothing.
  await act(async () => setBusy(true));
  expect(push).not.toHaveBeenCalled();

  await act(async () => setBusy(false));
  await waitFor(() => expect(push).toHaveBeenCalledWith('/inbox'));
  expect(push).toHaveBeenCalledTimes(1);
  expect(await createSettingsRepo(db).get(PENDING_HREF_KEY)).toBeNull();
});

test('a cold-start tap waits for the navigator to be ready', async () => {
  mockLastResponse = response('/trips');
  const { view, Wrapper } = await mount({ ready: false });
  await waitFor(async () =>
    expect(await createSettingsRepo(db).get(PENDING_HREF_KEY)).not.toBeNull()
  );
  expect(push).not.toHaveBeenCalled();

  await act(async () =>
    view.rerender(
      <Wrapper>
        <NotificationsHost
          isRecording={() => false}
          isBusy={() => busy}
          subscribeBusy={subscribeBusy}
          ready
        />
      </Wrapper>
    )
  );
  await waitFor(() => expect(push).toHaveBeenCalledWith('/trips'));
  expect(push).toHaveBeenCalledTimes(1);
});

test('a href held from before (the app was closed mid-drive) is replayed at mount when idle', async () => {
  await createSettingsRepo(db).set(PENDING_HREF_KEY, { href: '/permissions', at: T0 });
  await mount();
  await waitFor(() => expect(push).toHaveBeenCalledWith('/permissions'));
});

test('with nothing held, the drive host\'s ticks never touch the database (battery, §3.5)', async () => {
  await mount();
  // Let the mount's one look at the held tap finish.
  await waitFor(() => expect(busyListeners.size).toBe(1));
  await act(async () => {});
  const execute = jest.spyOn(db, 'execute');
  await act(async () => {
    for (let i = 0; i < 100; i += 1) setBusy(i % 2 === 0);
    setBusy(false);
  });
  expect(execute).not.toHaveBeenCalled();
  expect(push).not.toHaveBeenCalled();
});
