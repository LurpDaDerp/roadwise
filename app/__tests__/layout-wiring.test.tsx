/**
 * Task 18: what the root layout mounts around M3's drive wiring — the notification host (the app's
 * one response listener), the device host, the post-drive permission offers, the push-token release
 * before sign-out, and the two M4 routes. The notification host is the real one, over a scripted
 * expo-notifications; the device and prompt hosts are stand-ins that record their props (each is
 * tested in its own suite). A real SQLite (sql.js) stands behind the runtime's db.
 */
import { QueryClient } from '@tanstack/react-query';
import { act, render, renderHook, screen, within } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { AppState } from 'react-native';

import type { RuntimeState } from '@/boot/controller';
import { createSettingsRepo, type Db } from '@/data/db';
import { PUSH_REGISTRATION_KEY } from '@/data/devices/pushToken';
import { registerDriveStateSource, useDriveStateReported } from '@/data/devices/driveStateStore';
import { createTestDb } from '@/data/queries/__fixtures__/harness';
import type { DriveState } from '@/drive/host';

// ——— the controller, scripted ———
const mockController = {
  state: { status: 'booting', runtime: null, error: null, generation: 0 } as RuntimeState,
  listeners: new Set<() => void>(),
  set(next: Partial<RuntimeState>) {
    mockController.state = { ...mockController.state, ...next };
    for (const fn of [...mockController.listeners]) fn();
  },
};
jest.mock('@/boot/controller', () => ({
  runtimeController: {
    state: () => mockController.state,
    subscribe: (fn: () => void) => {
      mockController.listeners.add(fn);
      return () => mockController.listeners.delete(fn);
    },
    ensureRuntime: jest.fn(async () => undefined),
    rebuild: jest.fn(async () => undefined),
    foregroundJobs: () => null,
  },
}));

// ——— the navigator ———
const mockStack: { screens: string[] } = { screens: [] };
jest.mock('expo-router', () => {
  const Stack = ({ children }: { children?: ReactNode }) => children;
  Stack.Screen = function Screen({ name }: { name: string }) {
    mockStack.screens.push(name);
    return null;
  };
  return {
    Stack,
    router: { push: jest.fn() },
    useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
    useSegments: () => ['(tabs)', 'home'],
    usePathname: () => '/home',
  };
});

// ——— expo-notifications: every listener counted ———
const mockNotifications = {
  responseListeners: new Set<(r: unknown) => void>(),
  receivedListeners: new Set<(r: unknown) => void>(),
};
jest.mock('expo-notifications', () => ({
  DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
  AndroidImportance: { DEFAULT: 3 },
  setNotificationChannelAsync: jest.fn(async () => null),
  setNotificationCategoryAsync: jest.fn(async () => null),
  setNotificationHandler: jest.fn(),
  dismissNotificationAsync: jest.fn(async () => {}),
  getLastNotificationResponse: jest.fn(() => null),
  clearLastNotificationResponse: jest.fn(),
  addNotificationResponseReceivedListener: jest.fn((l: (r: unknown) => void) => {
    mockNotifications.responseListeners.add(l);
    return { remove: () => mockNotifications.responseListeners.delete(l) };
  }),
  addNotificationReceivedListener: jest.fn((l: (r: unknown) => void) => {
    mockNotifications.receivedListeners.add(l);
    return { remove: () => mockNotifications.receivedListeners.delete(l) };
  }),
}));

jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(async () => {}),
  hideAsync: jest.fn(async () => {}),
}));
jest.mock('react-native-gesture-handler', () => ({
  GestureHandlerRootView: ({ children }: { children: ReactNode }) => children,
}));
jest.mock('@/ui/fonts', () => ({
  ...jest.requireActual('@/ui/fonts'),
  useAppFonts: () => ({ loaded: true, error: null }),
}));

// ——— M3's wiring, out of the way (its own suite is layout.test.tsx) ———
jest.mock('@/features/auth/AuthGate', () => ({
  AuthGate: ({ children }: { children: ReactNode }) => children,
}));
jest.mock('@/features/drive/LockoutGate', () => ({
  LockoutGate: ({ children }: { children: ReactNode }) => children,
}));
jest.mock('@/features/home/HomeBanners', () => ({
  RestoreRetryProvider: ({ children }: { children: ReactNode }) => children,
}));
jest.mock('@/boot/device', () => ({
  readDeviceOwner: async () => null,
  hasDriverData: async () => false,
}));
jest.mock('@/boot/ownerWatch', () => ({ watchDeviceOwner: () => () => {} }));

