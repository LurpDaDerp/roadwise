import { QueryClient } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { AppState } from 'react-native';

import type { RuntimeState } from '@/boot/controller';
import { UNKNOWN_LIMIT } from '@/core/detectors/common';
import type { DriveState } from '@/drive/host';

// ——— the controller, scripted ———
const mockController = {
  state: { status: 'booting', runtime: null, error: null, generation: 0 } as RuntimeState,
  listeners: new Set<() => void>(),
  ensureRuntime: jest.fn(async () => undefined),
  rebuild: jest.fn(async (_opts?: { expectedUid?: string }) => undefined),
  runNow: jest.fn(async () => true),
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
    ensureRuntime: (...args: unknown[]) => mockController.ensureRuntime(...(args as [])),
    rebuild: (opts?: { expectedUid?: string }) => mockController.rebuild(opts),
    foregroundJobs: () => ({ runNow: mockController.runNow, stop: async () => {} }),
  },
}));

// ——— the navigator: the Stack's options are what is under test ———
const mockStack: { screenOptions?: unknown; screens: { name: string; options?: unknown }[] } = {
  screens: [],
};
const mockRouter = {
  replace: jest.fn(),
  push: jest.fn(),
  canDismiss: jest.fn(() => false),
  dismissAll: jest.fn(),
};
jest.mock('expo-router', () => {
  const Stack = ({ screenOptions, children }: { screenOptions?: unknown; children?: ReactNode }) => {
    mockStack.screenOptions = screenOptions;
    return children;
  };
  Stack.Screen = function Screen({ name, options }: { name: string; options?: unknown }) {
    mockStack.screens.push({ name, options });
    return null;
  };
  return {
    Stack,
    useRouter: () => mockRouter,
    usePathname: () => '/home',
    useSegments: () => ['(tabs)', 'home'],
  };
});

jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(async () => {}),
  hideAsync: jest.fn(async () => {}),
}));
jest.mock('expo-notifications', () => ({ setNotificationHandler: jest.fn() }));
jest.mock('react-native-gesture-handler', () => ({
  GestureHandlerRootView: ({ children }: { children: ReactNode }) => children,
}));
jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: jest.fn(async () => {}),
  deactivateKeepAwake: jest.fn(async () => {}),
}));
jest.mock('expo-location', () => ({ getLastKnownPositionAsync: jest.fn(async () => null) }));
jest.mock('expo-battery', () => ({ useBatteryLevel: () => 0.8 }));
jest.mock('@/ui/fonts', () => ({
  ...jest.requireActual('@/ui/fonts'),
  useAppFonts: () => ({ loaded: true, error: null }),
}));

const mockHandover: { fire: ((uid: string) => void) | null } = { fire: null };
jest.mock('@/boot/ownerWatch', () => ({
  watchDeviceOwner: (_db: unknown, deps: { onHandover: (uid: string) => void }) => {
    mockHandover.fire = deps.onHandover;
    return () => {
      mockHandover.fire = null;
    };
  },
}));
jest.mock('@/data/supabase/client', () => ({ supabase: {} }));

const mockSession: { flush: (() => Promise<unknown>) | null } = { flush: null };
jest.mock('@/data/supabase/session', () => ({
  SessionProvider: ({
    children,
    flushBeforeSignOut,
  }: {
    children: ReactNode;
    flushBeforeSignOut?: () => Promise<unknown>;
  }) => {
    mockSession.flush = flushBeforeSignOut ?? null;
    return children;
  },
  useSession: () => ({ status: 'signedIn' }),
}));
jest.mock('@/data/queries', () => ({
  ...jest.requireActual('@/data/queries'),
  DataProvider: ({ children }: { children: ReactNode }) => children,
}));

const mockRestore: { retry: (() => Promise<unknown>) | null } = { retry: null };
jest.mock('@/features/home/HomeBanners', () => ({
  RestoreRetryProvider: ({ children, retry }: { children: ReactNode; retry: () => Promise<unknown> }) => {
    mockRestore.retry = retry;
    return children;
  },
}));

const mockRouting = jest.fn();
jest.mock('@/features/drive/useSummaryNotificationRouting', () => ({
  useSummaryNotificationRouting: (opts: unknown) => mockRouting(opts),
}));

// eslint-disable-next-line import/first -- after the mocks it depends on
import RootLayout from '../_layout';

// Captured at module load, before `clearAllMocks` empties it.
const handlerCalls = (
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  (require('expo-notifications') as { setNotificationHandler: jest.Mock }).setNotificationHandler
).mock.calls.slice() as [{ handleNotification: () => Promise<Record<string, boolean>> }][];

const T = 1_790_000_000_000;

function driveState(over: Partial<DriveState> = {}): DriveState {
  return {
    status: 'armed',
    mode: 'mounted',
    role: 'driver',
    clientTripId: null,
    startedAt: null,
    lastRowTs: null,
    speedMps: 0,
    speedKnown: false,
    awaitingSpeedAfterResume: false,
    limit: UNKNOWN_LIMIT,
    distanceM: 0,
    stationarySinceTs: null,
    lockedOut: false,
    stoppedPanel: false,
    activeAlert: null,
    mutedForDrive: false,
    gps: 'good',
    thermal: 'nominal',
    callActive: false,
    screenLocked: false,
    lastFinalized: null,
    tripIndex: 5,
    dryRun: false,
    ...over,
  };
}

