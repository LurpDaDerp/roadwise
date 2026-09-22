import { createFakeDriveSense } from '@drive-sense';
import { render, screen, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';

import { createSamplesRepo, createSettingsRepo, type Db } from '@/data/db';
import { createTestDb, seedTrips } from '@/data/queries/__fixtures__/harness';
import { tripRow } from '@/data/queries/__fixtures__/rows';
import { DataProvider } from '@/data/queries/context';
import type { DriveHost, DriveState } from '@/drive/host';
import { ThemeProvider } from '@/ui';

import {
  createDriveBatteryRecorder,
  DIAG_BATTERY_KEY,
  readDriveBattery,
  type BatteryReading,
  type DriveBatteryRecord,
} from '../battery';
import { diagnosticsEnabled, DriveDiagnosticsRoute, DriveDiagnosticsScreen } from '../DriveDiagnosticsScreen';

const mockEnv = { diagnostics: false };
jest.mock('@/lib/env', () => ({
  get env() {
    return mockEnv;
  },
}));

jest.mock('expo-router', () => {
  const { Text: RNText } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    Redirect: ({ href }: { href: string }) => <RNText testID="redirect">{href}</RNText>,
    useRouter: () => ({ back: jest.fn(), canGoBack: () => false }),
  };
});

const mockBattery = { level: 0.64, lowPower: false, state: 1 };
jest.mock('expo-battery', () => ({
  BatteryState: { UNKNOWN: 0, UNPLUGGED: 1, CHARGING: 2, FULL: 3 },
  useBatteryLevel: () => mockBattery.level,
  useLowPowerMode: () => mockBattery.lowPower,
  useBatteryState: () => mockBattery.state,
  getBatteryLevelAsync: jest.fn(async () => mockBattery.level),
  isLowPowerModeEnabledAsync: jest.fn(async () => mockBattery.lowPower),
}));

const T = Date.UTC(2026, 8, 22, 18, 0, 0);

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
  mockEnv.diagnostics = false;
});

const Hud = () => <Text>hud</Text>;

function wrap(node: React.ReactNode) {
  return (
    <ThemeProvider>
      <DataProvider db={db}>{node}</DataProvider>
    </ThemeProvider>
  );
}

describe('route guard: __DEV__ || env.diagnostics', () => {
  const realDev = (globalThis as { __DEV__?: boolean }).__DEV__;
  afterEach(() => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = realDev;
  });
  const setDev = (v: boolean) => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = v;
  };

  test('a release build without the flag is sent home and never renders the screen', async () => {
    setDev(false);
    expect(diagnosticsEnabled()).toBe(false);
    await render(wrap(<DriveDiagnosticsRoute Hud={Hud} source={createFakeDriveSense()} />));
    expect(screen.getByTestId('redirect').props.children).toBe('/');
    expect(screen.queryByText('Drive diagnostics')).toBeNull();
  });

  test('the diagnostics flag (development and preview builds) opens it', async () => {
    setDev(false);
    mockEnv.diagnostics = true;
    expect(diagnosticsEnabled()).toBe(true);
    await render(wrap(<DriveDiagnosticsRoute Hud={Hud} source={createFakeDriveSense()} />));
    expect(await screen.findByText('Drive diagnostics')).toBeTruthy();
    expect(screen.queryByTestId('redirect')).toBeNull();
  });

  test('__DEV__ opens it', async () => {
    setDev(true);
    expect(diagnosticsEnabled()).toBe(true);
    await render(wrap(<DriveDiagnosticsRoute Hud={Hud} source={createFakeDriveSense()} />));
    expect(await screen.findByText('Drive diagnostics')).toBeTruthy();
  });
});

