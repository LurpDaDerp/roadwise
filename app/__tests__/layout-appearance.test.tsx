/**
 * The root layout at a cold start whose stored Appearance choice is read from the phone's storage
 * after the first render (as on a phone: AsyncStorage answers a few milliseconds later). Its own
 * file, because the app's store reads once per process: here it reads a mocked AsyncStorage whose
 * answer the test holds back. Only the store's 1 s give-way timer is faked, so it never fires
 * mid-test on a slow machine.
 */
import { QueryClient } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { Appearance, AppState } from 'react-native';

import type { RuntimeState } from '@/boot/controller';
import { UNKNOWN_LIMIT } from '@/core/detectors/common';
import type { DriveState } from '@/drive/host';

// ——— the phone's storage: the Appearance read waits until the test answers it ———
const mockStorage: { answer: ((v: string | null) => void) | null; reads: string[] } = { answer: null, reads: [] };
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: (key: string) => {
      mockStorage.reads.push(key);
      if (key !== 'roadwise.appearance.v1') return Promise.resolve(null);
      return new Promise<string | null>((resolve) => (mockStorage.answer = resolve));
    },
    setItem: async () => {},
  },
}));

const mockController = {
  state: { status: 'booting', runtime: null, error: null, generation: 0 } as RuntimeState,
  ensureRuntime: jest.fn(async () => undefined),
};
jest.mock('@/boot/controller', () => ({
  runtimeController: {
    state: () => mockController.state,
    subscribe: () => () => {},
    ensureRuntime: () => mockController.ensureRuntime(),
    rebuild: async () => undefined,
    foregroundJobs: () => ({ runNow: async () => true, stop: async () => {} }),
  },
}));
jest.mock('expo-router', () => {
  const Stack = ({ children }: { children?: ReactNode }) => children;
  Stack.Screen = function Screen() {
    return null;
  };
  return {
    Stack,
    useRouter: () => ({ replace: jest.fn(), push: jest.fn(), canDismiss: () => false, dismissAll: jest.fn(), dismissTo: jest.fn() }),
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
jest.mock('expo-location', () => ({
  getForegroundPermissionsAsync: jest.fn(async () => ({ granted: true })),
  getLastKnownPositionAsync: jest.fn(async () => ({ coords: { latitude: 47.6, longitude: -122.3 } })),
}));
jest.mock('expo-battery', () => ({ useBatteryLevel: () => 0.8 }));
jest.mock('@/ui/fonts', () => ({
  ...jest.requireActual('@/ui/fonts'),
  useAppFonts: () => ({ loaded: true, error: null }),
}));
jest.mock('@/features/auth/AuthGate', () => ({
  AuthGate: ({ children }: { children: ReactNode }) => children,
}));
jest.mock('@/features/auth/version', () => ({ useUpdateStatus: () => 'ok' }));
jest.mock('@/boot/device', () => ({ readDeviceOwner: async () => null, hasDriverData: async () => false }));
jest.mock('@/boot/ownerWatch', () => ({ watchDeviceOwner: () => () => {} }));
jest.mock('@/data/supabase/client', () => ({
  supabase: { auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }) } },
}));
jest.mock('@/data/supabase/session', () => ({
  SessionProvider: ({ children }: { children: ReactNode }) => children,
  useSession: () => ({ status: 'signedIn', profile: null }),
  registerBeforeSignOut: () => () => {},
  registerAfterSignOut: () => () => {},
}));
jest.mock('@/data/queries', () => ({
  ...jest.requireActual('@/data/queries'),
  DataProvider: ({ children }: { children: ReactNode }) => children,
}));
jest.mock('@/features/notifications', () => ({ NotificationsHost: () => null }));
jest.mock('@/data/devices/DeviceHost', () => ({ DeviceHost: () => null }));

