import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';

import { UNKNOWN_LIMIT } from '@/core/detectors/common';
import { DriveProvider } from '@/drive/DriveProvider';
import type { DriveHost, DriveState } from '@/drive/host';
import {
  DriveStartScreen,
  LAST_MODE_SETTING_KEY,
  LOW_BATTERY_PCT,
  PreDriveSheet,
  type PreDriveSheetProps,
  type StartDeps,
} from '@/features/drive/PreDriveSheet';
import { startCopy as copy } from '@/features/drive/startCopy';
import { ThemeProvider } from '@/ui';

const mockRouter = {
  replace: jest.fn(),
  back: jest.fn(),
  canGoBack: jest.fn(() => true),
  dismissTo: jest.fn(),
};
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

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
    tripIndex: 0,
    dryRun: false,
    ...over,
  };
}

function stubHost(initial: DriveState) {
  let current = initial;
  const listeners = new Set<(s: DriveState) => void>();
  const calls: string[] = [];
  const host = {
    snapshot: () => current,
    subscribe: (fn: (s: DriveState) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    isBusy: () => ['candidate', 'recording', 'ending', 'finalizing'].includes(current.status),
    manualStart: jest.fn(async (opts: { mode: string; passenger: boolean; evidence: string }) => {
      calls.push(`manualStart:${opts.mode}:${opts.passenger}:${opts.evidence}`);
      current = { ...current, status: 'recording', clientTripId: 'new', mode: opts.mode as 'mounted' | 'pocket' };
    }),
    announce: jest.fn(async (key: string) => {
      calls.push(`announce:${key}`);
    }),
  } as unknown as DriveHost;
  return { host, calls };
}

function fakeAppState() {
  const listeners = new Set<(s: string) => void>();
  return {
    currentState: 'active' as string | null,
    addEventListener(_type: 'change', fn: (s: string) => void) {
      listeners.add(fn);
      return { remove: () => listeners.delete(fn) };
    },
    emit(s: string) {
      for (const fn of listeners) fn(s);
    },
  };
}

function deps(over: Partial<StartDeps> = {}): StartDeps & { appState: ReturnType<typeof fakeAppState> } {
  const store = new Map<string, unknown>();
  return {
    appState: fakeAppState(),
    ensurePermissions: jest.fn(async () => ({ location: 'granted' as const, motion: 'granted' as const })),
    readLocationPermission: jest.fn(async () => 'granted' as const),
    openSettings: jest.fn(async () => {}),
    currentSpeedMps: jest.fn(async () => 0),
    settings: {
      get: jest.fn(async <T,>(key: string) => (store.has(key) ? (store.get(key) as T) : null)),
      set: jest.fn(async (key: string, value: unknown) => {
        store.set(key, value);
      }),
    },
    probes: {
      watchGps: jest.fn(async (cb: (accuracyM: number | null) => void) => {
        cb(8);
        return () => {};
      }),
      power: jest.fn(async () => ({ pct: 80, charging: false })),
      thermal: jest.fn(async () => 'nominal' as const),
    },
    ...over,
  } as StartDeps & { appState: ReturnType<typeof fakeAppState> };
}

async function renderStart(host: DriveHost, d: StartDeps) {
  const r = await render(
    <ThemeProvider>
      <DriveProvider host={host}>
        <DriveStartScreen deps={d} />
      </DriveProvider>
    </ThemeProvider>
  );
  await act(async () => {});
  return r;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
});