describe('the drive-sense readout', () => {
  test('state, lock signal, permissions, last exit and the stored rows', async () => {
    const fake = createFakeDriveSense({ platform: 'android' });
    fake.setState({ location: 'always', motion: 'granted', armed: true, lockSignal: 'reliable' });
    fake.setLastExitInfo({ ts: T, reason: 'watchdog', whileCapturing: true });
    fake.setIgnoringBatteryOptimizations(false);
    await seedTrips(db, [tripRow({ client_trip_id: 'open-1', status: 'recording' })]);
    const samples = createSamplesRepo(db);
    for (let i = 0; i < 12; i += 1) {
      await samples.append('open-1', T + i * 1000, {
          ts: T + i * 1000, lat: 47.6, lng: -122.3, hAcc: 5, speed: i, speedAcc: 0.5, course: 90, alt: 10,
          gnssValid: true, aLonMax: 0, aLonMin: 0, aLatMax: 0, aLatMin: 0, yawRateMax: 0, jerkMax: 0,
          gravityStability: 1, orientationDelta: 0, handlingScore: 0, locked: false, screenOn: true,
          appForeground: true,
      });
    }
    await render(wrap(<DriveDiagnosticsScreen Hud={Hud} source={fake} />));

    expect(await screen.findByText('Armed')).toBeTruthy();
    expect(screen.getByText('reliable')).toBeTruthy();
    expect(screen.getByText('always')).toBeTruthy();
    expect(screen.getByText('granted')).toBeTruthy();
    expect(screen.getByText(/Restricted/)).toBeTruthy(); // battery optimisation is on
    expect(screen.getByText('watchdog')).toBeTruthy();
    // The last 10 of the 12 stored rows, newest first — and never a map.
    await waitFor(() => expect(screen.getAllByTestId('diag-row')).toHaveLength(10));
    expect(screen.getAllByTestId('diag-row')[0]).toHaveTextContent(/24\.6 mph/);
    expect(fake.queries).toEqual(expect.arrayContaining(['getState', 'getLastExitInfo']));
    // The screen reads; it never commands capture, arming or a row listener.
    expect(fake.calls).toEqual([]);
    expect(fake.listenerCount('row')).toBe(0);
  });

  test('no stored rows and no exit record are said plainly', async () => {
    await render(wrap(<DriveDiagnosticsScreen Hud={Hud} source={createFakeDriveSense()} />));
    expect(await screen.findByText(/No rows are stored/)).toBeTruthy();
    expect(screen.getByText(/No exit recorded/)).toBeTruthy();
  });

  test('a missing native module is reported, not shown as a state', async () => {
    const broken = createFakeDriveSense();
    broken.getState = async () => {
      throw new Error('DriveSense native module is not available (Jest, Expo Go or web)');
    };
    await render(wrap(<DriveDiagnosticsScreen Hud={Hud} source={broken} />));
    expect(await screen.findByText(/native module is not available/)).toBeTruthy();
    expect(screen.queryByText('Armed')).toBeNull();
  });
});

describe('battery (diag.battery)', () => {
  function hostStub(initial: Partial<DriveState>) {
    let s = { status: 'off', clientTripId: null, dryRun: false, ...initial } as DriveState;
    const listeners = new Set<(s: DriveState) => void>();
    const host = {
      snapshot: () => s,
      subscribe: (fn: (s: DriveState) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    } as unknown as DriveHost;
    const set = (over: Partial<DriveState>) => {
      s = { ...s, ...over };
      for (const fn of listeners) fn(s);
    };
    return { host, set, listeners };
  }

  test('a reading when recording starts and one when the drive closes, stored once each', async () => {
    const settings = createSettingsRepo(db);
    let level = 0.9;
    let clock = T;
    const read = jest.fn(async (): Promise<BatteryReading> => ({ level, lowPower: false, at: clock }));
    const { host, set, listeners } = hostStub({});
    const stop = createDriveBatteryRecorder({ host, settings, read });

    set({ status: 'candidate' });
    expect(read).not.toHaveBeenCalled(); // a candidate may yet be discarded
    set({ status: 'recording', clientTripId: 't1' });
    set({ status: 'recording', clientTripId: 't1' }); // the 1 Hz rows read nothing
    set({ status: 'recording', clientTripId: 't1' });
    level = 0.82;
    clock = T + 3_600_000;
    set({ status: 'ending', clientTripId: 't1' });
    set({ status: 'armed', clientTripId: null });
    await waitFor(async () =>
      expect(await readDriveBattery(settings)).toEqual<DriveBatteryRecord>({
        clientTripId: 't1',
        start: { level: 0.9, lowPower: false, at: T },
        end: { level: 0.82, lowPower: false, at: T + 3_600_000 },
      })
    );
    expect(read).toHaveBeenCalledTimes(2);
    stop();
    expect(listeners.size).toBe(0);
  });

  test('a dry run (the simulation) records nothing', async () => {
    const settings = createSettingsRepo(db);
    const read = jest.fn(async (): Promise<BatteryReading> => ({ level: 0.5, lowPower: false, at: T }));
    const { host, set } = hostStub({ dryRun: true });
    createDriveBatteryRecorder({ host, settings, read });
    set({ status: 'recording', clientTripId: 'sim' });
    set({ status: 'off', clientTripId: null });
    await new Promise((r) => setTimeout(r, 0));
    expect(read).not.toHaveBeenCalled();
    expect(await settings.get(DIAG_BATTERY_KEY)).toBeNull();
  });

  test('the screen shows the level now and the last drive at start and end', async () => {
    await createSettingsRepo(db).set(DIAG_BATTERY_KEY, {
      clientTripId: 't1',
      start: { level: 0.9, lowPower: false, at: T },
      end: { level: 0.82, lowPower: true, at: T + 3_600_000 },
    } satisfies DriveBatteryRecord);
    await render(wrap(<DriveDiagnosticsScreen Hud={Hud} source={createFakeDriveSense()} />));
    expect(await screen.findByText('90 %')).toBeTruthy();
    expect(screen.getByText(/82 %/)).toBeTruthy();
    expect(screen.getByText(/power saving on/)).toBeTruthy();
    expect(screen.getByText('64 %')).toBeTruthy(); // now, from expo-battery's listener hooks
  });

  test('before any recorded drive it says so', async () => {
    await render(wrap(<DriveDiagnosticsScreen Hud={Hud} source={createFakeDriveSense()} />));
    expect(await screen.findByText(/No drive recorded with diagnostics on/)).toBeTruthy();
  });
});
