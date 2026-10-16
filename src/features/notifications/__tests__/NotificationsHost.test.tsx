// The one notification response listener, for a tap on the forgot-to-start reminder: it is never
// opened as a link, its token is claimed natively once, and only then does the injected start (the
// Start Drive button's) run, once, whichever way the tap arrives (the listener, the launch response,
// Android's native hand-over, a remount). Nothing starts on mount, for any other note, or while the
// app cannot start a drive.
import { act, render } from '@testing-library/react-native';

import { createFakeDriveSense } from '@drive-sense';

import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import type { Db } from '@/data/db/driver';
import { migrate } from '@/data/db/migrate';
import { DataProvider } from '@/data/queries/context';
import type { StartResult } from '@/drive/host';
import { clearStartNotice, readStartNotice, showStartNotice } from '@/features/home/startNotice';

import { NotificationsHost } from '../NotificationsHost';
import { REMINDER_NOTIFICATION_ID, type StartGate } from '../reminderTap';

const mockNotifications = {
  listener: null as null | ((r: unknown) => void),
  last: null as unknown,
  cleared: 0,
};

jest.mock('expo-notifications', () => ({
  DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
  addNotificationResponseReceivedListener: (fn: (r: unknown) => void) => {
    mockNotifications.listener = fn;
    return {
      remove: () => {
        // a stale tree's late cleanup must not take a newer listener away
        if (mockNotifications.listener === fn) mockNotifications.listener = null;
      },
    };
  },
  getLastNotificationResponse: () => mockNotifications.last,
  clearLastNotificationResponse: () => {
    mockNotifications.cleared += 1;
  },
  setNotificationHandler: () => {},
}));

const T = 1_760_000_000_000;
const TOKEN = 'tok-a';

const reminderResponse = (token = TOKEN, date = 1) => ({
  actionIdentifier: 'expo.modules.notifications.actions.DEFAULT',
  notification: { date, request: { identifier: REMINDER_NOTIFICATION_ID, content: { data: { kind: 'tripReminder', reminderToken: token } } } },
});

let db: Db;
beforeAll(async () => {
  db = await createSqlJsDb();
  await migrate(db);
});
beforeEach(() => {
  mockNotifications.listener = null;
  mockNotifications.last = null;
  mockNotifications.cleared = 0;
  clearStartNotice();
});

async function mount(o: { platform?: 'ios' | 'android'; gate?: StartGate; start?: StartResult } = {}) {
  let now = T;
  const native = createFakeDriveSense({ platform: o.platform ?? 'ios', now: () => now });
  await native.setTripReminder(true);
  native.postReminderForTest(TOKEN);
  const startDrive = jest.fn(async (): Promise<StartResult> => o.start ?? { ok: true, clientTripId: 'trip-1' });
  const navigate = jest.fn();
  let gate: StartGate = o.gate ?? 'yes';
  const props = () => ({
    isRecording: () => false,
    isBusy: () => false,
    subscribeBusy: () => () => {},
    startDrive,
    startGate: () => gate,
    navigate,
    reminderNative: native,
  });
  let generation = 0;
  const ui = (p: ReturnType<typeof props>) => (
    <DataProvider db={db} now={() => now}>
      <NotificationsHost key={generation} {...p} />
    </DataProvider>
  );
  const view = await render(ui(props()));
  const settle = async () => {
    for (let i = 0; i < 6; i += 1) await act(async () => Promise.resolve());
  };
  await settle();
  return {
    native,
    startDrive,
    navigate,
    view,
    settle,
    claims: () => native.calls.filter((c) => c === 'claimReminderTap').length,
    setGate: async (g: StartGate) => {
      gate = g;
      await view.rerender(ui(props()));
      await settle();
    },
    /** A new NotificationsHost in the same tree (an account switch remounts the runtime hosts). */
    remount: async () => {
      generation += 1;
      await view.rerender(ui(props()));
      await settle();
    },
    advance: (ms: number) => (now += ms),
  };
}

test('mounting alone claims nothing and starts nothing', async () => {
  const h = await mount();
  expect(h.claims()).toBe(0);
  expect(h.startDrive).not.toHaveBeenCalled();
  expect(h.navigate).not.toHaveBeenCalled();
});

test('a tap on the reminder: cleared, claimed once, started once, the drive screen — never opened as a link to Home', async () => {
  const h = await mount();
  showStartNotice('error'); // an older line about a reminder that started nothing
  await act(async () => mockNotifications.listener!(reminderResponse()));
  await h.settle();
  expect(mockNotifications.cleared).toBe(1);
  expect(h.claims()).toBe(1);
  expect(h.startDrive).toHaveBeenCalledTimes(1);
  expect(h.navigate.mock.calls).toEqual([['/drive']]);
  expect(readStartNotice()).toBeNull();
});