describe('DriveStartScreen (C1 entry)', () => {
  test('a host that is already busy routes to Home and announces nothing, starts nothing, asks nothing', async () => {
    const { host, calls } = stubHost(state({ status: 'recording', clientTripId: 'auto' }));
    const d = deps();
    await renderStart(host, d);
    expect(mockRouter.replace).toHaveBeenCalledWith('/(tabs)/home');
    expect(calls).toEqual([]);
    expect(d.ensurePermissions).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: copy.sheet.start })).toBeNull();
  });

  test('already moving: no sheet; a pocket drive starts with movingStart evidence, "Recording" is spoken, pocket route', async () => {
    const { host, calls } = stubHost(state());
    const d = deps({ currentSpeedMps: jest.fn(async () => 12) });
    await renderStart(host, d);
    expect(calls).toEqual(['manualStart:pocket:false:movingStart', 'announce:alert.recording']);
    expect(mockRouter.replace).toHaveBeenCalledWith('/drive/pocket');
    expect(screen.queryByRole('button', { name: copy.sheet.start })).toBeNull();
    // A moving start is not the driver's choice of mode: the remembered mode is left alone.
    expect(d.settings.set).not.toHaveBeenCalled();
  });

  test('an unknown speed opens the sheet (never treated as parked or as moving)', async () => {
    const { host, calls } = stubHost(state());
    await renderStart(host, deps({ currentSpeedMps: jest.fn(async () => null) }));
    expect(screen.getByRole('button', { name: copy.sheet.start })).toBeOnTheScreen();
    expect(calls).toEqual([]);
  });

  test('denied location: the blocking explainer with Open Settings — no sheet, no drive, no second prompt', async () => {
    const { host, calls } = stubHost(state());
    const d = deps({
      ensurePermissions: jest.fn(async () => ({ location: 'denied' as const, motion: 'undetermined' as const })),
      readLocationPermission: jest.fn(async () => 'denied' as const),
    });
    await renderStart(host, d);
    expect(screen.getByRole('header', { name: copy.locationDenied.title })).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: copy.sheet.start })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: copy.locationDenied.openSettings }));
    expect(d.openSettings).toHaveBeenCalled();

    // Back from Settings still denied: re-read, not re-asked.
    await act(async () => d.appState.emit('active'));
    expect(d.readLocationPermission).toHaveBeenCalled();
    expect(d.ensurePermissions).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);

    await fireEvent.press(screen.getByRole('button', { name: copy.locationDenied.notNow }));
    expect(mockRouter.back).toHaveBeenCalled();
  });

  test('back from Settings with location now on: no prompt, straight on to the sheet', async () => {
    const { host } = stubHost(state());
    const d = deps({
      ensurePermissions: jest.fn(async () => ({ location: 'denied' as const, motion: 'undetermined' as const })),
      readLocationPermission: jest.fn(async () => 'granted' as const),
    });
    await renderStart(host, d);
    await act(async () => d.appState.emit('active'));
    expect(await screen.findByRole('button', { name: copy.sheet.start })).toBeOnTheScreen();
    expect(d.ensurePermissions).toHaveBeenCalledTimes(1);
  });

  test('Start drive: manual start with tap evidence, then "Recording", then the HUD; the mode is remembered', async () => {
    const { host, calls } = stubHost(state());
    const d = deps();
    await renderStart(host, d);
    await fireEvent.press(screen.getByRole('button', { name: copy.sheet.start }));
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/drive/hud'));
    expect(calls).toEqual(['manualStart:mounted:false:tap', 'announce:alert.recording']);
    expect(d.settings.set).toHaveBeenCalledWith(LAST_MODE_SETTING_KEY, 'mounted');
  });

  test('the remembered mode is preselected; Pocket and passenger go through to the pocket route', async () => {
    const { host, calls } = stubHost(state());
    const d = deps();
    await d.settings.set(LAST_MODE_SETTING_KEY, 'pocket');
    await renderStart(host, d);
    expect(screen.getByRole('radio', { name: copy.sheet.pocket })).toBeChecked();
    await fireEvent(screen.getByRole('switch', { name: copy.sheet.passenger }), 'valueChange', true);
    await fireEvent.press(screen.getByRole('button', { name: copy.sheet.start }));
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/drive/pocket'));
    expect(calls[0]).toBe('manualStart:pocket:true:tap');
  });

  test('a drive that auto-started while the sheet was open: Start routes Home instead of starting a second', async () => {
    const s = stubHost(state());
    await renderStart(s.host, deps());
    Object.assign(s.host, { isBusy: () => true });
    await fireEvent.press(screen.getByRole('button', { name: copy.sheet.start }));
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/(tabs)/home'));
    expect(s.calls).toEqual([]);
  });

  test('a failed start says so in place and lets the driver try again', async () => {
    const { host } = stubHost(state());
    (host.manualStart as jest.Mock).mockRejectedValueOnce(new Error('E_PERMISSION'));
    await renderStart(host, deps());
    await fireEvent.press(screen.getByRole('button', { name: copy.sheet.start }));
    expect(await screen.findByText(copy.sheet.startFailed)).toBeOnTheScreen();
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: copy.sheet.start })).toBeEnabled();
  });

  test('Cancel goes back', async () => {
    const { host } = stubHost(state());
    await renderStart(host, deps());
    await fireEvent.press(screen.getByRole('button', { name: copy.sheet.cancel }));
    expect(mockRouter.back).toHaveBeenCalled();
  });
});

