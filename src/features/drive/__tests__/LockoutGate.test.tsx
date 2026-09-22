import {
  act,
  fireEvent,
  isHiddenFromAccessibility,
  render,
  screen,
} from '@testing-library/react-native';
import { useState } from 'react';
import { AppState, BackHandler, StyleSheet, Text } from 'react-native';

import { UNKNOWN_LIMIT } from '@/core/detectors/common';
import { DriveProvider } from '@/drive/DriveProvider';
import type { DriveHost, DriveState } from '@/drive/host';
import { DisputeSheet } from '@/features/trips/DisputeSheet';
import { ThemeProvider } from '@/ui';

import { hudCopy } from '../hudCopy';
import { HudScreen } from '../HudScreen';
import { KEEP_AWAKE_TAG, LockoutGate } from '../LockoutGate';
import { PocketScreen } from '../PocketScreen';

// ---- a small navigator standing in for expo-router ----------------------------------------------
// The real router cannot load under this repo's Jest transform list, so the stack is modelled: the
// `drive` group is a full-screen modal pushed over the app, and `dismissAll()` pops back to the
// first screen — which, from a drive route, removes the drive modal itself (review N-I1).
const mockNav = {
  stack: ['/home'] as string[],
  listeners: new Set<() => void>(),
  get path() {
    return mockNav.stack[mockNav.stack.length - 1];
  },
  set(stack: string[]) {
    mockNav.stack = stack;
    for (const fn of mockNav.listeners) fn();
  },
  subscribe(fn: () => void) {
    mockNav.listeners.add(fn);
    return () => mockNav.listeners.delete(fn);
  },
};
const mockRouter = {
  replace: jest.fn((p: string) => mockNav.set([...mockNav.stack.slice(0, -1), p])),
  push: jest.fn((p: string) => mockNav.set([...mockNav.stack, p])),
  canDismiss: jest.fn(() => mockNav.stack.length > 1),
  dismissAll: jest.fn(() => mockNav.set(mockNav.stack.slice(0, 1))),
};
jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  usePathname: () =>
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('react').useSyncExternalStore(mockNav.subscribe, () => mockNav.path),
}));

jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: jest.fn(async () => {}),
  deactivateKeepAwake: jest.fn(async () => {}),
}));
jest.mock('expo-location', () => ({ getLastKnownPositionAsync: jest.fn(async () => null) }));
jest.mock('expo-battery', () => ({ useBatteryLevel: () => 0.8 }));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const keepAwake = require('expo-keep-awake') as {
  activateKeepAwakeAsync: jest.Mock;
  deactivateKeepAwake: jest.Mock;
};

const T = 1_790_000_000_000;
const MPH = 0.44704;

function state(over: Partial<DriveState> = {}): DriveState {
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

const RECORDING: Partial<DriveState> = {
  status: 'recording',
  clientTripId: 't1',
  startedAt: T,
  lastRowTs: T,
  speedKnown: true,
};
const MOVING: Partial<DriveState> = { ...RECORDING, speedMps: 30 * MPH, lockedOut: true };
const STOPPED: Partial<DriveState> = {
  ...RECORDING,
  speedMps: 0,
  lockedOut: false,
  stoppedPanel: true,
  stationarySinceTs: T,
};

function TripScreen() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <Text>trip detail</Text>
      <DisputeSheet
        visible={open}
        busy={false}
        failed={false}
        onSubmit={() => {}}
        onNotDriver={() => {}}
        onClose={() => setOpen(false)}
        testID="dispute-sheet"
      />
    </>
  );
}

function Routes() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = (require('expo-router') as { usePathname: () => string }).usePathname();
  switch (path) {
    case '/drive/hud':
      return <HudScreen />;
    case '/drive/pocket':
      return <PocketScreen />;
    case '/drive/start':
      return <Text>pre-drive sheet</Text>;
    case '/trips/t0':
      return <TripScreen />;
    default:
      return <Text>{path}</Text>;
  }
}

async function renderApp(initial: Partial<DriveState>, stack: string[]) {
  mockNav.stack = stack;
  let current = state(initial);
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
    detectorContext: () => ({
      night: false,
      precipitation: false,
      lockReliable: true,
      lockLagged: false,
    }),
  };
  await render(
    <ThemeProvider scheme="light">
      <DriveProvider host={host as unknown as DriveHost}>
        <LockoutGate>
          <Routes />
        </LockoutGate>
      </DriveProvider>
    </ThemeProvider>
  );
  return {
    host,
    async push(next: Partial<DriveState>) {
      current = { ...current, ...next };
      await act(() => {
        for (const fn of listeners) fn(current);
      });
    },
  };
}