// The store's give-way timer starts when the layout module loads, so the clock is faked first and
// the layout is required after it. Everything else (promises, frames) runs for real.
jest.useFakeTimers({
  doNotFake: [
    'Date',
    'hrtime',
    'nextTick',
    'performance',
    'queueMicrotask',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'requestIdleCallback',
    'cancelIdleCallback',
    'setImmediate',
    'clearImmediate',
    'setInterval',
    'clearInterval',
  ],
});
/* eslint-disable @typescript-eslint/no-require-imports -- loaded after the fake clock above */
const RootLayout = (require('../_layout') as typeof import('../_layout')).default;
const { displayLook } = require('@/drive/displayLook') as typeof import('@/drive/displayLook');
const { appearance } = require('@/ui/appearance') as typeof import('@/ui/appearance');
const { lookFor } = require('@/ui/sky/look') as typeof import('@/ui/sky/look');
const { plainBundle } = require('@/ui/sky/palette') as typeof import('@/ui/sky/palette');
const { appSkyPorts } = require('@/ui/sky/ports') as typeof import('@/ui/sky/ports');
const SplashScreen = require('expo-splash-screen') as { hideAsync: jest.Mock };
/* eslint-enable @typescript-eslint/no-require-imports */

function readyRuntime() {
  const state: DriveState = {
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
    lastAlert: null,
    callActive: false,
    lastFinalized: null,
    alertsAvailable: true,
    dryRun: false,
    courseDeg: null,
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
  };
  const host = {
    snapshot: () => state,
    subscribe: () => () => {},
    isBusy: () => false,
    booted: () => true,
    signedIn: () => true,
    start: jest.fn(),
    end: jest.fn(),
    suspendForSignOut: jest.fn(async () => {}),
    resumeAfterSignIn: jest.fn(async () => {}),
    signedInAgain: jest.fn(async () => {}),
    signOutCompleted: jest.fn(),
    sessionEnded: jest.fn(async () => {}),
  };
  const runner = { drainOnce: jest.fn(async () => ({ done: 0 })), owed: jest.fn(async () => 0), signedIn: jest.fn(async () => {}) };
  return { db: {}, queryClient: new QueryClient(), drive: host, runner } as unknown as NonNullable<RuntimeState['runtime']>;
}

const settle = async () => {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
};

beforeAll(() => {
  (AppState as { currentState: string }).currentState = 'active';
});

test('a stored Dark read after the first render: the splash and the sky wait for it, then the app opens in Dark and the sky never reads the position or asks for weather', async () => {
  const override = jest.spyOn(Appearance, 'setColorScheme').mockImplementation(() => {});
  const position = jest.spyOn(appSkyPorts, 'position');
  const realFetch = globalThis.fetch;
  const fetch = jest.fn(async () => {
    throw new Error('no network in this test');
  });
  globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
  const runtime = readyRuntime();
  try {
    // Fonts in, the runtime up: only the Appearance read is still out.
    mockController.state = { status: 'ready', runtime, error: null, generation: 0 };
    expect(mockStorage.reads).toContain('roadwise.appearance.v1');
    expect(appearance.get()).toEqual({ choice: 'adaptive', loaded: false });

    await render(<RootLayout />);
    await settle();
    // Nothing is drawn yet: no themed tree, so no scheme forced on the phone either.
    expect(screen.toJSON()).toBeNull();
    expect(override).not.toHaveBeenCalled();
    expect(SplashScreen.hideAsync).not.toHaveBeenCalled();
    expect(position).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    // The background displays wait for the choice too.
    expect(displayLook()).toBeNull();

    await act(async () => mockStorage.answer?.('dark'));
    await settle();
    expect(appearance.get()).toEqual({ choice: 'dark', loaded: true });
    expect(SplashScreen.hideAsync).toHaveBeenCalledTimes(1);
    expect(displayLook()).toEqual(lookFor(plainBundle('dark')));
    expect(override).toHaveBeenLastCalledWith('dark');

    // The read landed in time, so the give-way to Adaptive never comes.
    await act(async () => jest.advanceTimersByTime(5_000));
    await settle();
    expect(appearance.get()).toEqual({ choice: 'dark', loaded: true });
    expect(position).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    globalThis.fetch = realFetch;
    override.mockRestore();
    position.mockRestore();
    runtime.queryClient.clear();
  }
});