describe('PreDriveSheet (C1)', () => {
  function props(over: Partial<PreDriveSheetProps> = {}): PreDriveSheetProps {
    return {
      initialMode: 'mounted',
      gps: 'ready',
      power: { pct: 80, charging: false },
      hot: false,
      starting: false,
      error: null,
      onStart: jest.fn(),
      onCancel: jest.fn(),
      ...over,
    };
  }

  const renderSheet = (p: PreDriveSheetProps) =>
    render(
      <ThemeProvider>
        <PreDriveSheet {...p} />
      </ThemeProvider>
    );

  test('Mounted and Pocket are a two-choice group; the passenger toggle is off by default', async () => {
    const p = props();
    await renderSheet(p);
    expect(screen.getByRole('radio', { name: copy.sheet.mounted })).toBeChecked();
    expect(screen.getByRole('radio', { name: copy.sheet.pocket })).not.toBeChecked();
    expect(screen.getByRole('switch', { name: copy.sheet.passenger })).toHaveProp('value', false);
    await fireEvent.press(screen.getByRole('radio', { name: copy.sheet.pocket }));
    await fireEvent.press(screen.getByRole('button', { name: copy.sheet.start }));
    expect(p.onStart).toHaveBeenCalledWith({ mode: 'pocket', passenger: false });
  });

  test('status chips: GPS ready or finding, battery with charging, and a hot phone', async () => {
    const { rerender } = await renderSheet(props());
    expect(screen.getByText(copy.chips.gpsReady)).toBeOnTheScreen();
    expect(screen.getByText(copy.chips.battery(80))).toBeOnTheScreen();
    expect(screen.queryByText(copy.chips.hot)).toBeNull();
    await rerender(
      <ThemeProvider>
        <PreDriveSheet {...props({ gps: 'searching', power: { pct: 40, charging: true }, hot: true })} />
      </ThemeProvider>
    );
    expect(screen.getByText(copy.chips.gpsSearching)).toBeOnTheScreen();
    expect(screen.getByText(copy.chips.charging(40))).toBeOnTheScreen();
    expect(screen.getByText(copy.chips.hot)).toBeOnTheScreen();
  });

  test('no GPS fix yet: Start is still allowed', async () => {
    const p = props({ gps: 'searching' });
    await renderSheet(p);
    expect(screen.getByRole('button', { name: copy.sheet.start })).toBeEnabled();
  });

  test('an unknown battery prints no battery chip rather than a guess', async () => {
    await renderSheet(props({ power: null }));
    expect(screen.queryByText(/Battery/)).toBeNull();
  });

  test('low battery and not charging in Mounted: suggests Pocket, and the suggestion switches the mode', async () => {
    const p = props({ power: { pct: LOW_BATTERY_PCT - 1, charging: false } });
    await renderSheet(p);
    expect(screen.getByText(copy.lowBattery.message(LOW_BATTERY_PCT - 1))).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: copy.lowBattery.action }));
    expect(screen.getByRole('radio', { name: copy.sheet.pocket })).toBeChecked();
    expect(screen.queryByText(copy.lowBattery.message(LOW_BATTERY_PCT - 1))).toBeNull();
  });

  test('no low-battery suggestion while charging, at the threshold, or already in Pocket', async () => {
    const { rerender } = await renderSheet(props({ power: { pct: 5, charging: true } }));
    expect(screen.queryByRole('button', { name: copy.lowBattery.action })).toBeNull();
    await rerender(
      <ThemeProvider>
        <PreDriveSheet {...props({ power: { pct: LOW_BATTERY_PCT, charging: false } })} />
      </ThemeProvider>
    );
    expect(screen.queryByRole('button', { name: copy.lowBattery.action })).toBeNull();
    await rerender(
      <ThemeProvider>
        <PreDriveSheet key="pocket" {...props({ initialMode: 'pocket', power: { pct: 5, charging: false } })} />
      </ThemeProvider>
    );
    expect(screen.queryByRole('button', { name: copy.lowBattery.action })).toBeNull();
  });

  test('VoiceOver lands on Start drive when the sheet opens', async () => {
    const spy = jest.spyOn(AccessibilityInfo, 'sendAccessibilityEvent');
    await renderSheet(props());
    await act(async () => {});
    expect(spy).toHaveBeenCalledWith(expect.anything(), 'focus');
    const target = spy.mock.calls[0]?.[0] as unknown as { props?: { accessibilityLabel?: string } };
    expect(target).toBeTruthy();
  });

  test('while starting, Start is busy and cannot be pressed twice', async () => {
    const p = props({ starting: true });
    await renderSheet(p);
    const start = screen.getByRole('button', { name: copy.sheet.start });
    expect(start).toBeBusy();
    expect(start).toBeDisabled();
    await fireEvent.press(start);
    expect(p.onStart).not.toHaveBeenCalled();
  });

  test('every control is at least 44 pt, Start at least 64 pt', async () => {
    await renderSheet(props());
    const { StyleSheet } = jest.requireActual<typeof import('react-native')>('react-native');
    const start = StyleSheet.flatten(screen.getByRole('button', { name: copy.sheet.start }).props.style);
    expect(start.minHeight).toBeGreaterThanOrEqual(64);
    for (const name of [copy.sheet.mounted, copy.sheet.pocket]) {
      const s = StyleSheet.flatten(screen.getByRole('radio', { name }).props.style);
      expect(s.minHeight).toBeGreaterThanOrEqual(44);
    }
  });
});