const path = () => mockNav.path;

beforeAll(() => {
  (AppState as { currentState: string }).currentState = 'active';
});
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
});
afterEach(() => jest.useRealTimers());

describe('LockoutGate: the overlay', () => {
  test('renders its children and nothing else while no drive is locked out', async () => {
    await renderApp({}, ['/home']);
    expect(screen.getByText('/home')).toBeTruthy();
    expect(screen.queryByTestId('hud-screen')).toBeNull();
    expect(screen.queryByTestId('parked-only-card')).toBeNull();
    expect(isHiddenFromAccessibility(screen.getByText('/home'))).toBe(false);
  });

  test('a mounted trip locking out over Home: the HUD covers everything, the app below is hidden and inert', async () => {
    const app = await renderApp(STOPPED, ['/home']);
    await app.push(MOVING);
    expect(screen.getByTestId('hud-screen')).toBeTruthy();
    expect(screen.getByTestId('hud-touch-shield')).toBeTruthy();
    const below = screen.getByText('/home', { includeHiddenElements: true });
    expect(isHiddenFromAccessibility(below)).toBe(true);
    const underlay = screen.getByTestId('lockout-underlay', { includeHiddenElements: true });
    expect(underlay.props.pointerEvents).toBe('none');
    // Nothing to dismiss on a root screen.
    expect(mockRouter.dismissAll).not.toHaveBeenCalled();
  });

  test('the overlay lifts at the next stop and the app below is usable again', async () => {
    const app = await renderApp(STOPPED, ['/home']);
    await app.push(MOVING);
    await app.push(STOPPED);
    expect(screen.queryByTestId('hud-screen')).toBeNull();
    expect(isHiddenFromAccessibility(screen.getByText('/home'))).toBe(false);
    const underlay = screen.getByTestId('lockout-underlay');
    expect(underlay.props.pointerEvents).toBe('auto');
  });

  test.each(['pocket', 'auto'] as const)(
    'a %s trip locking out shows only the parked card',
    async (mode) => {
      const app = await renderApp({ ...STOPPED, mode }, ['/home']);
      await app.push(MOVING);
      expect(screen.getByTestId('parked-only-card')).toBeTruthy();
      expect(screen.getByText(hudCopy.parked.title)).toBeTruthy();
      expect(screen.queryByTestId('hud-screen')).toBeNull();
    }
  );

  test('a passenger trip is never locked out, so nothing covers the app', async () => {
    const app = await renderApp({ ...STOPPED, role: 'passenger' }, ['/home']);
    await app.push({ ...MOVING, role: 'passenger', lockedOut: false });
    expect(screen.queryByTestId('hud-screen')).toBeNull();
  });
});