test('the same response from the launch and from the listener claims once and starts once', async () => {
  mockNotifications.last = reminderResponse();
  const h = await mount();
  await act(async () => mockNotifications.listener!(reminderResponse()));
  await h.settle();
  expect(h.claims()).toBe(1);
  expect(h.startDrive).toHaveBeenCalledTimes(1);
});

test('a tap during setup (or signed out, or an update required) is dropped; a remount that sees the same launch response again claims nothing', async () => {
  mockNotifications.last = reminderResponse();
  const h = await mount({ gate: 'never' });
  expect(mockNotifications.cleared).toBe(1);
  expect(h.claims()).toBe(0);
  // the mock does not really clear: the remount reads the same response again
  await h.remount();
  expect(h.claims()).toBe(0);
  expect(h.startDrive).not.toHaveBeenCalled();
  expect(h.navigate).not.toHaveBeenCalled();
  expect(readStartNotice()).toBeNull();
});

test('a tap while the app is still starting waits, and runs when it can', async () => {
  mockNotifications.last = reminderResponse();
  const h = await mount({ gate: 'wait' });
  expect(h.claims()).toBe(0);
  await h.setGate('yes');
  expect(h.claims()).toBe(1);
  expect(h.startDrive).toHaveBeenCalledTimes(1);
});

test('a tap waiting more than 2 min is expired: no claim, no start, Home says so', async () => {
  mockNotifications.last = reminderResponse();
  const h = await mount({ gate: 'wait' });
  h.advance(2 * 60_000 + 1);
  await h.setGate('yes');
  expect(h.claims()).toBe(0);
  expect(h.startDrive).not.toHaveBeenCalled();
  expect(h.navigate.mock.calls).toEqual([['/home']]);
  expect(readStartNotice()).toBe('reminder-expired');
});

test('a refused start lands on Home with the refusal, and the session stays reminded (a second tap is expired)', async () => {
  const h = await mount({ start: { ok: false, reason: 'permission' } });
  await act(async () => mockNotifications.listener!(reminderResponse()));
  await h.settle();
  expect(h.navigate.mock.calls).toEqual([['/home']]);
  expect(readStartNotice()).toBe('permission');
  await act(async () => mockNotifications.listener!(reminderResponse(TOKEN, 2)));
  await h.settle();
  expect(h.startDrive).toHaveBeenCalledTimes(1);
  expect(readStartNotice()).toBe('reminder-expired');
});

test('any other notification never starts a drive', async () => {
  const h = await mount();
  await act(async () =>
    mockNotifications.listener!({
      actionIdentifier: 'expo.modules.notifications.actions.DEFAULT',
      notification: { date: 3, request: { identifier: 'summary-1', content: { data: { url: '/drives', kind: 'tripReminder', reminderToken: TOKEN } } } },
    })
  );
  await h.settle();
  expect(h.claims()).toBe(0);
  expect(h.startDrive).not.toHaveBeenCalled();
  expect(h.navigate.mock.calls).toEqual([['/drives']]);
});

test('Android: a tap handed over natively before mount is taken and started once; the same token handed over again (a recreated activity) is never taken', async () => {
  let now = T;
  const native = createFakeDriveSense({ platform: 'android', now: () => now });
  await native.setTripReminder(true);
  native.postReminderForTest(TOKEN);
  native.tapReminderForTest(TOKEN);
  const startDrive = jest.fn(async (): Promise<StartResult> => ({ ok: true, clientTripId: 'trip-1' }));
  const navigate = jest.fn();
  await render(
    <DataProvider db={db} now={() => now}>
      <NotificationsHost
        isRecording={() => false}
        isBusy={() => false}
        subscribeBusy={() => () => {}}
        startDrive={startDrive}
        startGate={() => 'yes'}
        navigate={navigate}
        reminderNative={native}
      />
    </DataProvider>
  );
  for (let i = 0; i < 6; i += 1) await act(async () => Promise.resolve());
  expect(startDrive).toHaveBeenCalledTimes(1);
  expect(navigate.mock.calls).toEqual([['/drive']]);
  now += 1000;
  expect(native.tapReminderForTest(TOKEN)).toBe(false);
  for (let i = 0; i < 6; i += 1) await act(async () => Promise.resolve());
  expect(startDrive).toHaveBeenCalledTimes(1);
  expect(native.calls.filter((c) => c === 'claimReminderTap')).toHaveLength(1);
});
