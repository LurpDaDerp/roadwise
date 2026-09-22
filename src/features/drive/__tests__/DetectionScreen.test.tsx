import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';

import { T0, tripRow } from '@/data/queries/__fixtures__/rows';
import { DriveContext } from '@/drive/DriveProvider';
import type { DriveHost, DriveState } from '@/drive/host';
import { createDriveStore } from '@/drive/store';
import { DetectionScreen, type DetectionDeps } from '@/features/drive/DetectionScreen';
import { DISCLOSURE_TEXT, DISCLOSURE_VERSION } from '@/features/drive/detectionCopy';
import { clearQueryClients, routerDouble, world } from '@/features/trips/__fixtures__/render';

const mockRouter = routerDouble();
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
// The device ports are replaced wholesale by `deps` below; these keep the imports inert under Jest.
jest.mock('expo-notifications', () => ({ requestPermissionsAsync: jest.fn() }));
jest.mock('expo-location', () => ({
  getForegroundPermissionsAsync: jest.fn(),
  requestForegroundPermissionsAsync: jest.fn(),
  requestBackgroundPermissionsAsync: jest.fn(),
}));

/**
 * A host that answers what the screen asks: the intent, setting it, and its published arming
 * (`autoDetectArmed`, the one predicate — final review I4). By default it arms exactly when the
 * driver opts in; `armOnOptIn: false` models a host that could not arm.
 */
function fakeHost(initialIntent = false, opts: { armOnOptIn?: boolean } = {}) {
  let intent = initialIntent;
  const armOnOptIn = opts.armOnOptIn ?? true;
  const log: string[] = [];
  let state = { status: initialIntent ? 'armed' : 'off', autoDetectArmed: initialIntent && armOnOptIn } as DriveState;
  const listeners = new Set<(s: DriveState) => void>();
  const publish = (armed: boolean) => {
    state = { ...state, status: armed ? 'armed' : 'off', autoDetectArmed: armed };
    for (const fn of [...listeners]) fn(state);
  };
  const host = {
    snapshot: () => state,
    subscribe: (fn: (s: DriveState) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    autoDetectEnabled: () => intent,
    setAutoDetect: jest.fn(async (enabled: boolean) => {
      log.push(`setAutoDetect:${enabled}`);
      intent = enabled;
      publish(enabled && armOnOptIn);
    }),
    refreshArming: jest.fn(async () => {
      log.push('refreshArming');
    }),
  } as unknown as DriveHost;
  return { host, log, publish };
}

type Answers = {
  flag?: boolean;
  access?: { location: 'none' | 'whenInUse' | 'always'; motion: string };
  motion?: 'granted' | 'denied' | 'unavailable';
  foreground?: boolean;
  background?: boolean;
  notifications?: boolean;
};

/** Every prompt is logged in order, into the same log the host writes to. */
function fakeDeps(log: string[], os: string, androidApi: number, a: Answers = {}) {
  let access = a.access ?? { location: 'whenInUse' as const, motion: 'undetermined' };
  const appListeners = new Set<(s: string) => void>();
  const deps: DetectionDeps & {
    grant(next: { location: 'none' | 'whenInUse' | 'always'; motion: string }): void;
    foreground(): void;
  } = {
    os,
    androidApi,
    appState: {
      addEventListener: (_t: 'change', fn: (s: string) => void) => {
        appListeners.add(fn);
        return { remove: () => appListeners.delete(fn) };
      },
    },
    grant(next) {
      access = next;
    },
    foreground() {
      for (const fn of [...appListeners]) fn('active');
    },
    readAccess: jest.fn(async () => access),
    readFlag: jest.fn(async () => a.flag ?? true),
    requestMotion: jest.fn(async () => {
      log.push('motion');
      return a.motion ?? 'granted';
    }),
    ensureForegroundLocation: jest.fn(async () => {
      log.push('foregroundLocation');
      return a.foreground ?? true;
    }),
    requestBackgroundLocation: jest.fn(async () => {
      log.push('backgroundLocation');
      const ok = a.background ?? true;
      if (ok) access = { location: 'always', motion: 'granted' };
      return ok;
    }),
    requestNotifications: jest.fn(async () => {
      log.push('notifications');
      return a.notifications ?? true;
    }),
    openSettings: jest.fn(async () => {
      log.push('openSettings');
    }),
  };
  return deps;
}

const PROMPTS = ['motion', 'foregroundLocation', 'backgroundLocation', 'notifications'];
const aDrive = tripRow({ client_trip_id: 'first', started_at: T0, sync_state: 'synced' });

async function renderScreen(ui: ReactElement, host: DriveHost, trips = [aDrive]) {
  const w = await world({ trips });
  const store = createDriveStore(host, { currentState: 'active', addEventListener: () => ({ remove() {} }) });
  return w.renderScreen(<DriveContext.Provider value={{ host, store }}>{ui}</DriveContext.Provider>);
}

afterEach(clearQueryClients);

test('the disclosure is exported with a version, for M4 to take over', () => {
  expect(DISCLOSURE_VERSION).toBe(1);
  expect(DISCLOSURE_TEXT.heading).toBe('Record drives automatically');
  // Play's prominent disclosure: what is collected, that it is collected in the background, what for.
  expect(DISCLOSURE_TEXT.body).toMatch(/location/);
  expect(DISCLOSURE_TEXT.body).toMatch(/in the background when the app is closed or not in use/);
  expect(DISCLOSURE_TEXT.body).toMatch(/motion activity/);
});

test('the disclosure is printed first, and nothing is requested before the driver taps', async () => {
  const { host, log } = fakeHost();
  const deps = fakeDeps(log, 'android', 34);
  await renderScreen(<DetectionScreen deps={deps} />, host);

  expect(await screen.findByText(DISCLOSURE_TEXT.heading)).toBeOnTheScreen();
  expect(screen.getByText(DISCLOSURE_TEXT.body)).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: 'Turn on auto-record' })).toBeOnTheScreen();
  expect(log).toEqual([]);
  expect(host.setAutoDetect).not.toHaveBeenCalled();
});

