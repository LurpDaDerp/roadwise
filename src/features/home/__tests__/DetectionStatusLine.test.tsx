import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { View } from 'react-native';

import type { DriveHost, DriveState } from '@/drive/host';
import { AUTO_RECORD_HREF, DetectionStatusLine, detectionLineState } from '@/features/home/DetectionStatusLine';
import { HomeBanners } from '@/features/home/HomeBanners';
import {
  drive,
  fakeAdapter,
  fakeAppState,
  noRefresh,
  permissionsWorld,
  snap,
  type FakeAdapter,
} from '@/features/permissions/__fixtures__/harness';
import { clearQueryClients, routerDouble } from '@/features/trips/__fixtures__/render';

const mockRouter = routerDouble();
jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  return {
    useRouter: () => mockRouter,
    useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]),
  };
});
const mockSession = { profile: { driving_stage: 'new' } as { driving_stage: string } | null };
jest.mock('@/data/supabase/session', () => ({
  useSession: () => ({ session: { user: { id: 'u1' } }, profile: mockSession.profile }),
}));
jest.mock('@/data/supabase/profile', () => ({ recordConsent: jest.fn(async () => ({})) }));

/** `armed` defaults to what an idle host would publish: armed exactly when its status is. */
function fakeHost(status: DriveState['status'], intent: boolean, armed = status === 'armed') {
  let state = { status, autoDetectArmed: armed } as DriveState;
  const listeners = new Set<(s: DriveState) => void>();
  const host = {
    snapshot: () => state,
    subscribe: (fn: (s: DriveState) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    autoDetectEnabled: () => intent,
  } as unknown as DriveHost;
  return {
    host,
    move(next: DriveState['status'], nextArmed = next === 'armed') {
      state = { ...state, status: next, autoDetectArmed: nextArmed };
      for (const l of listeners) l(state);
    },
  };
}

const seams = (adapter: FakeAdapter) => ({ adapter, appState: fakeAppState(), appConfig: { refresher: noRefresh } });

async function renderLine(
  status: DriveState['status'],
  intent: boolean,
  opts: { flag?: boolean; armed?: boolean; adapter?: FakeAdapter; withBanners?: boolean } = {}
) {
  const adapter = opts.adapter ?? fakeAdapter(snap());
  const w = await permissionsWorld({ trips: [drive(1)], autoDetect: opts.flag });
  const fake = fakeHost(status, intent, opts.armed);
  await w.render(
    opts.withBanners ? (
      <View>
        <HomeBanners permissionDeps={seams(adapter)} />
        <DetectionStatusLine deps={seams(adapter)} />
      </View>
    ) : (
      <DetectionStatusLine deps={seams(adapter)} />
    ),
    fake.host
  );
  await waitFor(() => expect(adapter.log).toContain('snapshot'));
  await act(async () => {});
  return fake;
}

beforeEach(() => mockRouter.push.mockClear());
afterEach(() => {
  clearQueryClients();
  mockSession.profile = { driving_stage: 'new' };
});

test('what the line may claim follows the intent, the host\'s published arming and the flag', () => {
  expect(detectionLineState(true, true, true)).toBe('on');
  // Asked for, but the host is not armed (permissions, a refused arm, signed out).
  expect(detectionLineState(true, false, true)).toBe('notRunning');
  // A withdrawn flag is named as the reason even after an opt-in (review U4 m3).
  expect(detectionLineState(true, false, false)).toBe('unavailable');
  expect(detectionLineState(true, true, false)).toBe('unavailable');
  expect(detectionLineState(false, false, true)).toBe('manual');
  expect(detectionLineState(false, false, null)).toBe('manual');
  // A server flag that is off makes the feature unavailable, never "turned off" (D2 M-2).
  expect(detectionLineState(false, false, false)).toBe('unavailable');
});

test('and B2\'s recording mode must agree before it says "on" (Task 19)', () => {
  expect(detectionLineState(true, true, true, 'automatic')).toBe('on');
  // Armed a moment ago, but the phone now says Always or motion is gone: not claimed as running.
  expect(detectionLineState(true, true, true, 'manual')).toBe('notRunning');
  expect(detectionLineState(true, true, true, 'unavailable')).toBe('notRunning');
  expect(detectionLineState(false, false, true, 'manual')).toBe('manual');
  expect(detectionLineState(false, false, false, 'automatic')).toBe('unavailable');
});

test('a manual drive while auto-record is not armed never says "on" (final review M3)', async () => {
  const fake = await renderLine('recording', true, { armed: false });
  expect(await screen.findByText("Auto-record is on but isn't running")).toBeOnTheScreen();
  await act(async () => fake.move('recording', true));
  expect(screen.getByText('Auto-record is on')).toBeOnTheScreen();
});

test('opted in and armed: "Auto-record is on", and the row opens the auto-record screen', async () => {
  await renderLine('armed', true);
  expect(await screen.findByText('Auto-record is on')).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: 'Auto-record is on, Auto-record settings' }));
  expect(mockRouter.push).toHaveBeenCalledWith(AUTO_RECORD_HREF);
  expect(AUTO_RECORD_HREF).toBe('/permissions/auto-record');
  expect(mockRouter.push).not.toHaveBeenCalledWith('/detection');
});