// The drive provider marks the part of the tree that sits inside it.
jest.mock('@/drive/DriveProvider', () => {
  const { View: RNView } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    DriveProvider: ({ children }: { children: ReactNode }) => (
      <RNView testID="drive-provider">{children}</RNView>
    ),
  };
});

// ——— the app client: the session the push-token release checks, and the RPC it sends ———
const mockSupabase = { sessionUid: 'u1' as string | null, rpc: jest.fn() };
jest.mock('@/data/supabase/client', () => ({
  supabase: {
    auth: {
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      getSession: async () => ({
        data: {
          session: mockSupabase.sessionUid === null ? null : { user: { id: mockSupabase.sessionUid } },
        },
      }),
    },
    rpc: (name: string, args: unknown) => {
      mockSupabase.rpc(name, args);
      return { abortSignal: async () => ({ data: null, error: null }) };
    },
  },
}));

// ——— the session: a small store, so a handover re-renders; before-sign-out tasks recorded ———
const mockSessionStore = {
  uid: 'u1' as string | null,
  listeners: new Set<() => void>(),
  set(uid: string | null) {
    mockSessionStore.uid = uid;
    for (const l of [...mockSessionStore.listeners]) l();
  },
  tasks: new Set<() => unknown>(),
};
jest.mock('@/data/supabase/session', () => {
  const { useSyncExternalStore: useStore } = jest.requireActual<typeof import('react')>('react');
  const subscribe = (l: () => void) => {
    mockSessionStore.listeners.add(l);
    return () => mockSessionStore.listeners.delete(l);
  };
  return {
    SessionProvider: ({ children }: { children: ReactNode }) => children,
    useSession: () => {
      const uid = useStore(subscribe, () => mockSessionStore.uid);
      return {
        status: uid === null ? 'signedOut' : 'signedIn',
        session: uid === null ? null : { user: { id: uid } },
        profile: null,
      };
    },
    registerBeforeSignOut: (task: () => unknown) => {
      mockSessionStore.tasks.add(task);
      return () => {
        mockSessionStore.tasks.delete(task);
      };
    },
  };
});

// ——— the device and prompt hosts record what they were given ———
const mockHosts = {
  device: [] as Record<string, unknown>[],
  prompts: [] as Record<string, unknown>[],
  promptMounts: 0,
  promptUnmounts: 0,
};
jest.mock('@/data/devices/DeviceHost', () => {
  const { View: RNView } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    DeviceHost: (props: Record<string, unknown>) => {
      mockHosts.device.push(props);
      return <RNView testID="device-host" />;
    },
  };
});
jest.mock('@/features/permissions/PermissionPromptsHost', () => {
  const { View: RNView } = jest.requireActual<typeof import('react-native')>('react-native');
  const { useEffect: useMountEffect } = jest.requireActual<typeof import('react')>('react');
  return {
    PermissionPromptsHost: (props: Record<string, unknown>) => {
      mockHosts.prompts.push(props);
      useMountEffect(() => {
        mockHosts.promptMounts += 1;
        return () => {
          mockHosts.promptUnmounts += 1;
        };
      }, []);
      return <RNView testID="permission-prompts-host" />;
    },
  };
});
const mockSync = jest.fn(async (_userId: string, _deps: { db: unknown }) => 'unchanged' as const);
jest.mock('@/features/settings/notifications/sync', () => ({
  syncNotificationPrefs: (userId: string, deps: { db: unknown }) => mockSync(userId, deps),
}));

// eslint-disable-next-line import/first -- after the mocks it depends on
import * as Notifications from 'expo-notifications';
// eslint-disable-next-line import/first -- after the mocks it depends on
import RootLayout from '../_layout';

// Captured at module load, before `clearAllMocks` empties it: the layout sets no handler of its own.
const handlerCallsAtLoad = (Notifications.setNotificationHandler as jest.Mock).mock.calls.length;

function driveState(status: DriveState['status']): DriveState {
  return { status } as DriveState;
}

function fakeHost(initial: DriveState['status'] = 'armed') {
  let current = driveState(initial);
  const listeners = new Set<(s: DriveState) => void>();
  const busyStatuses = new Set(['candidate', 'recording', 'ending', 'finalizing']);
  return {
    snapshot: () => current,
    isBusy: () => busyStatuses.has(current.status),
    subscribe: jest.fn((fn: (s: DriveState) => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    }),
    setAgeBand: jest.fn(async () => {}),
    listenerCount: () => listeners.size,
    publish(status: DriveState['status']) {
      current = driveState(status);
      for (const l of [...listeners]) l(current);
    },
  };
}

