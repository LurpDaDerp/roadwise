// The one notification response listener: a tap on the iPhone's recording note or the phone
// reminder opens the driving screen while a drive records (never held past the drive, never
// replayed, starting nothing), and any other tap opens its allowlisted route, held during a drive
// (the driving screen meanwhile while the drive records).
import { act, render } from '@testing-library/react-native';

import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import type { Db } from '@/data/db/driver';
import { migrate } from '@/data/db/migrate';
import { DataProvider } from '@/data/queries/context';

import { NotificationsHost } from '../NotificationsHost';

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

const recordingTap = (date = 1, data: Record<string, unknown> = { kind: 'driveRecording', url: '/drive' }) => ({
  actionIdentifier: 'expo.modules.notifications.actions.DEFAULT',
  notification: { date, request: { identifier: 'roadwise.driveRecording', content: { data } } },
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
  mockRouter.push.mockClear();
  mockRouter.navigate.mockClear();
});

type Drive = 'idle' | 'recording' | 'closing';

async function mount(o: { drive?: Drive; ready?: boolean } = {}) {
  const now = T;
  const navigate = jest.fn();
  let drive: Drive = o.drive ?? 'idle';
  let ready = o.ready ?? true;
  const busyListeners = new Set<() => void>();
  const subscribeBusy = (fn: () => void) => {
    busyListeners.add(fn);
    return () => {
      busyListeners.delete(fn);
    };
  };
  const props = () => ({
    isRecording: () => drive === 'recording',
    isBusy: () => drive !== 'idle',
    subscribeBusy,
    navigate,
    ready,
  });
  const ui = (p: ReturnType<typeof props>) => (
    <DataProvider db={db} now={() => now}>
      <NotificationsHost {...p} />
    </DataProvider>
  );
  const view = await render(ui(props()));
  const settle = async () => {
    for (let i = 0; i < 6; i += 1) await act(async () => Promise.resolve());
  };
  await settle();
  return {
    navigate,
    settle,
    setDrive: async (d: Drive) => {
      drive = d;
      await view.rerender(ui(props()));
      await act(async () => {
        for (const fn of [...busyListeners]) fn();
      });
      await settle();
    },
    setReady: async (r: boolean) => {
      ready = r;
      await view.rerender(ui(props()));
      await settle();
    },
  };
}

test('mounting alone opens nothing', async () => {
  const h = await mount({ drive: 'recording' });
  expect(h.navigate).not.toHaveBeenCalled();
});

test('a tap on the recording note while a drive records opens the driving screen, once, however it arrives', async () => {
  mockNotifications.last = recordingTap();
  const h = await mount({ drive: 'recording' });
  await act(async () => mockNotifications.listener!(recordingTap()));
  await h.settle();
  expect(h.navigate.mock.calls).toEqual([['/drive']]);
  expect(mockNotifications.cleared).toBeGreaterThan(0);
});

test('it is never held past the drive: nothing more opens when the drive ends', async () => {
  const h = await mount({ drive: 'recording' });
  await act(async () => mockNotifications.listener!(recordingTap(2)));
  await h.settle();
  await h.setDrive('idle');
  expect(h.navigate.mock.calls).toEqual([['/drive']]);
});

test('with no drive recording, the note opens nothing', async () => {
  const h = await mount({ drive: 'idle' });
  await act(async () => mockNotifications.listener!(recordingTap(3)));
  await h.settle();
  await h.setDrive('closing');
  await h.setDrive('idle');
  expect(h.navigate).not.toHaveBeenCalled();
});

test('a tap before the navigator is up waits for it, and opens the driving screen only if the drive still records', async () => {
  mockNotifications.last = recordingTap(4);
  const h = await mount({ drive: 'recording', ready: false });
  expect(h.navigate).not.toHaveBeenCalled();
  await h.setReady(true);
  expect(h.navigate.mock.calls).toEqual([['/drive']]);

  mockNotifications.last = recordingTap(5);
  const late = await mount({ drive: 'recording', ready: false });
  await late.setDrive('idle');
  await late.setReady(true);
  expect(late.navigate).not.toHaveBeenCalled();
});

test('the phone reminder opens the driving screen while the drive records, and nothing once it is over', async () => {
  const reminder = (date: number) => ({
    actionIdentifier: 'expo.modules.notifications.actions.DEFAULT',
    notification: { date, request: { identifier: 'phone-reminder:trip-1', content: { data: { kind: 'phoneReminder', url: '/drive' } } } },
  });
  const h = await mount({ drive: 'recording' });
  await act(async () => mockNotifications.listener!(reminder(21)));
  await h.settle();
  expect(h.navigate.mock.calls).toEqual([['/drive']]);
  await h.setDrive('idle');
  await act(async () => mockNotifications.listener!(reminder(22)));
  await h.settle();
  expect(h.navigate.mock.calls).toEqual([['/drive']]);
});

