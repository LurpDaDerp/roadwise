import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { AppState, StyleSheet } from 'react-native';

import type { AlertDecision } from '@/core/alerts/types';
import { UNKNOWN_LIMIT } from '@/core/detectors/common';
import type { LimitSample } from '@/core/engine/types';
import { DriveProvider } from '@/drive/DriveProvider';
import type { DriveHost, DriveState } from '@/drive/host';
import { ThemeProvider } from '@/ui';
import { HUD } from '@/ui/drive';

import { hudCopy } from '../hudCopy';
import { HUD_MUTE_HOLD_MS, HudScreen } from '../HudScreen';

const mockRouter = {
  replace: jest.fn(),
  push: jest.fn(),
  dismissAll: jest.fn(),
  canDismiss: jest.fn(() => false),
};
jest.mock('expo-router', () => ({ useRouter: () => mockRouter, usePathname: () => '/drive/hud' }));

const mockPosition: {
  current: { coords: { latitude: number; longitude: number } } | null;
  pending: boolean;
} = { current: null, pending: false };
jest.mock('expo-location', () => ({
  getLastKnownPositionAsync: jest.fn(() =>
    mockPosition.pending ? new Promise(() => {}) : Promise.resolve(mockPosition.current)
  ),
}));

// Counts how often the HUD root re-renders its quiet children (review m3). The wrappers are not
// memoised, so each count is one render of the HUD body.
const mockRenders = { indicators: 0, ring: 0 };
jest.mock('@/ui/drive', () => {
  const actual = jest.requireActual<typeof import('@/ui/drive')>('@/ui/drive');
  const { createElement } = jest.requireActual<typeof import('react')>('react');
  return {
    ...actual,
    HudIndicators: (p: import('@/ui/drive').HudIndicatorsProps) => {
      mockRenders.indicators += 1;
      return createElement(actual.HudIndicators, p);
    },
    StatusRing: (p: import('@/ui/drive').StatusRingProps) => {
      mockRenders.ring += 1;
      return createElement(actual.StatusRing, p);
    },
  };
});
jest.mock('expo-battery', () => ({ useBatteryLevel: () => 0.8 }));

const T = Date.UTC(2026, 8, 22, 19, 0, 0); // noon in Seattle (PDT, UTC−7)
const MPH = 0.44704;