async function fakeRuntime(status: DriveState['status'] = 'armed') {
  const db = await createTestDb();
  const host = fakeHost(status);
  const runtime = {
    db,
    queryClient: new QueryClient(),
    drive: host,
    driveStateSettled: jest.fn(async () => {}),
    driveStateAbandon: jest.fn(async () => {}),
  } as unknown as NonNullable<RuntimeState['runtime']>;
  return { runtime, host, db };
}

async function renderWith(runtime: NonNullable<RuntimeState['runtime']>) {
  mockController.state = { status: 'ready', runtime, error: null, generation: 0 };
  await render(<RootLayout />);
}

beforeAll(() => {
  (AppState as { currentState: string }).currentState = 'active';
});

beforeEach(() => {
  jest.clearAllMocks();
  mockStack.screens = [];
  mockController.listeners.clear();
  mockController.state = { status: 'booting', runtime: null, error: null, generation: 0 };
  mockNotifications.responseListeners.clear();
  mockNotifications.receivedListeners.clear();
  mockSessionStore.uid = 'u1';
  mockSessionStore.tasks.clear();
  mockSupabase.sessionUid = 'u1';
  mockHosts.device = [];
  mockHosts.prompts = [];
  mockHosts.promptMounts = 0;
  mockHosts.promptUnmounts = 0;
});

describe('the hosts mount inside the drive provider, only when a runtime exists', () => {
  test.each([
    ['booting', { status: 'booting', runtime: null, error: null }],
    ['failed', { status: 'failed', runtime: null, error: new Error('disk') }],
    ['switching', { status: 'switching', runtime: null, error: null }],
  ] as const)('%s: nothing mounts, no listener, no pre-sign-out task', async (_label, state) => {
    mockController.state = { ...state, generation: 0 } as RuntimeState;
    await render(<RootLayout />);
    expect(screen.queryByTestId('device-host')).toBeNull();
    expect(screen.queryByTestId('permission-prompts-host')).toBeNull();
    expect(Notifications.addNotificationResponseReceivedListener).not.toHaveBeenCalled();
    expect(mockSessionStore.tasks.size).toBe(0);
  });

  test('with a runtime: all three are inside the drive provider', async () => {
    const { runtime } = await fakeRuntime();
    await renderWith(runtime);
    const provider = screen.getByTestId('drive-provider');
    expect(within(provider).getByTestId('device-host')).toBeTruthy();
    expect(within(provider).getByTestId('permission-prompts-host')).toBeTruthy();
    expect(mockNotifications.responseListeners.size).toBe(1);
  });

  test('the (onboarding) and update-required routes are on the root stack', async () => {
    const { runtime } = await fakeRuntime();
    await renderWith(runtime);
    expect(mockStack.screens).toEqual(
      expect.arrayContaining(['index', '(auth)', '(onboarding)', 'update-required', '(tabs)', 'drive'])
    );
  });
});

describe('one notification response listener (rev1: C1)', () => {
  test("exactly one in the tree: M3's routing hook is gone and the layout sets no handler", async () => {
    const { runtime } = await fakeRuntime();
    await renderWith(runtime);
    expect(Notifications.addNotificationResponseReceivedListener).toHaveBeenCalledTimes(1);
    expect(mockNotifications.responseListeners.size).toBe(1);
    expect(mockNotifications.receivedListeners.size).toBe(1);
    // The one foreground handler is the host's, installed at its mount; none at module load.
    expect(handlerCallsAtLoad).toBe(0);
    expect(Notifications.setNotificationHandler).toHaveBeenCalledTimes(1);
    expect(() => jest.requireActual('@/features/drive/useSummaryNotificationRouting')).toThrow();
  });

  test('foreground banners are hidden for the whole of a drive, not only while recording', async () => {
    const { runtime, host } = await fakeRuntime();
    await renderWith(runtime);
    const handler = (Notifications.setNotificationHandler as jest.Mock).mock.calls[0][0] as {
      handleNotification: () => Promise<{ shouldShowBanner: boolean; shouldShowList: boolean }>;
    };
    expect((await handler.handleNotification()).shouldShowBanner).toBe(true);
    for (const status of ['candidate', 'recording', 'ending', 'finalizing'] as const) {
      await act(async () => host.publish(status));
      expect(await handler.handleNotification()).toMatchObject({
        shouldShowBanner: false,
        shouldShowList: false,
      });
    }
    await act(async () => host.publish('armed'));
    expect((await handler.handleNotification()).shouldShowBanner).toBe(true);
  });

  test("the host's busy subscription rides the drive host's own, and goes with the tree", async () => {
    const { runtime, host } = await fakeRuntime();
    await renderWith(runtime);
    expect(host.subscribe).toHaveBeenCalled();
    const before = host.listenerCount();
    expect(before).toBeGreaterThan(0);
    await act(async () => mockController.set({ status: 'switching', runtime: null }));
    expect(host.listenerCount()).toBe(0);
    expect(mockNotifications.responseListeners.size).toBe(0);
  });
});

