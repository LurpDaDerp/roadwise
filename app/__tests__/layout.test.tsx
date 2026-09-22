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
const mockOwner: { uid: string | null; hasData: boolean } = { uid: null, hasData: false };
// The layout's subject is its own wiring, not the auth gate's routing (tested in its own suite).
jest.mock('@/features/auth/AuthGate', () => ({
  AuthGate: ({ children }: { children: ReactNode }) => children,
}));
jest.mock('@/boot/device', () => ({
  readDeviceOwner: async () => mockOwner.uid,
  hasDriverData: async () => mockOwner.hasData,
}));
jest.mock('@/boot/ownerWatch', () => ({
  watchDeviceOwner: (_db: unknown, deps: { onHandover: (uid: string) => void }) => {
    mockHandover.fire = deps.onHandover;
    return () => {
      mockHandover.fire = null;
    };
  },
}));
const mockAuth: { listener: ((event: string, session: unknown) => void) | null } = { listener: null };
jest.mock('@/data/supabase/client', () => ({
  supabase: {
    auth: {
      onAuthStateChange: (fn: (event: string, session: unknown) => void) => {
        mockAuth.listener = fn;
        return { data: { subscription: { unsubscribe: () => (mockAuth.listener = null) } } };
      },
    },
  },
}));

const mockProfile: { current: { age_band: string } | null } = { current: null };
const mockSession: {
  flush: (() => Promise<unknown>) | null;
  recording: { stop(): Promise<void>; resume(): Promise<void> } | null;
} = { flush: null, recording: null };
jest.mock('@/data/supabase/session', () => ({
  SessionProvider: ({
    children,
    flushBeforeSignOut,
    recording,
  }: {
    children: ReactNode;
    flushBeforeSignOut?: () => Promise<unknown>;
    recording?: { stop(): Promise<void>; resume(): Promise<void> };
  }) => {
    mockSession.flush = flushBeforeSignOut ?? null;
    mockSession.recording = recording ?? null;
    return children;
  },
  useSession: () => ({ status: 'signedIn', profile: mockProfile.current }),
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
    suspendForSignOut: jest.fn(async () => {}),
    resumeAfterSignIn: jest.fn(async () => {}),
    signedInAgain: jest.fn(async () => {}),
    setAgeBand: jest.fn(async () => {}),
    signOutCompleted: jest.fn(() => {}),
    sessionEnded: jest.fn(async () => {}),
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

describe('sign-out and sign-in reach the drive host (final review I3; final-fix security I-1)', () => {
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  test('sign-out stops recording through the host; backing out resumes it explicitly', async () => {
    const { host } = await renderReady();
    await mockSession.recording?.stop();
    expect(host.suspendForSignOut).toHaveBeenCalledTimes(1);
    await mockSession.recording?.resume();
    expect(host.resumeAfterSignIn).toHaveBeenCalledTimes(1);
  });

  test('SIGNED_IN by the device owner re-arms; a token refresh never does', async () => {
    mockOwner.uid = 'u1';
    const { host } = await renderReady();
    await act(async () => {
      mockAuth.listener?.('TOKEN_REFRESHED', { user: { id: 'u1' } });
      mockAuth.listener?.('USER_UPDATED', { user: { id: 'u1' } });
      await settle();
    });
    expect(host.signedInAgain).not.toHaveBeenCalled();
    expect(host.resumeAfterSignIn).not.toHaveBeenCalled();

    await act(async () => {
      mockAuth.listener?.('SIGNED_IN', { user: { id: 'u1' } });
      await settle();
    });
    expect(host.signedInAgain).toHaveBeenCalledWith();
  });

  test("a slow keychain: the owner's INITIAL_SESSION re-arms, marked initial so the host refuses it around a sign-out", async () => {
    mockOwner.uid = 'u1';
    const { host } = await renderReady();
    await act(async () => {
      mockAuth.listener?.('INITIAL_SESSION', { user: { id: 'u2' } });
      mockAuth.listener?.('INITIAL_SESSION', null);
      await settle();
    });
    expect(host.signedInAgain).not.toHaveBeenCalled();
    await act(async () => {
      mockAuth.listener?.('INITIAL_SESSION', { user: { id: 'u1' } });
      await settle();
    });
    expect(host.signedInAgain).toHaveBeenCalledWith({ initial: true });
  });

  test("a different driver's SIGNED_IN never re-arms the old host (a handover rebuilds instead)", async () => {
    mockOwner.uid = 'u1';
    const { host } = await renderReady();
    await act(async () => {
      mockAuth.listener?.('SIGNED_IN', { user: { id: 'u2' } });
      await settle();
    });
    expect(host.signedInAgain).not.toHaveBeenCalled();
    expect(host.resumeAfterSignIn).not.toHaveBeenCalled();
  });

  test('SIGNED_OUT (the driver\'s, or a revoked or expired session) ends recording through the host (r2-M2)', async () => {
    const { host } = await renderReady();
    await act(async () => mockAuth.listener?.('SIGNED_OUT', null));
    expect(host.sessionEnded).toHaveBeenCalledTimes(1);
  });

  test('no owner recorded: a SIGNED_IN arms only on a device with no drive data (r2-M1)', async () => {
    mockOwner.uid = null;
    mockOwner.hasData = true;
    const { host } = await renderReady();
    await act(async () => {
      mockAuth.listener?.('SIGNED_IN', { user: { id: 'u1' } });
      await settle();
    });
    // A pre-owner device holding somebody's drives: the handover decides, not this listener.
    expect(host.signedInAgain).not.toHaveBeenCalled();

    mockOwner.hasData = false;
    await act(async () => {
      mockAuth.listener?.('SIGNED_IN', { user: { id: 'u1' } });
      await settle();
    });
    expect(host.signedInAgain).toHaveBeenCalledTimes(1);
  });
});

describe("the account's age band reaches the host (ruling T12 (1))", () => {
  afterEach(() => {
    mockProfile.current = null;
  });

  test('the signed-in profile band is handed to the host, and a change follows', async () => {
    mockProfile.current = { age_band: '13_17' };
    const { host } = await renderReady();
    expect(host.setAgeBand).toHaveBeenLastCalledWith('13_17');
  });

  test('no profile yet: nothing is handed over (the cached band the launch read stands)', async () => {
    const { host } = await renderReady();
    expect(host.setAgeBand).not.toHaveBeenCalled();
  });
});