test('only the drive’s own notes open the driving screen: /drive under another kind opens Home', async () => {
  const h = await mount();
  await act(async () => mockNotifications.listener!(recordingTap(6, { kind: 'weekly_recap', url: '/drive' })));
  await h.settle();
  expect(h.navigate.mock.calls).toEqual([['/home']]);
});

test('without an injected navigate, the note routes with router.navigate (onto a driving screen already showing, never a second one)', async () => {
  await render(
    <DataProvider db={db} now={() => T}>
      <NotificationsHost isRecording={() => true} isBusy={() => true} subscribeBusy={() => () => {}} />
    </DataProvider>
  );
  await act(async () => mockNotifications.listener!(recordingTap(7)));
  for (let i = 0; i < 6; i += 1) await act(async () => Promise.resolve());
  expect(mockRouter.navigate.mock.calls).toEqual([['/drive']]);
  expect(mockRouter.push).not.toHaveBeenCalled();
});

test('on the driving screen already, the note opens nothing more', async () => {
  mockPathname = '/drive';
  try {
    const h = await mount({ drive: 'recording' });
    await act(async () => mockNotifications.listener!(recordingTap(8)));
    await h.settle();
    expect(h.navigate).not.toHaveBeenCalled();
  } finally {
    mockPathname = '/home';
  }
});

test('any other note opens its route, and never the driving screen', async () => {
  const h = await mount();
  await act(async () =>
    mockNotifications.listener!({
      actionIdentifier: 'expo.modules.notifications.actions.DEFAULT',
      notification: { date: 9, request: { identifier: 'summary-1', content: { data: { url: '/drives' } } } },
    })
  );
  await h.settle();
  expect(h.navigate.mock.calls).toEqual([['/drives']]);
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

  test('a tap held during a drive opens the driving screen meanwhile and is replayed once the drive is over, unless its summary is already on screen', async () => {
    const h = await mount({ drive: 'recording' });
    await act(async () => mockNotifications.listener!(summaryTap('/drives/trip-9?fresh=1', 13)));
    await h.settle();
    expect(h.navigate.mock.calls).toEqual([['/drive']]);
    mockPathname = '/drives/trip-9';
    await h.setDrive('idle');
    expect(h.navigate.mock.calls).toEqual([['/drive']]);
  });

  test('held while a drive records: the driving screen now, the recap once the drive is over', async () => {
    const h = await mount({ drive: 'recording' });
    await act(async () => mockNotifications.listener!(summaryTap('/drives/trip-9?fresh=1', 14)));
    await h.settle();
    expect(h.navigate.mock.calls).toEqual([['/drive']]);
    await h.setDrive('closing');
    expect(h.navigate.mock.calls).toEqual([['/drive']]);
    await h.setDrive('idle');
    expect(h.navigate.mock.calls).toEqual([['/drive'], ['/drives/trip-9?fresh=1']]);
  });

  test('held while a drive records, on the driving screen already: nothing more opens until the drive is over', async () => {
    mockPathname = '/drive';
    const h = await mount({ drive: 'recording' });
    await act(async () => mockNotifications.listener!(summaryTap('/drives/trip-9?fresh=1', 15)));
    await h.settle();
    expect(h.navigate).not.toHaveBeenCalled();
    await h.setDrive('idle');
    expect(h.navigate.mock.calls).toEqual([['/drives/trip-9?fresh=1']]);
  });

  test('held while a drive only finalizes, or before the navigator is up with no drive: no driving screen', async () => {
    const h = await mount({ drive: 'closing' });
    await act(async () => mockNotifications.listener!(summaryTap('/drives/trip-9?fresh=1', 16)));
    await h.settle();
    expect(h.navigate).not.toHaveBeenCalled();
    await h.setDrive('idle');
    expect(h.navigate.mock.calls).toEqual([['/drives/trip-9?fresh=1']]);

    mockNotifications.last = summaryTap('/drives/trip-7?fresh=1', 17);
    const cold = await mount({ ready: false });
    await cold.setReady(true);
    expect(cold.navigate.mock.calls).toEqual([['/drives/trip-7?fresh=1']]);
  });

  test('held before the navigator is up while a drive records: the driving screen once it is, the recap after the drive', async () => {
    mockNotifications.last = summaryTap('/drives/trip-6?fresh=1', 18);
    const h = await mount({ drive: 'recording', ready: false });
    expect(h.navigate).not.toHaveBeenCalled();
    await h.setReady(true);
    expect(h.navigate.mock.calls).toEqual([['/drive']]);
    await h.setDrive('idle');
    expect(h.navigate.mock.calls).toEqual([['/drive'], ['/drives/trip-6?fresh=1']]);
  });
});
