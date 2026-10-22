import { QueryClient } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { Appearance, AppState } from 'react-native';

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
  dismissTo: jest.fn(),
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

const mockHandover: { fire: ((uid: string) => void) | null; signIn: ((uid: string) => void) | null } = { fire: null, signIn: null };
const mockOwner: { uid: string | null; hasData: boolean } = { uid: null, hasData: false };
// The layout's subject is its own wiring, not the auth gate's routing (tested in its own suite).
jest.mock('@/features/auth/AuthGate', () => ({
  AuthGate: ({ children }: { children: ReactNode }) => children,
}));
// The minimum-version gate (its own suite tests it).
jest.mock('@/features/auth/version', () => ({ useUpdateStatus: () => 'ok' }));
jest.mock('@/boot/device', () => ({
  readDeviceOwner: async () => mockOwner.uid,
  hasDriverData: async () => mockOwner.hasData,
}));
jest.mock('@/boot/ownerWatch', () => ({
  watchDeviceOwner: (_db: unknown, deps: { onHandover: (uid: string) => void; onOwnerSignIn?: (uid: string) => void }) => {
    mockHandover.fire = deps.onHandover;
    mockHandover.signIn = deps.onOwnerSignIn ?? null;
    return () => {
      mockHandover.fire = null;
      mockHandover.signIn = null;
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

const mockProfile: { current: Record<string, unknown> | null } = { current: null };
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
  registerBeforeSignOut: () => () => {},
  registerAfterSignOut: () => () => {},
}));
jest.mock('@/data/queries', () => ({
  ...jest.requireActual('@/data/queries'),
  DataProvider: ({ children }: { children: ReactNode }) => children,
}));

// Task 18's hosts are stand-ins here; their wiring is `layout-wiring.test.tsx`'s subject.
jest.mock('@/features/notifications', () => ({ NotificationsHost: () => null }));
jest.mock('@/data/devices/DeviceHost', () => ({ DeviceHost: () => null }));

// eslint-disable-next-line import/first -- after the mocks it depends on
import RootLayout from '../_layout';
// eslint-disable-next-line import/first -- after the mocks
import { displayLook } from '@/drive/displayLook';
// eslint-disable-next-line import/first -- after the mocks
import { appearance } from '@/ui/appearance';
// eslint-disable-next-line import/first -- after the mocks
import { lookFor } from '@/ui/sky/look';
// eslint-disable-next-line import/first -- after the mocks
import { plainBundle } from '@/ui/sky/palette';
// eslint-disable-next-line import/first -- after the mocks
import { appSkyPorts } from '@/ui/sky/ports';

// Captured at module load, before `clearAllMocks` empties it.
const handlerCalls = (
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  (require('expo-notifications') as { setNotificationHandler: jest.Mock }).setNotificationHandler
).mock.calls.slice() as [{ handleNotification: () => Promise<Record<string, boolean>> }][];

const T = 1_790_000_000_000;

function driveState(over: Partial<DriveState> = {}): DriveState {
  return {
    status: 'idle',
    clientTripId: null,
    startedAt: null,
    lastRowTs: null,
    speedMps: 0,
    speedAccelMps2: 0,
    speedKnown: false,
    speedAt: null,
    rowSpeedMps: null,
    limit: UNKNOWN_LIMIT,
    limitMph: null,
    speedingTier: null,
    stopped: false,
    autoEndAt: null,
    distanceM: 0,
    lockedOut: false,
    drove: false,
    lastAlert: null,
    callActive: false,
    lastFinalized: null,
    alertsAvailable: true,
    dryRun: false,
    courseDeg: null,
    bearingDeg: null,
    bearingSource: null,
    speedingRatio: null,
    speedingOver: false,
    waiting: null,
    notDrivingAvailable: false,
    notDrivingSpentMs: 0,
    spotNudge: null,
    weatherAlert: null,
    weather: null,
    origin: null,
    lastShake: null,
    ...over,
  };
}

function fakeRuntime(drive: Partial<DriveState>) {
  const current = driveState(drive);
  const host = {
    snapshot: () => current,
    subscribe: () => () => {},
    isBusy: () => false,
    booted: () => true,
    signedIn: () => true,
    start: jest.fn(async () => ({ ok: false, reason: 'error' })),
    end: jest.fn(async () => null),
    suspendForSignOut: jest.fn(async () => {}),
    resumeAfterSignIn: jest.fn(async () => {}),
    signedInAgain: jest.fn(async (_opts?: { initial?: boolean }) => {}),
    signOutCompleted: jest.fn(() => {}),
    sessionEnded: jest.fn(async () => {}),
  };
  const queryClient = new QueryClient();
  // One drain sends what it can; the owed count is read after it.
  const runner = {
    drainOnce: jest.fn(async () => ({ done: 2 })),
    owed: jest.fn(async () => 1),
    signedIn: jest.fn(async () => {}),
  };
  // The sign-out drain first makes held uploads due (one UPDATE on the queue).
  const db = { execute: jest.fn(async () => ({ rows: [], changes: 0 })) };
  return {
    runtime: { db, now: () => 1_000, queryClient, drive: host, runner } as unknown as NonNullable<RuntimeState['runtime']>,
    host,
    runner,
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
  mockOwner.uid = null;
  mockOwner.hasData = false;
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

  test('a drive that locks out while another route shows brings the driving screen back', async () => {
    const { queryClient } = await renderReady({
      status: 'recording',
      clientTripId: 't1',
      startedAt: T,
      lastRowTs: T,
      speedKnown: true,
      speedMps: 13,
      lockedOut: true,
    });
    expect(mockRouter.dismissTo).toHaveBeenCalledWith('/drive');
    queryClient.clear();
  });

  test('no drive, no trip back to the driving screen', async () => {
    await renderReady();
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
  });

  test('sets no notification handler of its own: the notification host installs the only one (Task 18)', async () => {
    await renderReady();
    expect(handlerCalls).toHaveLength(0);
  });

  test('wires sign-out to one drain of the queue, reporting what is sent and what is still owed', async () => {
    const { runner } = await renderReady();
    await expect(mockSession.flush?.()).resolves.toEqual({ sent: 2, left: 1 });
    expect(runner.drainOnce).toHaveBeenCalledTimes(1);
    expect(runner.owed).toHaveBeenCalledTimes(1);
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

  test("the owner's sign-in restores their drives now, through the live runtime's foreground jobs, and sends what waited for a session", async () => {
    const { runner } = await renderReady();
    mockController.runNow.mockClear();
    expect(mockHandover.signIn).not.toBeNull();
    await act(async () => mockHandover.signIn?.('user-a'));
    expect(mockController.runNow).toHaveBeenCalledTimes(1);
    expect(runner.signedIn).toHaveBeenCalledTimes(1);
    expect(mockController.rebuild).not.toHaveBeenCalled();
  });

  test('a failed launch offers a retry that asks the controller again', async () => {
    mockController.state = { status: 'failed', runtime: null, error: new Error('disk'), generation: 0 };
    await render(<RootLayout />);
    mockController.ensureRuntime.mockClear();
    fireEvent.press(screen.getByRole('button'));
    expect(mockController.ensureRuntime).toHaveBeenCalledTimes(1);
  });

  test("Settings › Appearance: a static look stops the sky's reads, pins the look and dresses the Live Activity in it; System hands the scheme back to the phone; Adaptive wears the sky again", async () => {
    const override = jest.spyOn(Appearance, 'setColorScheme').mockImplementation(() => {});
    const position = jest.spyOn(appSkyPorts, 'position').mockResolvedValue(null);
    try {
      await act(async () => appearance.set('dark'));
      await renderReady();
      expect(position).not.toHaveBeenCalled();
      expect(displayLook()).toEqual(lookFor(plainBundle('dark')));
      expect(override).toHaveBeenLastCalledWith('dark');

      await act(async () => appearance.set('light'));
      expect(displayLook()).toEqual(lookFor(plainBundle('light')));
      expect(override).toHaveBeenLastCalledWith('light');
      expect(position).not.toHaveBeenCalled();

      await act(async () => appearance.set('system'));
      expect(override).toHaveBeenLastCalledWith('unspecified');
      expect(position).not.toHaveBeenCalled();

      await act(async () => appearance.set('adaptive'));
      expect(position).toHaveBeenCalled();
    } finally {
      await act(async () => appearance.set('adaptive'));
      override.mockRestore();
      position.mockRestore();
    }
  });

  test('the failed-launch and switching-accounts screens wear the Appearance choice too', async () => {
    const override = jest.spyOn(Appearance, 'setColorScheme').mockImplementation(() => {});
    const position = jest.spyOn(appSkyPorts, 'position').mockResolvedValue(null);
    try {
      await act(async () => appearance.set('dark'));
      mockController.state = { status: 'failed', runtime: null, error: new Error('disk'), generation: 0 };
      await render(<RootLayout />);
      expect(screen.getByRole('header')).toHaveStyle({ color: plainBundle('dark').colors.text });
      expect(override).toHaveBeenLastCalledWith('dark');

      await act(async () => appearance.set('light'));
      expect(screen.getByRole('header')).toHaveStyle({ color: plainBundle('light').colors.text });
      expect(override).toHaveBeenLastCalledWith('light');

      await act(async () => mockController.set({ status: 'switching', runtime: null, error: null }));
      expect(screen.getByText('Setting this phone up for you')).toHaveStyle({ color: plainBundle('light').colors.text });
      expect(override).toHaveBeenLastCalledWith('light');

      await act(async () => appearance.set('dark'));
      expect(screen.getByText('Setting this phone up for you')).toHaveStyle({ color: plainBundle('dark').colors.text });
      expect(override).toHaveBeenLastCalledWith('dark');

      await act(async () => appearance.set('system'));
      expect(override).toHaveBeenLastCalledWith('unspecified');
      expect(position).not.toHaveBeenCalled();
    } finally {
      await act(async () => appearance.set('adaptive'));
      override.mockRestore();
      position.mockRestore();
    }
  });
});

describe('sign-out and sign-in reach the drive host (final review I3; final-fix security I-1)', () => {
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  test('sign-out stops recording through the host (an open drive is finalized first); backing out resumes', async () => {
    const { host } = await renderReady();
    await mockSession.recording?.stop();
    expect(host.suspendForSignOut).toHaveBeenCalledTimes(1);
    expect(host.resumeAfterSignIn).not.toHaveBeenCalled();
    await mockSession.recording?.resume();
    expect(host.resumeAfterSignIn).toHaveBeenCalledTimes(1);
  });

  test('SIGNED_IN by the device owner lets Start Drive work again; a token refresh never does', async () => {
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
    expect(host.signedInAgain).toHaveBeenCalledTimes(1);
    expect(host.signedInAgain).toHaveBeenCalledWith({ initial: false });
    // Nothing here starts a drive: it begins only from the Start Drive tap (plan section 1, decision 4).
    expect(host.resumeAfterSignIn).not.toHaveBeenCalled();
    expect(host.sessionEnded).not.toHaveBeenCalled();
  });

  test("a slow keychain: the owner's INITIAL_SESSION counts, marked initial so the host refuses it around a sign-out", async () => {
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

  test("a different driver's SIGNED_IN never reaches the old host (a handover rebuilds instead)", async () => {
    mockOwner.uid = 'u1';
    const { host } = await renderReady();
    await act(async () => {
      mockAuth.listener?.('SIGNED_IN', { user: { id: 'u2' } });
      await settle();
    });
    expect(host.signedInAgain).not.toHaveBeenCalled();
    expect(host.resumeAfterSignIn).not.toHaveBeenCalled();
  });

  test('SIGNED_OUT (the driver\'s, or a revoked or expired session) ends the session through the host', async () => {
    const { host } = await renderReady();
    await act(async () => {
      mockAuth.listener?.('SIGNED_OUT', null);
      await settle();
    });
    expect(host.sessionEnded).toHaveBeenCalledTimes(1);
    expect(host.signedInAgain).not.toHaveBeenCalled();
  });

  test('no owner recorded: a SIGNED_IN counts only on a device with no drive data (r2-M1)', async () => {
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