function state(over: Partial<DriveState> = {}): DriveState {
  return {
    status: 'recording',
    mode: 'mounted',
    role: 'driver',
    clientTripId: 't1',
    startedAt: T,
    lastRowTs: T,
    speedMps: 20 * MPH,
    speedKnown: true,
    awaitingSpeedAfterResume: false,
    limit: UNKNOWN_LIMIT,
    distanceM: 0,
    stationarySinceTs: null,
    lockedOut: true,
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

function stubHost(initial: DriveState, night = false) {
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
    detectorContext: () => ({ night, precipitation: false, lockReliable: true, lockLagged: false }),
  };
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

const posted = (mph: number, matchConfidence = 0.95): LimitSample => ({
  limitMps: mph * MPH,
  source: 'posted',
  matchConfidence,
  parallelRoads: false,
});

const decision = (level: 1 | 2 | 3): AlertDecision => ({
  id: `a${level}`,
  level,
  kind: level === 3 ? 'drowsy' : level === 2 ? 'phone' : 'speeding',
  ts: T,
  voice: level === 3 ? 'alert.drowsy' : level === 2 ? 'alert.phoneDown' : 'alert.easeOff',
});

const inkOf = (id: string) => StyleSheet.flatten(screen.getByTestId(id).props.style).color;

function wrap(host: unknown, children: ReactNode) {
  return (
    <ThemeProvider scheme="light">
      <DriveProvider host={host as DriveHost}>{children}</DriveProvider>
    </ThemeProvider>
  );
}

async function renderHud(
  over: Partial<DriveState> = {},
  opts: { night?: boolean; overlay?: boolean } = {}
) {
  const h = stubHost(state(over), opts.night);
  await render(wrap(h.host, <HudScreen overlay={opts.overlay} />));
  // The night check reads the OS's cached position once on mount.
  await act(async () => {});
  return h;
}

beforeAll(() => {
  (AppState as { currentState: string }).currentState = 'active';
});
beforeEach(() => {
  jest.useFakeTimers({ now: T });
  mockPosition.current = null;
  mockPosition.pending = false;
  jest.clearAllMocks();
});
afterEach(() => {
  jest.useRealTimers();
});

describe('HudScreen (C3): what it shows', () => {
  test('no GPS: the speed reads "—" and the GPS mark says so; never the words "Finding GPS"', async () => {
    await renderHud({ speedKnown: false, speedMps: 0, gps: 'none', lockedOut: false });
    expect(screen.getByTestId('hud-speed-numeral')).toHaveTextContent('—');
    expect(screen.getByTestId('hud-ind-gps').props.accessibilityLabel).toBe('No GPS');
    expect(screen.queryByText(/Finding GPS/i)).toBeNull();
  });

  test('no limit: the sign reads "—" and the speed is not shown as speeding', async () => {
    await renderHud({ speedMps: 60 * MPH, limit: UNKNOWN_LIMIT });
    expect(screen.getByTestId('hud-limit-value')).toHaveTextContent('—');
    expect(screen.queryByTestId('hud-speeding-icon')).toBeNull();
  });

  test('a limit below the action gate is not shown (ramp match at 0.65)', async () => {
    await renderHud({ speedMps: 60 * MPH, limit: posted(35, 0.65) });
    expect(screen.getByTestId('hud-limit-value')).toHaveTextContent('—');
    expect(screen.queryByTestId('hud-speeding-icon')).toBeNull();
  });

  test('speeding past tolerance marks the speed', async () => {
    await renderHud({ speedMps: 50 * MPH, limit: posted(35) });
    expect(screen.getByTestId('hud-limit-value')).toHaveTextContent('35');
    expect(screen.getByTestId('hud-speed-numeral')).toHaveTextContent('50');
    expect(screen.getByTestId('hud-speeding-icon')).toBeTruthy();
  });

  test.each([
    [1, 'hud-alert-l1', 'Recording, alert active'],
    [2, 'hud-alert-l2', 'Recording, alert active'],
    [3, 'hud-alert-l3', 'Recording, urgent alert'],
  ] as const)(
    'alert level %i: its overlay and the status strip',
    async (level, overlayId, ring) => {
      await renderHud({ activeAlert: decision(level) });
      expect(screen.getByTestId(overlayId)).toBeTruthy();
      expect(screen.getByTestId('hud-status').props.accessibilityLabel).toBe(ring);
    }
  );

  test('no alert: calm strip that says it is recording', async () => {
    await renderHud();
    expect(screen.queryByTestId('hud-alert')).toBeNull();
    expect(screen.getByTestId('hud-status').props.accessibilityLabel).toBe('Recording');
    expect(screen.getByTestId('hud-status-recording')).toBeTruthy();
  });

  test('the status ring is mounted only while recording (not while ending, not in a candidate)', async () => {
    const h = await renderHud({ status: 'ending', lockedOut: false, speedMps: 0 });
    expect(screen.queryByTestId('hud-status')).toBeNull();
    await h.push({ status: 'candidate' });
    expect(screen.queryByTestId('hud-status')).toBeNull();
    await h.push({ status: 'recording' });
    expect(screen.getByTestId('hud-status')).toBeTruthy();
  });

  test('day: no hazard chip, day palette', async () => {
    mockPosition.current = { coords: { latitude: 47.6, longitude: -122.33 } };
    await renderHud();
    expect(screen.queryByTestId('hud-hazard')).toBeNull();
    expect(inkOf('hud-speed-numeral')).toBe(HUD.day.ink);
  });

  test('night by the sun at the last known position: night palette and the one night chip', async () => {
    jest.setSystemTime(Date.UTC(2026, 8, 23, 6, 0, 0)); // 23:00 in Seattle
    mockPosition.current = { coords: { latitude: 47.6, longitude: -122.33 } };
    await renderHud();
    expect(screen.getByTestId('hud-hazard')).toBeTruthy();
    expect(screen.getAllByTestId('hud-hazard')).toHaveLength(1);
    expect(inkOf('hud-speed-numeral')).toBe(HUD.night.ink);
  });

  test('the same instant is day where the sun is up (the position decides, not the clock)', async () => {
    jest.setSystemTime(Date.UTC(2026, 8, 23, 6, 0, 0)); // 23:00 Seattle = 16:00 in Tokyo
    mockPosition.current = { coords: { latitude: 35.68, longitude: 139.69 } };
    await renderHud();
    expect(screen.queryByTestId('hud-hazard')).toBeNull();
  });

  test("with no cached position it falls back to the host's night rule", async () => {
    mockPosition.current = null;
    await renderHud({}, { night: true });
    expect(screen.getByTestId('hud-hazard')).toBeTruthy();
  });

  test('the passenger stamp shows on a passenger trip', async () => {
    await renderHud({ role: 'passenger', lockedOut: false });
    expect(screen.getByTestId('hud-ind-passenger')).toBeTruthy();
  });
});

describe('HudScreen: touch policy', () => {
  test('while locked out a full-screen shield swallows touches and no controls exist', async () => {
    await renderHud({ lockedOut: true });
    const shield = screen.getByTestId('hud-touch-shield');
    expect(shield.props.onStartShouldSetResponder()).toBe(true);
    expect(shield.props.onResponderTerminationRequest()).toBe(false);
    await fireEvent.press(shield);
    expect(screen.queryByRole('button')).toBeNull();
  });

  test('while awaiting speed after an adopt, the shield is up even though lockout is off', async () => {
    await renderHud({ lockedOut: false, awaitingSpeedAfterResume: true, speedKnown: false });
    expect(screen.getByTestId('hud-touch-shield')).toBeTruthy();
    await fireEvent(screen.getByTestId('hud-touch-shield'), 'responderRelease');
    expect(screen.queryByRole('button', { name: hudCopy.stopped.endDrive })).toBeNull();
  });

  test('an ordinary trip start with no fix stays tappable: a tap shows the drive controls', async () => {
    await renderHud({
      lockedOut: false,
      awaitingSpeedAfterResume: false,
      speedKnown: false,
      speedMps: 0,
      gps: 'none',
    });
    expect(screen.queryByTestId('hud-touch-shield')).toBeNull();
    await fireEvent.press(screen.getByTestId('hud-tap-area'));
    expect(screen.getByRole('button', { name: hudCopy.stopped.endDrive })).toBeTruthy();
  });

  test('a tap does not reveal the controls while rolling (known speed above 3 mph)', async () => {
    await renderHud({ lockedOut: false, speedKnown: true, speedMps: 4 * MPH });
    await fireEvent.press(screen.getByTestId('hud-tap-area'));
    expect(screen.queryByRole('button', { name: hudCopy.stopped.endDrive })).toBeNull();
  });

  test('long-press thresholds: 1499 ms mutes nothing, 1500 ms mutes the current alert once', async () => {
    const h = await renderHud({ lockedOut: true, activeAlert: decision(2) });
    const shield = screen.getByTestId('hud-touch-shield');
    await fireEvent(shield, 'responderGrant', { nativeEvent: {} });
    await act(() => jest.advanceTimersByTime(HUD_MUTE_HOLD_MS - 1));
    expect(h.host.muteCurrentAlert).not.toHaveBeenCalled();
    await act(() => jest.advanceTimersByTime(1));
    expect(h.host.muteCurrentAlert).toHaveBeenCalledTimes(1);
    await act(() => jest.advanceTimersByTime(5000));
    expect(h.host.muteCurrentAlert).toHaveBeenCalledTimes(1);
    await fireEvent(shield, 'responderRelease');
  });

  test('a hold released early mutes nothing', async () => {
    const h = await renderHud({ lockedOut: true, activeAlert: decision(1) });
    const shield = screen.getByTestId('hud-touch-shield');
    await fireEvent(shield, 'responderGrant', { nativeEvent: {} });
    await act(() => jest.advanceTimersByTime(1000));
    await fireEvent(shield, 'responderRelease');
    await act(() => jest.advanceTimersByTime(2000));
    expect(h.host.muteCurrentAlert).not.toHaveBeenCalled();
    // A second, separate short press does not add up with the first.
    await fireEvent(shield, 'responderGrant', { nativeEvent: {} });
    await act(() => jest.advanceTimersByTime(600));
    await fireEvent(shield, 'responderTerminate');
    await act(() => jest.advanceTimersByTime(2000));
    expect(h.host.muteCurrentAlert).not.toHaveBeenCalled();
    expect(HUD_MUTE_HOLD_MS).toBe(1500);
  });
});

describe('HudScreen: the stopped panel and the end of the drive', () => {
  test('stopped ≥ 3 s: the panel appears; End drive routes to the end screen and ends the drive', async () => {
    const h = await renderHud({
      lockedOut: false,
      stoppedPanel: true,
      speedMps: 0,
      stationarySinceTs: T,
    });
    await fireEvent.press(screen.getByRole('button', { name: hudCopy.stopped.endDrive }));
    await act(() => jest.advanceTimersByTime(300));
    expect(mockRouter.replace).toHaveBeenCalledWith('/drive/end');
    expect(h.host.end).toHaveBeenCalledTimes(1);
  });

  test('the panel is also there in the gap window (ending)', async () => {
    await renderHud({ status: 'ending', lockedOut: false, speedMps: 0, stationarySinceTs: T });
    expect(screen.getByRole('button', { name: hudCopy.stopped.endDrive })).toBeTruthy();
  });

  test('the panel hides as the car moves off, and a pending tap is discarded', async () => {
    const h = await renderHud({
      lockedOut: false,
      stoppedPanel: true,
      speedMps: 0,
      stationarySinceTs: T,
    });
    await fireEvent.press(screen.getByRole('button', { name: hudCopy.stopped.muteDrive }));
    await act(() => jest.advanceTimersByTime(150));
    await h.push({ stoppedPanel: false, speedMps: 4 * MPH, stationarySinceTs: null });
    await act(() => jest.advanceTimersByTime(1000));
    expect(h.host.muteForDrive).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: hudCopy.stopped.endDrive })).toBeNull();
  });

  test('stopped panel wires the drive mute and the driver swap to the host', async () => {
    const h = await renderHud({
      lockedOut: false,
      stoppedPanel: true,
      speedMps: 0,
      stationarySinceTs: T,
    });
    await fireEvent.press(screen.getByRole('button', { name: hudCopy.stopped.muteDrive }));
    await act(() => jest.advanceTimersByTime(300));
    expect(h.host.muteForDrive).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByRole('button', { name: hudCopy.stopped.passengerNow }));
    await act(() => jest.advanceTimersByTime(300));
    expect(h.host.setPassenger).toHaveBeenCalledWith(true);
  });

  test('finalizing replaces the HUD with the end screen', async () => {
    const h = await renderHud({ lockedOut: false, speedMps: 0 });
    expect(mockRouter.replace).not.toHaveBeenCalled();
    await h.push({ status: 'finalizing' });
    expect(mockRouter.replace).toHaveBeenCalledWith('/drive/end');
    expect(mockRouter.replace).toHaveBeenCalledTimes(1);
  });

  test('a close that skips straight to armed (batched renders) still reaches the end screen', async () => {
    const h = await renderHud({ lockedOut: false, speedMps: 0 });
    await h.push({ status: 'armed', clientTripId: null });
    expect(mockRouter.replace).toHaveBeenCalledWith('/drive/end');
  });

  test('a HUD opened with no drive at all does not claim one ended', async () => {
    await renderHud({ status: 'armed', clientTripId: null, lockedOut: false });
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  test('as the lockout overlay it never navigates and shows no stopped panel', async () => {
    const h = await renderHud({ lockedOut: true }, { overlay: true });
    await h.push({ status: 'finalizing', lockedOut: false });
    expect(mockRouter.replace).not.toHaveBeenCalled();
    await h.push({ status: 'recording', stoppedPanel: true, speedMps: 0 });
    expect(screen.queryByRole('button', { name: hudCopy.stopped.endDrive })).toBeNull();
  });
});