test('Android 13+: motion, location, then POST_NOTIFICATIONS, and only then auto-record is turned on', async () => {
  const { host, log } = fakeHost();
  const deps = fakeDeps(log, 'android', 33);
  await renderScreen(<DetectionScreen deps={deps} />, host);

  await fireEvent.press(await screen.findByRole('button', { name: 'Turn on auto-record' }));
  await waitFor(() => expect(host.setAutoDetect).toHaveBeenCalledWith(true));
  expect(log).toEqual([...PROMPTS, 'setAutoDetect:true']);
  expect(await screen.findByText('Auto-record is on')).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: 'Turn off auto-record' })).toBeOnTheScreen();
});

test('Android 12 has no notification permission to ask for', async () => {
  const { host, log } = fakeHost();
  await renderScreen(<DetectionScreen deps={fakeDeps(log, 'android', 32)} />, host);
  await fireEvent.press(await screen.findByRole('button', { name: 'Turn on auto-record' }));
  await waitFor(() => expect(host.setAutoDetect).toHaveBeenCalledWith(true));
  expect(log).toEqual(['motion', 'foregroundLocation', 'backgroundLocation', 'setAutoDetect:true']);
});

test('notifications refused: auto-record still turns on, and the screen says what that costs', async () => {
  const { host, log } = fakeHost();
  await renderScreen(<DetectionScreen deps={fakeDeps(log, 'android', 34, { notifications: false })} />, host);
  await fireEvent.press(await screen.findByRole('button', { name: 'Turn on auto-record' }));
  expect(await screen.findByText('Auto-record is on')).toBeOnTheScreen();
  expect(screen.getByText(/Notifications are off/)).toBeOnTheScreen();
});

test.each([
  ['motion', { motion: 'denied' as const }, ['motion']],
  ['foreground location', { foreground: false }, ['motion', 'foregroundLocation']],
  ['background location', { background: false }, ['motion', 'foregroundLocation', 'backgroundLocation']],
])('%s denied: stops there, offers Open Settings, and never turns auto-record on', async (_, answers, asked) => {
  const { host, log } = fakeHost();
  const deps = fakeDeps(log, 'ios', 0, answers);
  await renderScreen(<DetectionScreen deps={deps} />, host);

  await fireEvent.press(await screen.findByRole('button', { name: 'Turn on auto-record' }));
  expect(await screen.findByText('Auto-record needs your permission')).toBeOnTheScreen();
  expect(log).toEqual(asked);
  expect(host.setAutoDetect).not.toHaveBeenCalled();

  await fireEvent.press(screen.getByRole('button', { name: 'Open Settings' }));
  expect(deps.openSettings).toHaveBeenCalled();
});

test('a phone without motion sensing is told so, not asked again', async () => {
  const { host, log } = fakeHost();
  await renderScreen(<DetectionScreen deps={fakeDeps(log, 'android', 34, { motion: 'unavailable' })} />, host);
  await fireEvent.press(await screen.findByRole('button', { name: 'Turn on auto-record' }));
  expect(await screen.findByText("This phone can't detect drives on its own")).toBeOnTheScreen();
  expect(host.setAutoDetect).not.toHaveBeenCalled();
});

test('iPhone before the first completed drive: explains, and requests nothing', async () => {
  const { host, log } = fakeHost();
  // A discarded ride was not a drive.
  const discarded = tripRow({ client_trip_id: 'slow', status: 'discarded', score: null, sync_state: 'synced' });
  await renderScreen(<DetectionScreen deps={fakeDeps(log, 'ios', 0)} />, host, [discarded]);

  expect(await screen.findByText('Record your first drive first')).toBeOnTheScreen();
  expect(screen.queryByRole('button', { name: 'Turn on auto-record' })).toBeNull();
  expect(screen.queryByText(DISCLOSURE_TEXT.heading)).toBeNull();
  expect(log).toEqual([]);
});

