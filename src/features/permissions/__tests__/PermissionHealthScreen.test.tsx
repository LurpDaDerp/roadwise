import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';

import { PROMPT_INTERVAL_MS, PROMPTS_KEY } from '@/core/permissions';
import { T0 } from '@/data/queries/__fixtures__/rows';
import {
  drive,
  fakeAdapter,
  fakeAppState,
  fakeHost,
  noRefresh,
  permissionsWorld,
  snap,
  type Seed,
} from '@/features/permissions/__fixtures__/harness';
import { PermissionHealthScreen, REPAIR_HREF } from '@/features/permissions/PermissionHealthScreen';
import { SETTINGS_RETURN_ACK_KEY } from '@/features/permissions/usePermissionHealth';
import { clearQueryClients, routerDouble } from '@/features/trips/__fixtures__/render';

const mockRouter = routerDouble();
const mockFocus: { cb: (() => void) | null } = { cb: null };
jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  return {
    useRouter: () => mockRouter,
    // The mount is the first focus; `mockFocus.cb()` stands for coming back to the screen.
    useFocusEffect: (cb: () => void) => {
      mockFocus.cb = cb;
      useEffect(() => {
        cb();
      }, [cb]);
    },
  };
});
const mockSession = {
  session: { user: { id: 'u1' } },
  profile: { driving_stage: 'new' } as { driving_stage: string } | null,
};
jest.mock('@/data/supabase/session', () => ({ useSession: () => mockSession }));
jest.mock('@/data/supabase/profile', () => ({ recordConsent: jest.fn(async () => ({})) }));

/** A tap whose async work settles inside `act`. */
const press = (el: Parameters<typeof fireEvent.press>[0]) =>
  act(async () => {
    fireEvent.press(el);
  });

afterEach(() => {
  clearQueryClients();
  mockSession.profile = { driving_stage: 'new' };
  jest.clearAllMocks();
});

async function renderB2(
  adapter = fakeAdapter(),
  seed: Seed = { trips: [drive(1)] },
  opts: { intent?: boolean; manufacturer?: string | null } = {}
) {
  const w = await permissionsWorld({ affirmed: true, ...seed });
  const { host } = fakeHost({ intent: opts.intent ?? true });
  const appState = fakeAppState();
  await w.render(
    <PermissionHealthScreen
      deps={{
        adapter,
        appState,
        appConfig: { refresher: noRefresh },
        manufacturer: opts.manufacturer ?? 'Google',
        now: () => T0,
      }}
    />,
    host
  );
  return { ...w, adapter, appState, host };
}

test('all good: the green summary, rows status-first, nothing to fix', async () => {
  await renderB2();
  expect(await screen.findByText('Everything RoadWise needs is on')).toBeOnTheScreen();
  expect(screen.getByLabelText('Location: all set. RoadWise can measure your drives.')).toBeOnTheScreen();
  expect(screen.queryByTestId(/permission-row-.*-fix/)).toBeNull();
  // Android: a battery row, no Low Power row.
  expect(screen.getByTestId('permission-row-battery')).toBeOnTheScreen();
  expect(screen.queryByTestId('permission-row-lowPower')).toBeNull();
});

test('status first for screen readers: "Location: off"', async () => {
  await renderB2(fakeAdapter(snap({ location: 'denied', precise: null })));
  expect(await screen.findByText("RoadWise can't record drives right now")).toBeOnTheScreen();
  expect(screen.getByLabelText('Location: off. Without location, RoadWise can’t record drives.')).toBeOnTheScreen();
});

test('a Fix is the driver’s tap: it asks the OS at once, even inside the 14-day window, and stamps the history', async () => {
  const adapter = fakeAdapter(snap({ motion: 'undetermined' }));
  const { settings } = await renderB2(adapter, { trips: [drive(1)], settings: { [PROMPTS_KEY]: { motion: T0 - 1000 } } });
  await press(await screen.findByTestId('permission-row-motion-fix'));
  await waitFor(() => expect(adapter.log).toContain('requestMotion'));
  expect(await settings.get(PROMPTS_KEY)).toEqual({ motion: T0 });
  expect(T0 - (T0 - 1000)).toBeLessThan(PROMPT_INTERVAL_MS);
  // Read again after the request: motion is allowed now, so its Fix is gone.
  await waitFor(() => expect(screen.queryByTestId('permission-row-motion-fix')).toBeNull());
  expect(screen.getByTestId('permission-row-motion')).toHaveTextContent(/All set/);
});

