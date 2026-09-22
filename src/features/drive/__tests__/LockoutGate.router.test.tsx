/**
 * The lockout gate under the real expo-router (ruling U2 concern 2). `LockoutGate.test.tsx` models
 * the stack; this suite runs the gate around a real root `Stack` with the drive group presented as
 * a full-screen modal over the app, as `app/_layout.tsx` does, so review N-I1's hazard — a
 * `dismissAll()` from a drive route removes the drive modal, HUD and all — is judged by the
 * navigator itself rather than by a model of it.
 */
import { act, renderRouter, screen } from 'expo-router/testing-library';
import { Stack } from 'expo-router';
import { AppState, Text } from 'react-native';

import { UNKNOWN_LIMIT } from '@/core/detectors/common';
import { DriveProvider } from '@/drive/DriveProvider';
import type { DriveHost, DriveState } from '@/drive/host';
import { ThemeProvider } from '@/ui';

import { DRIVE_ROUTES, driveHref } from '../hudCopy';
import { HudRouteScreen, LockoutGate } from '../LockoutGate';

jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: jest.fn(async () => {}),
  deactivateKeepAwake: jest.fn(async () => {}),
}));
jest.mock('expo-location', () => ({ getLastKnownPositionAsync: jest.fn(async () => null) }));
jest.mock('expo-battery', () => ({ useBatteryLevel: () => 0.8 }));

const T = 1_790_000_000_000;
const MPH = 0.44704;

function state(over: Partial<DriveState> = {}): DriveState {
  return {
    status: 'recording',
    mode: 'mounted',
    role: 'driver',
    clientTripId: 't1',
    startedAt: T,
    lastRowTs: T,
    speedMps: 0,
    speedKnown: true,
    awaitingSpeedAfterResume: false,
    limit: UNKNOWN_LIMIT,
    distanceM: 0,
    stationarySinceTs: T,
    lockedOut: false,
    stoppedPanel: true,
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

const MOVING: Partial<DriveState> = {
  speedMps: 30 * MPH,
  lockedOut: true,
  stoppedPanel: false,
  stationarySinceTs: null,
};

function fakeHost(initial: DriveState) {
  let current = initial;
  const listeners = new Set<(s: DriveState) => void>();
  const host = {
    snapshot: () => current,
    subscribe: (fn: (s: DriveState) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    end: jest.fn(async () => {}),
    setPassenger: jest.fn(async () => {}),
    setMode: jest.fn(async () => {}),
    muteCurrentAlert: jest.fn(async () => {}),
    muteForDrive: jest.fn(async () => {}),
    detectorContext: () => ({ night: false, precipitation: false, lockReliable: true, lockLagged: false }),
  };
  return {
    host: host as unknown as DriveHost,
    async push(next: Partial<DriveState>) {
      current = { ...current, ...next };
      await act(async () => {
        for (const fn of listeners) fn(current);
      });
    },
  };
}

/** The app's shape: the gate around the root stack, the drive group a full-screen modal over it. */
function routes(host: DriveHost) {
  return {
    _layout: () => (
      <ThemeProvider scheme="light">
        <DriveProvider host={host}>
          <LockoutGate>
            <Stack screenOptions={{ headerShown: false }}>
              <Stack.Screen name="drive" options={{ presentation: 'fullScreenModal' }} />
            </Stack>
          </LockoutGate>
        </DriveProvider>
      </ThemeProvider>
    ),
    home: () => <Text>home</Text>,
    'drive/_layout': () => <Stack screenOptions={{ headerShown: false }} />,
    'drive/hud': () => <HudRouteScreen />,
    'drive/pocket': () => <Text>pocket</Text>,
  };
}

beforeAll(() => {
  (AppState as { currentState: string }).currentState = 'active';
});

describe('LockoutGate under the real router', () => {
  test('a mounted drive on the HUD, pushed over Home, keeps its HUD through the lockout', async () => {
    const drive = fakeHost(state());
    // RNTL 14 renders asynchronously: `renderRouter` hands back the render's promise with the
    // router readers attached to it, so it is awaited and then read.
    const app = renderRouter(routes(drive.host), { initialUrl: '/home' });
    await app;
    expect(app.getPathname()).toBe('/home');
    const { router } = jest.requireActual<typeof import('expo-router')>('expo-router');
    await act(async () => {
      router.push(driveHref(DRIVE_ROUTES.hud));
    });
    expect(app.getPathname()).toBe('/drive/hud');
    expect(screen.getByTestId('hud-screen')).toBeTruthy();

    await drive.push(MOVING);

    // The navigator still shows the HUD route: nothing dismissed the drive modal (review N-I1),
    // and the gate laid no second HUD over the route that already is one.
    expect(app.getPathname()).toBe('/drive/hud');
    expect(screen.getAllByTestId('hud-screen')).toHaveLength(1);
    expect(screen.queryByText('home')).toBeNull();
    expect(screen.getByTestId('hud-touch-shield')).toBeTruthy();

    // And at the next stop the HUD is still the route, with its stopped panel back.
    await drive.push({ speedMps: 0, lockedOut: false, stoppedPanel: true, stationarySinceTs: T + 60_000 });
    expect(app.getPathname()).toBe('/drive/hud');
    expect(screen.getAllByTestId('hud-screen')).toHaveLength(1);
    expect(screen.getByTestId('stopped-panel')).toBeTruthy();
  });
});