test('iPhone after a completed drive: the disclosure, then the same order without Android notifications', async () => {
  const { host, log } = fakeHost();
  await renderScreen(<DetectionScreen deps={fakeDeps(log, 'ios', 0)} />, host);
  await fireEvent.press(await screen.findByRole('button', { name: 'Turn on auto-record' }));
  await waitFor(() => expect(host.setAutoDetect).toHaveBeenCalledWith(true));
  expect(log).toEqual(['motion', 'foregroundLocation', 'backgroundLocation', 'setAutoDetect:true']);
});

test('flag off: "not available yet", never shown as turned off by the driver, and nothing is asked', async () => {
  const { host, log } = fakeHost();
  await renderScreen(<DetectionScreen deps={fakeDeps(log, 'android', 34, { flag: false })} />, host);
  expect(await screen.findByText('Auto-record isn’t available yet')).toBeOnTheScreen();
  expect(screen.queryByRole('button', { name: 'Turn on auto-record' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Turn off auto-record' })).toBeNull();
  expect(log).toEqual([]);
});

test('turned on: Turn off asks the host and the screen returns to the disclosure', async () => {
  const { host, log } = fakeHost(true);
  const deps = fakeDeps(log, 'android', 34, { access: { location: 'always', motion: 'granted' } });
  await renderScreen(<DetectionScreen deps={deps} />, host);

  expect(await screen.findByText('Auto-record is on')).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: 'Turn off auto-record' }));
  await waitFor(() => expect(host.setAutoDetect).toHaveBeenCalledWith(false));
  expect(await screen.findByText(DISCLOSURE_TEXT.heading)).toBeOnTheScreen();
});

test('turned on but a permission was taken away since: says it cannot run, with Open Settings', async () => {
  const { host, log } = fakeHost(true);
  const deps = fakeDeps(log, 'android', 34, { access: { location: 'whenInUse', motion: 'granted' } });
  await renderScreen(<DetectionScreen deps={deps} />, host);

  expect(await screen.findByText("Auto-record can't run yet")).toBeOnTheScreen();
  expect(screen.queryByText('Auto-record is on')).toBeNull();
  expect(screen.getByRole('button', { name: 'Open Settings' })).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: 'Turn off auto-record' })).toBeOnTheScreen();
  expect(log).toEqual([]);
});

describe('the screen follows the host and the phone (final review I4, M9)', () => {
  test('opted in and permitted, but the host could not arm: never "on"; Try again re-applies the arming', async () => {
    const { host, log } = fakeHost(true, { armOnOptIn: false });
    const deps = fakeDeps(log, 'android', 34, { access: { location: 'always', motion: 'granted' } });
    await renderScreen(<DetectionScreen deps={deps} />, host);
    expect(await screen.findByText("Auto-record isn't running")).toBeOnTheScreen();
    expect(screen.queryByText('Auto-record is on')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(host.refreshArming).toHaveBeenCalledTimes(1);
  });

  test('back from Settings with Always granted: the screen re-reads on the foreground and shows the host armed', async () => {
    const { host, log, publish } = fakeHost(true, { armOnOptIn: false });
    const deps = fakeDeps(log, 'ios', 0, { access: { location: 'whenInUse', motion: 'granted' } });
    await renderScreen(<DetectionScreen deps={deps} />, host);
    expect(await screen.findByText("Auto-record can't run yet")).toBeOnTheScreen();

    deps.grant({ location: 'always', motion: 'granted' });
    // The host re-applies its arming on the same foreground transition (tested in the host).
    publish(true);
    deps.foreground();
    expect(await screen.findByText('Auto-record is on')).toBeOnTheScreen();
  });

  test('denied, then allowed in Settings: back on the screen it offers Turn on again', async () => {
    const { host, log } = fakeHost();
    const deps = fakeDeps(log, 'ios', 0, { motion: 'denied' });
    await renderScreen(<DetectionScreen deps={deps} />, host);
    await fireEvent.press(await screen.findByRole('button', { name: 'Turn on auto-record' }));
    expect(await screen.findByText('Auto-record needs your permission')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Open Settings' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Turn on again' })).toBeOnTheScreen();

    (deps.requestMotion as jest.Mock).mockResolvedValueOnce('granted');
    await fireEvent.press(screen.getByRole('button', { name: 'Turn on again' }));
    await waitFor(() => expect(host.setAutoDetect).toHaveBeenCalledWith(true));
    expect(await screen.findByText('Auto-record is on')).toBeOnTheScreen();
  });
});