test('Open Settings marks the return, so the next report carries ack', async () => {
  const adapter = fakeAdapter(snap({ notifications: 'denied', notificationsCanAskAgain: false }));
  const { settings } = await renderB2(adapter);
  await press(await screen.findByTestId('permission-row-notifications-fix'));
  await waitFor(() => expect(adapter.log).toContain('openAppSettings'));
  expect(await settings.get(SETTINGS_RETURN_ACK_KEY)).toBe(T0);
  await waitFor(() => expect(screen.getByTestId('permission-row-notifications-fix')).not.toBeBusy());
});

test('background location’s Fix opens the disclosure, never the OS prompt', async () => {
  const adapter = fakeAdapter(snap({ location: 'foreground' }));
  await renderB2(adapter, { trips: [drive(1)], settings: { 'permissions.everGranted': { locationAlways: true } } });
  await press(await screen.findByTestId('permission-row-locationAlways-fix'));
  expect(mockRouter.push).toHaveBeenCalledWith(REPAIR_HREF);
  expect(adapter.log.some((c) => c.startsWith('requestLocationAlways'))).toBe(false);
});

test('manual by choice: explained, no Fix, no nag', async () => {
  await renderB2(fakeAdapter(snap({ location: 'foreground', batteryOptimization: 'optimized' })), {
    trips: [drive(1)],
    settings: { 'permissions.manualByChoice': true },
  });
  expect(await screen.findByText('Everything RoadWise needs is on')).toBeOnTheScreen();
  expect(screen.getByTestId('permission-row-locationAlways')).toHaveTextContent(/Your choice/);
  expect(screen.queryByTestId('permission-row-locationAlways-fix')).toBeNull();
  expect(screen.queryByTestId('permission-row-battery-fix')).toBeNull();
});

test('reads the choice from host.autoDetectEnabled(), not the engine status', async () => {
  // The host is `off` (not armed: Always is missing) but the driver chose auto-record: that is a
  // repair, not a choice.
  await renderB2(fakeAdapter(snap({ location: 'foreground' })), { trips: [drive(1)] }, { intent: true });
  expect(await screen.findByTestId('permission-row-autoRecord-fix')).toBeOnTheScreen();
  expect(screen.getByTestId('permission-row-autoRecord')).toHaveTextContent(/Needs attention/);
});

test('a withdrawn auto_detect flag offers no fix for auto-record', async () => {
  await renderB2(fakeAdapter(snap({ location: 'foreground' })), { trips: [drive(1)], autoDetect: false });
  expect(await screen.findByTestId('permission-row-autoRecord')).toHaveTextContent(/Not available/);
  expect(screen.queryByTestId('permission-row-autoRecord-fix')).toBeNull();
  expect(screen.queryByTestId('permission-row-locationAlways-fix')).toBeNull();
});

test('Android battery: can’t check, with the maker’s guide and its settings page', async () => {
  const adapter = fakeAdapter(snap({ batteryOptimization: 'unknown' }));
  await renderB2(adapter, { trips: [drive(1)] }, { manufacturer: 'samsung' });
  const row = await screen.findByTestId('permission-row-battery');
  expect(row).toHaveTextContent(/We can’t check this from here\./);
  expect(screen.getByTestId('permission-row-battery-guide')).toHaveTextContent(/Samsung: let RoadWise run in the background/);
  await press(screen.getByTestId('permission-row-battery-fix'));
  await waitFor(() => expect(adapter.log).toContain('openBatterySettings'));
  await waitFor(() => expect(screen.getByTestId('permission-row-battery-fix')).not.toBeBusy());
});