test('opted in and armed, but the phone now reads While Using only: not "on"', async () => {
  await renderLine('armed', true, { adapter: fakeAdapter(snap({ location: 'foreground' })) });
  expect(await screen.findByText("Auto-record is on but isn't running")).toBeOnTheScreen();
  expect(screen.queryByText('Auto-record is on')).toBeNull();
});

test('opted in but the host is off: never claims it is on', async () => {
  const fake = await renderLine('off', true);
  expect(await screen.findByText("Auto-record is on but isn't running")).toBeOnTheScreen();
  expect(screen.queryByText('Auto-record is on')).toBeNull();

  await act(async () => fake.move('armed'));
  expect(screen.getByText('Auto-record is on')).toBeOnTheScreen();
});

test('not opted in: manual mode, with how to record', async () => {
  await renderLine('off', false);
  expect(await screen.findByText('Manual mode')).toBeOnTheScreen();
  expect(screen.getByText('Tap Start drive to record a drive.')).toBeOnTheScreen();
});

test('the server flag off: unavailable, not manual by choice', async () => {
  await renderLine('off', false, { flag: false });
  expect(await screen.findByText('Auto-record isn’t available yet')).toBeOnTheScreen();
  expect(screen.queryByText('Manual mode')).toBeNull();
});

test('opted in, then the server withdrew the flag: says unavailable, not merely not running', async () => {
  await renderLine('off', true, { flag: false });
  expect(await screen.findByText('Auto-record isn’t available yet')).toBeOnTheScreen();
  expect(screen.queryByText("Auto-record is on but isn't running")).toBeNull();
});

test('an account that does not drive has no auto-record line', async () => {
  mockSession.profile = { driving_stage: 'non_driver' };
  await renderLine('off', false);
  expect(screen.queryByTestId('detection-status')).toBeNull();
});

test('Home carries one banner and one status line, and the line never repeats the banner', async () => {
  await renderLine('off', true, {
    adapter: fakeAdapter(snap({ location: 'denied', precise: null })),
    withBanners: true,
  });
  const banner = await screen.findByTestId('banner-permission-health');
  expect(screen.getAllByTestId('banner-permission-health')).toHaveLength(1);
  expect(screen.getAllByTestId('detection-status')).toHaveLength(1);
  const bannerText = 'Drive recording is off — tap to fix';
  expect(banner).toHaveProp('accessibilityLabel', bannerText);
  const line = screen.getByTestId('detection-status-row');
  expect(line.props.accessibilityLabel).not.toContain(bannerText);
  expect(line.props.accessibilityLabel).toBe("Auto-record is on but isn't running, Auto-record settings");
});