describe('HudScreen: landscape', () => {
  test('lays the zones out for a landscape mount', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('react-native/Libraries/Utilities/useWindowDimensions');
    const spy = jest
      .spyOn(mod, 'default')
      .mockReturnValue({ width: 844, height: 390, scale: 3, fontScale: 1 });
    await renderHud();
    expect(screen.getByTestId('hud-layout-landscape')).toBeTruthy();
    expect(screen.queryByTestId('hud-layout-portrait')).toBeNull();
    spy.mockRestore();
  });

  test('portrait by default', async () => {
    await renderHud();
    expect(screen.getByTestId('hud-layout-portrait')).toBeTruthy();
  });
});

describe('HudScreen: fix round 1', () => {
  test('m1: at night the very first paint is already the night palette (no day flash while the position is read)', async () => {
    mockPosition.pending = true; // the OS never answers during this test
    const h = stubHost(state(), true);
    await render(wrap(h.host, <HudScreen />));
    expect(inkOf('hud-speed-numeral')).toBe(HUD.night.ink);
    expect(screen.getByTestId('hud-hazard')).toBeTruthy();
  });

  test('m1: by day the first paint is the day palette', async () => {
    mockPosition.pending = true;
    const h = stubHost(state(), false);
    await render(wrap(h.host, <HudScreen />));
    expect(inkOf('hud-speed-numeral')).toBe(HUD.day.ink);
  });

  test('m3: a speed-only row re-renders the gauges, not the rest of the HUD', async () => {
    const h = await renderHud({ speedMps: 20 * MPH });
    const before = { ...mockRenders };
    await h.push({ speedMps: 21 * MPH, lastRowTs: T + 1000 });
    await h.push({ speedMps: 22 * MPH, lastRowTs: T + 2000 });
    expect(screen.getByTestId('hud-speed-numeral')).toHaveTextContent('22');
    expect(mockRenders).toEqual(before);
  });
});
