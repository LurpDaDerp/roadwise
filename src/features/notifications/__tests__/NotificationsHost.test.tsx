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

const mockRouter = { push: jest.fn(), navigate: jest.fn(), dismissTo: jest.fn(), canDismiss: jest.fn(() => false) };
// read lazily: the factory runs at import time, before this file's consts are set
let mockPathname = '/home';
jest.mock('expo-router', () => ({
  usePathname: () => mockPathname,
  get router() {
    return mockRouter;
  },
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
  const busyListeners = new Set<() => void>();
  const subscribeBusy = (fn: () => void) => {
    busyListeners.add(fn);
    return () => {
      busyListeners.delete(fn);
    };
  };
  const props = () => ({
    isRecording: () => gate === 'driving',
    isBusy: () => gate === 'driving' || gate === 'closing',
    subscribeBusy,
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
    /** The drive host published a state (every change during a drive). */
    fireBusy: async () => {
      await act(async () => {
        for (const fn of [...busyListeners]) fn();
      });
      await settle();
    },
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

test('a tap while a drive records opens the drive screen and is spent: no claim, no start, no notice, nothing more when the drive ends after 2 min', async () => {
  const h = await mount({ gate: 'driving' });
  await act(async () => mockNotifications.listener!(reminderResponse()));
  await h.settle();
  expect(h.navigate.mock.calls).toEqual([['/drive']]);
  // the drive publishes its state all along, then closes and ends
  h.advance(2 * 60_000 + 1);
  await h.fireBusy();
  await h.setGate('closing');
  await h.fireBusy();
  await h.setGate('yes');
  await h.fireBusy();
  expect(h.claims()).toBe(0);
  expect(h.startDrive).not.toHaveBeenCalled();
  expect(h.navigate.mock.calls).toEqual([['/drive']]);
  expect(readStartNotice()).toBeNull();
});

test('a tap held while the app is still starting, which then finds a drive under way: the drive screen, never Home or "expired"', async () => {
  mockNotifications.last = reminderResponse();
  const h = await mount({ gate: 'wait' });
  h.advance(2 * 60_000 + 1);
  await h.setGate('driving');
  await h.fireBusy();
  await h.setGate('yes');
  await h.fireBusy();
  expect(h.claims()).toBe(0);
  expect(h.startDrive).not.toHaveBeenCalled();
  expect(h.navigate.mock.calls).toEqual([['/drive']]);
  expect(readStartNotice()).toBeNull();
});

test('a tap while a drive closes does nothing, then or after the drive ends', async () => {
  const h = await mount({ gate: 'closing' });
  await act(async () => mockNotifications.listener!(reminderResponse()));
  await h.settle();
  await h.setGate('yes');
  await h.fireBusy();
  expect(h.claims()).toBe(0);
  expect(h.startDrive).not.toHaveBeenCalled();
  expect(h.navigate).not.toHaveBeenCalled();
  expect(readStartNotice()).toBeNull();
});

test('without an injected navigate, a reminder tap routes with router.navigate (onto a drive screen already showing, never a second one)', async () => {
  mockRouter.push.mockClear();
  mockRouter.navigate.mockClear();
  const native = createFakeDriveSense({ platform: 'ios', now: () => T });
  await native.setTripReminder(true);
  native.postReminderForTest(TOKEN);
  await render(
    <DataProvider db={db} now={() => T}>
      <NotificationsHost
        isRecording={() => true}
        isBusy={() => true}
        subscribeBusy={() => () => {}}
        startDrive={jest.fn()}
        startGate={() => 'driving'}
        reminderNative={native}
      />
    </DataProvider>
  );
  await act(async () => mockNotifications.listener!(reminderResponse()));
  for (let i = 0; i < 6; i += 1) await act(async () => Promise.resolve());
  expect(mockRouter.navigate.mock.calls).toEqual([['/drive']]);
  expect(mockRouter.push).not.toHaveBeenCalled();
});

describe('without an injected navigate, a reminder tap that lands on Home returns to the Home already open', () => {
  async function refusedTap() {
    const native = createFakeDriveSense({ platform: 'ios', now: () => T });
    await native.setTripReminder(true);
    native.postReminderForTest(TOKEN);
    await render(
      <DataProvider db={db} now={() => T}>
        <NotificationsHost
          isRecording={() => false}
          isBusy={() => false}
          subscribeBusy={() => () => {}}
          startDrive={jest.fn(async () => ({ ok: false as const, reason: 'permission' as const }))}
          startGate={() => 'yes'}
          reminderNative={native}
        />
      </DataProvider>
    );
    await act(async () => mockNotifications.listener!(reminderResponse()));
    for (let i = 0; i < 6; i += 1) await act(async () => Promise.resolve());
  }

  beforeEach(() => {
    mockRouter.push.mockClear();
    mockRouter.navigate.mockClear();
    mockRouter.dismissTo.mockClear();
    mockRouter.canDismiss.mockReset();
  });

  test('a screen above the tabs: dismissTo Home (pops back to them), never a second Home', async () => {
    mockRouter.canDismiss.mockReturnValue(true);
    await refusedTap();
    expect(mockRouter.dismissTo.mock.calls).toEqual([['/home']]);
    expect(mockRouter.navigate).not.toHaveBeenCalled();
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  test('only the tabs open: a plain navigate (a tab switch; popping is not a tabs action)', async () => {
    mockRouter.canDismiss.mockReturnValue(false);
    await refusedTap();
    expect(mockRouter.navigate.mock.calls).toEqual([['/home']]);
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
    expect(mockRouter.push).not.toHaveBeenCalled();
  });
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

describe('a tap on the "Drive ended" note', () => {
  const summaryTap = (url: string, date: number) => ({
    actionIdentifier: 'expo.modules.notifications.actions.DEFAULT',
    notification: { date, request: { identifier: `drive-summary:${date}`, content: { data: { kind: 'driveSummary', url } } } },
  });
  afterEach(() => {
    mockPathname = '/home';
  });

  test('with that drive’s summary already on screen (the driving screen opened it as the drive ended), opens nothing more', async () => {
    mockPathname = '/drives/trip-9';
    const h = await mount();
    await act(async () => mockNotifications.listener!(summaryTap('/drives/trip-9?fresh=1', 11)));
    await h.settle();
    expect(h.navigate).not.toHaveBeenCalled();
  });

  test('anywhere else, or on another drive’s summary, opens it', async () => {
    mockPathname = '/drives/trip-8';
    const h = await mount();
    await act(async () => mockNotifications.listener!(summaryTap('/drives/trip-9?fresh=1', 12)));
    await h.settle();
    expect(h.navigate.mock.calls).toEqual([['/drives/trip-9?fresh=1']]);
  });

  test('a tap held during a drive is replayed once the drive is over, unless its summary is already on screen', async () => {
    const h = await mount({ gate: 'driving' });
    await act(async () => mockNotifications.listener!(summaryTap('/drives/trip-9?fresh=1', 13)));
    await h.settle();
    expect(h.navigate).not.toHaveBeenCalled();
    mockPathname = '/drives/trip-9';
    await h.setGate('yes');
    await h.fireBusy();
    expect(h.navigate).not.toHaveBeenCalled();
  });
});
