import { act, fireEvent, screen } from '@testing-library/react-native';

import { APP_CONFIG_KEY } from '@/data/config/appConfig';
import { createSettingsRepo } from '@/data/db/settings';
import { DriveContext } from '@/drive/DriveProvider';
import type { DriveHost, DriveState } from '@/drive/host';
import { createDriveStore } from '@/drive/store';
import { DetectionStatusLine, detectionLineState } from '@/features/home/DetectionStatusLine';
import { clearQueryClients, routerDouble, world } from '@/features/trips/__fixtures__/render';

const mockRouter = routerDouble();
jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  return {
    useRouter: () => mockRouter,
    useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]),
  };
});

function fakeHost(status: DriveState['status'], intent: boolean) {
  let state = { status } as DriveState;
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
    move(next: DriveState['status']) {
      state = { ...state, status: next };
      for (const l of listeners) l(state);
    },
  };
}

async function renderLine(status: DriveState['status'], intent: boolean, flag?: boolean) {
  const w = await world();
  if (flag !== undefined) {
    await createSettingsRepo(w.db).set(APP_CONFIG_KEY, { fetchedAt: 1, flags: { auto_detect: flag } });
  }
  const fake = fakeHost(status, intent);
  const store = createDriveStore(fake.host, { currentState: 'active', addEventListener: () => ({ remove() {} }) });
  await w.renderScreen(
    <DriveContext.Provider value={{ host: fake.host, store }}>
      <DetectionStatusLine />
    </DriveContext.Provider>
  );
  return fake;
}

beforeEach(() => mockRouter.push.mockClear());
afterEach(clearQueryClients);

test('what the line may claim follows the intent, the host and the flag', () => {
  expect(detectionLineState(true, 'armed', true)).toBe('on');
  expect(detectionLineState(true, 'recording', true)).toBe('on');
  // `off` is not the driver's choice: asked for, but not armed.
  expect(detectionLineState(true, 'off', true)).toBe('notRunning');
  expect(detectionLineState(true, 'off', false)).toBe('notRunning');
  expect(detectionLineState(false, 'off', true)).toBe('manual');
  expect(detectionLineState(false, 'off', null)).toBe('manual');
  // A server flag that is off makes the feature unavailable, never "turned off" (D2 M-2).
  expect(detectionLineState(false, 'off', false)).toBe('unavailable');
});

test('opted in and armed: "Auto-record is on", and the row opens the detection screen', async () => {
  await renderLine('armed', true);
  expect(await screen.findByText('Auto-record is on')).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: 'Auto-record is on, Auto-record settings' }));
  expect(mockRouter.push).toHaveBeenCalledWith('/detection');
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
  await renderLine('off', false, false);
  expect(await screen.findByText('Auto-record isn’t available yet')).toBeOnTheScreen();
  expect(screen.queryByText('Manual mode')).toBeNull();
});