describe('the device host (T10 r2: no subscribeDrive)', () => {
  test('is given only onForeground, which syncs the notification prefs for that account on this db', async () => {
    const { runtime, db } = await fakeRuntime();
    await renderWith(runtime);
    const props = mockHosts.device.at(-1) ?? {};
    expect(props).not.toHaveProperty('subscribeDrive');
    expect(Object.keys(props)).toEqual(['onForeground']);
    await (props.onForeground as (uid: string) => Promise<unknown>)('u1');
    expect(mockSync).toHaveBeenCalledWith('u1', expect.objectContaining({ db }));
  });
});

describe('the post-drive permission offers (T9)', () => {
  test("read the drive host's busy signal", async () => {
    const { runtime, host } = await fakeRuntime('recording');
    await renderWith(runtime);
    const isBusy = mockHosts.prompts.at(-1)?.isBusy as () => boolean;
    expect(isBusy()).toBe(true);
    await act(async () => host.publish('armed'));
    expect(isBusy()).toBe(false);
  });

  test('remount on a handover, so one owner\'s "finished" never holds back the next owner\'s offers', async () => {
    const { runtime } = await fakeRuntime();
    await renderWith(runtime);
    expect(mockHosts.promptMounts).toBe(1);
    await act(async () => mockSessionStore.set('u2'));
    expect(mockHosts.promptUnmounts).toBe(1);
    expect(mockHosts.promptMounts).toBe(2);
  });
});

describe('the push token is released before sign-out (T10, T17)', () => {
  const REGISTRATION = {
    token: 'ExponentPushToken[abcdefgh1234]',
    userId: 'u1',
    deviceId: 'install-1',
    at: 1,
  };

  async function seed(db: Db) {
    await createSettingsRepo(db).set(PUSH_REGISTRATION_KEY, REGISTRATION);
  }

  test('one task per runtime: re-renders add none, the switch removes it, the next runtime adds its own', async () => {
    const first = await fakeRuntime();
    await renderWith(first.runtime);
    expect(mockSessionStore.tasks.size).toBe(1);
    const task = [...mockSessionStore.tasks][0];

    await act(async () => mockSessionStore.set('u1'));
    await act(async () => mockController.set({ status: 'ready' }));
    expect([...mockSessionStore.tasks]).toEqual([task]);

    await act(async () => mockController.set({ status: 'switching', runtime: null }));
    expect(mockSessionStore.tasks.size).toBe(0);

    const second = await fakeRuntime();
    await act(async () => mockController.set({ status: 'ready', runtime: second.runtime }));
    expect(mockSessionStore.tasks.size).toBe(1);
    expect([...mockSessionStore.tasks][0]).not.toBe(task);
  });

  test("runs under the uid the token was registered for: the token is released on the server", async () => {
    const { runtime, db } = await fakeRuntime();
    await seed(db);
    await renderWith(runtime);
    await [...mockSessionStore.tasks][0]?.();
    expect(mockSupabase.rpc).toHaveBeenCalledWith('unregister_push_token', {
      p_token: REGISTRATION.token,
    });
    expect(await createSettingsRepo(db).get(PUSH_REGISTRATION_KEY)).toBeNull();
  });

  test("under another account's session nothing is sent: never under the next driver's JWT", async () => {
    const { runtime, db } = await fakeRuntime();
    await seed(db);
    await renderWith(runtime);
    mockSupabase.sessionUid = 'u2';
    await [...mockSessionStore.tasks][0]?.();
    expect(mockSupabase.rpc).not.toHaveBeenCalled();
  });
});

describe("A8's claim reads the runtime's reporter (controller ruling on T10 r2)", () => {
  test('the layout registers no drive-state source itself; the runtime\'s registration makes it true', async () => {
    const { runtime } = await fakeRuntime();
    await renderWith(runtime);
    const probe = renderHook(() => useDriveStateReported());
    expect((await probe).result.current).toBe(false);
    let release: () => void = () => {};
    await act(async () => {
      release = registerDriveStateSource(); // what bootstrap does for a signed-in launch
    });
    expect((await probe).result.current).toBe(true);
    await act(async () => release());
  });
});