test('iOS: Low Power Mode is informational, never a Fix', async () => {
  await renderB2(fakeAdapter(snap({ platform: 'ios', lowPowerMode: true })));
  const row = await screen.findByTestId('permission-row-lowPower');
  expect(row).toHaveTextContent(/While it’s on, drives may be recorded in less detail\./);
  expect(screen.queryByTestId('permission-row-lowPower-fix')).toBeNull();
  expect(screen.queryByTestId('permission-row-battery')).toBeNull();
});

test('iOS before the first drive: background location waits, and nothing asks for it', async () => {
  const adapter = fakeAdapter(snap({ platform: 'ios', location: 'foreground' }));
  await renderB2(adapter, { trips: [] });
  expect(await screen.findByTestId('permission-row-locationAlways')).toHaveTextContent(/After your first drive/);
  expect(screen.queryByTestId('permission-row-locationAlways-fix')).toBeNull();
});

test.each([
  [{ allowed: true, armed: true }, 'Auto-record is armed on this phone right now.'],
  [{ allowed: true, armed: false }, 'Auto-record isn’t armed right now, though this phone allows it.'],
  [{ allowed: false, armed: null }, 'We couldn’t check auto-record on this phone.'],
] as const)('Run a test says what readiness found: %j', async (readiness, said) => {
  await renderB2(fakeAdapter(snap(), { readiness }));
  await press(await screen.findByTestId('permissions-run-test'));
  expect(await screen.findByTestId('permissions-test-result')).toHaveTextContent(said);
});

test('a read failure is an inline error with a retry, never a made-up state', async () => {
  const adapter = fakeAdapter();
  adapter.failReads = true;
  await renderB2(adapter);
  expect(await screen.findByTestId('permissions-read-error')).toBeOnTheScreen();
  expect(screen.queryByTestId('permissions-summary')).toBeNull();
  adapter.failReads = false;
  await press(screen.getByText('Try again'));
  expect(await screen.findByText('Everything RoadWise needs is on')).toBeOnTheScreen();
});

test('reads on mount and on return to the front only; back from the disclosure reads again', async () => {
  const adapter = fakeAdapter();
  const { appState } = await renderB2(adapter);
  await screen.findByText('Everything RoadWise needs is on');
  const reads = () => adapter.log.filter((c) => c === 'snapshot').length;
  const first = reads();
  adapter.current = snap({ location: 'denied', precise: null });
  await act(async () => appState.foreground());
  expect(await screen.findByText("RoadWise can't record drives right now")).toBeOnTheScreen();
  expect(reads()).toBe(first + 1);
  adapter.current = snap();
  await act(async () => mockFocus.cb?.());
  expect(await screen.findByText('Everything RoadWise needs is on')).toBeOnTheScreen();
  expect(reads()).toBe(first + 2);
});

test('a non-driver sees only notifications, and no test', async () => {
  mockSession.profile = { driving_stage: 'non_driver' };
  await renderB2();
  expect(await screen.findByTestId('permission-row-notifications')).toBeOnTheScreen();
  expect(screen.queryByTestId('permission-row-location')).toBeNull();
  expect(screen.queryByTestId('permissions-run-test')).toBeNull();
});

test('Task 19 r1: auto-record wanted and allowed, but this account never affirmed the disclosure — its own row, and the Fix opens it', async () => {
  await renderB2(fakeAdapter(snap()), { trips: [drive(1)], affirmed: false });
  const rowEl = await screen.findByTestId('permission-row-autoRecord');
  expect(rowEl).toHaveTextContent(/Needs attention/);
  expect(rowEl).toHaveTextContent(/review how RoadWise uses background location/);
  expect(rowEl).not.toHaveTextContent(/Your choice/);
  await press(screen.getByTestId('permission-row-autoRecord-fix'));
  expect(mockRouter.push).toHaveBeenCalledWith(REPAIR_HREF);
  expect(screen.getByTestId('permission-row-autoRecord-fix')).toHaveTextContent('Review background location');
});