function fakeRuntime(drive: Partial<DriveState>) {
  const current = driveState(drive);
  const host = {
    snapshot: () => current,
    subscribe: () => () => {},
    isBusy: () => false,
    end: jest.fn(async () => {}),
    setPassenger: jest.fn(async () => {}),
    setMode: jest.fn(async () => {}),
    muteCurrentAlert: jest.fn(async () => {}),
    muteForDrive: jest.fn(async () => {}),
    detectorContext: () => ({ night: false, precipitation: false, lockReliable: true, lockLagged: false }),
  };
  const queryClient = new QueryClient();
  const flushDeletes = jest.fn(async () => ({ sent: 1, left: 0 }));
  return {
    runtime: { db: {}, queryClient, drive: host, runner: { flushDeletes } } as unknown as NonNullable<
      RuntimeState['runtime']
    >,
    host,
    flushDeletes,
    queryClient,
  };
}

beforeAll(() => {
  (AppState as { currentState: string }).currentState = 'active';
});

beforeEach(() => {
  jest.clearAllMocks();
  mockStack.screens = [];
  mockStack.screenOptions = undefined;
  mockController.listeners.clear();
  mockController.state = { status: 'booting', runtime: null, error: null, generation: 0 };
});

async function renderReady(drive: Partial<DriveState> = {}) {
  const made = fakeRuntime(drive);
  mockController.state = { status: 'ready', runtime: made.runtime, error: null, generation: 0 };
  await render(<RootLayout />);
  return made;
}

describe('the root layout', () => {
  test('joins the one launch, and waits on the splash while it boots', async () => {
    await render(<RootLayout />);
    expect(mockController.ensureRuntime).toHaveBeenCalledTimes(1);
    expect(screen.toJSON()).toBeNull();
  });

  test('pins portrait at the root and registers the drive group without swipe-back', async () => {
    await renderReady();
    expect(mockStack.screenOptions).toEqual({ headerShown: false, orientation: 'portrait' });
    expect(mockStack.screens.find((s) => s.name === 'drive')).toEqual({
      name: 'drive',
      options: { gestureEnabled: false, presentation: 'fullScreenModal' },
    });
  });

  test('renders the lockout overlay over the app when a mounted drive locks out', async () => {
    const { queryClient } = await renderReady({
      status: 'recording',
      clientTripId: 't1',
      startedAt: T,
      lastRowTs: T,
      speedKnown: true,
      speedMps: 13,
      lockedOut: true,
    });
    expect(screen.getByTestId('hud-screen')).toBeTruthy();
    expect(screen.getByTestId('lockout-underlay', { includeHiddenElements: true }).props.pointerEvents).toBe('none');
    queryClient.clear();
  });

  test('no drive, no overlay', async () => {
    await renderReady();
    expect(screen.queryByTestId('hud-screen')).toBeNull();
  });

  test('mounts the summary routing with the host, and the foreground notification handler', async () => {
    const { host } = await renderReady();
    expect(mockRouting).toHaveBeenLastCalledWith({ host, ready: true });
    // Set once, at module load: a summary firing while the app is open still shows, quietly.
    expect(handlerCalls).toHaveLength(1);
    await expect(handlerCalls[0]?.[0].handleNotification()).resolves.toEqual({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    });
  });

  test('wires sign-out to flush the deletes owed, and Home’s Retry to the restore', async () => {
    const { flushDeletes } = await renderReady();
    await expect(mockSession.flush?.()).resolves.toEqual({ sent: 1, left: 0 });
    expect(flushDeletes).toHaveBeenCalledTimes(1);
    await expect(mockRestore.retry?.()).resolves.toBe(true);
    expect(mockController.runNow).toHaveBeenCalledTimes(1);
  });

  test('a handover rebuilds through the controller, showing "switching" meanwhile', async () => {
    await renderReady();
    expect(mockHandover.fire).not.toBeNull();
    await act(async () => mockHandover.fire?.('user-b'));
    // The new driver's uid goes into the rebuild: it wipes without reading the session (H2 I-1 a).
    expect(mockController.rebuild).toHaveBeenCalledWith({ expectedUid: 'user-b' });

    await act(async () => mockController.set({ status: 'switching', runtime: null }));
    expect(screen.queryByTestId('lockout-underlay')).toBeNull();
    expect(screen.getByText('Setting this phone up for you')).toBeTruthy();
  });

  test('a failed launch offers a retry that asks the controller again', async () => {
    mockController.state = { status: 'failed', runtime: null, error: new Error('disk'), generation: 0 };
    await render(<RootLayout />);
    mockController.ensureRuntime.mockClear();
    fireEvent.press(screen.getByRole('button'));
    expect(mockController.ensureRuntime).toHaveBeenCalledTimes(1);
  });
});