describe('LockoutGate: what it dismisses at the onset', () => {
  test('lockout begins while the dispute sheet is open: the sheet closes and routed screens are dismissed', async () => {
    const app = await renderApp(STOPPED, ['/home', '/trips/t0']);
    expect(screen.getByTestId('dispute-sheet').props.visible).toBe(true);
    await app.push(MOVING);
    expect(mockRouter.dismissAll).toHaveBeenCalledTimes(1);
    expect(path()).toBe('/home');
    expect(screen.queryByTestId('dispute-sheet', { includeHiddenElements: true })).toBeNull();
  });

  test('the sheet closes through useLockout even where nothing is dismissed', async () => {
    const app = await renderApp(STOPPED, ['/trips/t0']);
    await app.push(MOVING);
    expect(mockRouter.dismissAll).not.toHaveBeenCalled();
    // React Native's Jest Modal renders nothing while not visible.
    expect(screen.queryByTestId('dispute-sheet', { includeHiddenElements: true })).toBeNull();
    expect(screen.getByText('trip detail', { includeHiddenElements: true })).toBeTruthy();
  });

  test('N-I1: lockout begins on /drive/hud — the HUD route survives, no second HUD, and C6 appears at the next stop', async () => {
    const app = await renderApp(STOPPED, ['/home', '/drive/hud']);
    await app.push(MOVING);
    expect(mockRouter.dismissAll).not.toHaveBeenCalled();
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(path()).toBe('/drive/hud');
    expect(screen.getAllByTestId('hud-screen')).toHaveLength(1);
    expect(isHiddenFromAccessibility(screen.getByTestId('hud-screen'))).toBe(false);
    await app.push(STOPPED);
    await act(() => jest.advanceTimersByTime(0));
    expect(screen.getByRole('button', { name: hudCopy.stopped.endDrive })).toBeTruthy();
  });

  test('lockout begins on /drive/pocket: nothing extra', async () => {
    const app = await renderApp({ ...STOPPED, mode: 'pocket' }, ['/home', '/drive/pocket']);
    await app.push({ ...MOVING, mode: 'pocket' });
    expect(mockRouter.dismissAll).not.toHaveBeenCalled();
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(screen.getByTestId('pocket-screen')).toBeTruthy();
    expect(screen.queryByTestId('parked-only-card')).toBeNull();
  });

  test.each([
    ['mounted', '/drive/hud'],
    ['pocket', '/drive/pocket'],
    ['auto', '/drive/pocket'],
  ] as const)(
    "lockout begins on the pre-drive sheet (%s): it is replaced by the trip's own route",
    async (mode, to) => {
      const app = await renderApp({ ...STOPPED, mode }, ['/home', '/drive/start']);
      await app.push({ ...MOVING, mode });
      expect(mockRouter.dismissAll).not.toHaveBeenCalled();
      expect(mockRouter.replace).toHaveBeenCalledWith(to);
      expect(path()).toBe(to);
      expect(screen.queryByTestId('parked-only-card')).toBeNull();
    }
  );

  test('staying locked out does not dismiss again on each row', async () => {
    const app = await renderApp(STOPPED, ['/home', '/trips/t0']);
    await app.push(MOVING);
    await act(() => mockRouter.push('/trips/t0'));
    await app.push({ ...MOVING, speedMps: 31 * MPH });
    await app.push({ ...MOVING, speedMps: 32 * MPH });
    expect(mockRouter.dismissAll).toHaveBeenCalledTimes(1);
  });
});

describe('LockoutGate: keep-awake and Android back', () => {
  test('keep-awake is on for a mounted trip while another route shows, and off when it ends', async () => {
    const app = await renderApp({}, ['/home']);
    expect(keepAwake.activateKeepAwakeAsync).not.toHaveBeenCalled();
    await app.push(STOPPED);
    expect(keepAwake.activateKeepAwakeAsync).toHaveBeenCalledWith(KEEP_AWAKE_TAG);
    await app.push(MOVING);
    await app.push({ status: 'ending', lockedOut: false, speedMps: 0 });
    expect(keepAwake.deactivateKeepAwake).not.toHaveBeenCalled();
    await app.push({ status: 'armed', clientTripId: null });
    expect(keepAwake.deactivateKeepAwake).toHaveBeenCalledWith(KEEP_AWAKE_TAG);
    expect(keepAwake.activateKeepAwakeAsync).toHaveBeenCalledTimes(1);
  });

  test('a pocket trip does not hold the screen on', async () => {
    const app = await renderApp({}, ['/home']);
    await app.push({ ...MOVING, mode: 'pocket' });
    expect(keepAwake.activateKeepAwakeAsync).not.toHaveBeenCalled();
  });

  test('switching a pocket trip to mounted turns keep-awake on', async () => {
    const app = await renderApp({ ...STOPPED, mode: 'pocket' }, ['/home']);
    expect(keepAwake.activateKeepAwakeAsync).not.toHaveBeenCalled();
    await app.push({ mode: 'mounted' });
    expect(keepAwake.activateKeepAwakeAsync).toHaveBeenCalledWith(KEEP_AWAKE_TAG);
  });

  test('Android back is swallowed while a trip records, and released after', async () => {
    const handlers: ((...args: never[]) => boolean | null | undefined)[] = [];
    const remove = jest.fn();
    const spy = jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_e, fn) => {
      handlers.push(fn);
      return { remove };
    });
    const app = await renderApp({}, ['/home']);
    expect(handlers).toHaveLength(0);
    await app.push(STOPPED);
    expect(handlers).toHaveLength(1);
    expect(handlers[0]?.()).toBe(true);
    await app.push(MOVING);
    expect(handlers).toHaveLength(1);
    await app.push({ status: 'armed', clientTripId: null, lockedOut: false });
    expect(remove).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

test('the overlay HUD is the black HUD world', async () => {
  const app = await renderApp(STOPPED, ['/home']);
  await app.push(MOVING);
  const root = StyleSheet.flatten(screen.getByTestId('hud-screen').props.style);
  expect(root.backgroundColor).toBe('#000000');
  await fireEvent.press(screen.getByTestId('hud-touch-shield'));
  expect(app.host.end).not.toHaveBeenCalled();
});
